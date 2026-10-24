// The shared context-size estimator (engine/context-estimate.ts) is the one
// contract both the compactor's trigger chain and the composer's ring read.
// The 0.4.1 report — "ring says 35%, model says overflow" after an 11-spawn
// batch — was exactly these two readers disagreeing: the ring returned the
// last request's raw inputTokens (the tail appended after it invisible), and
// the compactor's chars/3.5 estimate undercounted CJK ~3x. Both halves are
// pinned here.
import { describe, expect, it } from 'vitest'
import {
  contextTokensOf,
  estimateMessagesTokens,
  estimateTextTokens,
  requestTokensOf,
} from '../src/renderer/src/agent/engine/context-estimate'
import { ContextCompactor } from '../src/renderer/src/agent/engine/context-compactor'
import type { AgentMessage, ContentBlock } from '../src/renderer/src/types/agent'

let n = 0
const AT = '2026-09-22T00:00:00.000Z'

const textMsg = (role: 'user' | 'assistant', text: string, extra: Partial<AgentMessage> = {}): AgentMessage => ({
  id: `m${++n}`,
  role,
  contentBlocks: [{ type: 'text', text }] as ContentBlock[],
  createdAt: AT,
  ...extra
})

const useMsg = (id: string, name = 'read'): AgentMessage => ({
  id: `m${++n}`,
  role: 'assistant',
  contentBlocks: [{ type: 'tool_use', id, name, input: {} }] as ContentBlock[],
  createdAt: AT
})

const resultMsg = (toolUseId: string, content: string): AgentMessage => ({
  id: `m${++n}`,
  role: 'user',
  contentBlocks: [{ type: 'tool_result', tool_use_id: toolUseId, content }] as ContentBlock[],
  createdAt: AT
})

const round = (id: string, cjkChars: number): AgentMessage[] => [
  useMsg(id),
  resultMsg(id, '很'.repeat(cjkChars))
]

const makeCompactor = (messages: AgentMessage[]): ContextCompactor =>
  new ContextCompactor({ runHistorySummary: async () => '', getMessages: () => messages })

describe('estimateTextTokens', () => {
  it('counts CJK chars ~1:1 and the rest at 4 chars per token', () => {
    expect(estimateTextTokens('')).toBe(0)
    expect(estimateTextTokens('abcdefgh')).toBe(2) // 8 ascii → ceil(8/4)
    expect(estimateTextTokens('上下文长度超限')).toBe(7) // 7 CJK → 7
    expect(estimateTextTokens('abc上下')).toBe(3) // 2 CJK + ceil(3/4)
  })
})

describe('contextTokensOf', () => {
  it('with no real report, estimates and adds the fixed overhead', () => {
    const msgs = [textMsg('user', 'abcdefgh')]
    expect(contextTokensOf(msgs, 10)).toBe(12)
  })

  it('estimates the TAIL after the last real report — the spawn-batch blind spot', () => {
    // The request that dispatched the batch reported 1000 input tokens; the
    // 11 sub-agent reports landed AFTER it. The old ring returned 1000 flat;
    // the old chars/3.5 tail read 4000 CJK chars as ~1143.
    const msgs = [textMsg('assistant', 'ok', { inputTokens: 1000 }), resultMsg('t1', '很'.repeat(4000))]
    expect(contextTokensOf(msgs)).toBe(5000)
  })

  it('never reads smaller than the full-history estimate (stale report guard)', () => {
    const msgs = [textMsg('assistant', 'x', { inputTokens: 10 }), resultMsg('t1', '很'.repeat(4000))]
    // max(10 + 4000, 1 + 4000)
    expect(contextTokensOf(msgs)).toBe(4010)
  })

  it('outputTokens covers the whole completion — thinking and tool args are NOT added on top', () => {
    // conv_20260927170026 (2026-09-28): a thinking-only round reported
    // output_tokens=14242 for a 29.5k-char thinking block and zero text —
    // DeepSeek's completion report PRICES the reasoning. OpenAI details
    // reasoning_tokens as a breakdown of completion_tokens; Anthropic bills
    // thinking as output. The old per-block additions double-counted ~300k
    // tokens of thinking in that one conversation. The fixture's report sits
    // above the block price (103), the way an honest report must.
    const msg: AgentMessage = {
      id: 'm0', role: 'assistant', createdAt: AT,
      contentBlocks: [
        { type: 'text', text: 'hi' },
        { type: 'thinking', thinking: '很'.repeat(100) },
        { type: 'tool_use', id: 'u', name: 'read', input: {} }
      ] as ContentBlock[],
      outputTokens: 150
    }
    expect(estimateMessagesTokens([msg])).toBe(150)
    // Report-less messages still estimate block by block.
    const bare: AgentMessage = {
      id: 'm1', role: 'assistant', createdAt: AT,
      contentBlocks: [
        { type: 'thinking', thinking: '很'.repeat(100) },
        { type: 'tool_use', id: 'u', name: 'read', input: {} }
      ] as ContentBlock[]
    }
    expect(estimateMessagesTokens([bare])).toBe(100 + 2) // thinking + ceil(('{}'+read)/4)
  })

  it('a report that provably excludes its own content loses to the block floor', () => {
    // 模块11 replay (2026-09-30): the gateway's completion_tokens excludes
    // reasoning — 126 reported for blocks holding ~2K of thinking. The old
    // unconditional substitution blessed that report, the heuristic read
    // ~26K low over 50 rounds, and lightCompact's fit believed the copy
    // already fit while the real wire climbed to 161K. Below 1.5x the report
    // still wins (tokenizer variance), at 16x the blocks do.
    const blocks: ContentBlock[] = [
      { type: 'thinking', thinking: '很'.repeat(2000) },
      { type: 'tool_use', id: 'u', name: 'read', input: {} }
    ] as ContentBlock[]
    const stripped: AgentMessage = { id: 'm2', role: 'assistant', createdAt: AT, contentBlocks: blocks, outputTokens: 126 }
    expect(estimateMessagesTokens([stripped])).toBe(2002) // block floor, not 126
    // 1.5x 以内的汇报差仍是汇报赢（启发式读高是正常方差；2900 > 2002×1.5 不成立）
    const plausible: AgentMessage = { id: 'm3', role: 'assistant', createdAt: AT, contentBlocks: blocks, outputTokens: 2000 }
    expect(estimateMessagesTokens([plausible])).toBe(2000)
  })
})

describe('requestTokensOf (the ring)', () => {
  it('trusts the real report over the transcript heuristic — the 775K regression', () => {
    // conv_20260927170026 shape: the last request priced 88,128 real tokens,
    // but the append-only transcript estimates ~794k. contextTokensOf (the
    // compactor's trigger input) takes the transcript pressure; the ring must
    // not — it shows what the model actually sees.
    const msgs: AgentMessage[] = []
    for (let i = 0; i < 400; i++) msgs.push(...round(`u${i}`, 1800))
    const anchor = textMsg('assistant', 'done', { inputTokens: 88_128 })
    const full = [...msgs, anchor]
    expect(contextTokensOf(full)).toBeGreaterThan(500_000)
    expect(requestTokensOf(full)).toBe(88_128)
  })

  it('adds the tail appended since the report — the spawn-batch blind spot, ring side', () => {
    const msgs = [textMsg('assistant', 'ok', { inputTokens: 1000 }), resultMsg('t1', '很'.repeat(4000))]
    expect(requestTokensOf(msgs)).toBe(5000)
  })

  it('with no real report, estimates and adds the fixed overhead (fresh conversation)', () => {
    const msgs = [textMsg('user', 'abcdefgh')]
    expect(requestTokensOf(msgs, 10)).toBe(12)
  })
})

describe('compactor reads the same contract', () => {
  it('contextTokens/estimateTokens delegate to the shared estimator', () => {
    const msgs = [...round('a', 500), textMsg('assistant', 'done', { inputTokens: 4242 })]
    const compactor = makeCompactor(msgs)
    expect(compactor.contextTokens(msgs)).toBe(contextTokensOf(msgs))
    expect(compactor.estimateTokens(msgs)).toBe(estimateMessagesTokens(msgs))
  })

  it('lightCompact now fires on a CJK-heavy history the old chars/3.5 estimate blessed', () => {
    const msgs: AgentMessage[] = []
    for (let i = 0; i < 60; i++) msgs.push(...round(`u${i}`, 1000))
    // 60k CJK chars ≈ 60k real tokens; the old estimate read ~17k and left a
    // 64k window alone until the provider rejected the request.
    const compactor = makeCompactor(msgs)
    const compacted = compactor.lightCompact(msgs, 64_000, 0)
    expect(compacted.length).toBeLessThan(msgs.length)
  })

  it('hardTruncate now fires where the old estimate never did', () => {
    const msgs: AgentMessage[] = []
    for (let i = 0; i < 40; i++) msgs.push(...round(`h${i}`, 1500))
    const compactor = makeCompactor(msgs)
    const truncated = compactor.hardTruncate(msgs, 64_000, 0)
    expect(truncated.length).toBeLessThan(msgs.length)
  })
})

describe('emergencyTruncate', () => {
  it('is a no-op (same array) when the estimate already fits the named limit', () => {
    const msgs = [textMsg('user', 'abcdefgh')]
    const compactor = makeCompactor(msgs)
    expect(compactor.emergencyTruncate(msgs, 100_000, 0)).toBe(msgs)
  })

  it('drops oldest whole messages first and keeps tool_use↔tool_result pairing', () => {
    const msgs: AgentMessage[] = []
    for (let i = 0; i < 40; i++) msgs.push(...round(`d${i}`, 100)) // 40 rounds ≈ 4k tokens
    const compactor = makeCompactor(msgs)
    const result = compactor.emergencyTruncate(msgs, 5_000, 0) // target 3000
    expect(result.length).toBeLessThan(msgs.length)
    const useIds = new Set<string>()
    for (const m of result) {
      for (const b of m.contentBlocks) if (b.type === 'tool_use') useIds.add(b.id)
    }
    for (const m of result) {
      for (const b of m.contentBlocks) {
        if (b.type === 'tool_result') expect(useIds.has(b.tool_use_id)).toBe(true)
      }
    }
  })

  it('strips oldest tool_result bodies when the tail is unsplittable, newest survive intact', () => {
    const msgs: AgentMessage[] = []
    for (let i = 0; i < 5; i++) msgs.push(...round(`o${i}`, 100))
    // The collector message a wide spawn batch produces: one user message
    // carrying ten ~5k-token reports.
    msgs.push({
      id: 'm-ba', role: 'assistant', createdAt: AT,
      contentBlocks: Array.from({ length: 10 }, (_, i) => ({ type: 'tool_use' as const, id: `b${i}`, name: 'spawn_agent', input: {} }))
    })
    msgs.push({
      id: 'm-bu', role: 'user', createdAt: AT,
      contentBlocks: Array.from({ length: 10 }, (_, i) => ({ type: 'tool_result' as const, tool_use_id: `b${i}`, content: '很'.repeat(5000) }))
    })
    // ~50k tokens against a 45k limit → target 27k: ~7 of the 10 bodies must go.
    const compactor = makeCompactor(msgs)
    const result = compactor.emergencyTruncate(msgs, 45_000, 0)

    expect(contextTokensOf(result)).toBeLessThanOrEqual(27_000)
    const batch = result[result.length - 1].contentBlocks as Array<{ type: string; content?: string }>
    const stripped = batch.filter(b => (b.content ?? '').includes('tool_result_search'))
    const whole = batch.filter(b => b.content != null && (b.content as string).length === 5000)
    expect(stripped.length).toBeGreaterThan(0)
    expect(stripped.length + whole.length).toBe(10)
    expect(whole.length).toBeGreaterThan(0) // the newest reports survive verbatim
    // Pairing untouched: every result still names its tool_use_id.
    for (const b of result[result.length - 1].contentBlocks) {
      if (b.type === 'tool_result') expect((b as { tool_use_id: string }).tool_use_id).toMatch(/^b\d$/)
    }
  })

  it('returns the input untouched for an empty list or a nonsense limit', () => {
    const msgs: AgentMessage[] = []
    const compactor = makeCompactor(msgs)
    expect(compactor.emergencyTruncate(msgs, 5_000, 0)).toBe(msgs)
    expect(compactor.emergencyTruncate([textMsg('user', 'hi')], 0, 0)).toHaveLength(1)
  })
})

// ── fitKeepStart retention semantics (0.4.2「压缩机制不触发」修复) ──
// The old walk broke on the first fit and DECREMENTED on a miss; since a
// smaller keepStart only grows the tail, the walk was bimodal — the guard
// floor fitting → cut to the floor (~10 messages against a 0.9× window of
// headroom), it not fitting → keepStart ran to 0 and the caller no-opped the
// whole pass. The rewrite keeps the MOST history that fits, bounded by the
// minimum-retention guards (Math.min), and the floor wins over infeasibility.
describe('fitKeepStart retention semantics', () => {
  it('keeps the MOST history that fits the 0.9× threshold, not the guard floor', () => {
    // 60 rounds ≈ 90.4K tokens against a 100K window: hard's threshold is 90K
    // and the old shape kept 4 messages (~3K) — a utilization cliff.
    const msgs: AgentMessage[] = []
    for (let i = 0; i < 60; i++) msgs.push(...round(`k${i}`, 1_500))
    const compactor = makeCompactor(msgs)
    const out = compactor.hardTruncate(msgs, 100_000, 0)
    expect(out.length).toBeGreaterThan(100)
    expect(compactor.estimateTokens(out)).toBeLessThanOrEqual(90_000)
  })

  it('cuts to the guard floor instead of no-opping when even the floor cannot fit', () => {
    // 5 fat recent rounds (300K) over a 100K window: the old walk ran keepStart
    // to 0 and hardTruncate returned the SAME array — zero proactive drops.
    const msgs: AgentMessage[] = []
    for (let i = 0; i < 20; i++) msgs.push(...round(`f${i}`, 200))
    for (let i = 0; i < 5; i++) msgs.push(...round(`ff${i}`, 60_000))
    const compactor = makeCompactor(msgs)
    const out = compactor.hardTruncate(msgs, 100_000, 0)
    expect(out).not.toBe(msgs)
    // floor = min(second-last user index, len-10) → exactly the last 10 messages
    expect(out.length).toBe(10)
    const useIds = new Set<string>()
    for (const m of out) {
      for (const b of m.contentBlocks) if (b.type === 'tool_use') useIds.add((b as { id: string }).id)
    }
    for (const m of out) {
      for (const b of m.contentBlocks) {
        if (b.type === 'tool_result') expect(useIds.has((b as { tool_use_id: string }).tool_use_id)).toBe(true)
      }
    }
  })

  it('MIN_KEEP is a minimum retention and both last user turns survive', () => {
    // Text-only conversation (light has no tool cycles to drop): 240K tokens
    // over a 100K window — the old shape kept 4 messages.
    const msgs: AgentMessage[] = []
    for (let i = 0; i < 80; i++) {
      msgs.push(textMsg('user', '很'.repeat(1_500)))
      msgs.push(textMsg('assistant', '很'.repeat(1_500)))
    }
    const compactor = makeCompactor(msgs)
    const out = compactor.hardTruncate(msgs, 100_000, 0)
    expect(out.length).toBeGreaterThan(10)
    const lastTwoUsers = msgs.filter((m) => m.role === 'user').slice(-2)
    for (const u of lastTwoUsers) expect(out).toContain(u)
  })

  it('emergencyTruncate phase 1 cuts to the floor before stripping bodies', () => {
    // 3 fat rounds (90K) over a 100K named limit: the old walk no-opped phase 1
    // entirely (the floor could not fit) and left all 46 messages for the strip.
    const msgs: AgentMessage[] = []
    for (let i = 0; i < 20; i++) msgs.push(...round(`e${i}`, 100))
    for (let i = 0; i < 3; i++) msgs.push(...round(`ef${i}`, 30_000))
    const compactor = makeCompactor(msgs)
    const result = compactor.emergencyTruncate(msgs, 100_000, 0)
    expect(result.length).toBe(10) // phase 1: floor cut
    expect(contextTokensOf(result)).toBeLessThanOrEqual(60_000) // phase 2: strip to target
    const useIds = new Set<string>()
    for (const m of result) {
      for (const b of m.contentBlocks) if (b.type === 'tool_use') useIds.add((b as { id: string }).id)
    }
    for (const m of result) {
      for (const b of m.contentBlocks) {
        if (b.type === 'tool_result') expect(useIds.has((b as { tool_use_id: string }).tool_use_id)).toBe(true)
      }
    }
  })
})

// ── 覆盖补钉（0.4.2）：lcov 摸底发现的两条生产可达分支零覆盖 ──
// 其一：includePairedToolUses 的配对修复——最大保留走查下切点奇偶任意，落在
// tool_result 开头时必须向前补配对 tool_use，否则请求带着孤儿 result 被
// provider 拒绝；旧双态走查的切点总在偶数位，这个分支从未被任何 fixture 执行。
// 其二：lightCompact 的 userHasText 剥离——带正文的用户轮所在循环被丢弃时
// 保文本、剥 tool_result（textContributionOf + toStrip 重建）。
describe('cut-boundary pairing & text-bearing cycle strip', () => {
  it('a cut landing on a result-bearing user message pulls back to its tool_use', () => {
    // 40 rounds; every tool_use carries a fat input so the odd/even crossing
    // window is wide enough to place deterministically: the threshold is aimed
    // so the maximum-retention walk first fits at index 21 — the RESULT of
    // round 10 — which would orphan its tool_use without the repair walk.
    const msgs: AgentMessage[] = []
    for (let i = 0; i < 40; i++) {
      msgs.push({
        id: `pu${i}`, role: 'assistant', createdAt: AT,
        contentBlocks: [{ type: 'tool_use', id: `t${i}`, name: 'read', input: { q: 'x'.repeat(220) } }] as ContentBlock[],
      })
      msgs.push({
        id: `pr${i}`, role: 'user', createdAt: AT,
        contentBlocks: [{ type: 'tool_result', tool_use_id: `t${i}`, content: '很'.repeat(100) }] as ContentBlock[],
      })
    }
    const compactor = makeCompactor(msgs)
    const total = compactor.estimateTokens(msgs)
    const cum20 = compactor.estimateTokens(msgs.slice(0, 20))
    const threshold = total - cum20 - 20 // first fitting tail starts at index 21 (odd → a result message)
    const window = Math.ceil(threshold / 0.9)
    const out = compactor.hardTruncate(msgs, window, 0)
    // The repair pulled the cut back to the tool_use of round 10 (index 20).
    expect(out.length).toBe(msgs.length - 20)
    expect((out[0].contentBlocks[0] as { type: string }).type).toBe('tool_use')
    const useIds = new Set<string>()
    for (const m of out) {
      for (const b of m.contentBlocks) if (b.type === 'tool_use') useIds.add((b as { id: string }).id)
    }
    for (const m of out) {
      for (const b of m.contentBlocks) {
        if (b.type === 'tool_result') expect(useIds.has((b as { tool_use_id: string }).tool_use_id)).toBe(true)
      }
    }
  })

  it('lightCompact strips a text-bearing user cycle to its text (the userHasText branch)', () => {
    const msgs: AgentMessage[] = []
    for (let i = 0; i < 60; i++) {
      msgs.push({
        id: `su${i}`, role: 'assistant', createdAt: AT,
        contentBlocks: [{ type: 'tool_use', id: `s${i}`, name: 'read', input: {} }] as ContentBlock[],
      })
      msgs.push({
        id: `sr${i}`, role: 'user', createdAt: AT,
        contentBlocks: [
          { type: 'tool_result', tool_use_id: `s${i}`, content: '很'.repeat(2000) },
          { type: 'text', text: '很'.repeat(500) },
        ] as ContentBlock[],
      })
    }
    const compactor = makeCompactor(msgs)
    const out = compactor.lightCompact(msgs, 100_000, 0)
    expect(out.length).toBeLessThan(msgs.length)
    // Survivors of dropped cycles keep ONLY their text — the tool_result is
    // stripped, the user's own words ride on.
    const stripped = out.filter((m) => m.role === 'user' && !m.contentBlocks.some((b) => b.type === 'tool_result'))
    expect(stripped.length).toBeGreaterThan(0)
    for (const m of stripped) {
      for (const b of m.contentBlocks) expect(b.type).toBe('text')
      expect((m.contentBlocks[0] as { text: string }).text).toHaveLength(500)
    }
    // Every surviving tool_result still pairs with a tool_use.
    const useIds = new Set<string>()
    for (const m of out) {
      for (const b of m.contentBlocks) if (b.type === 'tool_use') useIds.add((b as { id: string }).id)
    }
    for (const m of out) {
      for (const b of m.contentBlocks) {
        if (b.type === 'tool_result') expect(useIds.has((b as { tool_use_id: string }).tool_use_id)).toBe(true)
      }
    }
  })
})
