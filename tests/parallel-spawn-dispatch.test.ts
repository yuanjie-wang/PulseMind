import { describe, expect, it, beforeEach } from 'vitest'
import type { PulseHost } from '../src/renderer/src/agent/host/types'
import { setHost } from '../src/renderer/src/agent/host'
import { AgentEngine } from '../src/renderer/src/agent/AgentEngine'
import { ToolManager } from '../src/renderer/src/tools/ToolManager'
import { SkillManager } from '../src/renderer/src/skills/SkillManager'
import type { SpawnSubAgentConfig, SubAgentHandle, SubAgentResult } from '../src/renderer/src/agent/agent-utils'
import type { ToolUseBlock, AgentStatus } from '../src/renderer/src/types/agent'
import { createPlanDag } from '../src/shared/plan/graph'

/**
 * M1 multi-expert parallel delegation: a batch carrying several spawn_agent
 * calls must run them CONCURRENTLY (each call hosts an independent engine),
 * while every other system tool keeps its serial dispatch. The invariants
 * proved here with fake sub-agent handles of controlled timing:
 *
 *  1. overlap — the second expert starts before the first one finishes;
 *  2. isolation — one expert's failure settles as its own error tool_result
 *     without tearing down the sibling still in flight;
 *  3. drain — every result lands, pendingToolIds empties, and the post-batch
 *     continueLoop runs exactly once (it stops on the no-apiKey guard here).
 */

let calls: string[] = []

function makeMockHost(): PulseHost {
  const record = (name: string) => () => {
    calls.push(name)
    return Promise.resolve([] as unknown[])
  }
  return {
    onApiStreamChunk: record('onApiStreamChunk'),
    onApiStreamError: record('onApiStreamError'),
    onApiStreamDone: record('onApiStreamDone'),
    onApiStreamRetry: record('onApiStreamRetry'),
    onTerminalOutput: record('onTerminalOutput'),
    onTerminalExit: record('onTerminalExit'),
    onTerminalError: record('onTerminalError'),
    onMcpServersChanged: record('onMcpServersChanged'),
    onSkillsChanged: record('onSkillsChanged'),
    mcpListServers: record('mcpListServers'),
    expertList: record('expertList'),
    getSkillPreferences: record('getSkillPreferences'),
    getSettings: () => Promise.resolve({ locale: 'zh' }),
    ...Object.fromEntries(
      [
        'apiAbortStream', 'apiFetch', 'apiFetchStream', 'execCommandSync', 'executeCommand',
        'killCommand', 'readFile', 'writeFile', 'editFile', 'patchFile', 'getFileStat',
        'convertFileToMarkdown', 'copyFileToTmp', 'saveBase64Image', 'gitInvoke',
        'mcpStartServer', 'mcpRegisterServer', 'mcpUpdateServerSummary', 'mcpCallTool',
        'setSkillPreferences', 'readSkillRaw', 'installSkill', 'readExperienceRecord',
        'touchExperienceRecord', 'saveMemory', 'searchConversationsByKeyword', 'getToolResult',
        'getConversation', 'saveConversation', 'appendConversationMessages',
        'persistToolResults', 'saveConversationPlan', 'getConversationPlan',
      ].map(k => [k, record(k)]),
    ),
  } as unknown as PulseHost
}

/** Empty apiKey is deliberate: the post-batch continueLoop must land on the
 *  no-key guard and stop — a contained, assertable drain (no LLM call). */
function makeEngine(): AgentEngine {
  return new AgentEngine({
    apiKey: '',
    baseURL: 'https://example.invalid',
    model: 'test-model',
    maxTokens: 512,
    myName: '',
    soul: '',
    yourName: '',
    adapter: {} as never,
    toolManager: new ToolManager(),
    skillManager: new SkillManager(),
    conversationId: 'conv_parallel_spawn',
  })
}

const makeSpawnTool = (id: string, task: string, planNode?: string): ToolUseBlock =>
  ({
    type: 'tool_use',
    id,
    name: 'spawn_agent',
    input: planNode ? { subAgentId: '', task, planNode } : { subAgentId: '', task },
    status: 'pending',
  }) as ToolUseBlock

/** Fake sub-agent hosting with per-expert timing. The label is read from the
 *  delegated task ('task A' / 'task B'); startedAt/finishedAt give the
 *  overlap invariant real timestamps instead of array-order coincidences. */
function stubSpawns(
  engine: AgentEngine,
  plan: Record<string, { delayMs: number; fail?: boolean }>,
) {
  const startedAt = new Map<string, number>()
  const finishedAt = new Map<string, number>()
  engine.toolExecutor.spawnSubAgent = (config: SpawnSubAgentConfig): SubAgentHandle => {
    const label = (config.title || '').includes('task A') ? 'A' : 'B'
    startedAt.set(label, Date.now())
    const { delayMs, fail } = plan[label]
    const completion = new Promise<SubAgentResult>((resolve, reject) => {
      setTimeout(() => {
        finishedAt.set(label, Date.now())
        if (fail) {
          reject(new Error(`expert ${label} failed`))
          return
        }
        resolve({
          status: 'completed',
          messages: [{
            id: `m_${label}`,
            role: 'assistant',
            contentBlocks: [{ type: 'text', text: `${label} done` }],
            createdAt: new Date().toISOString(),
          }],
        })
      }, delayMs)
    })
    return {
      id: `sub_${label}`,
      subConvId: `sub_conv_${label}`,
      messages: [],
      agentStatus: { status: 'idle' } as AgentStatus,
      abort: () => {},
      waitForCompletion: () => completion,
    }
  }
  return { startedAt, finishedAt }
}

const toolResultIds = (engine: AgentEngine): string[] =>
  engine.messages.flatMap(m => m.contentBlocks).filter(b => b.type === 'tool_result').map(b => (b as { tool_use_id: string }).tool_use_id)

beforeEach(() => {
  calls = []
  setHost(makeMockHost())
})

describe('parallel spawn_agent dispatch (multi-expert delegation)', () => {
  it('runs a batch of two spawn_agent calls concurrently and drains both results', async () => {
    const engine = makeEngine()
    const { startedAt, finishedAt } = stubSpawns(engine, { A: { delayMs: 200 }, B: { delayMs: 30 } })
    // The blocks are asserted directly: in production stream-runner appends
    // them to messages before handleToolUseResponse; the dispatch mutates
    // these very objects in place.
    const tuA = makeSpawnTool('tu_a', 'task A')
    const tuB = makeSpawnTool('tu_b', 'task B')

    await engine.handleToolUseResponse([tuA, tuB])

    // Overlap invariant: B was already hosting while A was still running.
    // Serial dispatch would satisfy startedAt(B) >= finishedAt(A) instead.
    expect(startedAt.get('A')!).toBeLessThanOrEqual(startedAt.get('B')!)
    expect(startedAt.get('B')!).toBeLessThan(finishedAt.get('A')!)

    // Both tool cards completed and both results reached the parent thread.
    expect(tuA.status).toBe('completed')
    expect(tuA.exitCode).toBe(0)
    expect(tuB.status).toBe('completed')
    expect(tuB.exitCode).toBe(0)
    expect(new Set(toolResultIds(engine))).toEqual(new Set(['tu_a', 'tu_b']))

    // Drain: the batch-end continueLoop fired once and stopped on the no-key guard.
    await new Promise(r => setTimeout(r, 30))
    expect(engine.agentStatus).toEqual({ status: 'error', error: 'API key not configured' })
  })

  it('isolates a failing expert: its own error result settles, the sibling completes', async () => {
    const engine = makeEngine()
    stubSpawns(engine, { A: { delayMs: 30, fail: true }, B: { delayMs: 60 } })
    const tuA = makeSpawnTool('tu_a', 'task A')
    const tuB = makeSpawnTool('tu_b', 'task B')

    await engine.handleToolUseResponse([tuA, tuB])

    expect(tuA.exitCode).toBe(-1)
    expect(tuB.exitCode).toBe(0)

    const results = engine.messages.flatMap(m => m.contentBlocks).filter(b => b.type === 'tool_result') as Array<{ tool_use_id: string; is_error?: boolean }>
    expect(results).toHaveLength(2)
    expect(results.find(r => r.tool_use_id === 'tu_a')?.is_error).toBe(true)
    expect(results.find(r => r.tool_use_id === 'tu_b')?.is_error).toBeFalsy()

    await new Promise(r => setTimeout(r, 30))
    expect(engine.agentStatus).toEqual({ status: 'error', error: 'API key not configured' })
  })

  it('keeps the single-spawn batch (the common case) working end to end', async () => {
    const engine = makeEngine()
    stubSpawns(engine, { A: { delayMs: 30 } })

    await engine.handleToolUseResponse([makeSpawnTool('tu_a', 'task A')])

    expect(toolResultIds(engine)).toEqual(['tu_a'])
    await new Promise(r => setTimeout(r, 30))
    expect(engine.agentStatus).toEqual({ status: 'error', error: 'API key not configured' })
  })
})

/** The create_plan → spawn_agent → advance_plan chain (PLAN-plan-dag): the
 *  spawn's planNode is validated against the LIVE plan, threaded into the
 *  sub-agent's task scope, and echoed back with the settle call. */
describe('spawn_agent planNode linkage', () => {
  const toolResultContent = (engine: AgentEngine, id: string): string =>
    engine.messages.flatMap(m => m.contentBlocks)
      .filter(b => b.type === 'tool_result' && (b as { tool_use_id: string }).tool_use_id === id)
      .map(b => (b as { content: string }).content)
      .join('\n')

  it('accepts a valid planNode, marks the card, and returns the settle reminder', async () => {
    const engine = makeEngine()
    const { finishedAt } = stubSpawns(engine, { A: { delayMs: 20 }, B: { delayMs: 20 } })
    engine.planManager.plan = createPlanDag('ship', [{ description: '调研' }, { description: '前端' }])
    const t = makeSpawnTool('tu_p', 'do the frontend', '2')

    await engine.handleToolUseResponse([t])

    expect(t.exitCode).toBe(0)
    expect((t as unknown as { _planNodeId?: string })._planNodeId).toBe('n2')
    const content = toolResultContent(engine, 'tu_p')
    expect(content).toContain('**Plan node n2** ("前端")')
    expect(content).toContain('advance_plan action="complete" node=2')
    expect(finishedAt.size).toBe(1) // the sub-agent actually ran
  })

  it('rejects unknown, already-settled and planless planNode references', async () => {
    const engine = makeEngine()
    stubSpawns(engine, { A: { delayMs: 20 }, B: { delayMs: 20 } })
    engine.planManager.plan = createPlanDag('ship', [{ description: 'a' }, { description: 'b' }])
    engine.planManager.plan.nodes[0].status = 'completed'

    const unknown = makeSpawnTool('tu_9', 'task', '9')
    await engine.handleToolUseResponse([unknown])
    expect(unknown.exitCode).toBe(-1)
    expect(toolResultContent(engine, 'tu_9')).toContain('Unknown planNode "9"')

    const settled = makeSpawnTool('tu_done', 'task', 1)
    await engine.handleToolUseResponse([settled])
    expect(settled.exitCode).toBe(-1)
    expect(toolResultContent(engine, 'tu_done')).toContain('already completed')

    const planless = makeEngine()
    stubSpawns(planless, { A: { delayMs: 20 }, B: { delayMs: 20 } })
    const noPlan = makeSpawnTool('tu_np', 'task', '2')
    await planless.handleToolUseResponse([noPlan])
    expect(noPlan.exitCode).toBe(-1)
    expect(toolResultContent(planless, 'tu_np')).toContain('no plan is active')
  })
})
