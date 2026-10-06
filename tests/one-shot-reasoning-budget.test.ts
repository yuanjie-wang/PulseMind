// PLAN-one-shot-reasoning-budget M1' (2026-10-06, 用户裁定二) — one-shot 关思考。
// thinking 网关把 reasoning_tokens 结算进 wire max_tokens（当日三 wire 实测：
// DeepSeek zen/openai、api.deepseek.com 双格式），one-shot 家族的帽按最终输出
// 语义设定 → 会话复盘/记忆合并 length 顶格、可见输出 ≈ 0。修复：callNonStreaming
// 发 `thinking:{type:'disabled'}`（三 wire 实测全有效，帽即最终输出帽，常量余量退役）；
// 拒收该参数的严格网关（真 OpenAI/真 Anthropic）走「失败 → 无参重试一次 → 重试
// 成功才记闸」的运行时发现，瞬时故障不误记闸。
// 这里钉五件事：参数真的上送、回退真的发生、记闸后不再发参数、双失败不记闸、
// wiring（常量已死、参数在两适配器都在、无余量算术残留）。

import { describe, expect, it, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openaiAdapter } from '../src/renderer/src/llm/OpenAIAdapter'
import { anthropicAdapter } from '../src/renderer/src/llm/AnthropicAdapter'
import { setHost } from '../src/renderer/src/agent/host'
import type { PulseHost } from '../src/renderer/src/agent/host/types'

const ROOT = join(import.meta.dirname, '..')
const LLM_DIR = join(ROOT, 'src/renderer/src/llm')

afterEach(() => setHost(null as unknown as PulseHost))

const okChunks = [
  'data: ' + JSON.stringify({ choices: [{ delta: { role: 'assistant' }, finish_reason: null }] }) + '\n\n',
  'data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: null }] }) + '\n\n',
  'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n',
  'data: ' + JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }) + '\n\n',
  'data: [DONE]\n\n',
]

/** Fake host for the OpenAI wire: fails the first `failFirstN` stream calls
 *  with an HTTP 400 (the strict-gateway shape), replays chunks after that. */
function openaiHost(failFirstN = 0) {
  type Evt = { requestId: string; data?: string; error?: string }
  let chunkCb: ((e: Evt) => void) | null = null
  let errorCb: ((e: Evt) => void) | null = null
  let doneCb: ((e: Evt) => void) | null = null
  const bodies: Array<Record<string, unknown>> = []
  let calls = 0
  const host = {
    onApiStreamChunk: (cb: (e: Evt) => void) => { chunkCb = cb; return () => { chunkCb = null } },
    onApiStreamError: (cb: (e: Evt) => void) => { errorCb = cb; return () => { errorCb = null } },
    onApiStreamDone: (cb: (e: Evt) => void) => { doneCb = cb; return () => { doneCb = null } },
    apiFetchStream: async (requestId: string, _url: string, options?: { body?: unknown }) => {
      calls++
      bodies.push((options?.body ?? {}) as Record<string, unknown>)
      if (calls <= failFirstN) {
        errorCb?.({ requestId, error: 'HTTP 400: unrecognized argument' })
        return
      }
      for (const c of okChunks) chunkCb?.({ requestId, data: c })
      doneCb?.({ requestId })
    },
  }
  return { host: host as unknown as PulseHost, bodies, getCalls: () => calls }
}

/** Fake host for the Anthropic wire: pops one response per apiFetch call
 *  (null = the simple-fetch transport's every-failure shape). Captured bodies
 *  are parsed — the adapter ships them as JSON strings. */
function anthropicHost(responses: Array<string | null>) {
  const bodies: Array<Record<string, unknown>> = []
  const queue = [...responses]
  const host = {
    apiFetch: async (_url: string, options?: { body?: unknown }) => {
      bodies.push(JSON.parse(String(options?.body ?? '{}')) as Record<string, unknown>)
      return queue.length ? queue.shift()! : null
    },
  }
  return { host: host as unknown as PulseHost, bodies }
}

const thinkingOff = (b: Record<string, unknown>) => (b.thinking as Record<string, unknown> | undefined)?.type === 'disabled'

describe('callNonStreaming disables thinking; the cap is the final-output cap', () => {
  it('openai wire: thinking param sent, max_tokens sent as-is', async () => {
    const { host, bodies } = openaiHost()
    setHost(host)
    const out = await openaiAdapter.callNonStreaming('k', 'https://happy-a.test/v1', 'm', 'sys', [{ role: 'user', content: 'hi' }], 100)
    expect(out).toBe('ok')
    expect(bodies).toHaveLength(1)
    expect(bodies[0].max_tokens).toBe(100)
    expect(thinkingOff(bodies[0])).toBe(true)
  })

  it('openai wire: strict gateway → plain retry in the same call, then memoized', async () => {
    const { host, bodies, getCalls } = openaiHost(1)
    setHost(host)
    const out = await openaiAdapter.callNonStreaming('k', 'https://strict-a.test/v1', 'm', 'sys', [{ role: 'user', content: 'hi' }], 100)
    expect(out).toBe('ok')
    expect(getCalls()).toBe(2)
    expect(thinkingOff(bodies[0])).toBe(true)
    expect(bodies[1].thinking).toBeUndefined()
    expect(bodies[1].max_tokens).toBe(100)
    // Memoized: the next call skips the param entirely (one 400 per gateway, ever).
    const again = await openaiAdapter.callNonStreaming('k', 'https://strict-a.test/v1', 'm', 'sys', [{ role: 'user', content: 'hi' }], 100)
    expect(again).toBe('ok')
    expect(getCalls()).toBe(3)
    expect(bodies[2].thinking).toBeUndefined()
    expect(bodies[2].max_tokens).toBe(100)
  })

  it('openai wire: both attempts failing must NOT memoize', async () => {
    const { host, bodies, getCalls } = openaiHost(999)
    setHost(host)
    const out = await openaiAdapter.callNonStreaming('k', 'https://flaky-a.test/v1', 'm', 'sys', [{ role: 'user', content: 'hi' }], 100)
    expect(out).toBeNull()
    expect(getCalls()).toBe(2)
    // A transient outage looks the same — the next call must try the param again.
    await openaiAdapter.callNonStreaming('k', 'https://flaky-a.test/v1', 'm', 'sys', [{ role: 'user', content: 'hi' }], 100)
    expect(getCalls()).toBe(4)
    expect(thinkingOff(bodies[2])).toBe(true)
  })

  it('anthropic wire: thinking param sent, max_tokens sent as-is', async () => {
    const { host, bodies } = anthropicHost([JSON.stringify({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' })])
    setHost(host)
    const out = await anthropicAdapter.callNonStreaming('k', 'https://happy-b.test', 'm', 'sys', [{ role: 'user', content: 'hi' }], 500)
    expect(out).toBe('ok')
    expect(bodies).toHaveLength(1)
    expect(bodies[0].max_tokens).toBe(500)
    expect(thinkingOff(bodies[0])).toBe(true)
  })

  it('anthropic wire: strict gateway → plain retry in the same call, then memoized', async () => {
    const { host, bodies } = anthropicHost([
      null, // param'd call — simple fetch reports every failure as null
      JSON.stringify({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' }),
    ])
    setHost(host)
    const out = await anthropicAdapter.callNonStreaming('k', 'https://strict-b.test', 'm', 'sys', [{ role: 'user', content: 'hi' }], 500)
    expect(out).toBe('ok')
    expect(bodies).toHaveLength(2)
    expect(thinkingOff(bodies[0])).toBe(true)
    expect(bodies[1].thinking).toBeUndefined()
    expect(bodies[1].max_tokens).toBe(500)
    // Memoized: the next call is a single param-less request.
    const { host: host2, bodies: bodies2 } = anthropicHost([
      JSON.stringify({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' }),
    ])
    setHost(host2)
    const again = await anthropicAdapter.callNonStreaming('k', 'https://strict-b.test', 'm', 'sys', [{ role: 'user', content: 'hi' }], 500)
    expect(again).toBe('ok')
    expect(bodies2).toHaveLength(1)
    expect(bodies2[0].thinking).toBeUndefined()
  })
})

describe('wiring: the thinking-off switch exists on both wires, the allowance is gone', () => {
  it('adapter.ts: no reasoning-allowance constant left behind', () => {
    const src = readFileSync(join(LLM_DIR, 'adapter.ts'), 'utf-8')
    expect(src).not.toMatch(/NON_STREAMING_REASONING_ALLOWANCE/)
    expect(src).toMatch(/thinkingParamUnsupportedBaseURLs/)
  })

  for (const file of ['OpenAIAdapter.ts', 'AnthropicAdapter.ts'] as const) {
    it(`${file}: sends the param, no allowance arithmetic`, () => {
      const src = readFileSync(join(LLM_DIR, file), 'utf-8')
      expect(src).toMatch(/body\.thinking = \{ type: 'disabled' \}/)
      expect(src).toMatch(/thinkingParamUnsupported\(baseURL\)/)
      expect(src).not.toMatch(/maxTokens \+/)
    })
  }
})
