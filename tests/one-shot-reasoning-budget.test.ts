// PLAN-one-shot-reasoning-budget M1'' (2026-10-06, 用户裁定三) — one-shot 不挑战
// thinking。thinking 网关把 reasoning_tokens 结算进 wire max_tokens（三 wire 实测），
// 且关思考的参数形状跨模型家族不统一（Anthropic/GLM 系 thinking:{}、Qwen
// enable_thinking、OpenRouter reasoning:{}…）——不依赖网关行为：请求侧预算 =
// 模型自己的输出上限（LlmConfig.modelMaxTokens，settings maxTokens，主循环同款），
// reasoning 与正文都装得下；接收侧照单全收，消费者帽降级为内容预期
// （摘要的 800 字截断等既有机制承担）。M1（+8192 余量）与 M1'（发参关思考）
// 均被本方案取代。
// 钉四件事：OneShotAgent 的预算优先级、两适配器原样上送（无参数无算术）、
// memory-extraction 直调点不再用 500、闸表/参数已死。

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OneShotAgent } from '../src/renderer/src/agent/one-shot-agent/OneShotAgent'
import type { ExecuteOptions, LlmConfig } from '../src/renderer/src/agent/one-shot-agent/LlmConfig'
import { openaiAdapter } from '../src/renderer/src/llm/OpenAIAdapter'
import { anthropicAdapter } from '../src/renderer/src/llm/AnthropicAdapter'
import { setHost } from '../src/renderer/src/agent/host'
import type { PulseHost } from '../src/renderer/src/agent/host/types'

const ROOT = join(import.meta.dirname, '..')
const LLM_DIR = join(ROOT, 'src/renderer/src/llm')

// ── OneShotAgent wire-budget rule ──────────────────────────────────────

class ProbeAgent extends OneShotAgent<string, string> {
  readonly name = 'probe'
  protected buildSystemPrompt(): string { return 'sys' }
  protected buildUserMessages(): { role: string; content: string }[] { return [{ role: 'user', content: 'hi' }] }
  protected parseResponse(raw: string): string { return raw }
  protected getDefaultOutput(): string { return '' }
}

function fakeLlmConfig(captured: number[], modelMaxTokens?: number): { config: LlmConfig; adapter: LlmConfig['adapter'] } {
  const adapter = {
    provider: 'openai',
    callNonStreaming: async (
      _apiKey: string, _baseURL: string, _model: string, _system: string,
      _messages: { role: string; content: string }[], maxTokens?: number,
    ) => { captured.push(maxTokens ?? 0); return 'ok' },
  } as unknown as LlmConfig['adapter']
  return { config: { apiKey: 'k', baseURL: 'https://api.test/v1', model: 'm', adapter, modelMaxTokens }, adapter }
}

describe('OneShotAgent wire budget prefers the model output limit', () => {
  it('modelMaxTokens wins over the consumer cap (thinking shares the budget)', async () => {
    const captured: number[] = []
    const { config } = fakeLlmConfig(captured, 32768)
    const options: ExecuteOptions = { llmConfig: config, maxTokens: 900 }
    await new ProbeAgent().execute('in', options)
    expect(captured).toEqual([32768])
  })

  it('un-plumbed callers keep their consumer cap as the wire budget', async () => {
    const captured: number[] = []
    const { config } = fakeLlmConfig(captured)
    await new ProbeAgent().execute('in', { llmConfig: config, maxTokens: 900 })
    expect(captured).toEqual([900])
  })

  it('neither given → the historical 4096 default', async () => {
    const captured: number[] = []
    const { config } = fakeLlmConfig(captured)
    await new ProbeAgent().execute('in', { llmConfig: config })
    expect(captured).toEqual([4096])
  })
})

// ── Adapters send the budget as-is ─────────────────────────────────────

const okChunks = [
  'data: ' + JSON.stringify({ choices: [{ delta: { role: 'assistant' }, finish_reason: null }] }) + '\n\n',
  'data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: null }] }) + '\n\n',
  'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n',
  'data: ' + JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }) + '\n\n',
  'data: [DONE]\n\n',
]

describe('callNonStreaming sends the wire budget as-is', () => {
  it('openai wire: max_tokens passed through, no thinking param', async () => {
    const bodies: Array<Record<string, unknown>> = []
    type Evt = { requestId: string; data?: string }
    let chunkCb: ((e: Evt) => void) | null = null
    let doneCb: ((e: Evt) => void) | null = null
    const host = {
      onApiStreamChunk: (cb: (e: Evt) => void) => { chunkCb = cb; return () => { chunkCb = null } },
      onApiStreamError: (_cb: unknown) => () => {},
      onApiStreamDone: (cb: (e: Evt) => void) => { doneCb = cb; return () => { doneCb = null } },
      apiFetchStream: async (requestId: string, _url: string, options?: { body?: unknown }) => {
        bodies.push((options?.body ?? {}) as Record<string, unknown>)
        for (const c of okChunks) chunkCb?.({ requestId, data: c })
        doneCb?.({ requestId })
      },
    }
    setHost(host as unknown as PulseHost)
    const out = await openaiAdapter.callNonStreaming('k', 'https://happy.test/v1', 'm', 'sys', [{ role: 'user', content: 'hi' }], 32768)
    expect(out).toBe('ok')
    expect(bodies).toHaveLength(1)
    expect(bodies[0].max_tokens).toBe(32768)
    expect(bodies[0].thinking).toBeUndefined()
    setHost(null as unknown as PulseHost)
  })

  it('anthropic wire: max_tokens passed through, no thinking param', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const host = {
      apiFetch: async (_url: string, options?: { body?: unknown }) => {
        bodies.push(JSON.parse(String(options?.body ?? '{}')) as Record<string, unknown>)
        return JSON.stringify({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' })
      },
    }
    setHost(host as unknown as PulseHost)
    const out = await anthropicAdapter.callNonStreaming('k', 'https://happy-b.test', 'm', 'sys', [{ role: 'user', content: 'hi' }], 32768)
    expect(out).toBe('ok')
    expect(bodies[0].max_tokens).toBe(32768)
    expect(bodies[0].thinking).toBeUndefined()
    setHost(null as unknown as PulseHost)
  })
})

// ── Wiring: the abandoned mechanisms stay dead ─────────────────────────

describe('wiring: no thinking param, no allowance arithmetic, no memo', () => {
  const adapterSrc = (f: string) => readFileSync(join(LLM_DIR, f), 'utf-8')

  it('adapter.ts carries neither the memo nor a reasoning constant', () => {
    const src = adapterSrc('adapter.ts')
    expect(src).not.toMatch(/thinkingParamUnsupported/)
    expect(src).not.toMatch(/NON_STREAMING_REASONING_ALLOWANCE/)
  })

  for (const file of ['OpenAIAdapter.ts', 'AnthropicAdapter.ts'] as const) {
    it(`${file}: budget passed through untouched`, () => {
      const src = adapterSrc(file)
      expect(src).toMatch(/max_tokens: maxTokens,/)
      expect(src).not.toMatch(/maxTokens \+/)
      // No thinking-suppression param (the streaming parser's own thinking
      // block machinery legitimately mentions the word).
      expect(src).not.toMatch(/thinking:\s*\{/)
      expect(src).not.toMatch(/'disabled'/)
    })
  }

  it('OneShotAgent keeps the budget preference rule', () => {
    const src = readFileSync(join(ROOT, 'src/renderer/src/agent/one-shot-agent/OneShotAgent.ts'), 'utf-8')
    expect(src).toMatch(/options\.llmConfig\.modelMaxTokens \?\? options\.maxTokens \?\? 4096/)
  })

  it('memory-extraction no longer sends the 500-token cap that thinking ate', () => {
    const src = readFileSync(join(ROOT, 'src/renderer/src/agent/engine/memory-extraction.ts'), 'utf-8')
    expect(src).toMatch(/engine\.opts\.maxTokens/)
    expect(src).not.toMatch(/\[\{ role: 'user' as const, content: summary \}\],\s*\n\s*500/)
  })
})
