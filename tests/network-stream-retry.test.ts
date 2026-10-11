import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Same HOME sandbox as stream-done-watchdog.test.ts — the engine import chain
// touches real stores, and a test must never write into the user's live
// ~/.pulsemind.
process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-network-retry-'))

const { AgentEngine } = await import('../src/renderer/src/agent/AgentEngine')
const { openaiAdapter } = await import('../src/renderer/src/llm/OpenAIAdapter')
const { ToolManager } = await import('../src/renderer/src/tools/ToolManager')
const { SkillManager } = await import('../src/renderer/src/skills/SkillManager')
const { MAX_STREAM_IDLE_RETRIES, STREAM_NETWORK_ERROR_MARKERS } = await import('../src/renderer/src/agent/engine/engine-constants')

import type { PulseHost } from '../src/renderer/src/agent/host/types'
import { setHost } from '../src/renderer/src/agent/host'
import type { AgentEngineOptions } from '../src/renderer/src/agent/AgentEngine'

/**
 * 12h-run hardening (2026-10-11): a stream that DIES actively — TCP reset
 * mid-body, the proxy's 20 backoff attempts exhausted during an outage, or the
 * sleep/resume cancelAllRequests sweep ('Request aborted') — used to end the
 * turn as a hard error. For an unattended run that is fatal: routine-runner
 * settles the row failed and nothing retries. These shapes now share the
 * idle-timeout budget (streamIdleRetries ≤ MAX_STREAM_IDLE_RETRIES) and
 * re-issue the request; 'HTTP …' status errors are deliberately excluded.
 */

type Runner = {
  run(opts: AgentEngineOptions, req: { apiUrl: string; headers: Record<string, string>; resolvedBody: unknown }): Promise<void>
}
const REQ = { apiUrl: 'https://example.invalid/v1/chat/completions', headers: {}, resolvedBody: {} }
const runnerOf = (engine: InstanceType<typeof AgentEngine>): Runner =>
  (engine as unknown as { streamRunner: Runner }).streamRunner

/** A host whose stream dies: apiFetchStream emits an API_STREAM_ERROR with the
 *  given message right before resolving. */
function makeDyingHost(error: string): PulseHost {
  let emitError: ((data: { requestId: string; error: string }) => void) | null = null
  const noop = () => Promise.resolve([] as unknown[])
  return {
    onApiStreamChunk: () => () => {},
    onApiStreamError: (cb) => { emitError = cb; return () => {} },
    onApiStreamDone: () => () => {},
    onApiStreamRetry: () => () => {},
    apiFetchStream: async (requestId: string) => { emitError?.({ requestId, error }) },
    onTerminalOutput: () => () => {},
    onTerminalExit: () => () => {},
    onTerminalError: () => () => {},
    onMcpServersChanged: () => () => {},
    onSkillsChanged: () => () => {},
    mcpListServers: noop,
    expertList: noop,
    getSkillPreferences: () => Promise.resolve({}),
    getSettings: () => Promise.resolve({ locale: 'zh' }),
  } as unknown as PulseHost
}

function makeEngine(spawned = false) {
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
    conversationId: 'conv_network_retry',
  } as unknown as AgentEngineOptions)
  if (spawned) {
    engine.spawnSystemPrompt = 'test spawn prompt'
    ;(engine as unknown as { resolveCompletion: unknown }).resolveCompletion = vi.fn()
  }
  return engine
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('mid-stream network-failure retry', () => {
  it('constant sanity: the transport shapes are covered, HTTP status is not a marker', () => {
    expect(MAX_STREAM_IDLE_RETRIES).toBeGreaterThanOrEqual(2)
    for (const marker of ['Request aborted', 'fetch failed', 'terminated', 'other side closed', 'socket hang up', 'ECONNRESET', 'ETIMEDOUT']) {
      expect(STREAM_NETWORK_ERROR_MARKERS).toContain(marker)
    }
    expect(STREAM_NETWORK_ERROR_MARKERS.some(m => m.startsWith('HTTP '))).toBe(false)
  })

  it('a mid-stream TCP reset re-issues the request within budget', async () => {
    setHost(makeDyingHost('terminated | cause: Error: other side closed'))
    const engine = makeEngine()
    const continueLoop = vi.fn()
    engine.continueLoop = continueLoop as unknown as typeof engine.continueLoop
    const run = runnerOf(engine).run(engine.opts, REQ)
    await vi.advanceTimersByTimeAsync(1_000)
    await run
    expect(continueLoop).toHaveBeenCalledTimes(1)
    expect(engine.streamIdleRetries).toBe(1)
    expect(engine.agentStatus.status).toBe('retrying')
    expect(String(engine.agentStatus.message)).toContain('网络连接中断')
  })

  it('sleep/resume abort (Request aborted) re-issues; user-stop never reaches the matcher', async () => {
    setHost(makeDyingHost('Request aborted'))
    const engine = makeEngine()
    const continueLoop = vi.fn()
    engine.continueLoop = continueLoop as unknown as typeof engine.continueLoop
    const run = runnerOf(engine).run(engine.opts, REQ)
    await vi.advanceTimersByTimeAsync(1_000)
    await run
    expect(continueLoop).toHaveBeenCalledTimes(1)
    expect(engine.agentStatus.status).toBe('retrying')
  })

  it('an exhausted budget ends the turn with an explicit error and settles a spawn', async () => {
    setHost(makeDyingHost('fetch failed | cause: Error: connect ETIMEDOUT'))
    const engine = makeEngine(true)
    engine.streamIdleRetries = MAX_STREAM_IDLE_RETRIES
    const resolveCompletion = (engine as unknown as { resolveCompletion: ReturnType<typeof vi.fn> }).resolveCompletion
    const run = runnerOf(engine).run(engine.opts, REQ)
    await vi.advanceTimersByTimeAsync(1_000)
    await run
    expect(engine.agentStatus.status).toBe('error')
    expect(resolveCompletion).toHaveBeenCalledTimes(1)
  })

  it('an HTTP status error is never retried, even with budget left', async () => {
    setHost(makeDyingHost('HTTP 502: upstream unavailable — cause reported ECONNRESET inside the body'))
    const engine = makeEngine()
    const continueLoop = vi.fn()
    engine.continueLoop = continueLoop as unknown as typeof engine.continueLoop
    const run = runnerOf(engine).run(engine.opts, REQ)
    await vi.advanceTimersByTimeAsync(1_000)
    await run
    expect(continueLoop).not.toHaveBeenCalled()
    expect(engine.agentStatus.status).toBe('error')
  })

  it('idle timeouts and network failures share ONE budget — alternating shapes cannot loop forever', async () => {
    setHost(makeDyingHost('terminated'))
    const engine = makeEngine()
    const continueLoop = vi.fn()
    engine.continueLoop = continueLoop as unknown as typeof engine.continueLoop
    // First failure: one idle retry already spent, this network death spends
    // the second and last.
    engine.streamIdleRetries = 1
    const run1 = runnerOf(engine).run(engine.opts, REQ)
    await vi.advanceTimersByTimeAsync(1_000)
    await run1
    expect(continueLoop).toHaveBeenCalledTimes(1)
    expect(engine.streamIdleRetries).toBe(2)
    // Second consecutive transport failure: budget gone, hard stop — the
    // reset at the end of the catch only refills after a NON-transport error.
    const run2 = runnerOf(engine).run(engine.opts, REQ)
    await vi.advanceTimersByTimeAsync(1_000)
    await run2
    expect(continueLoop).toHaveBeenCalledTimes(1)
    expect(engine.agentStatus.status).toBe('error')
  })

  it('a non-transport error refills the shared budget (the reset still runs)', async () => {
    setHost(makeDyingHost('HTTP 401: invalid api key'))
    const engine = makeEngine()
    engine.streamIdleRetries = 2
    const run = runnerOf(engine).run(engine.opts, REQ)
    await vi.advanceTimersByTimeAsync(1_000)
    await run
    expect(engine.agentStatus.status).toBe('error')
    expect(engine.streamIdleRetries).toBe(0)
  })
})
