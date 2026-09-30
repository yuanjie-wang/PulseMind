import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Same HOME sandbox as thinking-only-retry.test.ts — the engine import chain
// touches real stores, and a test must never write into the user's live
// ~/.pulsemind.
process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-stream-done-watchdog-'))

const { AgentEngine } = await import('../src/renderer/src/agent/AgentEngine')
const { openaiAdapter } = await import('../src/renderer/src/llm/OpenAIAdapter')
const { ToolManager } = await import('../src/renderer/src/tools/ToolManager')
const { SkillManager } = await import('../src/renderer/src/skills/SkillManager')
const { STREAM_DONE_WATCHDOG_MS, STREAM_DONE_WATCHDOG_ERROR } = await import('../src/renderer/src/agent/engine/engine-constants')

import type { PulseHost } from '../src/renderer/src/agent/host/types'
import { setHost } from '../src/renderer/src/agent/host'
import type { AgentEngineOptions } from '../src/renderer/src/agent/AgentEngine'

/**
 * conv_20260930091135 (2026-09-30): two plan sub-agents parked mid-run for
 * hours with no error, no settlement and no socket — an await on
 * streamDonePromise whose resolver was dropped somewhere below. The watchdog
 * converts that eternal await into a retryable error: a silently-resolved
 * apiFetchStream (no done, no error) must trip the watchdog after
 * STREAM_DONE_WATCHDOG_MS, take the idle-retry path while retries remain, and
 * end the turn with an explicit error (settling a spawned agent) once they
 * are exhausted.
 */

type Runner = {
  run(opts: AgentEngineOptions, req: { apiUrl: string; headers: Record<string, string>; resolvedBody: unknown }): Promise<void>
}
const REQ = { apiUrl: 'https://example.invalid/v1/chat/completions', headers: {}, resolvedBody: {} }
const runnerOf = (engine: InstanceType<typeof AgentEngine>): Runner =>
  (engine as unknown as { streamRunner: Runner }).streamRunner

/** A host whose apiFetchStream resolves WITHOUT ever emitting done/error —
 *  the dropped-resolver shape. */
function makeSilentHost(): PulseHost {
  const noop = () => Promise.resolve([] as unknown[])
  return {
    onApiStreamChunk: () => () => {},
    onApiStreamError: () => () => {},
    onApiStreamDone: () => () => {},
    onApiStreamRetry: () => () => {},
    apiFetchStream: async () => {},
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

function makeEngine(spawned: boolean) {
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
    conversationId: 'conv_stream_done_watchdog',
    ...(spawned ? {} : {}),
  } as unknown as AgentEngineOptions)
  if (spawned) {
    engine.spawnSystemPrompt = 'test spawn prompt'
    ;(engine as unknown as { resolveCompletion: unknown }).resolveCompletion = vi.fn()
  }
  return engine
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('stream-done watchdog (dropped done/error resolver)', () => {
  it('constant sanity', () => {
    expect(STREAM_DONE_WATCHDOG_MS).toBe(30_000)
    expect(STREAM_DONE_WATCHDOG_ERROR).toContain('stream done watchdog')
  })

  it('a silently-resolved stream trips the watchdog and takes the idle-retry path', async () => {
    setHost(makeSilentHost())
    const engine = makeEngine(false)
    const continueLoop = vi.fn()
    engine.continueLoop = continueLoop as unknown as typeof engine.continueLoop
    const run = runnerOf(engine).run(engine.opts, REQ)
    await vi.advanceTimersByTimeAsync(STREAM_DONE_WATCHDOG_MS + 1_000)
    await run
    expect(continueLoop).toHaveBeenCalledTimes(1)
    expect(engine.streamIdleRetries).toBe(1)
    expect(engine.agentStatus.status).toBe('retrying')
  })

  it('with retries exhausted the turn ends in an explicit error and settles the spawn', async () => {
    setHost(makeSilentHost())
    const engine = makeEngine(true)
    engine.streamIdleRetries = 2 // MAX_STREAM_IDLE_RETRIES — no retry budget left
    const resolveCompletion = (engine as unknown as { resolveCompletion: ReturnType<typeof vi.fn> }).resolveCompletion
    const run = runnerOf(engine).run(engine.opts, REQ)
    await vi.advanceTimersByTimeAsync(STREAM_DONE_WATCHDOG_MS + 1_000)
    await run
    expect(engine.agentStatus.status).toBe('error')
    expect(engine.agentStatus.error).toContain('stream done watchdog')
    expect(resolveCompletion).toHaveBeenCalledTimes(1)
    const result = resolveCompletion.mock.calls[0][0] as { status: string; error?: string }
    expect(result.status).toBe('error')
    expect(result.error).toContain('stream done watchdog')
  })
})
