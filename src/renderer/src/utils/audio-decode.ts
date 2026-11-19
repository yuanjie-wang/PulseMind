/**
 * 语音输入的音频前端纯函数（PLAN-voice-input §3.1）。
 *
 * MediaRecorder 产出的是 webm/opus 容器（浏览器只有它是通用的录音形态），
 * 引擎要的是 16k 单声道 Float32 PCM——解码（decodeAudioData）之外的两步
 * （下混、重采样）抽成纯函数，vitest 可直接覆盖；decodeAudioData 本身需要
 * AudioContext，只能探针/E2E 层面验证。
 *
 * 全程内存态，不落盘——转写结束即释放（音频是会话内容，沙箱纪律同样适用）。
 */

/** 多声道下混为单声道（等权平均）。单声道输入原样返回（避免多余拷贝）。 */
export function downmixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0)
  if (channels.length === 1) return channels[0]
  const len = channels[0].length
  const out = new Float32Array(len)
  const n = channels.length
  for (let i = 0; i < len; i++) {
    let acc = 0
    for (let c = 0; c < n; c++) acc += channels[c][i] ?? 0
    out[i] = acc / n
  }
  return out
}

/**
 * 线性插值重采样。16k 是 ASR 的输入契约（sherpa fbank 特征提取的采样率）。
 * 线性插值对语音质量足够（8k→16k 上采样或 44.1k/48k→16k 下采样，实时听写
 * 不是音频工程）；反混叠滤波在这里是过度设计——opus 解码后的语音带宽本就
 * 被 16k 上限框住。
 */
export function resampleLinear(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || samples.length === 0) return samples
  const ratio = toRate / fromRate
  const outLen = Math.max(1, Math.round(samples.length * ratio))
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const src = i / ratio
    const i0 = Math.floor(src)
    const i1 = Math.min(samples.length - 1, i0 + 1)
    const frac = src - i0
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac
  }
  return out
}

export interface Mono16k {
  samples: Float32Array
  sampleRate: 16000
}

/**
 * 解码一段录音 blob（webm/opus）→ 16k 单声道 Float32。
 * AudioContext 只在解码这一步借用（免 JND 细节：采样率参数只影响
 * decodeAudioData 的默认重采样目标，我们随后自己重采样到 16k）。
 */
export async function decodeToMono16k(data: ArrayBuffer): Promise<Mono16k> {
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctx) throw new Error('当前环境不支持音频解码（AudioContext 缺失）')
  const ctx = new Ctx()
  try {
    const buf = await ctx.decodeAudioData(data)
    const channels: Float32Array[] = []
    for (let c = 0; c < buf.numberOfChannels; c++) channels.push(buf.getChannelData(c))
    const mono = downmixToMono(channels)
    const samples = resampleLinear(mono, buf.sampleRate, 16000)
    return { samples, sampleRate: 16000 }
  } finally {
    void ctx.close()
  }
}
