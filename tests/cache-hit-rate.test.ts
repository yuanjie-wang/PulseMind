// ── Prompt-cache hit rate 口径 ──
// The counting rules are the whole point of this module: a rate is only
// comparable across sessions (and against another harness's published figure)
// when sidecar traffic is excluded, requests are weighted by tokens rather than
// averaged, and an unreported request is not silently scored as a miss.
import { describe, expect, it } from 'vitest'
import {
  CACHE_HIT_RATE_MIN_SAMPLES,
  computeCacheHitRate,
} from '../src/shared/agent-session/cache-hit-rate'
import { sessionCacheHitRate } from '../src/shared/agent-session/message-stats'
import type { AgentMessage } from '../src/renderer/src/types/agent'

describe('computeCacheHitRate', () => {
  it('weights by tokens, not by request count', () => {
    // 200 tokens at 0% + 60_000 tokens at 90% is ~89.7%, never 45%.
    const rate = computeCacheHitRate([
      { inputTokens: 200, cacheReadTokens: 0 },
      { inputTokens: 60_000, cacheReadTokens: 54_000 },
    ])
    expect(rate.inputTokens).toBe(60_200)
    expect(rate.cacheReadTokens).toBe(54_000)
    expect(rate.hitRate).toBeCloseTo(54_000 / 60_200, 10)
    expect(rate.requestCount).toBe(2)
  })

  it('excludes sidecar traffic from the denominator', () => {
    const rate = computeCacheHitRate([
      { inputTokens: 50_000, cacheReadTokens: 45_000 },
      // A compaction summary: one-shot prompt, no stable prefix, can never hit.
      { inputTokens: 40_000, cacheReadTokens: 0, sidecar: true },
    ])
    expect(rate.requestCount).toBe(1)
    expect(rate.inputTokens).toBe(50_000)
    expect(rate.hitRate).toBe(0.9)
  })

  it('skips an unreported request instead of scoring it as a miss', () => {
    const rate = computeCacheHitRate([
      { inputTokens: 10_000, cacheReadTokens: 8_000 },
      { inputTokens: undefined, cacheReadTokens: undefined },
      { inputTokens: 0, cacheReadTokens: 0 },
    ])
    expect(rate.requestCount).toBe(1)
    expect(rate.hitRate).toBe(0.8)
  })

  // Reversed 2026-11-14. This originally asserted that an absent cache read is
  // scored as a miss. That is wrong for both sources that actually produce the
  // hole — rows persisted before the 2026-10-25 `cached_tokens` migration
  // (f653b3b) rehydrate with the field absent, and providers with no cache
  // accounting never set it — because 0% is not a diagnosis, it is a fabricated
  // one, and it passes the sample floor so `reliable` then certifies it.
  // PRESENCE separates the two cases; value does not.
  it('skips a request whose cache read was never recorded, but keeps a reported 0 as a miss', () => {
    const rate = computeCacheHitRate([
      { inputTokens: 10_000, cacheReadTokens: 9_000 },
      { inputTokens: 10_000 }, // cache figure absent — missing data, not a miss
      { inputTokens: 10_000, cacheReadTokens: 0 }, // a cold miss the provider DID report
    ])
    expect(rate.requestCount).toBe(2)
    expect(rate.inputTokens).toBe(20_000)
    expect(rate.cacheReadTokens).toBe(9_000)
    expect(rate.hitRate).toBe(0.45)
  })

  it('scores a corrupt negative cache read as a miss rather than dropping the request', () => {
    // Unlike an absent field, a negative is one bad response from a provider
    // that DOES report the field — the prompt was still billed, so the request
    // stays in the denominator instead of vanishing from it.
    const rate = computeCacheHitRate([{ inputTokens: 1_000, cacheReadTokens: -5 }])
    expect(rate.requestCount).toBe(1)
    expect(rate.cacheReadTokens).toBe(0)
    expect(rate.hitRate).toBe(0)
  })

  it('clamps a cache read larger than the prompt', () => {
    // A gateway reporting nonsense must not push the rate past 1.
    const rate = computeCacheHitRate([{ inputTokens: 1_000, cacheReadTokens: 5_000 }])
    expect(rate.cacheReadTokens).toBe(1_000)
    expect(rate.hitRate).toBe(1)
  })

  it('reports zero and marks itself unreliable when nothing was counted', () => {
    const rate = computeCacheHitRate([])
    expect(rate).toEqual({ hitRate: 0, reliable: false, requestCount: 0, inputTokens: 0, cacheReadTokens: 0 })
  })

  it('only claims reliability past the sample floor', () => {
    const samples = (n: number) => Array.from({ length: n }, () => ({ inputTokens: 1_000, cacheReadTokens: 500 }))
    expect(computeCacheHitRate(samples(CACHE_HIT_RATE_MIN_SAMPLES - 1)).reliable).toBe(false)
    expect(computeCacheHitRate(samples(CACHE_HIT_RATE_MIN_SAMPLES)).reliable).toBe(true)
  })
})

describe('sessionCacheHitRate', () => {
  const msg = (over: Partial<AgentMessage>): AgentMessage => ({
    id: 'm',
    role: 'assistant',
    contentBlocks: [],
    createdAt: '2026-11-14T00:00:00.000Z',
    ...over,
  })

  it('counts assistant turns and drops synthesized summaries as sidecar', () => {
    const rate = sessionCacheHitRate([
      msg({ id: 'a', inputTokens: 20_000, promptCacheHitTokens: 15_000 }),
      msg({ id: 'b', inputTokens: 10_000, promptCacheHitTokens: 9_000 }),
      // The compactor's own summary message — never a main-turn request.
      msg({ id: 's', inputTokens: 30_000, promptCacheHitTokens: 0, autoSummary: true }),
      // A message whose stats the engine never reported.
      msg({ id: 'c' }),
    ])
    expect(rate.requestCount).toBe(2)
    expect(rate.inputTokens).toBe(30_000)
    expect(rate.cacheReadTokens).toBe(24_000)
    expect(rate.hitRate).toBe(0.8)
  })

  // The regression this whole split exists for: a session carried over from
  // before the `cached_tokens` migration (2026-10-25, f653b3b). Every row has a
  // prompt size and no cache column, so the previous rule scored the entire
  // session at 0% — and with enough rows it cleared the sample floor, so the
  // ring would have shown a confident 「0% 命中」 for a history whose cache
  // behaviour it simply cannot see.
  it('reports no samples for a pre-migration session instead of a confident 0%', () => {
    const legacy = Array.from({ length: 8 }, (_, i) => msg({ id: `old${i}`, inputTokens: 50_000 }))
    const rate = sessionCacheHitRate(legacy)
    expect(rate.requestCount).toBe(0)
    expect(rate.inputTokens).toBe(0)
    expect(rate.reliable).toBe(false)
  })

  it('does not let unreadable legacy rows dilute a session that also has real data', () => {
    const rate = sessionCacheHitRate([
      msg({ id: 'old', inputTokens: 400_000 }), // pre-migration: no cache column
      msg({ id: 'new', inputTokens: 20_000, promptCacheHitTokens: 16_000 }),
    ])
    // 80% over the one readable request — not 3.8% over 420k prompt tokens.
    expect(rate.requestCount).toBe(1)
    expect(rate.inputTokens).toBe(20_000)
    expect(rate.hitRate).toBe(0.8)
  })
})
