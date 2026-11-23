// ── 录音声波的电平映射契约 ──
// frameLevel 是纯函数（无 DOM/React 依赖），直接 import 真实现，不复制算法。
// 钉住三件事：静音落 0、正常说话铺得开、大声截断不越界。增益系数是视觉调参，
// 但「单调 + 有界 + 静音为 0」是波形不糊、不爆、静默时收得住的硬约束。

import { describe, it, expect } from 'vitest'
import { frameLevel } from '../src/renderer/src/components/chat/VoiceWaveform'

/** 造一帧定幅正弦，amplitude 即峰值。 */
function tone(amplitude: number, n = 1600): Float32Array {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * i) / 40)
  return out
}

describe('frameLevel（声波电平映射）', () => {
  it('静音帧 → 0', () => {
    expect(frameLevel(new Float32Array(1600))).toBe(0)
  })

  it('正常说话幅度（RMS≈0.07）落在中段，不贴地也不封顶', () => {
    // 正弦 RMS = amplitude/√2；取 amplitude 0.1 → RMS≈0.0707，×8≈0.566
    const level = frameLevel(tone(0.1))
    expect(level).toBeGreaterThan(0.4)
    expect(level).toBeLessThan(0.8)
  })

  it('电平随幅度单调递增', () => {
    const quiet = frameLevel(tone(0.02))
    const mid = frameLevel(tone(0.1))
    const loud = frameLevel(tone(0.3))
    expect(quiet).toBeLessThan(mid)
    expect(mid).toBeLessThan(loud)
  })

  it('满幅帧截断到 1，绝不越界（绘制高度乘以它，越界会画出容器）', () => {
    expect(frameLevel(tone(1))).toBe(1)
    expect(frameLevel(tone(0.5))).toBeLessThanOrEqual(1)
  })

  it('增益可调：同帧下 gain 越大电平越高', () => {
    const frame = tone(0.05)
    expect(frameLevel(frame, 8)).toBeGreaterThan(frameLevel(frame, 4))
  })
})
