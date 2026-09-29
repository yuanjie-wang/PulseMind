import { describe, expect, it, beforeEach } from 'vitest'
import type { PulseHost } from '../src/renderer/src/agent/host/types'
import { setHost } from '../src/renderer/src/agent/host'
import { AgentEngine } from '../src/renderer/src/agent/AgentEngine'
import { ToolManager } from '../src/renderer/src/tools/ToolManager'
import { SkillManager } from '../src/renderer/src/skills/SkillManager'
import type { SpawnSubAgentConfig, SubAgentHandle, SubAgentResult } from '../src/renderer/src/agent/agent-utils'
import type { AgentStatus } from '../src/renderer/src/types/agent'
import { createPlanDag } from '../src/shared/plan/graph'
import { activeSubAgentCount, resetSubAgentLimiter, subAgentBudgetKey } from '../src/renderer/src/agent/engine/subagent-limiter'

/**
 * Chained plan dispatch, end to end (2026-09-30, 「不应该浪费槽」): while a
 * wave is still draining, the first node to deliver settles immediately and
 * its ready dependent chains into the freed slot — through the SAME executor
 * path a batch uses (slot limiter, plan CAS, hand-off) but registered INTO
 * the live batch's accounting instead of a second handleToolUseResponse.
 *
 * The fixture is the user's shape shrunk to three nodes: n1 ← (n2, n3); n1
 * and n3 run as wave 1, n1 delivers first, and n2 must start at that moment —
 * under the old wave barrier it waited for n3 too. The drain closes when the
 * chained spawn's own result lands, and the plan auto-closes.
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

/** A key IS present here: settleAndChain's own applicability gate (no key →
 *  no doomed spawns) must pass for the chain to fire. The drain never reaches
 *  continueLoop — the fixture keeps isAutoExecuting up for the whole test, so
 *  the mid-drain entry is the only scheduler surface under test. */
function makeEngine(conversationId = 'conv_plan_chain'): AgentEngine {
  return new AgentEngine({
    apiKey: 'test-key',
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

/** Fake sub-agent hosting for the chained spawn: `started` resolves when the
 *  detached dispatch reaches spawnSubAgent (i.e. past the slot acquire), and
 *  `finish()` settles the expert the way a real completion would. */
function stubChainSpawn(engine: AgentEngine) {
  let resolveRun!: (r: SubAgentResult) => void
  let releaseStarted!: () => void
  const started = new Promise<void>((res) => { releaseStarted = res })
  engine.toolExecutor.spawnSubAgent = (_config: SpawnSubAgentConfig): SubAgentHandle => {
    releaseStarted()
    return {
      id: 'sub_n2',
      subConvId: 'sub_conv_n2',
      messages: [],
      agentStatus: { status: 'idle' } as AgentStatus,
      abort: () => {},
      waitForCompletion: () => new Promise<SubAgentResult>((resolve) => { resolveRun = resolve }),
    }
  }
  return {
    started,
    finish: () => resolveRun({
      status: 'completed',
      messages: [{
        id: 'm_n2',
        role: 'assistant',
        contentBlocks: [{ type: 'text', text: 'n2 deliverable' }],
        createdAt: new Date().toISOString(),
      }],
    }),
  }
}

describe('chained plan dispatch — the freed slot goes back to work mid-drain', () => {
  beforeEach(() => { resetSubAgentLimiter(); calls = [] })

  it('settles n1 on delivery, chains n2 alongside the live n3, and closes the plan when n2 drains', async () => {
    setHost(makeMockHost())
    const engine = makeEngine()
    const plan = createPlanDag('pipe', [
      { description: 'a' },                 // n1 — wave 1
      { description: 'b', dependsOn: [1] }, // n2 — becomes ready when n1 settles
      { description: 'c', dependsOn: [1] }, // n3 — wave 1, still running
    ])
    engine.planManager.plan = plan
    plan.nodes[0].execution = { attemptId: 'a1', status: 'running' }
    plan.nodes[2].execution = { attemptId: 'a3', status: 'running' }

    const chain = stubChainSpawn(engine)

    // Wave 1 mid-batch: both spawns registered, the batch flag up.
    engine.pendingToolIds.add('call_n1')
    engine.pendingToolIds.add('call_n3')
    engine.isAutoExecuting = true

    // n1 delivers — the real envelope path: execution CAS, then the result.
    engine.planManager.updateNodeExecution(1, 'a1', 'delivered')
    engine.addToolResult('call_n1', 'n1 deliverable', false)

    // The settle+chain entry ran (the drain itself stayed open):
    expect(plan.nodes[0].status).toBe('completed')
    expect(engine.pendingToolIds.has('call_n1')).toBe(false)
    expect(engine.pendingToolIds.size).toBeGreaterThan(0) // call_n3 + the chained call

    // n2 chained INTO the live accounting — not a second handleToolUseResponse.
    const chainCall = engine.toolUseBlocks.find(t => t.input?.planNode === 'n2')
    expect(chainCall).toBeDefined()
    expect(engine.pendingToolIds.has(chainCall!.id)).toBe(true)
    const chainMsg = engine.messages.find(m => m.role === 'assistant' && m.contentBlocks.includes(chainCall!))
    expect(chainMsg).toBeDefined()
    await chain.started // the detached spawn is past the slot acquire
    expect(activeSubAgentCount(subAgentBudgetKey(engine.opts))).toBe(1)

    // n3 delivers too: it settles, and nothing NEW chains (n2 is running).
    engine.planManager.updateNodeExecution(3, 'a3', 'delivered')
    engine.addToolResult('call_n3', 'n3 deliverable', false)
    expect(plan.nodes[2].status).toBe('completed')

    // The chained expert completes: its own result closes the drain and the
    // plan auto-settles — n2 never waited for n3's wave-mates to drain first.
    chain.finish()
    await new Promise(r => setTimeout(r, 30))
    expect(plan.nodes[1].status).toBe('completed')
    expect(plan.nodes[1].handoff).toContain('n2 deliverable')
    expect(plan.completed).toBe(true)
    expect(engine.pendingToolIds.size).toBe(0)
    expect(activeSubAgentCount(subAgentBudgetKey(engine.opts))).toBe(0)
  })
})
