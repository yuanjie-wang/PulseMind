// PLAN-one-shot-reasoning-budget M1''（2026-10-06，裁定三 + 同日精确化）——
// one-shot 的两个配置彻底分离：
//   · wire max_tokens = LlmConfig.modelMaxTokens（settings maxTokens，主循环同款），
//     场景帽绝不参与 wire —— thinking 网关把 reasoning 结算进 wire 帽（三 wire 实测），
//     关思考的参数形状跨模型家族不统一（Qwen enable_thinking / OpenRouter
//     reasoning:{} / …），所以不挑战 thinking、不定制 wire；
//   · 场景自己的「最大输出长度要求」= ExecuteOptions.maxOutputTokens，只执法在
//     最终内容上（超长截断，CJK 感知启发式估算），与 wire/模型/thinking 无关。
// 钉五件事：wire 预算只认 modelMaxTokens、场景帽在最终输出上真实执法、
// 未超长原样通过、memory-extraction 直调点同规则、旧机制（参数/闸表/余量算术）已死。

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OneShotAgent, enforceMaxOutputTokens } from '../src/renderer/src/agent/one-shot-agent/OneShotAgent'
import type { LlmConfig } from '../src/renderer/src/agent/one-shot-agent/LlmConfig'
import { openaiAdapter } from '../src/renderer/src/llm/OpenAIAdapter'
import { anthropicAdapter } from '../src/renderer/src/llm/AnthropicAdapter'
import { setHost } from '../src/renderer/src/agent/host'
import type { PulseHost } from '../src/renderer/src/agent/host/types'

const ROOT = join(import.meta.dirname, '..')
const LLM_DIR = join(ROOT, 'src/renderer/src/llm')

// ── OneShotAgent: wire budget + output cap are two different configs ───

class ProbeAgent extends OneShotAgent<string, string> {
  readonly name = 'probe'
  protected buildSystemPrompt(): string { return 'sys' }
  protected buildUserMessages(): { role: string; content: string }[] { return [{ role: 'user', content: 'hi' }] }
  protected parseResponse(raw: string): string { return raw }
  protected getDefaultOutput(): string { return '' }
}

function fakeLlmConfig(opts: { captured?: number[]; reply?: string; modelMaxTokens?: number } = {}) {
  const adapter = {
    provider: 'openai',
    callNonStreaming: async (
      _apiKey: string, _baseURL: string, _model: string, _system: string,
      _messages: { role: string; content: string }[], maxTokens?: number,
    ) => {
      opts.captured?.push(maxTokens ?? 0)
      return opts.reply ?? 'ok'
    },
  } as unknown as LlmConfig['adapter']
  return { config: { apiKey: 'k', baseURL: 'https://api.test/v1', model: 'm', adapter, modelMaxTokens: opts.modelMaxTokens } as LlmConfig }
}

describe('wire max_tokens comes from LlmConfig alone', () => {
  it('modelMaxTokens is the wire budget; the scenario cap never touches the wire', async () => {
    const captured: number[] = []
    const { config } = fakeLlmConfig({ captured, modelMaxTokens: 32768 })
    await new ProbeAgent().execute('in', { llmConfig: config, maxOutputTokens: 900 })
    expect(captured).toEqual([32768])
  })

  it('un-plumbed config → the 4096 fallback, NOT the scenario cap', async () => {
    const captured: number[] = []
    const { config } = fakeLlmConfig({ captured })
    await new ProbeAgent().execute('in', { llmConfig: config, maxOutputTokens: 900 })
    expect(captured).toEqual([4096])
  })

  it('no modelMaxTokens, no cap → the historical 4096 default', async () => {
    const captured: number[] = []
    const { config } = fakeLlmConfig({ captured })
    await new ProbeAgent().execute('in', { llmConfig: config })
    expect(captured).toEqual([4096])
  })
})

describe('the scenario cap controls the final output length', () => {
  it('over-cap ASCII output truncates to the largest fitting prefix', async () => {
    // 'x'.repeat(400) estimates to ceil(400/4)=100 tokens; cap 50 → 200 chars.
    const { config } = fakeLlmConfig({ reply: 'x'.repeat(400) })
    const out = await new ProbeAgent().execute('in', { llmConfig: config, maxOutputTokens: 50 })
    expect(out).toBe('x'.repeat(200))
  })

  it('over-cap CJK output truncates per char (CJK ≈ 1 token/char)', async () => {
    const { config } = fakeLlmConfig({ reply: '好'.repeat(100) })
    const out = await new ProbeAgent().execute('in', { llmConfig: config, maxOutputTokens: 30 })
    expect(out).toBe('好'.repeat(30))
  })

  it('under-cap output passes through untouched', async () => {
    const { config } = fakeLlmConfig({ reply: 'ok' })
    const out = await new ProbeAgent().execute('in', { llmConfig: config, maxOutputTokens: 900 })
    expect(out).toBe('ok')
  })

  it('no cap → output untouched regardless of length', async () => {
    const { config } = fakeLlmConfig({ reply: 'y'.repeat(5000) })
    const out = await new ProbeAgent().execute('in', { llmConfig: config })
    expect(out).toBe('y'.repeat(5000))
  })

  it('enforceMaxOutputTokens is idempotent on already-fitting input', () => {
    expect(enforceMaxOutputTokens('hello', 100)).toBe('hello')
    expect(enforceMaxOutputTokens('', 100)).toBe('')
    expect(enforceMaxOutputTokens('hello', undefined)).toBe('hello')
  })
})

// ── Adapters send the wire budget as-is ────────────────────────────────

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

// ── Wiring: two configs stay separate; the abandoned mechanisms stay dead ──

describe('wiring: the separation is real in source', () => {
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

  it('OneShotAgent: the wire rule reads only modelMaxTokens; the cap is post-hoc', () => {
    const src = readFileSync(join(ROOT, 'src/renderer/src/agent/one-shot-agent/OneShotAgent.ts'), 'utf-8')
    expect(src).toMatch(/options\.llmConfig\.modelMaxTokens \?\? 4096/)
    expect(src).not.toMatch(/options\.maxTokens/)
    expect(src).toMatch(/parseResponse\(enforceMaxOutputTokens\(raw, options\.maxOutputTokens\)/)
  })

  it('memory-extraction: wire = model limit, content capped at its own 500', () => {
    const src = readFileSync(join(ROOT, 'src/renderer/src/agent/engine/memory-extraction.ts'), 'utf-8')
    expect(src).toMatch(/engine\.opts\.maxTokens/)
    expect(src).toMatch(/enforceMaxOutputTokens\(raw, 500\)/)
  })

  it('callers declare the scenario cap as maxOutputTokens, not maxTokens', () => {
    for (const rel of [
      'src/renderer/src/agent/AgentEngine.ts',
      'src/renderer/src/memory/MemoryManager.ts',
      'src/renderer/src/agent/mcp-summary-service.ts',
      'src/renderer/src/agent/tool-executors.ts',
      'src/renderer/src/agent/executors/pick-tool.ts',
      'src/renderer/src/agent/executors/install-tool.ts',
      'src/renderer/src/hooks/useGreeting.ts',
      'src/renderer/src/knowledge/KnowledgeManager.ts',
      'src/renderer/src/experiences/ExperienceManager.ts',
    ]) {
      const src = readFileSync(join(ROOT, rel), 'utf-8')
      expect(src).toMatch(/maxOutputTokens: \d+/)
    }
  })
})
