/**
 * Thinking as a first-class streaming segment (2026-10-25, conv_20261025172138
 * 「飞行棋棋盘数学描述」卡死复盘).
 *
 * The incident: deepseek-v4.1-flash spent ~4 minutes streaming 45,851 reasoning
 * tokens with zero text/tool blocks. The engine forwarded every delta (80ms
 * coalesced) but `buildSegments` only lifted `text` and `tool_use` blocks into
 * segments — a pure-thinking round rendered NOTHING for its whole duration, and
 * the committed thinking-only round (the max_tokens shape persists it with 0
 * content) was skipped by `groupMessages` too. The user saw a frozen UI from
 * the first byte to the answer.
 *
 * Pins: streaming thinking JOINS the open execution segment (tenth ruling); committed
 * thinking rides whatever visible segment the round produces (text/exec/ask);
 * a thinking-only round is visible instead of dropped; an empty round is still
 * dropped.
 */
import { describe, expect, it } from 'vitest'
import { buildSegments, getSegmentKey, matchSegment, type Segment } from '../src/renderer/src/components/chat/message-segments'
import type { AgentMessage, ContentBlock, ThinkingBlock, ToolUseBlock } from '../src/renderer/src/types/agent'

let seq = 0
const msg = (role: 'user' | 'assistant', contentBlocks: ContentBlock[]): AgentMessage => ({
  id: `m${++seq}`,
  role,
  contentBlocks,
  createdAt: new Date().toISOString(),
})

const think = (text: string): ThinkingBlock => ({ type: 'thinking', thinking: text })
const text = (t: string): ContentBlock => ({ type: 'text', text: t })
const tool = (id: string, name = 'write'): ToolUseBlock => ({
  type: 'tool_use', id, name, input: {}, status: 'pending',
})

const NO_ACCUM = new Map()

function build(messages: AgentMessage[], streamingBlocks: ContentBlock[], isStreaming = streamingBlocks.length > 0): Segment[] {
  return buildSegments({ messages, isStreaming, streamingBlocks, cached: [], streamingToolAccum: NO_ACCUM })
}

describe('streaming tail (tenth ruling: one open segment, blocks 塞入 it)', () => {
  it('pure-thinking stream: thinking opens a live execution segment, not a separate strip', () => {
    const segs = build([msg('user', [text('继续')])], [think('a'.repeat(5000))])
    expect(segs.map(s => s.type)).toEqual(['single', 'execution'])
    const group = segs[1]
    if (group.type === 'execution') {
      expect(group.msgs).toHaveLength(1)
      expect(group.msgs[0].id).toBe('streaming-think')
      expect(group.msgs[0].contentBlocks).toHaveLength(1)
    }
    expect(segs.some(s => s.type === 'streaming-thinking')).toBe(false)
  })

  it('tool deltas join the SAME open segment the thinking opened', () => {
    const segs = build([msg('user', [text('继续')])], [think('reason'), tool('t1')])
    const tail = segs[segs.length - 1]
    expect(tail.type).toBe('execution')
    if (tail.type === 'execution') {
      expect(tail.msgs.map(m => m.id)).toEqual(['streaming-think', 'streaming-exec'])
    }
  })

  it('interleaved think→tool→think deltas update slices IN PLACE (no unbounded growth)', () => {
    let segs = build([msg('user', [text('继续')])], [think('a')])
    segs = buildSegments({ messages: [msg('user', [text('继续')])], isStreaming: true, streamingBlocks: [think('a'), tool('t1')], cached: segs, streamingToolAccum: new Map([['t1', tool('t1')]]) })
    segs = buildSegments({ messages: [msg('user', [text('继续')])], isStreaming: true, streamingBlocks: [think('a'), tool('t1'), think('b')], cached: segs, streamingToolAccum: new Map([['t1', tool('t1')]]) })
    const tail = segs[segs.length - 1]
    expect(tail.type).toBe('execution')
    if (tail.type === 'execution') {
      expect(tail.msgs.map(m => m.id)).toEqual(['streaming-think', 'streaming-exec'])
      const thinkSlice = tail.msgs.find(m => m.id === 'streaming-think')
      expect(thinkSlice && thinkSlice.contentBlocks).toHaveLength(2)
    }
  })

  it('text closes the live segment: [group] [streaming text]', () => {
    const segs = build([msg('user', [text('继续')])], [think('reason'), text('答')])
    expect(segs.map(s => s.type)).toEqual(['single', 'execution', 'streaming'])
  })

  it('redacted_thinking joins the live segment too', () => {
    const segs = build([], [{ type: 'redacted_thinking', data: 'x' }])
    const tail = segs[segs.length - 1]
    expect(tail.type).toBe('execution')
  })

  it('no thinking blocks → unchanged shapes', () => {
    const segs = build([msg('user', [text('hi')])], [text('hello')])
    expect(segs.map(s => s.type)).toEqual(['single', 'streaming'])
  })

  it('live synthetic slices never match the segment cache (no frozen header)', () => {
    const liveSeg: Segment = { type: 'execution', msgs: [{ id: 'streaming-think', role: 'assistant', contentBlocks: [think('a')], createdAt: '' }] }
    expect(matchSegment(liveSeg, { type: 'execution', msgs: [{ id: 'streaming-think', role: 'assistant', contentBlocks: [think('a')], createdAt: '' }] })).toBe(false)
  })
})

describe('committed rounds (groupMessages)', () => {
  it('thinking-only round becomes its own execution segment (collapsible, never bare)', () => {
    const segs = build([msg('assistant', [think('burned 49152 tokens')])], [])
    expect(segs).toHaveLength(1)
    expect(segs[0].type).toBe('execution')
    if (segs[0].type === 'execution') {
      expect(segs[0].msgs[0].id.endsWith('__think')).toBe(true)
      expect(segs[0].msgs[0].contentBlocks).toHaveLength(1)
    }
  })

  it('text + thinking (separate rounds): the thinking group STANDS — forward-stable, no folding', () => {
    // Ninth ruling: no look-ahead. The thinking committed into its exec group
    // the moment it existed; the later text must NOT dissolve or absorb it.
    const segs = build([
      msg('user', [text('继续')]),
      msg('assistant', [think('reason')]),
      msg('assistant', [text('answer')]),
    ], [])
    expect(segs.map(s => s.type)).toEqual(['single', 'execution', 'single'])
    if (segs[1].type === 'execution') {
      expect(segs[1].msgs[0].id.endsWith('__think')).toBe(true)
      expect(segs[1].msgs[0].contentBlocks.map(b => b.type)).toEqual(['thinking'])
    }
    if (segs[2].type === 'single') {
      expect(segs[2].msg.id.endsWith('__text')).toBe(true)
      expect(segs[2].msg.contentBlocks.map(b => b.type)).toEqual(['text'])
    }
  })

  it('pure think + message + tool: three stable segments, none rewritten', () => {
    const segs = build([
      msg('user', [text('继续')]),
      msg('assistant', [think('reason')]),
      msg('assistant', [text('answer')]),
      msg('assistant', [tool('t1')]),
      msg('user', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' } as ContentBlock]),
    ], [])
    expect(segs.map(s => s.type)).toEqual(['single', 'execution', 'single', 'execution'])
    if (segs[1].type === 'execution') expect(segs[1].msgs[0].id.endsWith('__think')).toBe(true)
    if (segs[3].type === 'execution') expect(segs[3].msgs[0].id.endsWith('__exec')).toBe(true)
  })

  it('thinking + tools (no text): one group, thinking slice rides ahead of the tool slice (unchanged)', () => {
    const segs = build([msg('assistant', [think('reason'), tool('t1')])], [])
    expect(segs).toHaveLength(1)
    expect(segs[0].type).toBe('execution')
    if (segs[0].type === 'execution') {
      expect(segs[0].msgs.map(m => m.id.replace(/^m\d+/, ''))).toEqual(['__think', '__exec'])
      expect(segs[0].msgs[0].contentBlocks.map(b => b.type)).toEqual(['thinking'])
      expect(segs[0].msgs[1].contentBlocks.map(b => b.type)).toEqual(['tool_use'])
    }
  })

  it('thinking + tools + text after: mixed group flushes WHOLE before the text (never split)', () => {
    const segs = build([
      msg('assistant', [think('reason')]),
      msg('assistant', [tool('t1')]),
      msg('user', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' } as ContentBlock]),
      msg('assistant', [text('answer')]),
    ], [])
    expect(segs.map(s => s.type)).toEqual(['execution', 'single'])
    if (segs[0].type === 'execution') {
      expect(segs[0].msgs.map(m => m.id.replace(/^m\d+/, ''))).toEqual(['__think', '__exec', ''])
    }
  })

  it('ask_user round after pure thinking: the thinking group stands before the ask card (no fold)', () => {
    const ask = tool('a1', 'ask_user')
    const segs = build([
      msg('assistant', [think('why')]),
      msg('assistant', [ask]),
    ], [])
    expect(segs.map(s => s.type)).toEqual(['execution', 'single'])
    if (segs[0].type === 'execution') expect(segs[0].msgs[0].id.endsWith('__think')).toBe(true)
    if (segs[1].type === 'single') {
      expect(segs[1].msg.id.endsWith('__ask')).toBe(true)
      expect(segs[1].msg.contentBlocks.map(b => b.type)).toEqual(['tool_use'])
    }
  })

  it('narrate-then-act in ONE message: [group(think)] [text] [tools] — chronology over fusion', () => {
    const segs = build([msg('assistant', [think('reason'), text('我先用脚本验证'), tool('t1')])], [])
    expect(segs.map(s => s.type)).toEqual(['execution', 'single', 'execution'])
    if (segs[0].type === 'execution') expect(segs[0].msgs[0].id.endsWith('__think')).toBe(true)
    if (segs[1].type === 'single') expect(segs[1].msg.contentBlocks.map(b => b.type)).toEqual(['text'])
    if (segs[2].type === 'execution') expect(segs[2].msgs[0].id.endsWith('__exec')).toBe(true)
  })

  it('consecutive thinking rounds GROW one group in place (1次→2次), still no dissolution', () => {
    const segs = build([
      msg('assistant', [think('round one')]),
      msg('assistant', [think('round two')]),
      msg('assistant', [text('answer')]),
    ], [])
    expect(segs.map(s => s.type)).toEqual(['execution', 'single'])
    if (segs[0].type === 'execution') {
      expect(segs[0].msgs).toHaveLength(2)
      expect(segs[0].msgs.every(m => m.id.endsWith('__think'))).toBe(true)
    }
  })

  it('truly empty assistant message is still skipped (no empty bubble)', () => {
    const segs = build([msg('assistant', [])], [])
    expect(segs).toHaveLength(0)
  })

  it('a degenerate round after tool activity JOINS the open group (no premature flush)', () => {
    const msgs = [
      msg('assistant', [tool('t1')]),
      msg('user', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' } as ContentBlock]),
      msg('assistant', [think('degenerate round')]),
    ]
    const segs = build(msgs, [])
    expect(segs).toHaveLength(1)
    expect(segs[0].type).toBe('execution')
    if (segs[0].type === 'execution') {
      // assistant __exec, the tool_result user row (no suffix), then the
      // degenerate round's __think — one group, chronological.
      expect(segs[0].msgs.map(m => m.id.replace(/^m\d+/, ''))).toEqual(['__exec', '', '__think'])
    }
  })

  it('the two slices of one message key DIFFERENT segments (no React duplicate keys)', () => {
    const segs = build([msg('assistant', [think('reason'), text('narration'), tool('t1')])], [])
    const keys = segs.map(getSegmentKey)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('streaming → settled continuity (the incident replay)', () => {
  it('the live segment the user watched becomes the committed group — same unit, stable key', () => {
    const userMsg = [msg('user', [text('继续')])]
    // Mid-round: only reasoning has arrived — the open live group.
    const live = build(userMsg, [think('x'.repeat(3000))])
    expect(live[live.length - 1].type).toBe('execution')
    // Round commits as thinking-only (max_tokens shape): the group persists,
    // now keyed on the committed message id.
    const settled = build([...userMsg, msg('assistant', [think('x'.repeat(3000))])], [])
    expect(settled[settled.length - 1].type).toBe('execution')
    if (settled[settled.length - 1].type === 'execution') {
      expect(settled[settled.length - 1].msgs[0].id.endsWith('__think')).toBe(true)
    }
  })
})

describe('cache semantics', () => {
  it('live synthetic slices never match (they are appended fresh each build)', () => {
    const liveSeg: Segment = { type: 'execution', msgs: [{ id: 'streaming-exec', role: 'assistant', contentBlocks: [tool('t')], createdAt: '' }] }
    expect(matchSegment(liveSeg, { type: 'execution', msgs: [{ id: 'streaming-exec', role: 'assistant', contentBlocks: [tool('t')], createdAt: '' }] })).toBe(false)
    expect(matchSegment(liveSeg, { type: 'streaming', blocks: [] })).toBe(false)
  })
})
