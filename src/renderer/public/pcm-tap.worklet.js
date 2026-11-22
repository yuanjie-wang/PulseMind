/* global AudioWorkletProcessor, registerProcessor */
/**
 * PCM 采集 worklet（B 方案实时分段的采集端）。
 *
 * 为什么必须放在 public/ 下、用相对路径加载，而不是 URL.createObjectURL：
 *   生产态渲染进程是 file:// origin，CSP 为 `script-src 'self'`，没有 worker-src。
 *   2026-11-22 用真实 Electron 33 + 生产 webPreferences 实测：
 *     addModule('./pcm-tap.worklet.js')  → ok
 *     addModule(file:// 绝对路径)          → ok
 *     addModule(blob: URL)               → FAIL「The user aborted a request.」（CSP 拦）
 *   所以这个文件是 public/ 下的真实静态资源（同 platform-boot.js 的既定做法），
 *   改动加载方式前请先重跑 .pulsemind/tmp/worklet-poc 的探针。
 *
 * 采样率由 AudioContext({ sampleRate: 16000 }) 保证，处理器内不做重采样。
 * 攒满一帧批量（默认 1600 采样 = 100ms）向主线程投递一次，降低 IPC 频率。
 */
class PcmTap extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const opt = (options && options.processorOptions) || {}
    this.batchFrames = Math.max(128, Math.floor(opt.batchFrames || 1600))
    // 复用同一块缓冲，投递时 slice 复制——直接 post 会把后续写入带过去
    this.buf = new Float32Array(this.batchFrames)
    this.filled = 0
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true
    for (let i = 0; i < channel.length; i++) {
      this.buf[this.filled++] = channel[i]
      if (this.filled === this.batchFrames) {
        this.port.postMessage(this.buf.slice(0, this.filled))
        this.filled = 0
      }
    }
    return true
  }
}

registerProcessor('pm-pcm-tap', PcmTap)
