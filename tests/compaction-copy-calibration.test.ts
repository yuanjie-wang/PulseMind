// copyCalibration 的收敛域（2026-11-22 回放之后放宽双端钳）。
//
// 取证 _review/review_20261122.md：两个真实会话的 `raw/wire` 合起来落在
// [0.42, 4.25]（主会话 p50 3.08、40/40 钉在旧钳 0.60 下限；第二会话 p50
// 0.74、13/40 钉在旧钳 1.60 上限且有 7/40 少报）。旧 [0.6, 1.6] 只能收敛
// raw/wire ∈ [0.625, 1.667]，两个方向都被真实内容击穿。
//
// 本组用真函数驱动 `setCopyCalibration` → `copyTokens`，钉的是：实测域内一次
// 回灌即收敛到 wire；域外仍限幅；非法读数不重置已学到的因子。常量本身也钉住
// 「覆盖实测域」，避免哪天把边界收窄回去而测试还在按比例断言。
import { describe, expect, it } from 'vitest'
import {
  ContextCompactor,
  COPY_CALIBRATION_MIN,
  COPY_CALIBRATION_MAX,
} from '../src/renderer/src/agent/engine/context-compactor'
import { copyTokensOf } from '../src/renderer/src/agent/engine/context-estimate'
import type { AgentMessage } from '../src/renderer/src/types/agent'

const AT = '2026-11-22T00:00:00.000Z'
/** 1 CJK char ≈ 1 token；240 chars 让 round() 的 ±1 误差可忽略。 */
const MSG: AgentMessage[] = [{
  id: 'u0', role: 'user', createdAt: AT,
  contentBlocks: [{ type: 'text', text: '文'.repeat(240) }],
}]

function compactor(): ContextCompactor {
  return new ContextCompactor({
    runHistorySummary: async () => '摘要',
    getMessages: () => MSG,
  })
}

/** One usage report against a request whose raw heuristic price was `raw`. */
function absorb(comp: ContextCompactor, raw: number, wire: number): void {
  // The engine computes the ratio from lastBuildCopyEstimate (= raw) and the
  // provider's measured wire; the compactor only ever sees their quotient.
  expect(raw).toBeGreaterThan(0)
  comp.setCopyCalibration(wire / raw)
}

describe('copyCalibration 边界覆盖实测域', () => {
  it('converges over the whole measured raw/wire range with margin', () => {
    // Measured extremes across both sessions (review_20261122.md §1).
    const measuredLow = 0.42
    const measuredHigh = 4.25
    expect(1 / COPY_CALIBRATION_MAX).toBeLessThanOrEqual(measuredLow)
    expect(1 / COPY_CALIBRATION_MIN).toBeGreaterThanOrEqual(measuredHigh)
    expect(COPY_CALIBRATION_MIN).toBeLessThan(0.6)   // both ends really widened
    expect(COPY_CALIBRATION_MAX).toBeGreaterThan(1.6)
  })
})

describe('setCopyCalibration → copyTokens（真函数，一轮回灌）', () => {
  // r = raw/wire. Both extremes broke the old clamp in OPPOSITE directions:
  // r=4.25 (raw over-reads → cut far too early), r=0.42 (raw under-reads →
  // D12's overflow direction).
  const cases: Array<{ r: number; label: string }> = [
    { r: 4.25, label: 'raw 高估上界（旧钳 0.60 下限）' },
    { r: 3.08, label: '主会话 p50' },
    { r: 1.0, label: '估计器准确' },
    { r: 0.74, label: '第二会话 p50' },
    { r: 0.42, label: 'raw 低估下界（旧钳 1.60 上限）' },
  ]

  for (const { r, label } of cases) {
    it(`${label}: raw/wire=${r} 一次回灌后 price ≈ wire`, () => {
      const comp = compactor()
      const raw = copyTokensOf(MSG)
      const wire = raw / r
      absorb(comp, raw, wire)

      expect(comp.copyCalibrationFactor).toBeCloseTo(wire / raw, 6)
      // ±1 is copyTokens' Math.round, not a residual clamp.
      expect(Math.abs(comp.copyTokens(MSG) - wire)).toBeLessThanOrEqual(1)
    })
  }

  it('a ratio outside the widened domain is still bounded, not dropped', () => {
    const comp = compactor()
    comp.setCopyCalibration(0.01)
    expect(comp.copyCalibrationFactor).toBe(COPY_CALIBRATION_MIN)
    comp.setCopyCalibration(100)
    expect(comp.copyCalibrationFactor).toBe(COPY_CALIBRATION_MAX)
  })

  it('a non-finite / non-positive report leaves the learned factor alone', () => {
    const comp = compactor()
    const raw = copyTokensOf(MSG)
    absorb(comp, raw, raw / 2)
    const learned = comp.copyCalibrationFactor
    expect(learned).toBeCloseTo(0.5, 6)

    for (const bad of [NaN, Infinity, -Infinity, 0, -1]) comp.setCopyCalibration(bad)
    expect(comp.copyCalibrationFactor).toBe(learned)
  })

  it('starts uncalibrated at 1 and re-learns in one round after an outlier', () => {
    const comp = compactor()
    expect(comp.copyCalibrationFactor).toBe(1)
    const raw = copyTokensOf(MSG)
    comp.setCopyCalibration(100)                       // one absurd report
    expect(comp.copyCalibrationFactor).toBe(COPY_CALIBRATION_MAX)
    absorb(comp, raw, raw / 3.08)                     // next request's usage
    expect(comp.copyCalibrationFactor).toBeCloseTo(1 / 3.08, 6)
  })
})
