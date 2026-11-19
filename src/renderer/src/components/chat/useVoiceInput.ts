/**
 * 语音输入前端（PLAN-voice-input §3.5）——录音状态机 + 转写调用。
 *
 * 状态机：idle → recording → transcribing → idle（结果由调用方插回光标处）
 *   - recording：点麦克风开始（按钮变停止态 + 计时）；Esc 取消
 *   - transcribing：停止后 1–2s 内出字（M0-5 实测热路径 RTF 0.32）
 *   - 空结果给可行动提示；失败区分「无模型 / 权限拒绝 / 引擎错误」
 *
 * 录音形态（plan §3.1）：getUserMedia（回声消除/降噪/自动增益全开）→
 * MediaRecorder(audio/webm;codecs=opus) → 停止后 AudioContext 解码 →
 * 下混单声道 + 重采样 16k → Float32Array → IPC。音频全程内存态不落盘。
 *
 * 引导卡（场景 A）：首按无模型 → guideCard 置 true，InputArea 在麦克风按钮
 * 旁弹引导卡（期望文件名 + sha256 + 获取指引 + 导入按钮）。模型安装/删除
 * 广播（onAsrModelsChanged）驱动 modelInstalled 重查。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { decodeToMono16k } from '../../utils/audio-decode'
import { notify, notifyFailure } from '../../utils/notify'

export type VoiceInputPhase = 'idle' | 'recording' | 'transcribing'

export interface VoiceInputState {
  phase: VoiceInputPhase
  /** 录音秒数（recording 态每秒跳动；transcribing 态冻结在停止那一刻） */
  seconds: number
  /** 首按无模型 → 引导卡（InputArea 据此在按钮旁弹出） */
  guideVisible: boolean
  /** 设置页需要的已装模型判定（转写前查询 + 广播刷新） */
  modelInstalled: boolean
}

export interface VoiceInputApi {
  state: VoiceInputState
  start: () => void
  stop: () => void
  cancel: () => void
  dismissGuide: () => void
  /** 转写完成回调（InputArea 把文本插回光标处） */
  onTranscribed: (handler: (text: string) => void) => void
}

interface UseVoiceInputOptions {
  /** 插入失败/空结果的本地化文案 */
  t: (path: string, values?: Record<string, string | number>) => string
  /** 转写语言 hint（设置页偏好；缺省 auto） */
  language?: string
}

/** 模型有没有装：state 查询 + 广播刷新共用 */
async function queryModelInstalled(): Promise<boolean> {
  try {
    const state = await window.electronAPI.asrGetState()
    return state.catalog.models.some((m) => m.installed)
  } catch {
    return false
  }
}

export function useVoiceInput(opts: UseVoiceInputOptions): VoiceInputApi {
  const { t, language } = opts
  const [phase, setPhase] = useState<VoiceInputPhase>('idle')
  const [seconds, setSeconds] = useState(0)
  const [guideVisible, setGuideVisible] = useState(false)
  const [modelInstalled, setModelInstalled] = useState(false)

  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const transcribedHandlerRef = useRef<((text: string) => void) | null>(null)
  const cancelledRef = useRef(false)
  const phaseRef = useRef<VoiceInputPhase>('idle')

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

  const cleanup = useCallback((): void => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      try {
        recorderRef.current.stop()
      } catch {
        /* already stopped */
      }
    }
    recorderRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    chunksRef.current = []
  }, [])

  const finish = useCallback((): void => {
    setPhaseSafe('idle')
    setSeconds(0)
    cleanup()
  }, [cleanup])

  /** 停止录音 → 解码 → 转写 → 交还文本 */
  const transcribe = useCallback(async (): Promise<void> => {
    const recorder = recorderRef.current
    if (!recorder) return
    const stopped = new Promise<Blob>((resolve) => {
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
        resolve(blob)
      }
    })
    try {
      recorder.stop()
    } catch {
      /* inactive */
    }
    setPhaseSafe('transcribing')
    const startedAt = Date.now()
    try {
      const blob = await stopped
      const buf = await blob.arrayBuffer()
      const { samples, sampleRate } = await decodeToMono16k(buf)
      const r = await window.electronAPI.asrTranscribe(samples, sampleRate, { language })
      const text = (r?.text ?? '').trim()
      if (!text) {
        notify.warning(t('voiceInput.emptyResult'))
        return
      }
      transcribedHandlerRef.current?.(text)
      // 慢转写给一句耗时提示（热路径 <2s 不打扰）
      const took = Date.now() - startedAt
      if (took > 4000) notify.info(t('voiceInput.slowResult', { seconds: Math.round(took / 1000) }))
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      if (cancelledRef.current) return // Esc 取消的失败静默
      const msg = err.message || ''
      if (msg.includes('尚未导入语音模型') || (msg.includes('model') && msg.includes('导入'))) {
        setGuideVisible(true)
        notify.warning(t('voiceInput.noModel'))
      } else {
        notifyFailure('voiceInput', err, `${t('voiceInput.failed')}：${msg}`)
      }
    } finally {
      finish()
    }
  }, [finish, language, t])

  const startRecording = useCallback(async (): Promise<void> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'
      const recorder = new MediaRecorder(stream, { mimeType: mime })
      chunksRef.current = []
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      recorderRef.current = recorder
      streamRef.current = stream
      recorder.start()
      setPhaseSafe('recording')
      setSeconds(0)
      timerRef.current = setInterval(() => {
        setSeconds((s) => s + 1)
      }, 1000)
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      cleanup()
      setPhaseSafe('idle')
      if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
        notifyFailure('voiceInput', err, t('voiceInput.permissionDenied'))
      } else if (err.name === 'NotFoundError' || err.name === 'NotReadableError') {
        notifyFailure('voiceInput', err, t('voiceInput.noMicrophone'))
      } else {
        notifyFailure('voiceInput', err, `${t('voiceInput.failed')}：${err.message}`)
      }
    }
  }, [cleanup, t])

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

  const stop = useCallback((): void => {
    if (phaseRef.current === 'recording') void transcribe()
  }, [transcribe])

  const cancel = useCallback((): void => {
    if (phaseRef.current === 'idle') return
    cancelledRef.current = true
    finish()
  }, [finish])

  // Esc 取消录音（只在 recording 态拦——转写中 Esc 不打扰）
  useEffect(() => {
    if (phase !== 'recording') return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        cancel()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [phase, cancel])

  // 卸载兜底：录音流必须跟着组件走（不然麦克风常亮）
  useEffect(() => () => cleanup(), [cleanup])

  const onTranscribed = useCallback((handler: (text: string) => void): void => {
    transcribedHandlerRef.current = handler
  }, [])

  return {
    state: { phase, seconds, guideVisible, modelInstalled },
    start,
    stop,
    cancel,
    dismissGuide: () => setGuideVisible(false),
    onTranscribed,
  }
}
