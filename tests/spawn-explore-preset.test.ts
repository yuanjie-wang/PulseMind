/**
 * The spawn_agent explore preset (2026-10-27 验证闭环批次 #2): a READ-ONLY
 * reconnaissance delegation — toolset whitelist + a report contract on the
 * spawn system prompt. Drives the REAL execSpawnAgent with a minimal context
 * fake (spawn-redispatch-gate.test.ts's harness): the preset validation sits
 * with the other synchronous checks, before the slot queue, so no host beyond
 * the readFile probe is touched on the rejection paths; the happy path is
 * settled by a fake handle that reports a completed result.
 *
 * The toolset whitelist itself is enforced downstream by tool-collection's
 * allowedToolsSet filter (already pinned by the extension-page-tools routing
 * tests' membership machinery); what this suite pins is the spawn-side
 * WIRING: the preset's whitelist rides config, the contract rides the prompt,
 * and the two conflict rejections fire before any sub-agent starts.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-spawn-explore-'))

const { execSpawnAgent, spawnTaskSignature, EXPLORE_TOOLSET, EXPLORE_REPORT_CONTRACT } = await import(
  '../src/renderer/src/agent/executors/spawn-tool'
)
const { setHost } = await import('../src/renderer/src/agent/host')
import type { ToolUseBlock } from '../src/renderer/src/types/agent'

type ToolExecContext = Parameters<typeof execSpawnAgent>[0]
type SpawnConfig = Parameters<NonNullable<ToolExecContext['spawnSubAgent']>>[0]

const TASK = '摸清 auth 模块的入口和调用链'

interface Harness {
  ex: ToolExecContext
  config: { captured: SpawnConfig | null }
  state: { captured: { content: string; isError: boolean } | null }
  plan: { value: unknown }
}

function makeHarness(opts: {
  plan?: unknown
  results?: Map<string, 'completed' | 'failed' | 'aborted'>
} = {}): Harness {
  const config: { captured: SpawnConfig | null } = { captured: null }
  const state: { captured: { content: string; isError: boolean } | null } = { captured: null }
  const plan = { value: opts.plan ?? null }
  const ex = {
    opts: { spawnedToolset: false, workspaceDir: '/ws', maxTokens: 1000, earlyStopGuard: false },
    notify: () => {},
    addToolResult: (_id: string, content: string, isError: boolean) => { state.captured = { content, isError } },
    spawnTaskResults: opts.results ?? new Map(),
    getPlan: () => plan.value,
    spawnSubAgent: (c: SpawnConfig) => {
      config.captured = c
      return {
        id: 'sub_1',
        subConvId: 'sub_conv_1',
        waitForCompletion: async () => ({
          messages: [{
            id: 'm1', role: 'assistant', createdAt: new Date().toISOString(),
            contentBlocks: [{ type: 'text', text: 'Map: src/auth/index.ts:10 — entry point.' }],
          }],
          status: 'completed',
          outputTokens: 10,
        }),
      }
    },
  } as unknown as ToolExecContext
  return { ex, config, state, plan }
}

const block = (input: Record<string, unknown>): ToolUseBlock =>
  ({ type: 'tool_use', id: 't_spawn', name: 'spawn_agent', input, status: 'queued' }) as ToolUseBlock

describe('explore preset — happy path', () => {
  it('restricts the toolset, appends the report contract, records the ledger', async () => {
    setHost({ readFile: async () => null } as never)
    const h = makeHarness()
    const t = block({ task: TASK, preset: 'explore' })
    await execSpawnAgent(h.ex, t)

    expect(h.config.captured).not.toBeNull()
    expect(h.config.captured!.allowedTools).toEqual(EXPLORE_TOOLSET)
    expect(h.config.captured!.allowedSkills).toBeUndefined()
    // The contract rides the spawn system prompt's tail (the model decides its
    // next move off the last bytes), and the engineering workflow still holds.
    const prompt = h.config.captured!.systemPrompt
    expect(prompt).toContain('## Explore Mode')
    expect(prompt).toContain('READ-ONLY')
    expect(prompt).toContain('path:line')
    // Tail position is the design: the model decides its next move off the
    // last bytes, so the contract is the prompt's END (after the workflow).
    expect(prompt.endsWith(EXPLORE_REPORT_CONTRACT)).toBe(true)
    // The task itself stays the first user message (the 2026-09-25 ruling).
    expect(h.config.captured!.initialMessages[0].contentBlocks[0]).toMatchObject({ type: 'text' })
    expect((h.config.captured!.initialMessages[0].contentBlocks[0] as { text: string }).text).toContain(TASK)
    // Settles as a normal completed delegation.
    expect(t.exitCode).toBe(0)
    expect(h.state.captured?.content).toContain('Sub-Agent Result (completed)')
    expect(h.state.captured?.content).toContain('do NOT re-dispatch')
    expect(h.ex.spawnTaskResults?.get(spawnTaskSignature(TASK))).toBe('completed')
  })

  it('a plain spawn (no preset) stays unrestricted and contract-free', async () => {
    setHost({ readFile: async () => null } as never)
    const h = makeHarness()
    await execSpawnAgent(h.ex, block({ task: TASK }))
    expect(h.config.captured!.allowedTools).toBeUndefined()
    expect(h.config.captured!.systemPrompt).not.toContain('## Explore Mode')
  })
})

describe('explore preset — synchronous rejections', () => {
  it('rejects an unknown preset name before any sub-agent starts', async () => {
    setHost({ readFile: async () => null } as never)
    const h = makeHarness()
    await execSpawnAgent(h.ex, block({ task: TASK, preset: 'research' }))
    expect(h.state.captured?.content).toContain('Unknown preset "research"')
    expect(h.config.captured).toBeNull()
  })

  it('rejects explore × planNode — a plan node owes a report file, explore writes nothing', async () => {
    setHost({ readFile: async () => null } as never)
    // mode 'direct' skips the scheduler-ownership gate so THIS gate is what fires.
    const plan = {
      id: 'p1', objective: 'x', mode: 'direct',
      nodes: [{ id: 'n1', description: 'explore the auth module', status: 'pending', dependsOn: [] }],
    }
    const h = makeHarness({ plan })
    await execSpawnAgent(h.ex, block({ task: TASK, preset: 'explore', planNode: '1' }))
    expect(h.state.captured?.content).toContain('cannot be combined with planNode')
    expect(h.config.captured).toBeNull()
  })
})
