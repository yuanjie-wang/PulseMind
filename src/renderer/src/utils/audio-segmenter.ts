/**
 * 音频分段器（B 方案：分段落准实时转写，PLAN-voice-input / 2026-11-22 方案变更）。
 *
 * 纯函数、无副作用、不碰 Web Audio —— 只有一个职责：把 worklet 源源不断送来的
 * 16k 单声道帧流，按「说话/静音」切成可以被离线模型逐段识别的片段。
 *
 * 为什么需要它：SenseVoice 是非流式模型（现有清单里只有 model.int8.onnx），
 * 没法增量出字。所以「准实时」的做法是——按自然停顿切段，每段独立送现有
 * transcribe 通道，转完就追加。段切得好不好，直接决定体验。
 *
 * 切段规则（三条，缺一不可）：
 *   1. 尾部静音 ≥ silenceMs 且段长 ≥ minSegmentMs → 正常切段
 *   2. 段长 ≥ maxSegmentMs → 强切（用户一口气说不歇，不能无限等）
 *   3. 段长 < minSegmentMs → 不切（咳嗽、碰麦、单字噪声不该成为一段）
 *
 * 停止时用 flush() 取残余，阈值放宽到 flushMinMs —— 用户已经明确按停了，
 * 哪怕只说了两个字也该给出来，不能因为不够 minSegmentMs 就吞掉。
 */

export interface SegmenterOptions {
  /** 采样率，与 AudioContext 一致（默认 16000） */
  sampleRate?: number
  /** 单帧时长（worklet 每 100ms 投递一次，默认 100） */
  frameMs?: number
  /** 静音达到多久算一句话说完了 */
  silenceMs?: number
  /** 切段的最小段长（防碎片） */
  minSegmentMs?: number
  /** 强制切段的最大段长（防长句无限等） */
  maxSegmentMs?: number
  /** 静音判定：一帧 RMS 低于此值算静音 */
  silenceRms?: number
  /** flush 时的最小段长（比 minSegmentMs 宽松） */
  flushMinMs?: number
}

export interface Segmenter {
  /** 送入一帧；返回本次切出的完整段（可能 0 段，也可能多段） */
  push: (frame: Float32Array) => Float32Array[]
  /** 停止时取残余；没有可用的内容返回 null */
  flush: () => Float32Array | null
  /** 丢弃全部中间状态（取消录音时用） */
  reset: () => void
  /** 当前段已累积的采样数（调试/诊断用） */
  pendingSamples: () => number
}

interface Frame {
  data: Float32Array
  silent: boolean
}

const DEFAULTS = {
  sampleRate: 16000,
  frameMs: 100,
  silenceMs: 550,
  minSegmentMs: 800,
  maxSegmentMs: 8000,
  // 16k 单声道语音的静音底噪通常 <0.005，正常说话 >0.02；0.008 留了余量。
  // 这是经验值，真机上若发现「一直不切段」或「静音被当说话」，先调这个。
  silenceRms: 0.008,
  flushMinMs: 200,
}

/** 一帧的均方根（RMS），用于判断这一帧是静音还是说话 */
export function frameRms(frame: Float32Array): number {
  if (frame.length === 0) return 0
  let sum = 0
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
  return Math.sqrt(sum / frame.length)
}

function concat(frames: Float32Array[]): Float32Array {
  let total = 0
  for (const f of frames) total += f.length
  const out = new Float32Array(total)
  let at = 0
  for (const f of frames) {
    out.set(f, at)
    at += f.length
  }
  return out
}

export function createSegmenter(options: SegmenterOptions = {}): Segmenter {
  const o = { ...DEFAULTS, ...options }
  const msToSamples = (ms: number): number => Math.round((ms / 1000) * o.sampleRate)
  const silenceSamples = msToSamples(o.silenceMs)
  const minSamples = msToSamples(o.minSegmentMs)
  const maxSamples = msToSamples(o.maxSegmentMs)
  const flushMinSamples = msToSamples(o.flushMinMs)

  let frames: Frame[] = []
  let totalSamples = 0
  /** 段尾连续静音的采样数 */
  let trailingSilence = 0
  /** 是否出现过说话帧（全是静音的段 flush 时要丢掉） */
  let voiced = false

  const reset = (): void => {
    frames = []
    totalSamples = 0
    trailingSilence = 0
    voiced = false
  }

  /** 取走当前段：裁掉尾部静音，返回采样 */
  const take = (): Float32Array | null => {
    let end = frames.length
    // 尾部静音对识别没有贡献，白烧推理时间，裁掉
    while (end > 0 && frames[end - 1].silent) end--
    if (end === 0) {
      reset()
      return null
    }
    const out = concat(frames.slice(0, end).map((f) => f.data))
    reset()
    return out
  }

  const push = (frame: Float32Array): Float32Array[] => {
    if (frame.length === 0) return []
    const silent = frameRms(frame) < o.silenceRms
    frames.push({ data: frame, silent })
    totalSamples += frame.length
    if (silent) {
      trailingSilence += frame.length
      // 只有「说话之后又静下来」才算一句话结束；开头一段静音不该触发切段
      if (voiced && trailingSilence >= silenceSamples && totalSamples >= minSamples) {
        const seg = take()
        return seg ? [seg] : []
      }
    } else {
      voiced = true
      trailingSilence = 0
    }
    // 强切：一口气说不歇也要出字，切点只能接受落在词中间
    if (totalSamples >= maxSamples) {
      const seg = take()
      return seg ? [seg] : []
    }
    return []
  }

  const flush = (): Float32Array | null => {
    // 用户已经按停：没说过话（纯静音）才丢弃，说过话就尽量给出来
    if (!voiced || totalSamples < flushMinSamples) {
      reset()
      return null
    }
    return take()
  }

  return { push, flush, reset, pendingSamples: () => totalSamples }
}
