import { describe, expect, it } from 'vitest'
import { collectUserReplays } from '../src/renderer/src/agent/engine/context-compactor'
import type { AgentMessage, ContentBlock } from '../src/renderer/src/types/agent'

// ── Fixtures ──────────────────────────────────────────────────────────
// Token accounting in this file uses the shared estimator's own arithmetic:
// CJK chars ≈ 1 token each, everything else ≈ 1 token per 4 chars. Budgets
// below are therefore written in estimator units, not provider units.

let seq = 0
const msg = (role: 'user' | 'assistant', text: string, extra: ContentBlock[] = []): AgentMessage => ({
  id: `m${++seq}`,
  role,
  contentBlocks: [{ type: 'text', text }, ...extra],
  createdAt: '2026-09-23T10:00:00.000Z',
})

/**
 * 差距分析 P0-2（2026-09-23）：压缩副本此前只带 500-token 的摘要，用户原话
 * 在丢弃区间里只活在转述里。这里钉住重放的三条规则——只挑带正文的 user 消息、
 * 从新到旧填预算再按时序倒回、超预算的那条截头加标记而不是跳过。
 */
describe('collectUserReplays: dropped region → verbatim user messages', () => {
  it('picks only user messages with text, in chronological order', () => {
    const dropped = [
      msg('user', '第一条需求'),
      msg('assistant', '助手回复'),
      msg('user', '纠正一下'),
      msg('assistant', '好的'),
    ]
    const replays = collectUserReplays(dropped, 1000)
    expect(replays).toHaveLength(2)
    expect(replays.map((r) => r.contentBlocks[0]).map((b) => (b as { text: string }).text))
      .toEqual(['第一条需求', '纠正一下'])
    // Fresh shells — the original object must stay out of the API copy.
    replays.forEach((r, i) => {
      expect(r).not.toBe(dropped[i * 2])
      expect(r.id).toBe(dropped[i * 2].id) // identity preserved for debugging
    })
  })

  it('skips tool_result collector messages with no text', () => {
    const collector = msg('user', '', [
      { type: 'tool_result', tool_use_id: 't1', content: '结果', is_error: false, tool_result_id: 'r1' },
    ])
    const replays = collectUserReplays([msg('user', '真实需求'), collector], 1000)
    expect(replays).toHaveLength(1)
    expect((replays[0].contentBlocks[0] as { text: string }).text).toBe('真实需求')
  })

  it('fills the budget newest-first and truncates the boundary message', () => {
    // 'a'.repeat(40) = 10 tokens; 'b'.repeat(40) = 10; 'c'.repeat(400) = 100.
    const old = msg('user', 'a'.repeat(40))
    const mid = msg('user', 'b'.repeat(40))
    const newest = msg('user', 'c'.repeat(400))
    // 15-token budget: the newest message (100) overflows → truncated to the
    // remaining head with the marker, and nothing older is taken.
    const replays = collectUserReplays([old, mid, newest], 15)
    expect(replays).toHaveLength(1)
    const text = (replays[0].contentBlocks[0] as { text: string }).text
    expect(text.startsWith('c'.repeat(50))).toBe(true) // 15 tokens ÷ 0.25 tok/char = 60 chars… head kept
    expect(text).toContain('…[已截断]')
    expect(replays[0].id).toBe(newest.id)
  })

  it('keeps whole messages while they all fit, newest first', () => {
    const a = msg('user', 'a'.repeat(40)) // 10 tokens
    const b = msg('user', 'b'.repeat(40)) // 10 tokens
    const c = msg('user', 'c'.repeat(400)) // 100 tokens
    const replays = collectUserReplays([a, b, c], 130)
    expect(replays).toHaveLength(3)
    expect(replays.map((r) => r.id)).toEqual([a.id, b.id, c.id]) // chronological
  })

  it('returns nothing for an empty region or budget', () => {
    expect(collectUserReplays([], 100)).toEqual([])
    expect(collectUserReplays([msg('user', 'hi')], 0)).toEqual([])
  })
})
