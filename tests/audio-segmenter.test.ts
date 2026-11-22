import { describe, expect, it } from 'vitest'
import { createSegmenter, frameRms } from '../src/renderer/src/utils/audio-segmenter'

const FRAME = 1600 // 100ms @ 16k，与 worklet 默认 batchFrames 一致

/** 造一帧：fill 决定 RMS（0 = 静音，0.1 = 说话） */
function frame(fill: number, length = FRAME): Float32Array {
  return new Float32Array(length).fill(fill)
}

const speak = (): Float32Array => frame(0.1)
const quiet = (): Float32Array => frame(0)

function pushAll(seg: ReturnType<typeof createSegmenter>, frames: Float32Array[]): Float32Array[] {
  const out: Float32Array[] = []
  for (const f of frames) out.push(...seg.push(f))
  return out
}

describe('frameRms', () => {
  it('静音帧 RMS 为 0，说话帧接近填充值', () => {
    expect(frameRms(quiet())).toBe(0)
    expect(frameRms(speak())).toBeCloseTo(0.1, 5)
  })

  it('空帧返回 0 而不是 NaN', () => {
    expect(frameRms(new Float32Array(0))).toBe(0)
  })
})

describe('audio-segmenter 切段', () => {
  it('空帧被忽略', () => {
    const seg = createSegmenter()
    expect(seg.push(new Float32Array(0))).toEqual([])
    expect(seg.pendingSamples()).toBe(0)
  })

  it('开头静音不触发切段（还没开始说话）', () => {
    const seg = createSegmenter()
    // 20 帧纯静音 = 2s，远超 silenceMs，但 voiced 为 false，不该切
    expect(pushAll(seg, Array.from({ length: 20 }, quiet))).toEqual([])
    expect(seg.flush()).toBeNull()
  })

  it('说话 + 尾部静音达阈值 → 切段，且尾部静音被裁掉', () => {
    const seg = createSegmenter()
    // 1 帧说话(100ms) + 7 帧静音(700ms) = 800ms 恰好够 minSegmentMs
    const out = pushAll(seg, [speak(), ...Array.from({ length: 7 }, quiet)])
    expect(out).toHaveLength(1)
    // 只保留说话那一帧，尾部 700ms 静音不送去识别
    expect(out[0].length).toBe(FRAME)
  })

  it('段长不足 minSegmentMs 时不切（防咳嗽/碰麦成段）', () => {
    const seg = createSegmenter()
    // 半帧说话(50ms) + 6 帧静音(600ms)：尾部静音已超 550ms，但总长 650ms < 800ms
    const out = pushAll(seg, [frame(0.1, 800), ...Array.from({ length: 6 }, quiet)])
    expect(out).toEqual([])
    // 再来一帧说话，静音计数归零，依旧不切
    expect(seg.push(speak())).toEqual([])
  })

  it('一口气说不歇 → 达到 maxSegmentMs 强切', () => {
    const seg = createSegmenter()
    const frames = Array.from({ length: 79 }, speak) // 7.9s
    expect(pushAll(seg, frames)).toEqual([])
    const out = seg.push(speak()) // 第 80 帧 = 8.0s
    expect(out).toHaveLength(1)
    expect(out[0].length).toBe(16000 * 8)
  })

  it('连续两句各自成段', () => {
    const seg = createSegmenter()
    const out = pushAll(seg, [
      speak(),
      ...Array.from({ length: 7 }, quiet),
      speak(),
      ...Array.from({ length: 7 }, quiet),
    ])
    expect(out).toHaveLength(2)
    expect(out[0].length).toBe(FRAME)
    expect(out[1].length).toBe(FRAME)
  })

  it('自定义阈值生效', () => {
    // 把静音阈值调到 200ms：说话 1 帧 + 静音 2 帧(200ms) 就切（总长 300ms ≥ 默认 min 800ms？不够）
    const seg = createSegmenter({ silenceMs: 200, minSegmentMs: 300 })
    const out = pushAll(seg, [speak(), quiet(), quiet()])
    expect(out).toHaveLength(1)
  })
})

describe('audio-segmenter flush', () => {
  it('用户按停：说过话就尽量给出残余（不受 minSegmentMs 限制）', () => {
    const seg = createSegmenter()
    // 2 帧说话 = 200ms，远低于 minSegmentMs(800)，但 flush 阈值是 200ms
    seg.push(speak())
    seg.push(speak())
    const rest = seg.flush()
    expect(rest).not.toBeNull()
    expect(rest?.length).toBe(FRAME * 2)
  })

  it('残余短于 flushMinMs 时丢弃', () => {
    const seg = createSegmenter()
    seg.push(speak()) // 100ms < flushMinMs 200ms
    expect(seg.flush()).toBeNull()
  })

  it('纯静音 flush 返回 null', () => {
    const seg = createSegmenter()
    pushAll(seg, Array.from({ length: 5 }, quiet))
    expect(seg.flush()).toBeNull()
  })

  it('flush 后状态清空，可继续录音', () => {
    const seg = createSegmenter()
    seg.push(speak())
    seg.push(speak())
    expect(seg.flush()).not.toBeNull()
    expect(seg.pendingSamples()).toBe(0)
    expect(seg.flush()).toBeNull()
  })

  it('reset 丢弃未成段的内容', () => {
    const seg = createSegmenter()
    seg.push(speak())
    seg.push(speak())
    seg.reset()
    expect(seg.pendingSamples()).toBe(0)
    expect(seg.flush()).toBeNull()
  })
})
