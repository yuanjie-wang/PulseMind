import { describe, expect, it, beforeEach } from 'vitest'
import type { PulseHost } from '../src/renderer/src/agent/host/types'
import { setHost } from '../src/renderer/src/agent/host'
import { ToolManager } from '../src/renderer/src/tools/ToolManager'
import { BUILT_IN_TOOLS, SUB_AGENT_DENY_TOOLS, SUB_PLAN_BUILT_IN_TOOLS } from '../src/renderer/src/tools/built-in-tools'
import type { ToolManager as ToolManagerType } from '../src/renderer/src/tools/ToolManager'
import { collectEnabledTools } from '../src/renderer/src/agent/engine/tool-collection'
import type { ToolCollectionDeps } from '../src/renderer/src/agent/engine/tool-collection'
import type { AgentEngineOptions } from '../src/renderer/src/agent/AgentEngine'
import { AgentEngine } from '../src/renderer/src/agent/AgentEngine'
import { SkillManager } from '../src/renderer/src/skills/SkillManager'
import { resetSubAgentLimiter } from '../src/renderer/src/agent/engine/subagent-limiter'
import type { ToolUseBlock } from '../src/renderer/src/types/agent'
import type { SplitChildSpec } from '../src/shared/plan/split-proposal'

/**
 * 子代理工具边界（PLAN-plan-split v2 R2/R6，用户裁定 2026-09-29）：
 *
 *  1. spawnedToolset 摘除 create_plan / advance_plan / spawn_agent —— 子代理
 *     不建图、不结算、不派生；主 Agent 工具集不受影响。
 *  2. create_sub_plan 只为可拆节点的 spawn 存在（opts.spawnPlanSplit 是
 *     工具集门 + 桥参数载体）——gen-1 子代理与普通会话都看不到它。
 *  3. 真实父子引擎的窄桥：spawn-manager 挂 parentPlanMerge，子引擎
 *     createSubPlan → 父 planManager.mergeSplitProposal（midprocess 形状），
 *     createdIds 回填供父层信封注记。
 *
 * 非空验证：摘掉 collectEnabledTools 的 spawnedToolset 过滤 → 用例 ① 立红。
 */

function makeMockHost(): PulseHost {
  const noop = () => Promise.resolve([] as unknown[])
  return {
    onApiStreamChunk: () => () => {},
    onApiStreamError: () => () => {},
    onApiStreamDone: () => () => {},
    onApiStreamRetry: () => () => {},
    onTerminalOutput: () => () => {},
    onTerminalExit: () => () => {},
    onTerminalError: () => () => {},
    onMcpServersChanged: () => () => {},
    onSkillsChanged: () => () => {},
    mcpListServers: noop,
    expertList: noop,
    getSkillPreferences: () => Promise.resolve({}),
    getSettings: () => Promise.resolve({ locale: 'zh' }),
    saveConversation: noop,
    appendConversationMessages: noop,
    saveConversationPlan: noop,
    getConversationPlan: noop,
  } as unknown as PulseHost
}

beforeEach(() => {
  setHost(makeMockHost())
  resetSubAgentLimiter()
})

function fullToolManager(): ToolManagerType {
  const tm = new ToolManager() as ToolManagerType
  tm.applyPreferences({ enabledTools: BUILT_IN_TOOLS.map((t) => t.name) })
  return tm
}

function deps(opts: Partial<AgentEngineOptions> = {}): ToolCollectionDeps {
  return {
    mcpToolOwner: new Map(),
    selectedBuiltinTools: [],
    selectedMcpTools: [],
    messages: [],
    opts: { toolManager: fullToolManager(), skillManager: undefined, ...opts } as unknown as AgentEngineOptions,
  }
}

const names = async (opts: Partial<AgentEngineOptions> = {}): Promise<string[]> =>
  (await collectEnabledTools(deps(opts), fullToolManager())).map((t) => t.name)

describe('the sub-agent tool boundary (v2 R2)', () => {
  it('a spawned toolset drops create_plan / advance_plan / spawn_agent; the main engine keeps them', async () => {
    const sub = await names({ spawnedToolset: true })
    for (const denied of SUB_AGENT_DENY_TOOLS) expect(sub).not.toContain(denied)
    expect(sub).toContain('read')

    const main = await names({})
    for (const denied of SUB_AGENT_DENY_TOOLS) expect(main).toContain(denied)
  })

  it('the deny list is exactly the ruled three', () => {
    expect(SUB_AGENT_DENY_TOOLS).toEqual(['create_plan', 'advance_plan', 'spawn_agent'])
  })
})

describe('create_sub_plan: sub-agent-only, splittable-node-only (v2 R6)', () => {
  it('present only when opts.spawnPlanSplit is set (and never on a main engine)', async () => {
    const armed = await names({ spawnedToolset: true, spawnPlanSplit: { nodeRef: 'n1', attemptId: 'a1' } })
    expect(armed).toContain('create_sub_plan')

    const unarmedSub = await names({ spawnedToolset: true })
    expect(unarmedSub).not.toContain('create_sub_plan')

    const main = await names({ spawnPlanSplit: { nodeRef: 'n1', attemptId: 'a1' } as never })
    // Even with the opt somehow present, a non-spawned toolset carries no
    // sub-plan tool — the merge door keys on the opt, the SEMANTICS on the
    // bridge; a main engine has neither wired.
    expect(main).not.toContain('create_sub_plan')
  })

  it('the tool definition is not in the desktop registry', () => {
    expect(BUILT_IN_TOOLS.map(t => t.name)).not.toContain('create_sub_plan')
    expect(SUB_PLAN_BUILT_IN_TOOLS.map(t => t.name)).toEqual(['create_sub_plan'])
  })
})

describe('the narrow parent-plan bridge on real engines (v2 R6)', () => {
  function makeEngine(conversationId: string): AgentEngine {
    return new AgentEngine({
      apiKey: '', baseURL: 'https://example.invalid', model: 'test-model', maxTokens: 512,
      myName: '', soul: '', yourName: '',
      adapter: {} as never,
      toolManager: new ToolManager(),
      skillManager: new SkillManager(),
      conversationId,
    })
  }

  it('spawnSubAgent with planSplit wires the bridge; createSubPlan merges into the PARENT plan', async () => {
    const engine = makeEngine('conv_bridge')
    engine.planManager.plan = {
      objective: 'ship it',
      version: 2,
      mode: 'delegated',
      completed: false,
      nodes: [
        { id: 'n1', description: '调研', status: 'pending', dependsOn: [] },
        { id: 'n2', description: '发布', status: 'pending', dependsOn: ['n1'] },
      ],
    }
    engine.planManager.beginNodeExecution('n1', 'attempt_parent')

    const handle = engine.spawnSubAgent({
      systemPrompt: 'do a thing',
      initialMessages: [],
      title: '子代理: split bridge',
      maxTokens: 128,
      maxLoopIterations: 1,
      planSplit: { nodeRef: 'n1', attemptId: 'attempt_parent', createdIds: [] },
    })
    const sub = engine.activeSubAgents.get(handle.id)!

    // The opts carry both the boundary and the bridge constants.
    expect(sub.opts.spawnedToolset).toBe(true)
    expect(sub.opts.spawnPlanSplit).toEqual({ nodeRef: 'n1', attemptId: 'attempt_parent' })

    // The sub-agent splits through its executor; the PARENT plan grows.
    const result = sub.toolExecutor.createSubPlan([{ description: '子任务A' }, { description: '子任务B', dependsOn: [1] } as SplitChildSpec])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.nodeIds).toEqual(['n3', 'n4'])

    const plan = engine.planManager.plan!
    expect(plan.nodes.map(n => n.id)).toEqual(['n1', 'n2', 'n3', 'n4'])
    expect(plan.nodes[0].status).toBe('pending') // X untouched
    expect(plan.nodes[1].dependsOn).toEqual(['n1', 'n3', 'n4']) // downstream union
    expect(plan.nodes[2].dependsOn).toEqual(['n1']) // children wait on X

    const completion = handle.waitForCompletion()
    engine.stopExecution()
    await completion
    expect(engine.activeSubAgents.size).toBe(0)
  })

  it('CAS: a proposal under a superseded attemptId is rejected through the bridge', async () => {
    const engine = makeEngine('conv_bridge_cas')
    engine.planManager.plan = {
      objective: 'ship it', version: 2, mode: 'delegated', completed: false,
      nodes: [{ id: 'n1', description: '调研', status: 'pending', dependsOn: [] }],
    }
    engine.planManager.beginNodeExecution('n1', 'attempt_live')

    const handle = engine.spawnSubAgent({
      systemPrompt: 'x', initialMessages: [], title: '子代理: stale',
      maxTokens: 128, maxLoopIterations: 1,
      planSplit: { nodeRef: 'n1', attemptId: 'attempt_STALE', createdIds: [] },
    })
    const sub = engine.activeSubAgents.get(handle.id)!
    const result = sub.toolExecutor.createSubPlan([{ description: 'A' }, { description: 'B' }])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('Attempt mismatch')

    const completion = handle.waitForCompletion()
    engine.stopExecution()
    await completion
  })
})

describe('the executor boundary guard (out-of-schema hallucination)', () => {
  it('execSpawnAgent refuses on a spawned toolset before any dispatch', async () => {
    const { execSpawnAgent } = await import('../src/renderer/src/agent/executors/spawn-tool')
    const captured: Array<{ content: string; isError: boolean }> = []
    const ex = {
      opts: { conversationId: 'conv_guard', spawnedToolset: true },
      notify: () => {},
      addToolResult: (_id: string, content: string, isError: boolean) => { captured.push({ content, isError }) },
    } as unknown as import('../src/renderer/src/agent/executors/context').ToolExecContext
    const t = { id: 't1', type: 'tool_use', name: 'spawn_agent', input: { task: 'nested' }, status: 'pending' } as ToolUseBlock

    await execSpawnAgent(ex, t)

    expect(t.exitCode).toBe(-1)
    expect(captured[0].isError).toBe(true)
    expect(captured[0].content).toContain('子代理不能再派生子代理')
    expect(captured[0].content).toContain('create_sub_plan')
  })
})
