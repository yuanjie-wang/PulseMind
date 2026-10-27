import { describe, expect, it } from 'vitest'
import { execSpawnAgent } from '../src/renderer/src/agent/executors/spawn-tool'
import type { ToolExecContext } from '../src/renderer/src/agent/executors/context'
import type { ToolUseBlock } from '../src/renderer/src/types/agent'
import { createPlanDag } from '../src/shared/plan/graph'
import type { Plan } from '../src/shared/types/plan'

/**
 * spawn_agent 的调度器所有权门（conv_20261026154702 A1/B3 改源）：delegated
 * plan 里从未起步的 READY 节点归调度器派发——散文说了「do NOT call
 * spawn_agent」但模型照样派了（A1），所以契约落成硬门。钉住豁免面的精确性：
 * 调度器自己的调用（autoDispatch 标记）、子代理内建图（调度器在那里不运行，
 * 用户裁定「子代理内建图维持模型驱动」）、direct 模式（无调度器）、带死亡
 * attempt 的节点（失败信封自己指示 re-dispatch）全部放行。
 */

const subMessages = (text: string) => [
  { id: 'a1', role: 'assistant', contentBlocks: [{ type: 'text', text }], createdAt: '2026-10-26T12:00:00.000Z' },
]

interface Captured { content: string; isError: boolean }

function makeContext(plan: Plan, opts: { isSubAgent?: boolean } = {}) {
  const calls = {
    results: [] as Captured[],
    spawned: [] as string[],
    begins: [] as string[],
  }
  const ex = {
    opts: { conversationId: 'conv_gate', maxTokens: 1024 },
    notify: () => {},
    addToolResult: (_id: string, content: string, isError: boolean) => { calls.results.push({ content, isError }) },
    spawnSubAgent: (config: { initialMessages: Array<{ contentBlocks: Array<{ type: string; text?: string }> }> }) => {
      calls.spawned.push(config.initialMessages[0]?.contentBlocks?.find(b => b.type === 'text')?.text ?? '')
      return {
        id: 'h1', subConvId: 'sub_gate', messages: [], agentStatus: { status: 'completed' }, abort: () => {},
        waitForCompletion: async () => ({ status: 'completed', messages: subMessages('节点完成') }),
      }
    },
    getPlan: () => plan,
    beginPlanNodeExecution: (ref: string | number) => { calls.begins.push(String(ref)) },
    updatePlanNodeExecution: () => {},
    isSpawnedSubAgent: () => opts.isSubAgent ?? false,
    formatExecResult: () => '',
  } as unknown as ToolExecContext
  const tool = (input: Record<string, unknown>) =>
    ({ id: 't1', type: 'tool_use', name: 'spawn_agent', input, status: 'pending' }) as ToolUseBlock
  return { ex, calls, tool }
}

const freshPlan = (): Plan => createPlanDag('gate', [{ description: 'ready node' }, { description: '下游', dependsOn: [1] }])

describe('spawn_agent scheduler-ownership gate', () => {
  it('a manual spawn of a never-started READY node is rejected with the contract teaching, nothing dispatched', async () => {
    const plan = freshPlan()
    const { ex, calls, tool } = makeContext(plan)
    const block = tool({ task: 'ready node', planNode: 1 })

    await execSpawnAgent(ex, block)

    expect(calls.results[0].isError).toBe(true)
    expect(calls.results[0].content).toContain('the scheduler dispatches READY nodes automatically')
    expect(calls.results[0].content).toContain('advance_plan action="skip" or "fail"')
    expect(calls.spawned).toHaveLength(0)
    expect(calls.begins).toHaveLength(0) // the gate fires BEFORE the attempt begins — no lifecycle residue
    expect(block.exitCode).toBe(-1)
  })

  it('the scheduler\u2019s own stamped call (autoDispatch) passes', async () => {
    const plan = freshPlan()
    const { ex, calls, tool } = makeContext(plan)
    await execSpawnAgent(ex, tool({ task: 'ready node', planNode: 1, autoDispatch: true }))
    expect(calls.spawned).toHaveLength(1)
    expect(calls.begins).toEqual(['n1'])
  })

  it('a sub-agent\u2019s own plan stays model-driven (the scheduler never runs there)', async () => {
    const plan = freshPlan()
    const { ex, calls, tool } = makeContext(plan, { isSubAgent: true })
    await execSpawnAgent(ex, tool({ task: 'ready node', planNode: 1 }))
    expect(calls.spawned).toHaveLength(1)
  })

  it('a direct-mode plan has no scheduler — manual dispatch is THE channel', async () => {
    const plan = freshPlan()
    plan.mode = 'direct'
    const { ex, calls, tool } = makeContext(plan)
    await execSpawnAgent(ex, tool({ task: 'ready node', planNode: 1 }))
    expect(calls.spawned).toHaveLength(1)
  })

  it('a node with a dead attempt stays re-dispatchable (the failure envelope instructs exactly this)', async () => {
    const plan = freshPlan()
    plan.nodes[0].execution = { attemptId: 'dead', status: 'failed' }
    const { ex, calls, tool } = makeContext(plan)
    await execSpawnAgent(ex, tool({ task: 'ready node', planNode: 1 }))
    expect(calls.spawned).toHaveLength(1)
  })
})
