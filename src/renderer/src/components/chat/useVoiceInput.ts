/**
 * 语音输入前端 —— 分段落准实时转写（B 方案，2026-11-22 方案变更）。
 *
 * 为什么不是真流式：现有模型 SenseVoice 是非流式的（清单里只有 model.int8.onnx），
 * 无法增量出字。真流式要换流式模型包（+200MB 下载）、重写 worker 协议、再把 IPC
 * 改成会话流，成本 8~12 人日；分段落只复用现有 transcribe 通道——worker 协议
 * 本来就是 id 驱动的多次转写，逐段调用即可。
 *
 * 链路：getUserMedia → AudioContext(16k) → AudioWorklet('pm-pcm-tap') 每 100ms
 * 投递一帧 PCM → segmenter 按自然停顿切段 → 逐段 asrTranscribe → 每段到达即追加。
 * 音频全程内存态不落盘。
 *
 * 采集为什么是 AudioWorklet 而不是 MediaRecorder：MediaRecorder 给的是 webm/opus
 * 容器，必须整段编码后才能解码，天然无法分段；worklet 直接给 16k 单声道 Float32。
 * worklet 文件必须是 public/ 下的真实静态资源并用相对路径加载 —— blob: URL 会被
 * 生产 CSP（script-src 'self'）拦掉，实测见 .pulsemind/tmp/worklet-poc。
 *
 * 状态机：idle → recording（边录边逐段出字）→ transcribing（收尾最后一段）→ idle
 *   - 听写期间调用方锁住输入框（用户 2026-11-22 裁定），因此不需要处理光标漂移
 *   - Esc 在 recording/transcribing 都可用（转写中只丢弃结果，不打断在途 IPC）
 *   - 不设录音时长上限（user 2026-11-22 裁定）：每段独立转写，停止时的尾延迟
 *     只取决于最后一段、与总时长无关；分段器 8s 强切 + 段队列合并也保证内存
 *     不随总时长增长。旧架构「录完再转」才需要这个上限来压尾延迟
 *
 * 引导卡（场景 A）：首按无模型 → guideVisible，InputArea 在麦克风按钮旁弹出。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createSegmenter, type Segmenter } from '../../utils/audio-segmenter'
import { notify, notifyFailure } from '../../utils/notify'
import { frameLevel, type VoiceLevelRef } from './VoiceWaveform'

export type VoiceInputPhase = 'idle' | 'recording' | 'transcribing'

export interface VoiceInputState {
  phase: VoiceInputPhase
  /** 首按无模型 → 引导卡（InputArea 据此在按钮旁弹出） */
  guideVisible: boolean
  /** 设置页需要的已装模型判定（转写前查询 + 广播刷新） */
  modelInstalled: boolean
  /** 当前麦克风电平（0..1），供 VoiceWaveform 的 canvas 读取。
   *  用 ref 而非 state：电平每 100ms 一到，进 state 会重渲整棵 InputArea。 */
  levelRef: VoiceLevelRef
  // 故意不暴露「已录秒数」与「有段在转写中」：它们都挂在同一个图标按钮上，
  // 秒数每秒改写宽度、转写标志在边录边转时反复进出，用户会看成按钮在抖
  // （user 2026-11-22 反馈）。秒数显示由 InputArea 的独立小组件 VoiceElapsed
  // 自计时——从这里暴露的话，每秒一次 setState 会把整棵 1690 行的
  // InputAreaImpl 重渲一遍。
}

export interface VoiceInputApi {
  state: VoiceInputState
  start: () => void
  stop: () => void
  cancel: () => void
  dismissGuide: () => void
  /** 每段转写完成回调（InputArea 逐段追加到草稿） */
  onTranscribed: (handler: (text: string) => void) => void
}

interface UseVoiceInputOptions {
  /** 插入失败/空结果的本地化文案 */
  t: (path: string, values?: Record<string, string | number>) => string
  /** 转写语言 hint（设置页偏好优先，缺省 auto） */
  language?: string
  /** 听写开始时读取当前草稿——取消回滚的快照来源 */
  readDraft?: () => string
  /** 取消时把草稿整体恢复成快照（Esc 的语义是「当这次没发生」） */
  writeDraft?: (text: string) => void
}

/** 采集与模型要求的采样率 */
const SAMPLE_RATE = 16000
/** worklet 每批投递的采样数 = 100ms，与 segmenter 的 frameMs 默认值对齐 */
const BATCH_FRAMES = 1600
/** 段队列积压上限：超过就与后续段合并，避免越录越追不上 */
const MAX_PENDING_SEGMENTS = 2

/** 模型有没有装：state 查询 + 广播刷新共用 */
async function queryModelInstalled(): Promise<boolean> {
  try {
    const state = await window.electronAPI.asrGetState()
    return state.catalog.models.some((m) => m.installed)
  } catch {
    return false
  }
}

/** 多段拼成一段（背压合并用） */
function concatSegments(segments: Float32Array[]): Float32Array {
  let total = 0
  for (const s of segments) total += s.length
  const out = new Float32Array(total)
  let at = 0
  for (const s of segments) {
    out.set(s, at)
    at += s.length
  }
  return out
}

export function useVoiceInput(opts: UseVoiceInputOptions): VoiceInputApi {
  const { t } = opts
  // 转写语言：settings.voiceLanguage 是权威源（opts.language 显式给了才覆盖）。
  // 此前这里只读 opts.language，而唯一的调用点（InputArea）从不传它——设置页
  // 的下拉框把 voiceLanguage 写进了 settings，却没有任何消费者，选了永远走
  // auto。读一次 + 订阅 SETTINGS_CHANGED，设置页一改立即生效且跨窗口一致。
  const languageRef = useRef<string | undefined>(opts.language)
  useEffect(() => {
    if (opts.language) return
    let alive = true
    const apply = (value: string | undefined): void => {
      if (!alive) return
      languageRef.current = value ?? 'zh'
    }
    void window.electronAPI
      .getSettings()
      .then((s) => apply(s.voiceLanguage))
      .catch(() => {})
    const off = window.electronAPI.onSettingsChanged((s) => apply(s.voiceLanguage))
    return () => {
      alive = false
      off()
    }
  }, [opts.language])
  useEffect(() => {
    if (opts.language) languageRef.current = opts.language
  }, [opts.language])

  const [phase, setPhase] = useState<VoiceInputPhase>('idle')
  const [guideVisible, setGuideVisible] = useState(false)
  const [modelInstalled, setModelInstalled] = useState(false)

  const phaseRef = useRef<VoiceInputPhase>('idle')
  // 声波用电平：每帧算 RMS 写入，canvas 自己读。绝不进 state。
  const levelRef: VoiceLevelRef = useRef(0)
  const streamRef = useRef<MediaStream | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const workletRef = useRef<AudioWorkletNode | null>(null)
  const segmenterRef = useRef<Segmenter | null>(null)
  const queueRef = useRef<Float32Array[]>([])
  const drainingRef = useRef<Promise<void> | null>(null)
  const transcribedHandlerRef = useRef<((text: string) => void) | null>(null)
  const cancelledRef = useRef(false)
  // 草稿的读写归调用方（InputArea 才是草稿持有者）。用「最新值 ref」模式同步：
  // 这两个回调只可能在事件处理或异步流程里被调，那时 render 早已 commit、effect
  // 也跑过了，所以不会拿到旧闭包；而 render 期间直写 ref 会破坏渲染纯性
  // （react-hooks/refs: Cannot update ref during render）。
  const readDraftRef = useRef(opts.readDraft)
  const writeDraftRef = useRef(opts.writeDraft)
  useEffect(() => {
    readDraftRef.current = opts.readDraft
    writeDraftRef.current = opts.writeDraft
  })
  /** 开录那一刻的草稿快照；null = 没有可回滚的内容 */
  const draftSnapshotRef = useRef<string | null>(null)

  const setPhaseSafe = (p: VoiceInputPhase): void => {
    phaseRef.current = p
    setPhase(p)
  }

  // 模型安装态：挂载查一次 + 广播跟随（导入/删除后引导卡与按钮即时翻面）
  useEffect(() => {
    void queryModelInstalled().then(setModelInstalled)
    const off = window.electronAPI.onAsrModelsChanged(() => {
      void queryModelInstalled().then((installed) => {
        setModelInstalled(installed)
        // 模型刚装上，正在开着的引导卡自动收起
        if (installed) setGuideVisible(false)
      })
    })
    return off
  }, [])

  /**
   * 摘掉采集：停轨 + 断 worklet + 关 AudioContext。
   * 必须三件都做——只停轨不关 ctx 时 macOS 菜单栏的麦克风指示灯仍亮着，
   * 用户会当成隐私事故（review 20261122 遗留项）。
   */
  const teardownCapture = useCallback((): void => {
    const node = workletRef.current
    workletRef.current = null
    if (node) {
      node.port.onmessage = null
      try {
        node.disconnect()
      } catch {
        /* 已断开 */
      }
    }
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    const ctx = ctxRef.current
    ctxRef.current = null
    if (ctx && ctx.state !== 'closed') {
      void ctx.close().catch(() => {
        /* 已关闭 */
      })
    }
  }, [])

  const finish = useCallback((): void => {
    segmenterRef.current = null
    queueRef.current = []
    draftSnapshotRef.current = null
    levelRef.current = 0
    setPhaseSafe('idle')
    teardownCapture()
  }, [teardownCapture])

  const handleTranscribeError = useCallback(
    (e: unknown): void => {
      const err = e instanceof Error ? e : new Error(String(e))
      const msg = err.message || ''
      // 模型缺失一律走引导卡，别把用户丢进通用错误
      if (msg.includes('尚未导入语音模型') || (msg.includes('model') && msg.includes('导入'))) {
        setGuideVisible(true)
        notify.warning(t('voiceInput.noModel'))
      } else {
        notifyFailure('voiceInput', err, `${t('voiceInput.failed')}：${msg}`)
      }
    },
    [t],
  )

  /**
   * 单段转写：复用既有 IPC 通道（worker 协议本就是 id 驱动的多次转写，
   * 分段落不需要改主进程）。
   */
  const transcribeSegment = useCallback(async (samples: Float32Array): Promise<string> => {
    const r = await window.electronAPI.asrTranscribe(samples, SAMPLE_RATE, { language: languageRef.current })
    return (r?.text ?? '').trim()
  }, [])

  /**
   * 段队列消费：必须串行（同一时刻只有一段在转），积压就合并。
   * 返回同一个 promise，调用方可以 await「把所有在途段都转完」。
   */
  const drain = useCallback((): Promise<void> => {
    if (drainingRef.current) return drainingRef.current
    const run = async (): Promise<void> => {
      // 不再用 try/finally 复位「转写中」标志：那个标志本身已经删掉了——它一动
      // 按钮就变宽，正是抖动来源。队列消费完有没有落定，看 drainingRef 即可。
      while (queueRef.current.length) {
        if (cancelledRef.current) {
          queueRef.current = []
          break
        }
        let segment = queueRef.current.shift() as Float32Array
        // 背压：用户连续说不歇时队列会越积越多（8s 强切 + RTF 0.32 ≈ 2.6s 推理），
        // 与其永远追不上，不如把后续段并进来——一段长点，但字总能出来
        if (queueRef.current.length > MAX_PENDING_SEGMENTS) {
          segment = concatSegments([segment, ...queueRef.current])
          queueRef.current = []
        }
        try {
          const text = await transcribeSegment(segment)
          if (cancelledRef.current) break
          if (text) transcribedHandlerRef.current?.(text)
        } catch (e) {
          if (cancelledRef.current) break
          // 引擎/模型级失败：继续试下一段只会刷屏，停在这里
          handleTranscribeError(e)
          queueRef.current = []
          break
        }
      }
    }
    const p = run()
    drainingRef.current = p
    // 注意顺序：先赋值再挂 finally，否则空队列时 run 可能已同步走完，
    // 把刚赋上的 drainingRef 留成非 null 的死值，后续 drain 永远直接返回
    void p
      .catch(() => {
        /* 已在循环内处理 */
      })
      .finally(() => {
        if (drainingRef.current === p) drainingRef.current = null
      })
    return p
  }, [handleTranscribeError, transcribeSegment])

  const startRecording = useCallback(async (): Promise<void> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      streamRef.current = stream
      const ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
      ctxRef.current = ctx
      if (ctx.state === 'suspended') await ctx.resume()
      // 相对路径 + public/ 下的真实文件：blob: 会被生产 CSP(script-src 'self') 拦掉
      await ctx.audioWorklet.addModule('./pcm-tap.worklet.js')
      const segmenter = createSegmenter({ sampleRate: ctx.sampleRate })
      segmenterRef.current = segmenter
      const node = new AudioWorkletNode(ctx, 'pm-pcm-tap', { processorOptions: { batchFrames: BATCH_FRAMES } })
      node.port.onmessage = (ev: MessageEvent<Float32Array>): void => {
        if (cancelledRef.current) return
        const frame: Float32Array = ev.data
        // 顺手算电平喂声波：纯函数 RMS，与分段转写共用同一帧、零额外采集。
        levelRef.current = frameLevel(frame)
        const segments = segmenter.push(frame)
        if (!segments.length) return
        for (const s of segments) queueRef.current.push(s)
        void drain()
      }
      workletRef.current = node
      ctx.createMediaStreamSource(stream).connect(node)
      // 必须接到 destination 才会被驱动；中间过 0 增益，避免把自己说的播出来
      const mute = ctx.createGain()
      mute.gain.value = 0
      node.connect(mute)
      mute.connect(ctx.destination)

      setPhaseSafe('recording')
      // 快照必须在真正开录之后取：麦克风被拒时不该留下一个可回滚的假快照
      draftSnapshotRef.current = readDraftRef.current ? readDraftRef.current() : null
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      levelRef.current = 0
      teardownCapture()
      setPhaseSafe('idle')
      if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
        notifyFailure('voiceInput', err, t('voiceInput.permissionDenied'))
      } else if (err.name === 'NotFoundError' || err.name === 'NotReadableError') {
        notifyFailure('voiceInput', err, t('voiceInput.noMicrophone'))
      } else {
        notifyFailure('voiceInput', err, `${t('voiceInput.failed')}：${err.message}`)
      }
    }
  }, [drain, t, teardownCapture])

  /** 停止录音：摘采集 → 取残余段 → 转完全部在途段 → 回 idle */
  const stop = useCallback((): void => {
    if (phaseRef.current !== 'recording') return
    setPhaseSafe('transcribing')
    // 先取残余再摘采集：顺序反了会丢掉最后不足一段的话
    const rest = segmenterRef.current?.flush() ?? null
    teardownCapture()
    if (rest) queueRef.current.push(rest)
    // 不能只调 drain()：若上一轮 drain 的 while 刚发现队列空并退出，promise 已
    // resolve，但清空 drainingRef 的 finally 还在下一个微任务里——此刻调 drain()
    // 会直接返回那个已结束的旧 promise，刚 push 的残余段再没人消费，表现就是
    // 「最后一句丢了」。先等在途链落定，再 drain 一次兜住这个窗口。
    const inflight = drainingRef.current
    void (async () => {
      if (inflight) {
        try {
          await inflight
        } catch {
          /* drain 内部已处理，这里只等它结束 */
        }
      }
      await drain()
      if (!cancelledRef.current) finish()
    })()
  }, [drain, finish, teardownCapture])

  const cancel = useCallback((): void => {
    if (phaseRef.current === 'idle') return
    cancelledRef.current = true
    segmenterRef.current?.reset()
    // Esc 的语义是「当这次没发生」：已转出的段落一并撤掉，草稿恢复成开录时的样子。
    // 顺序不能反——finish() 会清空快照，先取再 finish。
    const snapshot = draftSnapshotRef.current
    finish()
    if (snapshot !== null) writeDraftRef.current?.(snapshot)
  }, [finish])

  const start = useCallback((): void => {
    if (phaseRef.current !== 'idle') return
    cancelledRef.current = false
    // 无模型的首按不进录音——引导卡才是这一按的答案
    if (!modelInstalled) {
      void queryModelInstalled().then((installed) => {
        setModelInstalled(installed)
        if (!installed) {
          setGuideVisible(true)
          notify.warning(t('voiceInput.noModel'))
        } else {
          // 查询到已装（广播还没到）——直接开录
          void startRecording()
        }
      })
      return
    }
    void startRecording()
  }, [modelInstalled, startRecording, t])

  // Esc 取消：recording 与 transcribing 都可用（转写中只是丢弃结果，不打断在途 IPC）。
  // 此前只在 recording 挂监听且按钮不处理 transcribing，转写态没有任何退出路径。
  useEffect(() => {
    if (phase === 'idle') return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      cancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [phase, cancel])

  // 卸载兜底：录音流必须跟着组件走（不然麦克风常亮）
  useEffect(
    () => () => {
      cancelledRef.current = true
      teardownCapture()
    },
    [teardownCapture],
  )

  const onTranscribed = useCallback((handler: (text: string) => void): void => {
    transcribedHandlerRef.current = handler
  }, [])

  return {
    state: { phase, guideVisible, modelInstalled, levelRef },
    start,
    stop,
    cancel,
    dismissGuide: () => setGuideVisible(false),
    onTranscribed,
  }
}
