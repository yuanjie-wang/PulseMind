// review 20260925 item 9 (second tier) — the two LLM adapters were the largest
// zero-coverage surface in the renderer: 974 lines of request building, message
// serialization and SSE parsing with no test at all. Everything below drives the
// REAL openaiAdapter/anthropicAdapter with synthetic wire text and in-memory
// AgentMessage fixtures. callNonStreaming used to be the deliberate exception
// (review 20260925 中10) — the one-shot agents' path (title, greeting, memory
// consolidation, session review) had zero coverage. It is driven now: the fake
// host below replays SSE chunk strings over exactly the stream events
// fetchStreamChunks subscribes to, so the boundary stubbed is the same one the
// api-proxy owns — the adapter's own parsing/accumulation is exercised for real.

import { describe, expect, it, afterEach } from 'vitest'
import { openaiAdapter } from '../src/renderer/src/llm/OpenAIAdapter'
import { anthropicAdapter } from '../src/renderer/src/llm/AnthropicAdapter'
import { createStreamParser } from '../src/renderer/src/llm/stream-utils'
import { setHost } from '../src/renderer/src/agent/host'
import type { PulseHost } from '../src/renderer/src/agent/host/types'
import type { StreamEventHandlers } from '../src/renderer/src/llm/stream-types'
import type { AgentMessage, ToolResultBlock, ToolUseBlock } from '../src/renderer/src/types/agent'
import type { ContentBlock } from '../src/shared/types/agent'
import type { ToolDefinition } from '../src/renderer/src/tools/types'

// ── Fixtures ───────────────────────────────────────────────────────────

const TOOL: ToolDefinition = {
  name: 'read_file',
  description: 'Read a file',
  category: 'fs',
  instructions: 'Read the file at the given path.',
  input_schema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'File path' } },
    required: ['path'],
  },
}

function msg(role: 'user' | 'assistant', contentBlocks: ContentBlock[], id = 'm1'): AgentMessage {
  return { id, role, contentBlocks, createdAt: '2026-09-25T00:00:00.000Z' }
}
const text = (t: string): ContentBlock => ({ type: 'text', text: t })
const thinking = (t: string): ContentBlock => ({ type: 'thinking', thinking: t })
const toolUse = (id: string, name: string, input: Record<string, unknown> = {}, status?: ToolUseBlock['status']): ContentBlock => ({
  type: 'tool_use', id, name, input, ...(status ? { status } : {}),
})
const toolResult = (id: string, content: string, is_error = false): ContentBlock => ({
  type: 'tool_result', tool_use_id: id, content, is_error,
})

/** Record every normalized stream event in order — an empty array fails toEqual. */
function record(): { events: unknown[][]; handlers: StreamEventHandlers } {
  const events: unknown[][] = []
  const handlers: StreamEventHandlers = {
    onContentBlockStart: (index, block) => { events.push(['start', index, block]) },
    onContentBlockDelta: (index, delta) => { events.push(['delta', index, delta]) },
    onContentBlockStop: (index) => { events.push(['stop', index]) },
    onStreamComplete: (stopReason, usage) => { events.push(['complete', stopReason, usage ?? null]) },
    onError: (error) => { events.push(['error', error]) },
  }
  return { events, handlers }
}

// ── Synthetic wire text ────────────────────────────────────────────────

const dataLine = (payload: unknown) => `data: ${JSON.stringify(payload)}\n`
/** One OpenAI chat-completion chunk (choices[0].delta …). */
const deltaChunk = (
  delta: Record<string, unknown>,
  finish: string | null = null,
  usage?: Record<string, unknown>
) => dataLine({ choices: [{ delta, finish_reason: finish }], ...(usage ? { usage } : {}) })
/** The final usage-only chunk (no choices) OpenAI/DeepSeek send. */
const usageChunk = (usage: Record<string, unknown>) => dataLine({ usage })
/** One Anthropic SSE frame — event line + data line + blank dispatch line. */
const anthropicFrame = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`

// ── Contract ───────────────────────────────────────────────────────────

describe('adapter contract', () => {
  it.each([['openai', openaiAdapter], ['anthropic', anthropicAdapter]] as const)(
    '%s exposes every pure seam (so `?.()` call sites stay meaningful)',
    (_name, adapter) => {
      expect(adapter.provider).toBeTruthy()
      expect(typeof adapter.buildRequest).toBe('function')
      expect(typeof adapter.createStreamParser).toBe('function')
      expect(typeof adapter.buildMessages).toBe('function')
      expect(typeof adapter.buildTools).toBe('function')
      expect(typeof adapter.reconcileMessages).toBe('function')
      expect(typeof adapter.extractTextContent).toBe('function')
      expect(typeof adapter.callNonStreaming).toBe('function')
    }
  )
})

// ── shared line splitter ───────────────────────────────────────────────

describe('createStreamParser (shared line splitter)', () => {
  it('holds an unterminated line until its newline arrives, then flush() takes the tail', () => {
    const seen: string[] = []
    const p = createStreamParser((l) => { seen.push(l) })
    p.processChunk('part1')
    expect(seen).toEqual([])            // no newline yet — nothing dispatched
    p.processChunk('part2\nmore')
    expect(seen).toEqual(['part1part2']) // the two chunks reassembled into one line
    p.flush()
    expect(seen).toEqual(['part1part2', 'more'])
  })

  it('flush() is a no-op on an empty or whitespace-only tail', () => {
    const seen: string[] = []
    const p = createStreamParser((l) => { seen.push(l) })
    p.processChunk('x\n')
    p.flush()
    expect(seen).toEqual(['x'])
    p.processChunk('   ')
    p.flush()
    expect(seen).toEqual(['x'])          // whitespace tail is not a line
  })
})

// ── OpenAI adapter ─────────────────────────────────────────────────────

describe('openaiAdapter.buildRequest', () => {
  it('assembles url/headers/body: trailing slashes stripped, system first, tools present', () => {
    const req = openaiAdapter.buildRequest('https://api.example.com/v1/', 'sk-test', {
      model: 'gpt-x', maxTokens: 1234, messages: [msg('user', [text('hi')])],
      tools: [TOOL], systemPrompt: 'SYS', stream: true,
    })
    expect(req.url).toBe('https://api.example.com/v1/chat/completions')
    expect(req.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk-test',
    })
    expect(req.body).toMatchObject({
      model: 'gpt-x', max_tokens: 1234, stream: true,
      stream_options: { include_usage: true },
    })
    expect(req.body.tools).toEqual([{
      type: 'function',
      function: { name: 'read_file', description: 'Read a file', parameters: TOOL.input_schema },
    }])
    expect((req.body.messages as unknown[])[0]).toEqual({ role: 'system', content: 'SYS' })
  })

  it('omits the tools key entirely when no tools are enabled', () => {
    const req = openaiAdapter.buildRequest('https://api.example.com', 'k', {
      model: 'm', maxTokens: 1, messages: [msg('user', [text('hi')])],
      tools: [], systemPrompt: '', stream: false,
    })
    expect('tools' in req.body).toBe(false)
    expect(req.body).toMatchObject({ model: 'm', max_tokens: 1, stream: false })
  })
})

describe('anthropicAdapter.buildMessages — the safety net agrees with reconcile (full_20261011 M7-P1-1)', () => {
  it('a tool_result after an INTERLEAVED assistant message resolves its call — no synthetic duplicate', () => {
    // The chained-spawn shape: the real result sits after an assistant
    // message. Under the narrow `break` scan the safety net injected a second
    // tool_result for call_1 into the OUTGOING payload (duplicate id →
    // Anthropic 400 shape; or a fake "interrupted" verdict).
    const { apiMessages } = anthropicAdapter.buildMessages([
      msg('user', [text('spawn A')], 'm1'),
      msg('assistant', [toolUse('call_1', 'spawn_agent', {})], 'm2'),
      msg('assistant', [text('A 报告完成')], 'm3'),
      msg('user', [toolResult('call_1', 'A done')], 'm4'),
    ], 'SYS')
    const results = apiMessages.flatMap((m: { content: Array<{ type: string; tool_use_id?: string }> }) =>
      Array.isArray(m.content) ? m.content.filter((b) => b.type === 'tool_result') : [])
    expect(results).toHaveLength(1)
    expect(results[0]!.tool_use_id).toBe('call_1')
    expect(JSON.stringify(apiMessages)).not.toContain('interrupted or cancelled')
  })

  it('a genuinely unresolved tool_use still gets the synthetic result', () => {
    // reconcile fixes a bare orphan, so the net's own case is the one buildMessages
    // MANUFACTURES: an empty-content tool_result message is dropped from the API
    // result (the `!blocks[0].content` skip), leaving call_x unresolved there.
    const { apiMessages } = anthropicAdapter.buildMessages([
      msg('user', [text('go')], 'm1'),
      msg('assistant', [toolUse('call_x', 'shell', {})], 'm2'),
      msg('user', [toolResult('call_x', '')], 'm3'),
    ], 'SYS')
    const injected = apiMessages.filter((m: { content: Array<{ type: string }> }) =>
      Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'))
    expect(injected).toHaveLength(1)
    expect(JSON.stringify(apiMessages)).toContain('interrupted or cancelled')
  })
})

describe('reconcile placeholders are status-aware (2026-10-25 plan-tool evaluation)', () => {
  // The evaluation's shape: a manual spawn_agent re-dispatch was answered by
  // the reconcile fabrication while the sub-agent was still running — the
  // model read "interrupted or cancelled" for work that completed and wrote
  // its report. A call its executor still holds must read as live, and the
  // placeholder must be replaceable (_synthetic) when the real result lands.
  it('anthropic reconcile: a live tool_use reads "still in progress", not interrupted, and carries _synthetic', () => {
    for (const status of ['queued', 'approved', 'running'] as const) {
      const messages = [
        msg('assistant', [toolUse('c1', 'spawn_agent', {}, status)], 'm1'),
        msg('user', [text('go on')], 'm2'),
      ]
      anthropicAdapter.reconcileMessages!(messages)
      const injected = messages[1].contentBlocks[0] as ToolResultBlock
      expect(injected.content).toContain('still in progress')
      expect(injected.is_error).toBe(false)
      expect(injected._synthetic).toBe(true)
    }
  })

  it('anthropic reconcile: a dead tool_use keeps the interrupted verdict, also marked _synthetic', () => {
    const messages = [
      msg('assistant', [toolUse('c1', 'spawn_agent', {}, 'pending')], 'm1'),
      msg('user', [text('go on')], 'm2'),
    ]
    anthropicAdapter.reconcileMessages!(messages)
    const injected = messages[1].contentBlocks[0] as ToolResultBlock
    expect(injected.content).toContain('interrupted or cancelled')
    expect(injected.is_error).toBe(true)
    expect(injected._synthetic).toBe(true)
  })

  it('openai reconcile: same status split, same _synthetic marker', () => {
    const live = [
      msg('assistant', [toolUse('c1', 'spawn_agent', {}, 'running')], 'm1'),
      msg('user', [text('go on')], 'm2'),
    ]
    openaiAdapter.reconcileMessages!(live)
    const injectedLive = live[1].contentBlocks[0] as ToolResultBlock
    expect(injectedLive.content).toContain('still in progress')
    expect(injectedLive.is_error).toBe(false)
    expect(injectedLive._synthetic).toBe(true)

    const dead = [
      msg('assistant', [toolUse('c2', 'shell', {})], 'm1'),
      msg('user', [text('go on')], 'm2'),
    ]
    openaiAdapter.reconcileMessages!(dead)
    const injectedDead = dead[1].contentBlocks[0] as ToolResultBlock
    expect(injectedDead.content).toContain('interrupted or cancelled')
    expect(injectedDead._synthetic).toBe(true)
  })

  it('anthropic buildMessages end-to-end: a live call never reads interrupted in the outgoing payload', () => {
    // buildMessages reconciles FIRST, so its own net is preempted here — this
    // pins the observable invariant through the whole path: the placeholder
    // the reconcile fabricated for the live call is what reaches the payload.
    const { apiMessages } = anthropicAdapter.buildMessages([
      msg('user', [text('go')], 'm1'),
      msg('assistant', [toolUse('call_x', 'spawn_agent', {}, 'running')], 'm2'),
      msg('user', [toolResult('call_x', '')], 'm3'),
    ], 'SYS')
    expect(JSON.stringify(apiMessages)).toContain('still in progress')
    expect(JSON.stringify(apiMessages)).not.toContain('interrupted or cancelled')
  })

  it('openai buildMessages safety net: a LIVE call manufactures the still-in-progress verdict', () => {
    // OpenAI's buildMessages does NOT reconcile first — the net below fires
    // directly, so this exercises its status branch for real.
    const { apiMessages } = openaiAdapter.buildMessages([
      msg('user', [text('go')], 'm1'),
      msg('assistant', [toolUse('call_live', 'spawn_agent', {}, 'running')], 'm2'),
    ], '')
    const toolMsg = apiMessages.find((m: { role?: string }) => m.role === 'tool') as { content: string }
    expect(toolMsg.content).toContain('still in progress')
    expect(JSON.stringify(apiMessages)).not.toContain('interrupted or cancelled')
  })
})

describe('openaiAdapter.buildMessages', () => {
  it('puts the system prompt first and joins user text blocks with newlines', () => {
    const { apiMessages } = openaiAdapter.buildMessages([msg('user', [text('a'), text('b')])], 'SYS')
    expect(apiMessages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'a\nb' },
    ])
  })

  it('serializes tool_use → tool_calls and the answering tool_result → role tool', () => {
    const { apiMessages } = openaiAdapter.buildMessages([
      msg('user', [text('do it')], 'm1'),
      msg('assistant', [text('calling'), toolUse('call_1', 'read_file', { path: 'a.txt' })], 'm2'),
      msg('user', [toolResult('call_1', 'contents')], 'm3'),
    ], '')
    expect(apiMessages).toEqual([
      { role: 'user', content: 'do it' },
      {
        role: 'assistant', content: 'calling',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'contents' },
    ])
  })

  it('encodes tool failure in the content — OpenAI tool messages have no is_error', () => {
    const { apiMessages } = openaiAdapter.buildMessages([
      msg('assistant', [toolUse('call_1', 't')], 'm2'),
      msg('user', [toolResult('call_1', 'boom', true)], 'm3'),
    ], '')
    expect(apiMessages[1]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '[tool_result_error] boom' })
  })

  it('turns an orphaned tool_result (compaction dropped its tool_use) back into user text', () => {
    const { apiMessages } = openaiAdapter.buildMessages([
      msg('user', [text('question')], 'm1'),
      msg('user', [toolResult('call_gone', 'leftover output')], 'm2'),
    ], '')
    expect(apiMessages).toEqual([
      { role: 'user', content: 'question' },
      { role: 'user', content: '\n\n[Tool result for call_gone]: leftover output' },
    ])
  })

  it('caps orphaned tool-result text at 2000 chars so one result cannot flood the request', () => {
    const { apiMessages } = openaiAdapter.buildMessages(
      [msg('user', [toolResult('c', 'y'.repeat(2500))], 'm1')], '')
    const content = (apiMessages[0] as { content: string }).content
    expect(content).toContain('y'.repeat(2000))
    expect(content.includes('y'.repeat(2001))).toBe(false)
  })

  it('injects synthetic tool responses after an interrupted assistant tool_calls (no 400)', () => {
    const { apiMessages } = openaiAdapter.buildMessages([
      msg('assistant', [toolUse('call_x', 'shell', {})], 'm1'),
      msg('user', [text('next')], 'm2'),
    ], '')
    expect(apiMessages).toEqual([
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'shell', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_x', content: 'Tool execution was interrupted or cancelled.' },
      { role: 'user', content: 'next' },
    ])
  })

  it('skips empty assistant messages (no content, no tool_calls)', () => {
    const { apiMessages } = openaiAdapter.buildMessages([
      msg('assistant', [], 'm1'),
      msg('assistant', [text('')], 'm2'),
      msg('user', [text('ok')], 'm3'),
    ], '')
    expect(apiMessages).toEqual([{ role: 'user', content: 'ok' }])
  })

  it('passes thinking blocks back as reasoning_content for reasoning models', () => {
    const { apiMessages } = openaiAdapter.buildMessages(
      [msg('assistant', [thinking('deep'), text('answer')])], '')
    expect(apiMessages).toEqual([
      { role: 'assistant', content: 'answer', reasoning_content: 'deep' },
    ])
  })
})

describe('openaiAdapter.createStreamParser', () => {
  it('text stream: block lifecycle + finish/usage in one chunk → end_turn with tokens', () => {
    const { events, handlers } = record()
    const p = openaiAdapter.createStreamParser(handlers)
    p.processChunk(
      deltaChunk({ content: 'Hel' }) +
      deltaChunk({ content: 'lo' }) +
      deltaChunk({}, 'stop', { prompt_tokens: 12, completion_tokens: 3 }) +
      // after completion the parser is dead: neither [DONE] nor late content emit
      'data: [DONE]\n' +
      deltaChunk({ content: 'more' })
    )
    p.flush()
    expect(events).toEqual([
      ['start', 0, { type: 'text' }],
      ['delta', 0, { type: 'text_delta', text: 'Hel' }],
      ['delta', 0, { type: 'text_delta', text: 'lo' }],
      ['stop', 0],
      ['complete', 'end_turn', { inputTokens: 12, outputTokens: 3 }],
    ])
  })

  it('defers completion when finish_reason arrives before usage (DeepSeek shape)', () => {
    const { events, handlers } = record()
    const p = openaiAdapter.createStreamParser(handlers)
    p.processChunk(deltaChunk({ content: 'Hi' }))
    p.processChunk(deltaChunk({}, 'stop'))
    expect(events).toEqual([
      ['start', 0, { type: 'text' }],
      ['delta', 0, { type: 'text_delta', text: 'Hi' }],
      ['stop', 0],
    ]) // no complete yet — the usage chunk may still be coming
    p.processChunk(usageChunk({ prompt_tokens: 40, completion_tokens: 5, prompt_cache_hit_tokens: 33 }))
    p.flush()
    expect(events).toHaveLength(4)
    expect(events[3]).toEqual(['complete', 'end_turn', { inputTokens: 40, outputTokens: 5, promptCacheHitTokens: 33 }])
  })

  // The two nested-form cases are load-bearing for opencode zen (measured
  // 2026-10-24): it sends `prompt_tokens_details.cached_tokens` ONLY — no
  // top-level `prompt_cache_hit_tokens` — so a single-form read silently
  // reported 0% cache hit for a whole 410-request task that was actually
  // serving 83% from cache.
  it('reads cache hits from the OpenAI-standard nested form (gateway shape) in the finish chunk', () => {
    const { events, handlers } = record()
    const p = openaiAdapter.createStreamParser(handlers)
    p.processChunk(
      deltaChunk({ content: 'Hi' }, 'stop', {
        prompt_tokens: 70, completion_tokens: 5,
        prompt_tokens_details: { audio_tokens: 0, cached_tokens: 60 }
      }) + 'data: [DONE]\n'
    )
    p.flush()
    expect(events).toEqual([
      ['start', 0, { type: 'text' }],
      ['delta', 0, { type: 'text_delta', text: 'Hi' }],
      ['stop', 0],
      ['complete', 'end_turn', { inputTokens: 70, outputTokens: 5, promptCacheHitTokens: 60 }],
    ])
  })

  it('reads the nested cached form from a deferred usage-only chunk too', () => {
    const { events, handlers } = record()
    const p = openaiAdapter.createStreamParser(handlers)
    p.processChunk(deltaChunk({ content: 'Hi' }))
    p.processChunk(deltaChunk({}, 'stop'))
    p.processChunk(usageChunk({ prompt_tokens: 40, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 33 } }))
    p.flush()
    expect(events).toHaveLength(4)
    expect(events[3]).toEqual(['complete', 'end_turn', { inputTokens: 40, outputTokens: 5, promptCacheHitTokens: 33 }])
  })

  it('tool stream: id-keyed blocks, index continuation, partial_json assembly, stop → tool_use', () => {
    const { events, handlers } = record()
    const p = openaiAdapter.createStreamParser(handlers)
    p.processChunk(
      deltaChunk({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '' } }] }) +
      deltaChunk({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'shell', arguments: '' } }] }) +
      // continuation chunks carry no id — they resume via the index map, and
      // block 0 receiving its args is what pins the `=== undefined` (not `!i`) keying
      deltaChunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }) +
      deltaChunk({ tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }) +
      deltaChunk({ tool_calls: [{ index: 1, function: { arguments: '{"command":"ls"}' } }] }) +
      deltaChunk({}, 'tool_calls') +
      usageChunk({ prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 3 })
    )
    p.flush()
    expect(events).toEqual([
      ['start', 0, { type: 'tool_use', id: 'call_a', name: 'read_file' }],
      ['start', 1, { type: 'tool_use', id: 'call_b', name: 'shell' }],
      ['delta', 0, { type: 'input_json_delta', partial_json: '{"path":' }],
      ['delta', 0, { type: 'input_json_delta', partial_json: '"a.txt"}' }],
      ['delta', 1, { type: 'input_json_delta', partial_json: '{"command":"ls"}' }],
      ['stop', 0],
      ['stop', 1],
      ['complete', 'tool_use', { inputTokens: 10, outputTokens: 5, promptCacheHitTokens: 3 }],
    ])
    const args = events
      .filter((e) => e[0] === 'delta' && e[1] === 0)
      .map((e) => (e[2] as { partial_json: string }).partial_json)
      .join('')
    expect(args).toBe('{"path":"a.txt"}')
  })

  it('reasoning first: thinking block closes when text starts', () => {
    const { events, handlers } = record()
    const p = openaiAdapter.createStreamParser(handlers)
    p.processChunk(
      deltaChunk({ reasoning_content: 'pondering' }) +
      deltaChunk({ content: 'Hi' }) +
      deltaChunk({}, 'stop', { prompt_tokens: 1, completion_tokens: 2 })
    )
    p.flush()
    expect(events).toEqual([
      ['start', 0, { type: 'thinking' }],
      ['delta', 0, { type: 'thinking_delta', thinking: 'pondering' }],
      ['stop', 0],
      ['start', 1, { type: 'text' }],
      ['delta', 1, { type: 'text_delta', text: 'Hi' }],
      ['stop', 1],
      ['complete', 'end_turn', { inputTokens: 1, outputTokens: 2 }],
    ])
  })

  it('a leading whitespace-only content delta opens no block and is dropped', () => {
    const { events, handlers } = record()
    const p = openaiAdapter.createStreamParser(handlers)
    p.processChunk(deltaChunk({ content: '  ' }) + deltaChunk({ content: 'Hi' }))
    p.flush()
    expect(events).toEqual([
      ['start', 0, { type: 'text' }],
      ['delta', 0, { type: 'text_delta', text: 'Hi' }],
    ])
  })

  it.each([
    ['stop', 'end_turn'],
    ['length', 'max_tokens'],
    ['content_filter', 'content_filter'],
    ['brand_new_reason', 'brand_new_reason'],
  ])('finish_reason %s normalizes to %s', (raw, expected) => {
    const { events, handlers } = record()
    const p = openaiAdapter.createStreamParser(handlers)
    p.processChunk(deltaChunk({}, raw, { prompt_tokens: 1, completion_tokens: 1 }))
    p.flush()
    expect(events).toEqual([['complete', expected, { inputTokens: 1, outputTokens: 1 }]])
  })

  it('ignores non-data lines, malformed JSON and no-space data lines without throwing', () => {
    const { events, handlers } = record()
    const p = openaiAdapter.createStreamParser(handlers)
    p.processChunk('garbage line\nevent: x\ndata: {broken json\n' + 'data:{"choices":[{"delta":{"content":"nope"}}]}\n')
    p.flush()
    expect(events).toEqual([])
    // …and the parser still works afterwards
    p.processChunk(deltaChunk({ content: 'ok' }))
    p.flush()
    expect(events[0]).toEqual(['start', 0, { type: 'text' }])
  })
})

describe('openaiAdapter.reconcileMessages', () => {
  it('inserts synthetic tool_results for an interrupted tool_use before the user text', () => {
    const messages = [
      msg('assistant', [toolUse('c1', 't')], 'm1'),
      msg('user', [text('go on')], 'm2'),
    ]
    openaiAdapter.reconcileMessages!(messages)
    expect(messages).toHaveLength(3)
    expect(messages[1].role).toBe('user')
    expect(messages[1].contentBlocks).toEqual([{
      type: 'tool_result', tool_use_id: 'c1',
      content: 'Tool execution was interrupted or cancelled.', is_error: true,
      tool_result_id: expect.any(String),
      _synthetic: true,
    }])
    expect(messages[2].contentBlocks).toEqual([text('go on')]) // original text untouched
  })

  it('leaves an answered tool_use alone', () => {
    const messages = [
      msg('assistant', [toolUse('c1', 't')], 'm1'),
      msg('user', [toolResult('c1', 'ok')], 'm2'),
    ]
    const before = JSON.stringify(messages)
    openaiAdapter.reconcileMessages!(messages)
    expect(messages).toHaveLength(2)
    expect(JSON.stringify(messages)).toBe(before)
  })

  it('answers an interrupted tool_use when the next message is an assistant turn', () => {
    const messages = [
      msg('assistant', [toolUse('c1', 't')], 'm1'),
      msg('assistant', [text('continued')], 'm2'),
    ]
    openaiAdapter.reconcileMessages!(messages)
    expect(messages).toHaveLength(3)
    expect(messages[1].role).toBe('user')
    expect(messages[1].contentBlocks[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'c1', is_error: true })
    expect(messages[2].contentBlocks).toEqual([text('continued')])
  })

  it('strips trailing tool_use from a final assistant message (result never came)', () => {
    const both = [msg('assistant', [toolUse('c9', 't'), text('partial')], 'm1')]
    openaiAdapter.reconcileMessages!(both)
    expect(both[0].contentBlocks).toEqual([text('partial')])

    const onlyTool = [msg('assistant', [toolUse('c9', 't')], 'm1')]
    openaiAdapter.reconcileMessages!(onlyTool)
    expect(onlyTool[0].contentBlocks).toEqual([])
  })
})

describe('openaiAdapter.extractTextContent', () => {
  it('pulls choices[0].message.content, falls back to the raw string, null elsewhere', () => {
    expect(openaiAdapter.extractTextContent('{"choices":[{"message":{"content":"hi"}}]}')).toBe('hi')
    expect(openaiAdapter.extractTextContent('not json at all')).toBe('not json at all')
    expect(openaiAdapter.extractTextContent('{"choices":[]}')).toBeNull()
    expect(openaiAdapter.extractTextContent(null)).toBeNull()
  })
})

// ── Anthropic adapter ──────────────────────────────────────────────────

describe('anthropicAdapter.buildRequest', () => {
  it('assembles url/version headers/system field; trailing slash stripped', () => {
    const req = anthropicAdapter.buildRequest('https://api.anthropic.com/', 'sk-ant', {
      model: 'claude-x', maxTokens: 500, messages: [msg('user', [text('hi')])],
      tools: [TOOL], systemPrompt: 'SYS', stream: true,
    })
    expect(req.url).toBe('https://api.anthropic.com/v1/messages')
    expect(req.headers).toEqual({
      'Content-Type': 'application/json',
      'x-api-key': 'sk-ant',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'tools-2024-04-04',
    })
    expect(req.body).toMatchObject({ model: 'claude-x', max_tokens: 500, stream: true, system: 'SYS' })
    expect(req.body.tools).toEqual([{ name: 'read_file', description: 'Read a file', input_schema: TOOL.input_schema }])
    expect(req.body.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('reconciles orphaned tool_use on the way in — params.messages mutates in place', () => {
    const messages = [
      msg('assistant', [toolUse('r1', 't')], 'm1'),
      msg('user', [text('next')], 'm2'),
    ]
    const req = anthropicAdapter.buildRequest('https://api.anthropic.com', 'k', {
      model: 'c', maxTokens: 10, messages, tools: [], systemPrompt: '', stream: true,
    })
    expect(messages).toHaveLength(3)          // the defensive pass wrote back
    expect(req.body.tools).toEqual([])        // anthropic keeps the key, empty
    expect(req.body.system).toBeUndefined()   // no systemPrompt → no field
    const apiMessages = req.body.messages as Array<{ role: string; content: unknown }>
    expect(apiMessages).toHaveLength(3)
    expect(apiMessages[1]).toEqual({
      role: 'user',
      content: [{
        type: 'tool_result', tool_use_id: 'r1',
        content: 'Tool execution was interrupted or cancelled.', is_error: true,
      }],
    })
    expect(apiMessages[2]).toEqual({ role: 'user', content: 'next' })
  })
})

describe('anthropicAdapter.buildMessages', () => {
  it('a lone text block serializes as a plain string; system rides systemField', () => {
    const { apiMessages, systemField } = anthropicAdapter.buildMessages([msg('user', [text('hi')])], 'SYS')
    expect(systemField).toBe('SYS')
    expect(apiMessages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('mixed blocks become the typed array, tool_result carries is_error only when set', () => {
    const { apiMessages } = anthropicAdapter.buildMessages([
      msg('assistant', [thinking('hmm'), text('ans'), toolUse('c1', 'read_file', { path: 'a' })], 'm2'),
      msg('user', [toolResult('c1', 'ok')], 'm3'),
    ], '')
    expect(apiMessages).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'ans' },
          { type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'a' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }] },
    ])
  })

  it('marks failed results and skips empty / lone-empty-tool_result messages', () => {
    const { apiMessages } = anthropicAdapter.buildMessages([
      msg('user', [], 'm1'),
      msg('user', [toolResult('c2', '')], 'm2'),
      msg('user', [toolResult('c3', 'boom', true)], 'm3'),
      msg('user', [text('keep')], 'm4'),
    ], '')
    expect(apiMessages).toEqual([
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c3', content: 'boom', is_error: true }] },
      { role: 'user', content: 'keep' },
    ])
  })

  it('reconciles an orphaned tool_use in place — no orphan survives into apiMessages', () => {
    const messages = [
      msg('assistant', [toolUse('o1', 't')], 'm1'),
      msg('user', [text('go on')], 'm2'),
    ]
    const { apiMessages } = anthropicAdapter.buildMessages(messages, '')
    expect(messages).toHaveLength(3)         // mutated, not copied
    expect(apiMessages).toEqual([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'o1', name: 't', input: {} }] },
      {
        role: 'user',
        content: [{
          type: 'tool_result', tool_use_id: 'o1',
          content: 'Tool execution was interrupted or cancelled.', is_error: true,
        }],
      },
      { role: 'user', content: 'go on' },
    ])
  })

  it('strips a trailing interrupted tool_use (with and without sibling text)', () => {
    const withText = [msg('assistant', [toolUse('z1', 't'), text('partial')], 'm1')]
    expect(anthropicAdapter.buildMessages(withText, '').apiMessages)
      .toEqual([{ role: 'assistant', content: 'partial' }])
    expect(withText[0].contentBlocks).toEqual([text('partial')])

    const onlyTool = [msg('assistant', [toolUse('z2', 't')], 'm1')]
    expect(anthropicAdapter.buildMessages(onlyTool, '').apiMessages).toEqual([])
    expect(onlyTool[0].contentBlocks).toEqual([])
  })
})

describe('anthropicAdapter.createStreamParser', () => {
  it('happy path: start/delta/stop passthrough, cache math in message_start', () => {
    const { events, handlers } = record()
    const p = anthropicAdapter.createStreamParser(handlers)
    p.processChunk(
      anthropicFrame('message_start', {
        type: 'message_start',
        message: { usage: { input_tokens: 100, cache_creation_input_tokens: 10, cache_read_input_tokens: 40 } },
      }) +
      anthropicFrame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
      anthropicFrame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }) +
      anthropicFrame('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      anthropicFrame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }) +
      anthropicFrame('message_stop', { type: 'message_stop' })
    )
    p.flush()
    expect(events).toEqual([
      ['start', 0, { type: 'text', text: '' }],
      ['delta', 0, { type: 'text_delta', text: 'Hello' }],
      ['stop', 0],
      ['complete', 'end_turn', { inputTokens: 150, outputTokens: 7, promptCacheHitTokens: 40 }],
    ])
  })

  it('tool block flow with raw delta passthrough (thinking/partial_json ride along)', () => {
    const { events, handlers } = record()
    const p = anthropicAdapter.createStreamParser(handlers)
    p.processChunk(
      anthropicFrame('content_block_start', {
        type: 'content_block_start', index: 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} },
      }) +
      anthropicFrame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"loc' } }) +
      anthropicFrame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'ation":"SF"}' } }) +
      anthropicFrame('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      // no message_start in this frame — input defaults to 0
      anthropicFrame('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } })
    )
    p.flush()
    expect(events).toEqual([
      ['start', 0, { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} }],
      ['delta', 0, { type: 'input_json_delta', partial_json: '{"loc' }],
      ['delta', 0, { type: 'input_json_delta', partial_json: 'ation":"SF"}' }],
      ['stop', 0],
      ['complete', 'tool_use', { inputTokens: 0, outputTokens: 9 }],
    ])
  })

  it('falls back to the event line when the data JSON omits type (raw thinking delta)', () => {
    const { events, handlers } = record()
    const p = anthropicAdapter.createStreamParser(handlers)
    p.processChunk(
      `event: content_block_delta\ndata: {"index":0,"delta":{"type":"thinking_delta","thinking":"deep"}}\n\n` +
      `event: message_delta\ndata: {"delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":2}}\n\n`
    )
    p.flush()
    expect(events).toEqual([
      ['delta', 0, { type: 'thinking_delta', thinking: 'deep' }],
      ['complete', 'max_tokens', { inputTokens: 0, outputTokens: 2 }],
    ])
  })

  it('error frame: reports accumulated usage first, then onError', () => {
    const { events, handlers } = record()
    const p = anthropicAdapter.createStreamParser(handlers)
    p.processChunk(
      anthropicFrame('message_start', {
        type: 'message_start',
        message: { usage: { input_tokens: 100, cache_read_input_tokens: 50 } },
      }) +
      anthropicFrame('error', { type: 'error', error: { message: 'Overloaded' } })
    )
    p.flush()
    expect(events).toEqual([
      // the error report deliberately carries no promptCacheHitTokens key
      ['complete', null, { inputTokens: 150, outputTokens: 0 }],
      ['error', 'Overloaded'],
    ])
  })

  it('ping is silent, malformed JSON is skipped without throwing, next frame still works', () => {
    const { events, handlers } = record()
    const p = anthropicAdapter.createStreamParser(handlers)
    p.processChunk(
      anthropicFrame('ping', { type: 'ping' }) +
      'event: message_delta\ndata: {broken json\n\n' +
      anthropicFrame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } })
    )
    p.flush()
    expect(events).toEqual([['complete', 'end_turn', { inputTokens: 0, outputTokens: 2 }]])
  })

  it('buffers frames split mid-line across processChunk calls', () => {
    const { events, handlers } = record()
    const p = anthropicAdapter.createStreamParser(handlers)
    p.processChunk('event: content_block_delta\ndata: {"type":"content_block_delt')
    expect(events).toEqual([])                    // line not terminated — nothing dispatches
    p.processChunk('a","index":0,"delta":{"type":"text_delta","text":"x"}}\n\n')
    p.flush()
    expect(events).toEqual([['delta', 0, { type: 'text_delta', text: 'x' }]])
  })
})

describe('anthropicAdapter.reconcileMessages', () => {
  it('delegates to the same orphan contract: insert before user text, strip the tail', () => {
    const messages = [
      msg('assistant', [toolUse('c1', 't')], 'm1'),
      msg('user', [text('go on')], 'm2'),
      msg('assistant', [toolUse('c2', 't'), text('partial')], 'm3'),
    ]
    anthropicAdapter.reconcileMessages!(messages)
    expect(messages).toHaveLength(4)
    expect(messages[1].contentBlocks[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'c1', is_error: true })
    expect(messages[2].contentBlocks).toEqual([text('go on')])
    expect(messages[3].contentBlocks).toEqual([text('partial')])
  })
})

describe('anthropicAdapter.buildTools', () => {
  it('maps to the anthropic tool shape (name/description/input_schema, no function wrapper)', () => {
    expect(anthropicAdapter.buildTools([TOOL])).toEqual([
      { name: 'read_file', description: 'Read a file', input_schema: TOOL.input_schema },
    ])
  })
})

describe('anthropicAdapter.extractTextContent', () => {
  it('picks the first text block (skipping thinking), falls back to raw, null elsewhere', () => {
    const response = JSON.stringify({ content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'hello' }] })
    expect(anthropicAdapter.extractTextContent(response)).toBe('hello')
    expect(anthropicAdapter.extractTextContent('plain text')).toBe('plain text')
    expect(anthropicAdapter.extractTextContent('{"content":[]}')).toBeNull()
    expect(anthropicAdapter.extractTextContent(null)).toBeNull()
  })
})

// ── callNonStreaming (review 2026-09-26 中10) ────────────────────────────

type StreamEvt = { requestId: string; data?: string; error?: string }

/** A fake host that replays `chunks` over the stream events fetchStreamChunks
 *  subscribes to — the outermost boundary, exactly what the production
 *  api-proxy answers. Captures the apiFetchStream args for request asserts. */
function hostReplaying(chunks: string[], opts?: { failWith?: string }): { host: PulseHost; calls: Array<{ requestId: string; url: string; options?: { body?: unknown } }> } {
  let chunkCb: ((e: StreamEvt) => void) | null = null
  let errorCb: ((e: StreamEvt) => void) | null = null
  let doneCb: ((e: StreamEvt) => void) | null = null
  const calls: Array<{ requestId: string; url: string; options?: { body?: unknown } }> = []
  const host = {
    onApiStreamChunk: (cb: (e: StreamEvt) => void) => { chunkCb = cb; return () => { chunkCb = null } },
    onApiStreamError: (cb: (e: StreamEvt) => void) => { errorCb = cb; return () => { errorCb = null } },
    onApiStreamDone: (cb: (e: StreamEvt) => void) => { doneCb = cb; return () => { doneCb = null } },
    apiFetchStream: async (requestId: string, url: string, options?: { body?: unknown }) => {
      calls.push({ requestId, url, options })
      if (opts?.failWith) {
        errorCb?.({ requestId, error: opts.failWith })
        return
      }
      for (const c of chunks) chunkCb?.({ requestId, data: c })
      doneCb?.({ requestId })
    },
  }
  return { host: host as unknown as PulseHost, calls }
}

describe('openaiAdapter.callNonStreaming', () => {
  afterEach(() => setHost(null as unknown as PulseHost))

  it('accumulates visible content across chunks and reports usage + finish reason', async () => {
    const { host, calls } = hostReplaying([
      deltaChunk({ role: 'assistant' }),
      deltaChunk({ content: 'Hello' }),
      deltaChunk({ content: ' 世界' }, 'stop'),
      usageChunk({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }),
      'data: [DONE]\n',
    ])
    setHost(host)
    const usage: unknown[] = []
    const reasons: (string | null)[] = []
    const out = await openaiAdapter.callNonStreaming('k', 'https://api.test/v1', 'm', 'sys', [{ role: 'user', content: 'hi' }], 100, (u) => usage.push(u), (r) => reasons.push(r))
    expect(out).toBe('Hello 世界')
    expect(usage).toEqual([{ inputTokens: 11, outputTokens: 7, promptCacheHitTokens: undefined }])
    expect(reasons).toEqual(['stop'])
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.test/v1/chat/completions')
    const body = calls[0].options?.body as { messages: Array<{ role: string; content: string }>; stream: boolean; model: string }
    expect(body.stream).toBe(true)
    expect(body.model).toBe('m')
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' })
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hi' })
  })

  it('keeps reasoning_content out of the response and skips malformed JSON lines', async () => {
    const { host } = hostReplaying([
      deltaChunk({ reasoning_content: 'internal thinking' }) + dataLine('not json'),
      deltaChunk({ content: 'clean' }),
      'data: [DONE]\n',
    ])
    setHost(host)
    const out = await openaiAdapter.callNonStreaming('k', 'https://api.test/v1', 'm', '', [{ role: 'user', content: 'hi' }])
    expect(out).toBe('clean')
  })

  it('returns null (not a throw) when the stream errors — the empty-catch tail', async () => {
    const { host } = hostReplaying([], { failWith: 'upstream 502' })
    setHost(host)
    const out = await openaiAdapter.callNonStreaming('k', 'https://api.test/v1', 'm', '', [{ role: 'user', content: 'hi' }])
    expect(out).toBeNull()
  })

  it('returns null when the stream completes with no visible content', async () => {
    const { host } = hostReplaying([deltaChunk({ role: 'assistant' }), 'data: [DONE]\n'])
    setHost(host)
    const out = await openaiAdapter.callNonStreaming('k', 'https://api.test/v1', 'm', '', [{ role: 'user', content: 'hi' }])
    expect(out).toBeNull()
  })

  it('splits a chunk arriving mid-JSON (buffer carry) and flushes the tail buffer', async () => {
    const full = deltaChunk({ content: 'tail' })
    const cut = Math.floor(full.length / 2)
    const { host } = hostReplaying([deltaChunk({ content: 'head' }), full.slice(0, cut), full.slice(cut)])
    setHost(host)
    const out = await openaiAdapter.callNonStreaming('k', 'https://api.test/v1', 'm', '', [{ role: 'user', content: 'hi' }])
    expect(out).toBe('headtail')
  })
})

// ── Wide reconcile scan (chained plan dispatch, 2026-09-30) ────────────
// Chained dispatch lands an assistant message BETWEEN a live batch and its
// still-arriving results. The old scans broke at the first non-user message,
// so a call answered AFTER that interleaved assistant read as orphaned — the
// reconciler fabricated "interrupted" results for spawns that were merely
// still running, and addToolResult's duplicate guard then swallowed their
// real outputs. The scan now walks ALL later messages.

describe('reconcile wide scan — a result past an interleaved assistant still resolves its call', () => {
  /** A(1,2) → U(r1) → B(3) → U(r3, r2): r2 lands after the interleaved B. */
  function interleaved(): AgentMessage[] {
    return [
      msg('assistant', [toolUse('c1', 'spawn_agent'), toolUse('c2', 'spawn_agent')], 'mA'),
      msg('user', [toolResult('c1', 'a done')], 'mU1'),
      msg('assistant', [toolUse('c3', 'spawn_agent')], 'mB'),
      msg('user', [toolResult('c3', 'b done'), toolResult('c2', 'a2 done')], 'mU2'),
    ]
  }

  it('openaiAdapter.reconcileMessages injects nothing for the chained shape', () => {
    const messages = interleaved()
    const before = JSON.stringify(messages)
    openaiAdapter.reconcileMessages!(messages)
    expect(JSON.stringify(messages)).toBe(before)
  })

  it('anthropicAdapter.reconcileMessages injects nothing for the chained shape', () => {
    const messages = interleaved()
    const before = JSON.stringify(messages)
    anthropicAdapter.reconcileMessages!(messages)
    expect(JSON.stringify(messages)).toBe(before)
  })

  it('a genuinely orphaned call still gets its synthetic result (both adapters)', () => {
    for (const adapter of [openaiAdapter, anthropicAdapter]) {
      const messages = [
        msg('assistant', [toolUse('c1', 'spawn_agent'), toolUse('c9', 'spawn_agent')], 'mA'),
        msg('user', [toolResult('c1', 'a done')], 'mU1'),
        msg('assistant', [toolUse('c3', 'spawn_agent')], 'mB'),
        msg('user', [toolResult('c3', 'b done')], 'mU2'),
      ]
      adapter.reconcileMessages!(messages)
      // c9 has no result anywhere later → synthetic, adjacent to A.
      const synthetic = messages[1].contentBlocks.filter(b => b.type === 'tool_result' && (b as { tool_use_id: string }).tool_use_id === 'c9')
      expect(synthetic).toHaveLength(1)
      expect((synthetic[0] as { is_error: boolean }).is_error).toBe(true)
      // The other calls were not touched.
      expect(messages.filter(m => m.contentBlocks.some(b => b.type === 'tool_result' && (b as { tool_use_id: string }).tool_use_id === 'c9'))).toHaveLength(1)
    }
  })
})
