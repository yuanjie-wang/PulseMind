import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Same HOME sandbox as auto-mode-phantom-approval.test.ts — the engine import
// chain touches real stores, and a test must never write into the user's live
// ~/.pulsemind.
process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-thinking-only-'))

const { AgentEngine } = await import('../src/renderer/src/agent/AgentEngine')
const { openaiAdapter } = await import('../src/renderer/src/llm/OpenAIAdapter')
const { ToolManager } = await import('../src/renderer/src/tools/ToolManager')
const { SkillManager } = await import('../src/renderer/src/skills/SkillManager')

import type { PulseHost } from '../src/renderer/src/agent/host/types'
import { setHost } from '../src/renderer/src/agent/host'
import type { AgentEngineOptions } from '../src/renderer/src/agent/AgentEngine'

const tick = () => new Promise((r) => setTimeout(r, 10))

/**
 * conv_20260927170026 (2026-09-28): deepseek-v4.1-flash ended a round with
 * ONLY a thinking block — it wrote 「我停止思考，正式输出」 into the CoT, then
 * looped 「好。发。（写）完成。」 ~770 times, burned 14k output tokens and the
 * stream closed with no text and no tool_use. The old dispatch treated the
 * round as a normal turn end (and handleMaxTokensResponse closed the
 * max_tokens variant on purpose), so the model looked silently "unwilling" —
 * the transcript held a collapsed thinking block and nothing else. The fix:
 * one bounded re-issue per turn, then an explicit error instead of the old
 * silent close. Rounds with ANY text stay exempt — that is the 2026-09-20
 * shape handleMaxTokensResponse already closes deliberately.
 *
 * These tests drive the REAL StreamRunner dispatch (real OpenAIAdapter SSE
 * parsing) over a fake host that pumps queued chunks per request; the
 * re-issue's continueLoop is a controllable fake that pumps the next round.
 */

type Runner = {
  run(opts: AgentEngineOptions, req: { apiUrl: string; headers: Record<string, string>; resolvedBody: unknown }): Promise<void>
}
const REQ = { apiUrl: 'https://example.invalid/v1/chat/completions', headers: {}, resolvedBody: {} }
const runnerOf = (engine: InstanceType<typeof AgentEngine>): Runner =>
  (engine as unknown as { streamRunner: Runner }).streamRunner

function makeStreamHost(): PulseHost & { pump(chunks: string[]): void } {
  const chunkListeners = new Set<(d: { requestId: string; data: string }) => void>()
  const doneListeners = new Set<(d: { requestId: string }) => void>()
  const queue: string[][] = []
  const noop = () => Promise.resolve([] as unknown[])
  const host = {
    onApiStreamChunk: (fn: (d: { requestId: string; data: string }) => void) => { chunkListeners.add(fn); return () => { chunkListeners.delete(fn) } },
    onApiStreamError: () => () => {},
    onApiStreamDone: (fn: (d: { requestId: string }) => void) => { doneListeners.add(fn); return () => { doneListeners.delete(fn) } },
    onApiStreamRetry: () => () => {},
    apiFetchStream: async (requestId: string) => {
      const chunks = queue.shift() ?? []
      for (const c of chunks) for (const fn of [...chunkListeners]) fn({ requestId, data: c })
      for (const fn of [...doneListeners]) fn({ requestId })
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

/** The degenerate shape: reasoning_content only, then a clean close. */
const thinkingOnlyStream = (finish = 'stop'): string[] => [
  sse({ choices: [{ delta: { reasoning_content: '我停止思考，正式输出。好。发。好。（写）。' } }] }),
  sse({ choices: [{ delta: {}, finish_reason: finish }], usage: { prompt_tokens: 881, completion_tokens: 42 } }),
  'data: [DONE]\n\n',
]

/** A productive TOOL round: visible tool_use — the only productive shape that
 *  keeps the loop running (a text round ends the turn). */
const toolStream = (): string[] => [
  sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'webfetch', arguments: '{"url":"https://example.invalid"}' } }] } }] }),
  sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 881, completion_tokens: 9 } }),
  'data: [DONE]\n\n',
]

/** A productive text round: visible text — the retry landed; ends the turn. */
const textStream = (finish = 'stop'): string[] => [
  sse({ choices: [{ delta: { content: '好的，继续探测 bookmarks。' } }] }),
  sse({ choices: [{ delta: {}, finish_reason: finish }], usage: { prompt_tokens: 881, completion_tokens: 7 } }),
  'data: [DONE]\n\n',
]

function makeEngine(_host: ReturnType<typeof makeStreamHost>) {
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
    conversationId: 'conv_thinking_only',
  } as unknown as AgentEngineOptions)

  const statuses: string[] = []
  const baseNotify = engine.notify.bind(engine)
  engine.notify = () => { statuses.push(engine.agentStatus.status); baseNotify() }
  return { engine, statuses }
}

describe('thinking-only rounds are re-issued once, then end loudly', () => {
  it('re-issues after a thinking-only round and the retry completes the turn', async () => {
    const host = makeStreamHost()
    setHost(host)
    const { engine, statuses } = makeEngine(host)

    let continueCalls = 0
    engine.continueLoop = async (): Promise<void> => {
      continueCalls += 1
      host.pump(textStream())
      await runnerOf(engine).run(engine.opts, REQ)
      await tick()
    }

    host.pump(thinkingOnlyStream())
    await runnerOf(engine).run(engine.opts, REQ)
    await tick()

    expect(continueCalls).toBe(1)
    expect(statuses).toContain('retrying')
    // The turn CLOSED normally after the productive retry — not the error path.
    expect(engine.agentStatus).toEqual({ status: 'completed' })
    expect(engine.thinkingOnlyRetries).toBe(0)
    // Both rounds live in the transcript: the degenerate thinking-only message
    // AND the recovered text round after it.
    const assistant = engine.messages.filter((m) => m.role === 'assistant')
    expect(assistant).toHaveLength(2)
    expect(assistant[0].contentBlocks.some((b) => b.type === 'thinking')).toBe(true)
    expect(assistant[1].contentBlocks.some((b) => b.type === 'text' && b.text.trim())).toBe(true)
  })

  it('a second consecutive degenerate round ends the turn with an explicit error', async () => {
    const host = makeStreamHost()
    setHost(host)
    const { engine } = makeEngine(host)

    let continueCalls = 0
    engine.continueLoop = async (): Promise<void> => {
      continueCalls += 1
      host.pump(thinkingOnlyStream())
      await runnerOf(engine).run(engine.opts, REQ)
      await tick()
    }

    host.pump(thinkingOnlyStream())
    await runnerOf(engine).run(engine.opts, REQ)
    await tick()

    // Exactly ONE re-issue — the second degenerate round must not loop.
    expect(continueCalls).toBe(1)
    expect(engine.agentStatus.status).toBe('error')
    expect((engine.agentStatus as { error: string }).error).toContain('只输出了思考')
    expect(engine.thinkingOnlyRetries).toBe(1)
    expect(engine.messages.filter((m) => m.role === 'assistant')).toHaveLength(2)
  })

  it('a productive round resets the counter — a later degenerate round gets its own re-issue', async () => {
    const host = makeStreamHost()
    setHost(host)
    const { engine } = makeEngine(host)
    // The tool round must settle without touching a network: same stub shape
    // as auto-mode-phantom-approval.test.ts.
    engine.toolExecutor.execReadOnlyTools = async (tools: Array<{ id: string; status?: string; exitCode?: number | null }>) => {
      for (const t of tools) { t.status = 'completed'; t.exitCode = 0 }
      engine.addToolResult(tools[0].id, 'page body', false)
    }

    let continueCalls = 0
    const rounds: string[][] = [thinkingOnlyStream(), toolStream(), thinkingOnlyStream()]
    engine.continueLoop = async (): Promise<void> => {
      continueCalls += 1
      const chunks = rounds.shift()
      if (!chunks) return
      host.pump(chunks)
      await runnerOf(engine).run(engine.opts, REQ)
      await tick()
    }

    host.pump(rounds.shift()!)
    await runnerOf(engine).run(engine.opts, REQ)
    await tick()

    // degenerate → retry, tool round → reset, degenerate → retry AGAIN (a
    // text round would have ended the turn instead of reaching round 3).
    expect(continueCalls).toBe(3)
    expect(engine.thinkingOnlyRetries).toBe(1)
    expect(engine.agentStatus).toMatchObject({ status: 'retrying' })
  })

  it('a text answer cut by max_tokens is exempt — handleMaxTokensResponse closes it (2026-09-20 shape)', async () => {
    const host = makeStreamHost()
    setHost(host)
    const { engine } = makeEngine(host)

    let continueCalls = 0
    engine.continueLoop = async (): Promise<void> => { continueCalls += 1 }

    host.pump(textStream('length'))
    await runnerOf(engine).run(engine.opts, REQ)
    await tick()

    // The ruling: a max_tokens cut WITH a visible reply is a finished answer —
    // no re-issue, turn closes normally. The thinking-only branch must not
    // intercept it.
    expect(continueCalls).toBe(0)
    expect(engine.agentStatus).toEqual({ status: 'completed' })
    expect(engine.thinkingOnlyRetries).toBe(0)
  })

  it('the [LLM Cache] log line names the stop reason', async () => {
    const host = makeStreamHost()
    setHost(host)
    const { engine } = makeEngine(host)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    engine.continueLoop = async (): Promise<void> => {}
    host.pump(textStream())
    await runnerOf(engine).run(engine.opts, REQ)
    await tick()

    const cacheLine = logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('[LLM Cache]'))
    expect(cacheLine).toBeDefined()
    // The adapter normalizes OpenAI's `stop` to `end_turn` — either way the
    // reason is now ON the wire log, which is the point.
    expect(cacheLine).toMatch(/stop=(stop|end_turn)/)
    logSpy.mockRestore()
  })
})

describe('prepareTurn gives a new send a fresh re-issue budget', () => {
  it('resets thinkingOnlyRetries', async () => {
    const host = makeStreamHost()
    setHost(host)
    const { engine } = makeEngine(host)
    engine.thinkingOnlyRetries = 1
    // prepareTurn is TS-private; the runtime method is the reset's owner and
    // the reset sits after the apiKey gate, so the key stays set and the turn
    // preamble runs for real (no LLM call — the loop never starts).
    await (engine as unknown as { prepareTurn(text: string): Promise<string | null> }).prepareTurn('继续')
    expect(engine.thinkingOnlyRetries).toBe(0)
  })
})

// review_20260929 中4: the error hint promises 「可直接重试」 — the button must
// actually re-buy the sampling chance. retryLastTurn does NOT pass through
// prepareTurn (it drives continueLoop directly), so the counter the error
// close left at 1 must be reset by the retry itself: without that the first
// degenerate round after the retry fails `1 < 1` and the button re-errores
// with zero sampling (the main affordance dead for exactly this error).

describe('retryLastTurn re-arms the thinking-only re-issue', () => {
  it('a retry after the error close gets its own bounded re-issue, not an instant re-error', async () => {
    const host = makeStreamHost()
    setHost(host)
    const { engine } = makeEngine(host)

    const degenerateLoop = async (): Promise<void> => {
      host.pump(thinkingOnlyStream())
      await runnerOf(engine).run(engine.opts, REQ)
      await tick()
    }
    engine.continueLoop = degenerateLoop

    // Turn 1: two degenerate rounds → the explicit error, counter parked at 1.
    host.pump(thinkingOnlyStream())
    await runnerOf(engine).run(engine.opts, REQ)
    await tick()
    expect(engine.agentStatus.status).toBe('error')
    expect(engine.thinkingOnlyRetries).toBe(1)
    const assistantsAfterTurn1 = engine.messages.filter((m) => m.role === 'assistant').length

    // The retry: same degenerate stream, but the counter was re-armed → one
    // re-issue happens before the bounded close (old code: zero — the button
    // re-errored on the first round, continueCalls would stay 2).
    await engine.retryLastTurn()
    expect(engine.thinkingOnlyRetries).toBe(1) // spent again, then bounded — no loop
    expect(engine.agentStatus.status).toBe('error')
    expect(engine.messages.filter((m) => m.role === 'assistant')).toHaveLength(assistantsAfterTurn1 + 2)
  })
})
