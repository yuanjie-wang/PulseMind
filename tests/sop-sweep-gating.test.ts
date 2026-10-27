import { describe, expect, it } from 'vitest'
import {
  judgeSopCandidate,
  sortBySopPriority,
  SOP_MAX_ATTEMPTS,
  SOP_RECURRENCE_MIN,
  SOP_RETRY_MS,
  SOP_SWEEP_BATCH,
} from '../src/shared/sop-sweep'

/** SOP 自动清扫资格门（PLAN-experience-sop 刀四）：recurrence 资格 / 24h 退避 /
 *  3 次退役 / use_count 优先排序。DB 接线由 probe-sop-distill.mjs 驱动真库验证。 */

const base = {
  maturity: 'clue',
  recurrence: SOP_RECURRENCE_MIN,
  attempts: 0,
  lastAttemptAt: null as number | null,
}
const NOW = 1_800_000_000_000

describe('judgeSopCandidate 资格矩阵', () => {
  it('资格齐备 → distill', () => {
    expect(judgeSopCandidate(base, NOW)).toBe('distill')
  })
  it('maturity=sop → skip（已是产物，compile pass 也不碰）', () => {
    expect(judgeSopCandidate({ ...base, maturity: 'sop' }, NOW)).toBe('skip-maturity')
  })
  it(`recurrence < ${SOP_RECURRENCE_MIN} → skip（信号还没攒够）`, () => {
    expect(judgeSopCandidate({ ...base, recurrence: 0 }, NOW)).toBe('skip-recurrence')
    expect(judgeSopCandidate({ ...base, recurrence: 1 }, NOW)).toBe('skip-recurrence')
  })
  it('24h 退避窗内 → skip；窗外 → distill', () => {
    const recent = judgeSopCandidate({ ...base, lastAttemptAt: NOW - SOP_RETRY_MS + 60_000 }, NOW)
    const stale = judgeSopCandidate({ ...base, lastAttemptAt: NOW - SOP_RETRY_MS - 60_000 }, NOW)
    expect(recent).toBe('skip-backoff')
    expect(stale).toBe('distill')
  })
  it(`${SOP_MAX_ATTEMPTS} 次失败退役——退避窗与 recurrence 都不再救`, () => {
    const retired = { ...base, attempts: SOP_MAX_ATTEMPTS, lastAttemptAt: NOW - 10 * SOP_RETRY_MS }
    expect(judgeSopCandidate(retired, NOW)).toBe('skip-retired')
    // 退役先于退避判定（顺序即语义）
    expect(judgeSopCandidate({ ...retired, recurrence: 99 }, NOW)).toBe('skip-retired')
  })
  it('门限可注入（测试/调参面）', () => {
    expect(judgeSopCandidate({ ...base, recurrence: 1 }, NOW, { recurrenceMin: 1 })).toBe('distill')
    expect(judgeSopCandidate({ ...base, lastAttemptAt: NOW - 60_000 }, NOW, { retryMs: 30_000 })).toBe('distill')
  })
})

describe('sortBySopPriority：使用侧优先', () => {
  const page = (over: Partial<{ useCount: number; recurrence: number; updatedAt: string }>) => ({
    useCount: 0, recurrence: 0, updatedAt: '2026-10-01T00:00:00.000Z', ...over,
  })
  it('use_count 高者优先；平手看 recurrence；再平手看新者', () => {
    const sorted = sortBySopPriority([
      page({ useCount: 3, updatedAt: '2026-10-01' }),
      page({ useCount: 9, recurrence: 1, updatedAt: '2026-10-01' }),
      page({ useCount: 9, recurrence: 5, updatedAt: '2026-10-01' }),
      page({ useCount: 9, recurrence: 5, updatedAt: '2026-10-09' }),
    ])
    expect(sorted.map((p) => [p.useCount, p.recurrence, p.updatedAt])).toEqual([
      [9, 5, '2026-10-09'],
      [9, 5, '2026-10-01'],
      [9, 1, '2026-10-01'],
      [3, 0, '2026-10-01'],
    ])
  })
  it('不改输入数组', () => {
    const input = [page({ useCount: 1 }), page({ useCount: 5 })]
    sortBySopPriority(input)
    expect(input[0].useCount).toBe(1)
  })
})

describe('接线（DB 行为见 probe-sop-distill.mjs）', () => {
  it('批帽为 2（每轮派发上限）', () => {
    expect(SOP_SWEEP_BATCH).toBe(2)
  })
})
