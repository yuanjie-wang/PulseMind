// review 20260925 item 9 (second tier) — the two LLM adapters were the largest
// zero-coverage surface in the renderer: 974 lines of request building, message
// serialization and SSE parsing with no test at all. Everything below drives the
// REAL openaiAdapter/anthropicAdapter with synthetic wire text and in-memory
// AgentMessage fixtures. callNonStreaming is deliberately NOT driven — it
// funnels into getHost().apiFetch / fetchStreamChunks (main-process proxy +
// network), which llm-request-dump.test.ts and the api-proxy tests own instead.

import { describe, expect, it } from 'vitest'
import { openaiAdapter } from '../src/renderer/src/llm/OpenAIAdapter'
import { anthropicAdapter } from '../src/renderer/src/llm/AnthropicAdapter'
import { createStreamParser } from '../src/renderer/src/llm/stream-utils'
import type { StreamEventHandlers } from '../src/renderer/src/llm/stream-types'
import type { AgentMessage } from '../src/renderer/src/types/agent'
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
const toolUse = (id: string, name: string, input: Record<string, unknown> = {}): ContentBlock => ({
  type: 'tool_use', id, name, input,
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
      { role: 'tool', tool_call_id: 'call_x', content: 'Tool execution was interrupted or cancelled before producing a result.' },
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
