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
    // tokens of thinking in that one conversation.
    const msg: AgentMessage = {
      id: 'm0', role: 'assistant', createdAt: AT,
      contentBlocks: [
        { type: 'text', text: 'hi' },
        { type: 'thinking', thinking: '很'.repeat(100) },
        { type: 'tool_use', id: 'u', name: 'read', input: {} }
      ] as ContentBlock[],
      outputTokens: 50
    }
    expect(estimateMessagesTokens([msg])).toBe(50)
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
