import { describe, expect, it, beforeEach } from 'vitest'
import type { PulseHost } from '../src/renderer/src/agent/host/types'
import { setHost } from '../src/renderer/src/agent/host'
import { AgentEngine } from '../src/renderer/src/agent/AgentEngine'
import { ToolManager } from '../src/renderer/src/tools/ToolManager'
import { SkillManager } from '../src/renderer/src/skills/SkillManager'
import type { SpawnSubAgentConfig, SubAgentHandle, SubAgentResult } from '../src/renderer/src/agent/agent-utils'
import type { ToolUseBlock, AgentStatus } from '../src/renderer/src/types/agent'
import { createPlanDag } from '../src/shared/plan/graph'
import {
  MAX_PARALLEL_SUBAGENTS,
  activeSubAgentCount,
  resetSubAgentLimiter,
  subAgentBudgetKey,
} from '../src/renderer/src/agent/engine/subagent-limiter'

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
function makeEngine(conversationId = 'conv_parallel_spawn', apiKey = ''): AgentEngine {
  return new AgentEngine({
    apiKey,
    baseURL: 'https://example.invalid',
    model: 'test-model',
    maxTokens: 512,
    myName: '',
    soul: '',
    yourName: '',
    adapter: {} as never,
    toolManager: new ToolManager(),
    skillManager: new SkillManager(),
    conversationId,
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
  resetSubAgentLimiter()
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
    expect(t.planNodeId).toBe('n2')
    // Both carriers of the node→session link (PLAN-workbench W12): the block
    // (card preview — travels on the status diff) and the plan node (the DAG's
    // node click — the only copy that is persisted with the plan).
    expect(t.subConvId).toBe('sub_conv_B')
    expect(engine.planManager.plan.nodes[1].subConvId).toBe('sub_conv_B')
    // Status-neutral: a dispatch links the node, advance_plan is what settles it.
    expect(engine.planManager.plan.nodes[1].status).toBe('pending')
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

/** 并行专家上限（PLAN-parallel-experts P2，用户裁定 2026-09-16：同一会话最多 3 人）。
 *  派发层的证明——一批五个 spawn 里同时在跑的专家数峰值必须是 3（引擎数、LLM
 *  流数跟着一起被压住），多出来的按 FIFO 等空位，且"停止之后不再起新专家"。 */
describe('parallel expert cap at dispatch (three per session)', () => {
  /** Fake sub-agents that count how many are in flight at once. The label comes
   *  from the delegated task, so the started order is assertable. */
  function stubTimedSpawns(engine: AgentEngine, delayMs: number) {
    const state = { running: 0, peak: 0, started: [] as string[] }
    engine.toolExecutor.spawnSubAgent = (config: SpawnSubAgentConfig): SubAgentHandle => {
      const label = String(config.title || '').split(': ').pop() || '?'
      state.started.push(label)
      state.running += 1
      state.peak = Math.max(state.peak, state.running)
      const completion = new Promise<SubAgentResult>((resolve) => {
        setTimeout(() => {
          state.running -= 1
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
    return state
  }

  const toolResultContent = (engine: AgentEngine, id: string): string =>
    engine.messages.flatMap(m => m.contentBlocks)
      .filter(b => b.type === 'tool_result' && (b as { tool_use_id: string }).tool_use_id === id)
      .map(b => (b as { content: string }).content)
      .join('\n')

  it('never runs more than three experts at once, and drains all five in FIFO order', async () => {
    const engine = makeEngine('conv_cap_batch')
    const state = stubTimedSpawns(engine, 30)
    const batch = [1, 2, 3, 4, 5].map(n => makeSpawnTool(`tu_${n}`, `task ${n}`))

    await engine.handleToolUseResponse(batch)

    expect(state.peak).toBe(MAX_PARALLEL_SUBAGENTS)
    expect(state.started).toEqual(['task 1', 'task 2', 'task 3', 'task 4', 'task 5'])
    expect(batch.every(t => t.exitCode === 0)).toBe(true)
    expect(new Set(toolResultIds(engine))).toEqual(new Set(batch.map(t => t.id)))
    // 全部收工后槽位归零：下一次派发不会排在上一次的队尾。
    expect(activeSubAgentCount('conv_cap_batch')).toBe(0)
  })

  it('ranks two sessions independently — a busy one does not starve the other', async () => {
    const left = makeEngine('conv_cap_left')
    const right = makeEngine('conv_cap_right')
    const leftState = stubTimedSpawns(left, 30)
    const rightState = stubTimedSpawns(right, 30)
    const leftBatch = [1, 2, 3, 4].map(n => makeSpawnTool(`l_${n}`, `L${n}`))
    const rightBatch = [1, 2, 3].map(n => makeSpawnTool(`r_${n}`, `R${n}`))

    await Promise.all([left.handleToolUseResponse(leftBatch), right.handleToolUseResponse(rightBatch)])

    expect(leftState.peak).toBe(MAX_PARALLEL_SUBAGENTS)
    expect(rightState.peak).toBe(MAX_PARALLEL_SUBAGENTS) // 右边的三个没被左边挡住
    expect(rightState.started).toEqual(['R1', 'R2', 'R3'])
    expect(leftState.started).toHaveLength(4)
  })

  it('starts no queued expert after the session is stopped', async () => {
    const engine = makeEngine('conv_cap_stop')
    const state = stubTimedSpawns(engine, 40)
    const batch = [1, 2, 3, 4].map(n => makeSpawnTool(`tu_${n}`, `task ${n}`))

    const dispatch = engine.handleToolUseResponse(batch)
    await new Promise(r => setTimeout(r, 5))
    expect(state.started).toEqual(['task 1', 'task 2', 'task 3']) // 第四个在排队

    engine.stopExecution()
    await dispatch

    expect(state.started).toEqual(['task 1', 'task 2', 'task 3']) // 停止后没有新专家启动
    expect(batch[3].exitCode).toBe(-1)
    expect(toolResultContent(engine, batch[3].id)).toContain('子代理未启动')
    expect(activeSubAgentCount('conv_cap_stop')).toBe(0)
  })

  it('a spawned engine spends its parent session’s budget', async () => {
    const engine = makeEngine('conv_cap_nested')
    const handle = engine.spawnSubAgent({
      systemPrompt: 'do a thing',
      initialMessages: [],
      title: '子代理: nested',
      maxTokens: 128,
      maxLoopIterations: 1,
    })
    const subEngine = engine.activeSubAgents.get(handle.id)!
    // 子代理的会话是自己的 sub_…，但预算键必须是父会话——否则嵌套 spawn 等于每层
    // 各拿三个槽位，上限形同虚设。
    expect(subEngine.opts.conversationId).toMatch(/^sub_/)
    expect(subAgentBudgetKey(subEngine.opts)).toBe('conv_cap_nested')

    // 先取 promise 再等（真实派发方就是这么用的：waitForCompletion 是 getter，
    // 结算时 completionPromise 被清空，之后再去读会拿到 undefined）。
    const completion = handle.waitForCompletion()
    // 停止把真实子引擎结算为 aborted：不结算就没人清它的 5s 存档定时器、没人放回
    // 槽位（本会话的三个槽位就此永久占死），尾部消息也不会落库。
    engine.stopExecution()
    const result = await completion
    expect(result.status).toBe('aborted')
    expect(engine.activeSubAgents.size).toBe(0)
  })
})

/** T8（PLAN-parallel-experts P3，L12 裁定：专家越过自己的循环上限就报错收摊）。
 *  旧的 +50 静默续期是主代理「自主扩展」的语义；在无人值守的专家身上，它等于一个
 *  卡住的专家永远不结束——父代理 `await spawnBatch` 挂死、FIFO 槽位队列被顶死。 */
describe('sub-agent loop limit settles for real (T8)', () => {
  it('a spawned engine crossing its loop limit errors out and settles its completion', async () => {
    // 父引擎带 apiKey：上限分支在 no-key 守卫之后，空 key 会先撞守卫、测不到它。
    const parent = makeEngine('conv_limit_real', 'test-key')
    const handle = parent.spawnSubAgent({
      systemPrompt: 'do a thing',
      initialMessages: [],
      title: '子代理: limit',
      maxTokens: 128,
      // 0 = 上限已耗尽：startSpawnLoop 原样赋值（?? 只认 null/undefined），
      // 第一轮 continueLoop（loopCount=1 > 0）就走 T8 分支——不必发起任何 LLM 请求。
      maxLoopIterations: 0,
    })
    const subEngine = parent.activeSubAgents.get(handle.id)!
    const completion = handle.waitForCompletion()
    const result = await completion

    expect(result.status).toBe('error') // 必须结算，且不是 completed
    expect(subEngine.agentStatus.status).toBe('error')
    expect(String(subEngine.agentStatus.error)).toContain('loop limit')
  })

  it('a limit-failed expert frees its slot — the queued fourth still starts', async () => {
    const engine = makeEngine('conv_cap_limitfail')
    // task 1 以 T8 产生的形态收场（completion 结算为 status:'error'），
    // 其余照常完成；五个里前三个占满槽位，第四个必须等 task 1 出错释放后启动。
    const state = { running: 0, peak: 0, started: [] as string[] }
    engine.toolExecutor.spawnSubAgent = (config: SpawnSubAgentConfig): SubAgentHandle => {
      const label = String(config.title || '').split(': ').pop() || '?'
      state.started.push(label)
      state.running += 1
      state.peak = Math.max(state.peak, state.running)
      const failed = label === 'task 1'
      const completion = new Promise<SubAgentResult>((resolve) => {
        setTimeout(() => {
          state.running -= 1
          resolve({
            status: failed ? 'error' : 'completed',
            messages: [{
              id: `m_${label}`,
              role: 'assistant',
              contentBlocks: [{ type: 'text', text: `${label} ${failed ? 'hit the limit' : 'done'}` }],
              createdAt: new Date().toISOString(),
            }],
          })
        }, 30)
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

    const batch = [1, 2, 3, 4].map(n => makeSpawnTool(`tu_${n}`, `task ${n}`))
    await engine.handleToolUseResponse(batch)

    expect(state.peak).toBe(MAX_PARALLEL_SUBAGENTS)
    expect(state.started).toEqual(['task 1', 'task 2', 'task 3', 'task 4']) // 出错释放后第四个照常启动
    expect(batch[0].exitCode).toBe(1) // 失败专家的卡上报失败
    expect(batch[3].exitCode).toBe(0)
    expect(activeSubAgentCount('conv_cap_limitfail')).toBe(0)
  })
})
