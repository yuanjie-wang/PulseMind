import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Same HOME sandbox as thinking-only-retry.test.ts — the engine import chain
// touches real stores, and a test must never write into the user's live
// ~/.pulsemind.
process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-overflow-reaim-'))

const { AgentEngine } = await import('../src/renderer/src/agent/AgentEngine')
const { openaiAdapter } = await import('../src/renderer/src/llm/OpenAIAdapter')
const { ToolManager } = await import('../src/renderer/src/tools/ToolManager')
const { SkillManager } = await import('../src/renderer/src/skills/SkillManager')

import type { PulseHost } from '../src/renderer/src/agent/host/types'
import { setHost } from '../src/renderer/src/agent/host'
import type { AgentEngineOptions } from '../src/renderer/src/agent/AgentEngine'

const tick = () => new Promise((r) => setTimeout(r, 10))

// 0.4.2「压缩机制不触发」修复的接线钉子：provider 报出具体窗口数字的溢出拒绝
// 必须把本会话的自动压缩链瞄准真实窗口（light 0.3× / hard 0.1× / 0.55 预检 /
// 刻度都读 opts.contextLength —— 配置缺失或配大时每个触发线都落在真实窗口之外，
// 自动链永远不开火，每个增长周期付一次 400 + 强制重试）。无数字的猜测回落
// 只保持旧的 flag 语义，不得静默缩小会话。

type Runner = {
  run(opts: AgentEngineOptions, req: { apiUrl: string; headers: Record<string, string>; resolvedBody: unknown }): Promise<void>
}
const REQ = { apiUrl: 'https://example.invalid/v1/chat/completions', headers: {}, resolvedBody: {} }
const runnerOf = (engine: InstanceType<typeof AgentEngine>): Runner =>
  (engine as unknown as { streamRunner: Runner }).streamRunner

function makeHost(overflowMessage: string): PulseHost & { pump(chunks: string[]): void } {
  const chunkListeners = new Set<(d: { requestId: string; data: string }) => void>()
  const errorListeners = new Set<(d: { requestId: string; error: string }) => void>()
  const doneListeners = new Set<(d: { requestId: string }) => void>()
  const queue: string[][] = []
  const noop = () => Promise.resolve([] as unknown[])
  const host = {
    onApiStreamChunk: (fn: (d: { requestId: string; data: string }) => void) => { chunkListeners.add(fn); return () => { chunkListeners.delete(fn) } },
    onApiStreamError: (fn: (d: { requestId: string; error: string }) => void) => { errorListeners.add(fn); return () => { errorListeners.delete(fn) } },
    onApiStreamDone: (fn: (d: { requestId: string }) => void) => { doneListeners.add(fn); return () => { doneListeners.delete(fn) } },
    onApiStreamRetry: () => () => {},
    apiFetchStream: async (requestId: string) => {
      const chunks = queue.shift()
      if (chunks) {
        for (const c of chunks) for (const fn of [...chunkListeners]) fn({ requestId, data: c })
        for (const fn of [...doneListeners]) fn({ requestId })
        return
      }
      for (const fn of [...errorListeners]) fn({ requestId, error: overflowMessage })
    },
    onTerminalOutput: () => () => {},
    onTerminalExit: () => () => {},
    onTerminalError: () => () => {},
    onMcpServersChanged: () => () => {},
    onSkillsChanged: () => () => {},
    mcpListServers: noop,
    expertList: noop,
    getSkillPreferences: () => Promise.resolve({}),
    getSettings: () => Promise.resolve({ locale: 'zh' }),
  } as unknown as PulseHost & { pump(chunks: string[]): void }
  ;(host as unknown as { pump(chunks: string[]): void }).pump = (chunks: string[]) => { queue.push(chunks) }
  return host
}

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`

/** The overflow rejection the proxy surfaces: `HTTP <status>: <first 1000 chars
 *  of the body>` (api-proxy.handler). The numbered shape parses 32768; the
 *  numberless one matches the pattern but parses null. */
const NUMBERED = 'HTTP 400: {"error":{"message":"This model\'s maximum context length is 32768 tokens. However, you requested 130000 tokens in the messages"}}'
const NUMBERLESS = 'HTTP 400: prompt is too long'

/** A productive text round — the retried request is accepted. */
const okStream = (): string[] => [
  sse({ choices: [{ delta: { content: '好的，已按真实窗口继续。' } }] }),
  sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 30_000, completion_tokens: 7 } }),
  'data: [DONE]\n\n',
]

function makeEngine(_host: ReturnType<typeof makeHost>) {
  const engine = new AgentEngine({
    apiKey: 'test-key',
    baseURL: 'https://example.invalid',
    model: 'test-model',
    maxTokens: 1024,
    myName: 'tester',
    soul: '',
    yourName: 'user',
    adapter: openaiAdapter,
    toolManager: new ToolManager() as never,
    skillManager: new SkillManager(),
    conversationId: 'conv_overflow_reaim',
  } as unknown as AgentEngineOptions)

  const statuses: string[] = []
  const baseNotify = engine.notify.bind(engine)
  engine.notify = () => { statuses.push(engine.agentStatus.status); baseNotify() }
  return { engine, statuses }
}

describe('a numbered provider overflow re-aims the session window', () => {
  it('sets opts.contextLength to the provider-named limit and retries once', async () => {
    const host = makeHost(NUMBERED)
    setHost(host)
    const { engine, statuses } = makeEngine(host)
    engine.opts.contextLength = 128_000

    let continueCalls = 0
    engine.continueLoop = async (): Promise<void> => { continueCalls += 1 }

    await runnerOf(engine).run(engine.opts, REQ)
    await tick()

    expect(engine.contextOverflowLimit).toBe(32_768)
    expect(engine.opts.contextLength).toBe(32_768)
    expect(continueCalls).toBe(1)
    expect(statuses).toContain('retrying')
  })

  it('the re-aim survives an accepted retry; acceptance clears only the forced-cut flag', async () => {
    const host = makeHost(NUMBERED)
    setHost(host)
    const { engine } = makeEngine(host)
    engine.opts.contextLength = 128_000

    // The retried request goes out and is ACCEPTED — the regular trigger chain
    // regains authority (flag cleared), now aimed at the real window.
    let phase: 'overflow' | 'ok' = 'overflow'
    engine.continueLoop = async (): Promise<void> => {
      phase = 'ok'
      host.pump(okStream())
      await runnerOf(engine).run(engine.opts, REQ)
      await tick()
    }

    await runnerOf(engine).run(engine.opts, REQ)
    await tick()

    expect(engine.contextOverflowLimit).toBeNull()
    expect(engine.opts.contextLength).toBe(32_768)
    expect(phase).toBe('ok')
    expect(engine.agentStatus).toEqual({ status: 'completed', stopReason: 'end_turn' })
  })

  it('a numberless rejection keeps the flag-only semantics — no silent shrink', async () => {
    const host = makeHost(NUMBERLESS)
    setHost(host)
    const { engine } = makeEngine(host)
    engine.opts.contextLength = 128_000

    let continueCalls = 0
    engine.continueLoop = async (): Promise<void> => { continueCalls += 1 }

    await runnerOf(engine).run(engine.opts, REQ)
    await tick()

    // The halved guess still arms the forced cut, but opts stay untouched.
    expect(engine.contextOverflowLimit).toBe(64_000)
    expect(engine.opts.contextLength).toBe(128_000)
    expect(continueCalls).toBe(1)
  })

  it('a 413 with an unhelpful body still arms the rescue — the status is a structured signal', async () => {
    // A gateway answering "Payload Too Large" gives the body-text pattern
    // nothing; before the status arm, this shape errored the turn with the
    // whole rescue chain unengaged (the last "mechanism never participated"
    // path). The proxy does not retry 413 (only 429/5xx), so it arrives here.
    const host = makeHost('HTTP 413: Payload Too Large')
    setHost(host)
    const { engine, statuses } = makeEngine(host)
    engine.opts.contextLength = 128_000

    let continueCalls = 0
    engine.continueLoop = async (): Promise<void> => { continueCalls += 1 }

    await runnerOf(engine).run(engine.opts, REQ)
    await tick()

    expect(engine.contextOverflowLimit).toBe(64_000) // halved guess — no named limit
    expect(engine.opts.contextLength).toBe(128_000) // no number → no re-aim
    expect(continueCalls).toBe(1)
    expect(statuses).toContain('retrying')
  })

  it('an unrelated 400 neither arms the rescue nor retries', async () => {
    const host = makeHost('HTTP 400: {"error":{"message":"Invalid model id"}}')
    setHost(host)
    const { engine } = makeEngine(host)
    engine.opts.contextLength = 128_000

    let continueCalls = 0
    engine.continueLoop = async (): Promise<void> => { continueCalls += 1 }

    await runnerOf(engine).run(engine.opts, REQ)
    await tick()

    expect(engine.contextOverflowLimit).toBeNull()
    expect(engine.opts.contextLength).toBe(128_000)
    expect(continueCalls).toBe(0)
    expect(engine.agentStatus.status).toBe('error')
  })
})
