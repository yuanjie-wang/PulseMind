// PLAN-one-shot-reasoning-budget M1 (2026-10-06) — one-shot 内容帽剥离 reasoning
// 预算。thinking 网关把 reasoning_tokens 结算进 wire max_tokens（当日三 wire 实测：
// DeepSeek zen/openai、api.deepseek.com 双格式），one-shot 家族的帽按可见内容语义
// 设定，两者单位不同 → 会话复盘/记忆合并 length 顶格、可见输出 ≈ 0。修复在
// callNonStreaming 的 wire 换算：max_tokens = 调用方帽 + NON_STREAMING_REASONING_ALLOWANCE。
// 这里钉三件事：两条 wire 的换算真的发生、调用方数字保持内容语义、换算点唯一
// （主循环 buildRequest 的流式路径不得被波及——单侧「简化」或顺手扩散都会红）。

import { describe, expect, it, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openaiAdapter } from '../src/renderer/src/llm/OpenAIAdapter'
import { anthropicAdapter } from '../src/renderer/src/llm/AnthropicAdapter'
import { NON_STREAMING_REASONING_ALLOWANCE } from '../src/renderer/src/llm/adapter'
import { setHost } from '../src/renderer/src/agent/host'
import type { PulseHost } from '../src/renderer/src/agent/host/types'

const ROOT = join(import.meta.dirname, '..')
const LLM_DIR = join(ROOT, 'src/renderer/src/llm')

afterEach(() => setHost(null as unknown as PulseHost))

function openaiHostCapturingBody() {
  const chunks = [
    'data: ' + JSON.stringify({ choices: [{ delta: { role: 'assistant' }, finish_reason: null }] }) + '\n\n',
    'data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: null }] }) + '\n\n',
    'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n',
    'data: ' + JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }) + '\n\n',
    'data: [DONE]\n\n',
  ]
  type Evt = { requestId: string; data?: string }
  let chunkCb: ((e: Evt) => void) | null = null
  let doneCb: ((e: Evt) => void) | null = null
  const bodies: Array<Record<string, unknown>> = []
  const host = {
    onApiStreamChunk: (cb: (e: Evt) => void) => { chunkCb = cb; return () => { chunkCb = null } },
    onApiStreamError: (_cb: unknown) => () => {},
    onApiStreamDone: (cb: (e: Evt) => void) => { doneCb = cb; return () => { doneCb = null } },
    apiFetchStream: async (requestId: string, _url: string, options?: { body?: unknown }) => {
      // fetchStreamChunks passes the body as the raw object — keep it as-is.
      bodies.push((options?.body ?? {}) as Record<string, unknown>)
      for (const c of chunks) chunkCb?.({ requestId, data: c })
      doneCb?.({ requestId })
    },
  }
  return { host: host as unknown as PulseHost, bodies }
}

describe('callNonStreaming wire max_tokens carries the reasoning allowance', () => {
  it('openai wire: body max_tokens = content cap + allowance', async () => {
    const { host, bodies } = openaiHostCapturingBody()
    setHost(host)
    const out = await openaiAdapter.callNonStreaming(
      'k', 'https://api.test/v1', 'm', 'sys', [{ role: 'user', content: 'hi' }], 100
    )
    expect(out).toBe('ok')
    expect(bodies).toHaveLength(1)
    expect(bodies[0].max_tokens).toBe(100 + NON_STREAMING_REASONING_ALLOWANCE)
  })

  it('openai wire: the caller number stays the content budget (second cap)', async () => {
    const { host, bodies } = openaiHostCapturingBody()
    setHost(host)
    await openaiAdapter.callNonStreaming('k', 'https://api.test/v1', 'm', 'sys', [{ role: 'user', content: 'hi' }], 4096)
    expect(bodies[0].max_tokens).toBe(4096 + NON_STREAMING_REASONING_ALLOWANCE)
  })

  it('anthropic wire: body max_tokens = content cap + allowance', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const host = {
      apiFetch: async (_url: string, options?: { body?: unknown }) => {
        bodies.push(JSON.parse(String(options?.body)))
        return JSON.stringify({
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: 'end_turn',
        })
      },
    }
    setHost(host as unknown as PulseHost)
    const out = await anthropicAdapter.callNonStreaming(
      'k', 'https://api.test', 'm', 'sys', [{ role: 'user', content: 'hi' }], 500
    )
    expect(out).toBe('ok')
    expect(bodies[0].max_tokens).toBe(500 + NON_STREAMING_REASONING_ALLOWANCE)
  })
})

describe('wiring: the translation exists on both wires and nowhere else', () => {
  const ADAPTERS = ['OpenAIAdapter.ts', 'AnthropicAdapter.ts'] as const

  it('constant is defined in adapter.ts', () => {
    const src = readFileSync(join(LLM_DIR, 'adapter.ts'), 'utf-8')
    expect(src).toMatch(/export const NON_STREAMING_REASONING_ALLOWANCE = \d+/)
  })

  for (const file of ADAPTERS) {
    it(`${file}: exactly one translation point (callNonStreaming only)`, () => {
      const src = readFileSync(join(LLM_DIR, file), 'utf-8')
      // One occurrence = the body line; two would mean the streaming
      // buildRequest path picked the allowance up too (out of scope by
      // PLAN-one-shot-reasoning-budget §3.4).
      expect(src.split('maxTokens + NON_STREAMING_REASONING_ALLOWANCE')).toHaveLength(2)
    })
  }
})
