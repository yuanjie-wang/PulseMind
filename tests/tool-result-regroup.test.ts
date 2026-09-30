import { describe, expect, it } from 'vitest'
import { isToolResultAdjacencyLegal, regroupToolResults } from '../src/renderer/src/llm/regroup-tool-results'
import type { AgentMessage } from '../src/renderer/src/types/agent'
import type { ContentBlock, ToolResultBlock, ToolUseBlock } from '../src/shared/types/agent'

/**
 * The request-time adjacency repair (2026-09-30): chained plan dispatch lands
 * an assistant message BETWEEN a live batch and its still-arriving results,
 * and both providers require results adjacent to their calls. The contract
 * under test has two halves:
 *
 *  1. IDENTITY — an already-legal history comes back as the SAME reference,
 *     byte-identical. This is the cache contract: sessions that never chain
 *     must pay nothing, and the wiring point sits on EVERY request.
 *  2. REPAIR — the interleaved shape rebuilds so each assistant message is
 *     immediately followed by all of its results, deterministically
 *     (regroup∘regroup = regroup, and a growing history's regrouped prefix
 *     is stable).
 */

let seq = 0
const msg = (role: 'user' | 'assistant', blocks: ContentBlock[], id?: string): AgentMessage => ({
  id: id ?? `m${++seq}`,
  role,
  contentBlocks: blocks,
  createdAt: new Date().toISOString(),
})

const use = (id: string): ToolUseBlock => ({ type: 'tool_use', id, name: 'spawn_agent', input: {} })
const result = (toolUseId: string, content: string): ToolResultBlock => ({
  type: 'tool_result',
  tool_use_id: toolUseId,
  content,
  tool_result_id: `tr_${toolUseId}`,
})
const text = (t: string): ContentBlock => ({ type: 'text', text: t })

describe('isToolResultAdjacencyLegal', () => {
  it('accepts the shapes the engine produces today', () => {
    // One batch, one collector message.
    expect(isToolResultAdjacencyLegal([
      msg('user', [text('hi')]),
      msg('assistant', [use('a'), use('b')]),
      msg('user', [result('a', 'x'), result('b', 'y')]),
      msg('assistant', [text('done')]),
    ])).toBe(true)
    // Results split across several user messages after one assistant.
    expect(isToolResultAdjacencyLegal([
      msg('assistant', [use('a'), use('b')]),
      msg('user', [result('a', 'x')]),
      msg('user', [result('b', 'y')]),
    ])).toBe(true)
    // A call with results still pending at the tail (live turn) is legal.
    expect(isToolResultAdjacencyLegal([
      msg('assistant', [use('a')]),
      msg('user', [result('a', 'x')]),
      msg('assistant', [use('b')]),
    ])).toBe(true)
    // No tools at all.
    expect(isToolResultAdjacencyLegal([msg('user', [text('hi')])])).toBe(true)
  })

  it('rejects a result that lands after an interleaved assistant message', () => {
    // The chained-dispatch shape: A's r1 arrives after B's message.
    expect(isToolResultAdjacencyLegal([
      msg('assistant', [use('a1'), use('a2'), use('a3')]),
      msg('user', [result('a2', 'x')]),
      msg('assistant', [use('b1')]),
      msg('user', [result('b1', 'y'), result('a1', 'p'), result('a3', 'q')]),
    ])).toBe(false)
  })

  it('rejects adjacent assistant messages (review_20260930 中6)', () => {
    // The clean-dispatch shape: a turn ends with text while the plan is open,
    // and the scheduler appends the synthetic dispatch assistant right after
    // the model's own closing text — a same-role run Anthropic 400s on.
    expect(isToolResultAdjacencyLegal([
      msg('user', [text('hi')]),
      msg('assistant', [text('on it')]),
      msg('assistant', [use('a1')]),
      msg('user', [result('a1', 'x')]),
    ])).toBe(false)
  })
})

describe('regroupToolResults — identity on legal histories', () => {
  it('returns the same reference for the single-batch shape', () => {
    const history = [
      msg('user', [text('hi')]),
      msg('assistant', [use('a'), use('b')]),
      msg('user', [result('a', 'x'), result('b', 'y')]),
      msg('assistant', [text('done')]),
    ]
    expect(regroupToolResults(history)).toBe(history)
  })

  it('returns the same reference across multi-wave and text-turn histories', () => {
    const history = [
      msg('user', [text('do it')]),
      msg('assistant', [use('w1')]),
      msg('user', [result('w1', 'r1')]),
      msg('assistant', [use('w2a'), use('w2b')]),
      msg('user', [result('w2a', 'r2a')]),
      msg('user', [result('w2b', 'r2b')]),
      msg('assistant', [text('synthesis')]),
      msg('user', [text('thanks')]),
    ]
    expect(regroupToolResults(history)).toBe(history)
  })

  it('returns the same reference when there are no tools at all', () => {
    const history = [msg('user', [text('hi')]), msg('assistant', [text('hello')])]
    expect(regroupToolResults(history)).toBe(history)
  })
})

describe('regroupToolResults — repair of the interleaved shape', () => {
  it('moves A\'s late results back under A, keeping B\'s adjacent', () => {
    const A = msg('assistant', [use('a1'), use('a2'), use('a3')], 'msgA')
    const B = msg('assistant', [use('b1')], 'msgB')
    const out = regroupToolResults([
      msg('user', [text('go')]),
      A,
      msg('user', [result('a2', 'early')]),
      B,
      msg('user', [result('b1', 'b-out'), result('a1', 'late-1'), result('a3', 'late-2')]),
    ])

    expect(out).toHaveLength(5)
    expect(out[0].role).toBe('user')
    expect(out[1]).toBe(A)
    // A's bucket: the early result first (input order), then the late ones.
    expect(out[2].id).toBe('regroup_msgA')
    expect(out[2].contentBlocks.map(b => (b as ToolResultBlock).tool_use_id))
      .toEqual(['a2', 'a1', 'a3'])
    expect(out[3]).toBe(B)
    expect(out[4].contentBlocks.map(b => (b as ToolResultBlock).tool_use_id))
      .toEqual(['b1'])
  })

  it('keeps user text blocks in place and only moves results', () => {
    const A = msg('assistant', [use('a1'), use('a2')], 'msgA')
    const B = msg('assistant', [use('b1')], 'msgB')
    const out = regroupToolResults([
      A,
      msg('user', [result('a1', 'x')]),
      B,
      msg('user', [text('a human note'), result('b1', 'y'), result('a2', 'late')]),
    ])
    // The human note is NOT swallowed into A's bucket.
    const noteMsg = out.find(m => m.contentBlocks.some(b => b.type === 'text' && (b as { text: string }).text === 'a human note'))
    expect(noteMsg).toBeDefined()
    expect(noteMsg!.contentBlocks).toHaveLength(1)
  })

  it('leaves orphan results (no parent) where they are', () => {
    const orphan = result('ghost', 'nobody declared me')
    const A = msg('assistant', [use('a1')], 'msgA')
    const out = regroupToolResults([
      msg('user', [orphan]),
      A,
      msg('user', [result('a1', 'x')]),
    ])
    expect(out[0].contentBlocks).toContain(orphan)
    expect(out).toHaveLength(3)
  })

  it('is deterministic — regroup is idempotent and prefix-stable', () => {
    const A = msg('assistant', [use('a1'), use('a2')], 'msgA')
    const B = msg('assistant', [use('b1')], 'msgB')
    const head = [
      msg('user', [text('go')]),
      A,
      msg('user', [result('a1', 'x')]),
      B,
      msg('user', [result('b1', 'y'), result('a2', 'z')]),
    ]
    const once = regroupToolResults(head)
    expect(isToolResultAdjacencyLegal(once)).toBe(true)
    expect(regroupToolResults(once)).toEqual(once)

    // A later turn appends: the earlier regrouped bytes are unchanged.
    const grown = regroupToolResults([...head, msg('assistant', [text('final')])])
    expect(JSON.stringify(grown.slice(0, once.length))).toBe(JSON.stringify(once))
  })

  it('derives the bucket id from the parent message, so it is stable across requests', () => {
    const A = msg('assistant', [use('a1'), use('a2')], 'msgA')
    const B = msg('assistant', [use('b1')], 'msgB')
    const interleaved = [
      A,
      msg('user', [result('a1', 'x')]),
      B,
      msg('user', [result('b1', 'y'), result('a2', 'late')]),
    ]
    const first = regroupToolResults(interleaved)
    const second = regroupToolResults(interleaved)
    expect(first.find(m => m.id.startsWith('regroup_'))!.id)
      .toBe(second.find(m => m.id.startsWith('regroup_'))!.id)
  })
})

describe('regroupToolResults — merge of adjacent assistants (review_20260930 中6)', () => {
  it('merges the text-ending turn with the synthetic dispatch into one assistant run', () => {
    const out = regroupToolResults([
      msg('user', [text('hi')]),
      msg('assistant', [text('on it')], 'msgText'),
      msg('assistant', [use('a1')], 'msgDispatch'),
      msg('user', [result('a1', 'x')]),
    ])
    // Roles alternate and the two assistant messages are one.
    expect(out.map(m => m.role)).toEqual(['user', 'assistant', 'user'])
    const merged = out[1]
    expect(merged.id).toBe('msgText') // the survivor is the FIRST message
    expect(merged.contentBlocks.map(b => b.type)).toEqual(['text', 'tool_use'])
    // The result still hangs off its call, in the user run right after.
    expect(out[2].id).toBe('regroup_msgText')
    expect(out[2].contentBlocks.map(b => (b as ToolResultBlock).tool_use_id)).toEqual(['a1'])
    expect(isToolResultAdjacencyLegal(out)).toBe(true)
  })

  it('merges a three-assistant run and keeps later waves intact', () => {
    const out = regroupToolResults([
      msg('assistant', [text('a')], 'mA'),
      msg('assistant', [text('b'), use('w1')], 'mB'),
      msg('assistant', [use('w2')], 'mC'),
      msg('user', [result('w1', 'x'), result('w2', 'y')]),
    ])
    expect(out.map(m => m.role)).toEqual(['assistant', 'user'])
    expect(out[0].contentBlocks.map(b => b.type)).toEqual(['text', 'text', 'tool_use', 'tool_use'])
    expect(out[1].contentBlocks.map(b => (b as ToolResultBlock).tool_use_id)).toEqual(['w1', 'w2'])
    expect(isToolResultAdjacencyLegal(out)).toBe(true)
  })

  it('without adjacent assistants the identity contract is untouched', () => {
    const history = [msg('user', [text('hi')]), msg('assistant', [text('hello')])]
    expect(regroupToolResults(history)).toBe(history)
  })
})
