/**
 * The spawn_agent re-dispatch gate (2026-10-27): a free-form task this
 * session already COMPLETED is refused before any sub-agent starts. The
 * measured incident all the prose layers failed to stop: mimo re-dispatched
 * a finished translation five times (AGENTS.md, the Tool Protocols origin).
 *
 * Drives the REAL execSpawnAgent with a minimal context fake — the gate sits
 * before the slot acquisition, so no host, limiter or sub-engine is touched
 * on the refusal path. The negative control (a FAILED prior passes) lets the
 * call continue past the gate into the (fake-host-less) failure it meets
 * downstream — the assertion is only that the REFUSAL did not fire.
 */
import { describe, expect, it } from 'vitest'
import type { ToolUseBlock } from '../src/renderer/src/types/agent'

const { execSpawnAgent, spawnTaskSignature, spawnRedispatchRejection } = await import(
  '../src/renderer/src/agent/executors/spawn-tool'
)
type ToolExecContext = Parameters<typeof execSpawnAgent>[0]

const TASK = '把这份合同 翻译成英文'

function makeContext(results: Map<string, 'completed' | 'failed' | 'aborted'>, opts: Record<string, unknown> = {}): {
  ex: ToolExecContext
  state: { captured: { content: string; isError: boolean } | null }
  notifies: () => number
} {
  // The holder object is the point: returning `captured` itself would return
  // the null snapshot, not the closure's live binding.
  const state: { captured: { content: string; isError: boolean } | null } = { captured: null }
  let notifyCount = 0
  const ex = {
    opts: { spawnedToolset: false, workspaceDir: '/ws', ...opts },
    notify: () => { notifyCount++ },
    addToolResult: (_id: string, content: string, isError: boolean) => { state.captured = { content, isError } },
    spawnTaskResults: results,
  } as unknown as ToolExecContext
  return { ex, state, notifies: () => notifyCount }
}

const block = (input: Record<string, unknown>): ToolUseBlock =>
  ({ type: 'tool_use', id: 't_redispatch', name: 'spawn_agent', input, status: 'queued' }) as ToolUseBlock

describe('spawnTaskSignature', () => {
  it('normalizes whitespace and case so a reformatted repeat matches', () => {
    expect(spawnTaskSignature(`  把这份合同\n\n   翻译成英文  `)).toBe(spawnTaskSignature('把这份合同 翻译成英文'))
    expect(spawnTaskSignature('REFACTOR the auth module')).toBe(spawnTaskSignature('refactor the auth module'))
    expect(spawnTaskSignature('a')).not.toBe(spawnTaskSignature('b'))
  })
})

describe('re-dispatch gate', () => {
  it('refuses a free-form task whose signature already COMPLETED, before any host touch', async () => {
    const results = new Map([[spawnTaskSignature(TASK), 'completed' as const]])
    const { ex, state, notifies } = makeContext(results)
    const t = block({ task: TASK })
    await execSpawnAgent(ex, t)
    expect(state.captured?.content).toBe(spawnRedispatchRejection())
    expect(state.captured?.isError).toBe(true)
    expect(t.exitCode).toBe(-1)
    expect(t.status).toBe('completed')
    // The gate settles synchronously before the FIFO — one flip to queued,
    // one settle notify.
    expect(notifies()).toBe(2)
  })

  it('a reformatted repeat of the same task trips the same signature', async () => {
    const results = new Map([[spawnTaskSignature(TASK), 'completed' as const]])
    const { ex, state } = makeContext(results)
    // \s+ collapses to ONE space — it cannot invent or delete a space, so the
    // repeat differs from the seed by whitespace shape only.
    const t = block({ task: '把这份合同\n  翻译成英文' })
    await execSpawnAgent(ex, t)
    expect(state.captured?.content).toBe(spawnRedispatchRejection())
  })

  it("a FAILED prior passes the gate — a failed task's retry is the protocol", async () => {
    const results = new Map([[spawnTaskSignature(TASK), 'failed' as const]])
    const { ex, state } = makeContext(results)
    // No spawnSubAgent on the fake: the call proceeds past the gate and dies
    // downstream — the assertion is only that the REFUSAL did not fire.
    await execSpawnAgent(ex, block({ task: TASK }))
    expect(state.captured?.content).not.toBe(spawnRedispatchRejection())
  })

  it('an aborted prior passes the gate — a user-stopped spawn did not complete', async () => {
    const results = new Map([[spawnTaskSignature(TASK), 'aborted' as const]])
    const { ex, state } = makeContext(results)
    await execSpawnAgent(ex, block({ task: TASK }))
    expect(state.captured?.content).not.toBe(spawnRedispatchRejection())
  })

  it('a plan-node spawn never enters the gate — its re-dispatch IS the protocol', async () => {
    const results = new Map([[spawnTaskSignature(TASK), 'completed' as const]])
    const { ex, state } = makeContext(results)
    // planNode without a live plan fails its own validation (a different,
    // earlier message) — the point is that the ledger never answers it.
    await execSpawnAgent(ex, block({ task: TASK, planNode: 1 }))
    expect(state.captured?.content).not.toBe(spawnRedispatchRejection())
  })
})

describe('wiring', () => {
  it('the ledger is a real field on ToolExecutor and the gate reads it', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const root = join(__dirname, '..')
    const executorSrc = readFileSync(join(root, 'src/renderer/src/agent/tool-executors.ts'), 'utf8')
    expect(executorSrc).toContain('spawnTaskResults = new Map')
    const spawnSrc = readFileSync(join(root, 'src/renderer/src/agent/executors/spawn-tool.ts'), 'utf8')
    expect(spawnSrc).toContain('ex.spawnTaskResults?.get(spawnTaskSignature(task))')
    expect(spawnSrc).toContain('!planNode')
    // The recording side is inside the completion path, before the slot release.
    expect(spawnSrc).toMatch(/if \(!planNode && ex\.spawnTaskResults\)/)
    expect(spawnSrc.indexOf('ex.spawnTaskResults.set')).toBeGreaterThan(-1)
  })
})
