// Refill 断路器（PLAN-context-zcode-benchmarks P1，2026-09-29）。
// 病灶防区：fit-based light/hard 丢弃后，若副本在 <3 个工具轮内再次越线
// （某个大文件/大输出每轮被完整重读），摘要增量每个请求都扩、字节持续抖动
// 还烧 LLM 调用。断路器：连续 3 次 fast-refill → 摘要吸收挂起；节奏正常化
// 自动解除。只停摘要——nano/light/hard/emergency 零 LLM 且承溢出安全，不停。
import { describe, expect, it, vi } from 'vitest'
import {
  evaluateRefillBreaker,
  makeCompactTracking,
  REFILL_BREAKER_LIMIT,
  REFILL_TOOL_TURN_THRESHOLD,
  ContextCompactor,
} from '../src/renderer/src/agent/engine/context-compactor'
import type { AgentMessage, ContentBlock } from '../src/renderer/src/types/agent'

const AT = '2026-09-29T00:00:00.000Z'
const text = (t: string): ContentBlock => ({ type: 'text', text: t })

describe('evaluateRefillBreaker: pure transition', () => {
  it('a drop within the threshold is a refill; three in a row trip the breaker exactly once', () => {
    const t = makeCompactTracking()
    // drop #1 arrives with the clock at 0 rounds (< 3)
    expect(evaluateRefillBreaker(t, 0, true).transitionedToSuspended).toBe(false)
    expect(t.consecutiveRefills).toBe(1)
    expect(t.toolRoundsSinceDrop).toBe(0) // the drop restarts the clock
    // simulate two tool rounds, then drop #2
    t.toolRoundsSinceDrop += 2
    expect(evaluateRefillBreaker(t, 2, true).transitionedToSuspended).toBe(false)
    expect(t.consecutiveRefills).toBe(2)
    // two more rounds, drop #3 → trips exactly once
    t.toolRoundsSinceDrop += 2
    expect(evaluateRefillBreaker(t, 2, true).transitionedToSuspended).toBe(true)
    expect(t.summarySuspended).toBe(true)
    // a 4th refill does NOT re-report the transition (no duplicate events)
    t.toolRoundsSinceDrop += 1
    expect(evaluateRefillBreaker(t, 1, true).transitionedToSuspended).toBe(false)
    expect(t.summarySuspended).toBe(true)
    expect(REFILL_BREAKER_LIMIT).toBe(3)
    expect(REFILL_TOOL_TURN_THRESHOLD).toBe(3)
  })

  it('a drop arriving after enough tool rounds resets the counter and lifts the suspension', () => {
    const t = makeCompactTracking()
    t.consecutiveRefills = 2
    t.summarySuspended = false
    // rhythm normalized: 5 tool rounds passed, then a drop
    expect(evaluateRefillBreaker(t, 5, true).transitionedToSuspended).toBe(false)
    expect(t.consecutiveRefills).toBe(0)
    expect(t.summarySuspended).toBe(false)
  })

  it('a quiet pass with normalized rhythm lifts the suspension WITHOUT needing a drop', () => {
    const t = makeCompactTracking()
    t.summarySuspended = true
    t.consecutiveRefills = 3
    t.toolRoundsSinceDrop = 4 // ≥ threshold rounds since the last drop
    evaluateRefillBreaker(t, 4, false)
    expect(t.summarySuspended).toBe(false)
    expect(t.consecutiveRefills).toBe(0)
  })

  it('quiet passes below the threshold preserve the accumulating refill state', () => {
    const t = makeCompactTracking()
    t.consecutiveRefills = 2
    t.toolRoundsSinceDrop = 1
    evaluateRefillBreaker(t, 1, false) // no drop, still within the hot window
    expect(t.consecutiveRefills).toBe(2) // untouched
    expect(t.summarySuspended).toBe(false)
  })

  it('an emergency-only drop re-bases the round clock but never counts as a refill', () => {
    const t = makeCompactTracking()
    t.consecutiveRefills = 2 // one more fast refill would trip
    t.toolRoundsSinceDrop = 1
    // droppedFit=false, droppedAny=true (the emergency branch)
    expect(evaluateRefillBreaker(t, 1, false, true).transitionedToSuspended).toBe(false)
    expect(t.consecutiveRefills).toBe(2) // not a refill signal
    expect(t.toolRoundsSinceDrop).toBe(0) // but the clock re-bases
  })
})

// ── 与注入管线的集成：suspended 时摘要吸收停摆，账本不动 ──────────────

describe('suspended compactor: the summary absorption pauses, the ledger holds', () => {
  function build(n: number): AgentMessage[] {
    const msgs: AgentMessage[] = []
    for (let i = 0; i < n; i++) {
      msgs.push(
        { id: `ru${i}`, role: 'user', createdAt: AT, contentBlocks: [text(`用户指令 MARKER-${i}。` + '言'.repeat(2400))] },
        { id: `ra${i}`, role: 'assistant', createdAt: AT, contentBlocks: [text(`回复 MARKER-${i}。` + '述'.repeat(2400))] },
      )
    }
    return msgs
  }

  it('suspended: cached text rides as-is, uncovered slices are NOT absorbed, no LLM call', async () => {
    const msgs = build(20)
    const runHistorySummary = vi.fn(async () => '摘要内容')
    const compactor = new ContextCompactor({
      runHistorySummary,
      getMessages: () => msgs,
      isSummarySuspended: () => true, // breaker tripped before any cache existed
    })
    // Plain truncation while suspended with no cache — no call, no cache, and
    // the user replays STILL ride (P1 suspends summary absorption only; the
    // replays are not part of it).
    const final = await compactor.injectHistorySummary(msgs, msgs.slice(10))
    expect(runHistorySummary).not.toHaveBeenCalled()
    expect(compactor.getHistorySummary()).toBeNull()
    expect(compactor.lastInjectReplayCount).toBeGreaterThan(0)
    // The kept tail rides untouched after the replay block.
    expect(final.slice(final.length - 30)).toEqual(msgs.slice(10))
    expect(final.some((m) => (m.contentBlocks[0] as { text?: string }).text?.includes('【历史对话摘要】'))).toBe(false)
  })

  it('a cache built before suspension is reused verbatim; the lift absorbs the accrual in one call', async () => {
    const msgs = build(20)
    const runHistorySummary = vi.fn(async () => '摘要内容')
    let suspended = false
    const compactor = new ContextCompactor({
      runHistorySummary,
      getMessages: () => msgs,
      isSummarySuspended: () => suspended,
    })
    // Pass 1 (not suspended): builds the cache over a SMALL dropped region
    // (pairs 0-2). Each message enters the summary region capped at
    // SUMMARY_TEXT_CAP=2000 chars, so "enough to cross the accrual line" is
    // counted in capped units (~2K chars/message), not raw fixture sizes.
    await compactor.injectHistorySummary(msgs, msgs.slice(6))
    expect(runHistorySummary).toHaveBeenCalledTimes(1)
    const cached = compactor.getHistorySummary()

    // Pass 2 (suspended): the same text rides, no extension call, the ledger's
    // coverage does NOT grow — the new slice stays uncovered.
    suspended = true
    await compactor.injectHistorySummary(msgs, msgs.slice(15))
    expect(runHistorySummary).toHaveBeenCalledTimes(1)
    expect(compactor.getHistorySummary()).toEqual(cached)

    // Pass 3 (lifted): the rhythm normalized — one call absorbs the accrual
    // (9 uncovered messages ≈ 18K capped chars > the 12K line; the slice the
    // breaker sat on was never stamped covered).
    suspended = false
    await compactor.injectHistorySummary(msgs, msgs.slice(15))
    expect(runHistorySummary).toHaveBeenCalledTimes(2)
    const absorbed = runHistorySummary.mock.calls[1][0] as string
    expect(absorbed).toContain('MARKER-5') // the uncovered accrual, not the whole region
    expect(absorbed).not.toContain('MARKER-0') // the pass-1 coverage is not re-sent
  })
})
