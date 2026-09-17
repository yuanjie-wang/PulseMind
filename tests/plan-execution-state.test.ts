import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

// The desktop component is client-only. For this markup-only test, supply the
// store's current snapshot through the SSR hook; production needs no SSR API.
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>()
  return { ...actual, useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot() }
})
import { PlanManager } from '../src/renderer/src/agent/plan-manager'
import { execSpawnAgent } from '../src/renderer/src/agent/executors/spawn-tool'
import type { ToolExecContext } from '../src/renderer/src/agent/executors/context'
import type { SubAgentResult } from '../src/renderer/src/agent/agent-utils'
import type { ToolUseBlock } from '../src/renderer/src/types/agent'
import { createPlanDag, readyNodes, updateNodeExecution, planNodeExecutionLabel } from '../src/shared/plan/graph'
import type { Plan, PlanNodeExecutionStatus } from '../src/shared/types/plan'
import { PlanGraphView } from '../src/renderer/src/components/workbench/PlanGraphView'
import { resolvePlanNodeTarget } from '../src/renderer/src/agent/plan-node-target'
import { acquireSubAgentSlot, MAX_PARALLEL_SUBAGENTS, releaseQueuedSubAgents, resetSubAgentLimiter } from '../src/renderer/src/agent/engine/subagent-limiter'

const tool = (): ToolUseBlock => ({ type: 'tool_use', id: 'same-tool-id', name: 'spawn_agent', input: { task: 'Deliver node', planNode: 1 } })
function deferred() {
  let resolve!: (result: SubAgentResult) => void
  let reject!: (error: Error) => void
  const promise = new Promise<SubAgentResult>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture() {
  const persisted: Plan[] = []
  const manager = new PlanManager(vi.fn(), vi.fn(), () => [], plan => { if (plan) persisted.push(JSON.parse(JSON.stringify(plan))) })
  manager.plan = createPlanDag('Objective', [{ description: 'Produce' }, { description: 'Consume', dependsOn: [1] }])
  const runs: ReturnType<typeof deferred>[] = []
  const ex: ToolExecContext = {
    opts: { conversationId: 'execution-state-test', maxTokens: 1024 } as ToolExecContext['opts'],
    getPlan: () => manager.plan,
    beginPlanNodeExecution: (ref, id) => manager.beginNodeExecution(ref, id),
    updatePlanNodeExecution: (ref, id, status, sub) => manager.updateNodeExecution(ref, id, status, sub),
    notify: vi.fn(), addToolResult: vi.fn(), formatExecResult: () => '',
    spawnSubAgent: vi.fn(() => {
      const run = deferred(); runs.push(run)
      return { subConvId: `sub_${runs.length}`, waitForCompletion: () => run.promise } as ReturnType<NonNullable<ToolExecContext['spawnSubAgent']>>
    }),
  }
  const finish = (index = 0, status: SubAgentResult['status'] = 'completed') => runs[index].resolve({ status, messages: [], text: '' } as SubAgentResult)
  return { manager, ex, runs, finish, persisted, node: () => manager.plan!.nodes[0] }
}
afterEach(() => { resetSubAgentLimiter(); vi.restoreAllMocks() })

describe('parent-owned plan execution, separate from acceptance', () => {
  it('persists queued → running → delivered before the result; only advance_plan unlocks dependencies', async () => {
    const f = fixture()
    const promise = execSpawnAgent(f.ex, tool())
    expect(f.node().execution?.status).toBe('queued')
    await Promise.resolve()
    expect(f.node().execution?.status).toBe('running')
    expect(f.node().subConvId).toBe('sub_1')
    f.finish(); await promise
    expect(f.persisted.map(p => p.nodes[0].execution?.status)).toEqual(['queued', 'running', 'delivered'])
    expect(f.node().status).toBe('pending')
    expect(f.manager.plan!.completed).toBe(false)
    expect(readyNodes(f.manager.plan!).map(n => n.id)).toEqual(['n1'])
    expect(resolvePlanNodeTarget(f.node(), [])).toMatchObject({ live: false })
    await f.manager.execAdvancePlan({ type: 'tool_use', id: 'accept', name: 'advance_plan', input: { action: 'complete', node: 1 } })
    expect(f.node().status).toBe('completed')
    expect(f.node().execution?.status).toBe('delivered')
    expect(readyNodes(f.manager.plan!).map(n => n.id)).toEqual(['n2'])
  })

  it.each([['error', 'failed'], ['aborted', 'stopped']] as const)('maps child %s to %s without accepting it', async (result, execution) => {
    const f = fixture(); const promise = execSpawnAgent(f.ex, tool()); await Promise.resolve()
    f.finish(0, result); await promise
    expect(f.node().execution?.status).toBe(execution)
    expect(f.node().status).toBe('pending')
  })

  it.each(['throw', 'reject'] as const)('records %s errors via the same change callback', async mode => {
    const f = fixture()
    if (mode === 'throw') f.ex.spawnSubAgent = () => { throw new Error('cannot start') }
    const promise = execSpawnAgent(f.ex, tool()); await Promise.resolve()
    if (mode === 'reject') f.runs[0].reject(new Error('cannot finish'))
    await promise
    expect(f.node().execution?.status).toBe('failed')
    expect(f.persisted.at(-1)!.nodes[0].execution?.status).toBe('failed')
    expect(f.node().status).toBe('pending')
  })

  it('keeps a saturated dispatch queued and records stop without starting a child', async () => {
    const f = fixture()
    const releases = await Promise.all(Array.from({ length: MAX_PARALLEL_SUBAGENTS }, () => acquireSubAgentSlot('execution-state-test')))
    const promise = execSpawnAgent(f.ex, tool())
    expect(f.node().execution?.status).toBe('queued')
    expect(f.ex.spawnSubAgent).not.toHaveBeenCalled()
    releaseQueuedSubAgents('execution-state-test'); await promise
    expect(f.node().execution?.status).toBe('stopped')
    expect(f.ex.spawnSubAgent).not.toHaveBeenCalled()
    releases.forEach(release => release?.())
  })

  it('replayed tool IDs get distinct attempts; old completion cannot overwrite the latest link or state', async () => {
    const f = fixture()
    const first = execSpawnAgent(f.ex, tool()); await Promise.resolve()
    const oldId = f.node().execution!.attemptId
    const second = execSpawnAgent(f.ex, tool())
    expect(f.node().execution!.attemptId).not.toBe(oldId)
    expect(f.node().subConvId).toBeUndefined()
    await Promise.resolve()
    const count = f.persisted.length
    f.finish(0); await first
    expect(f.persisted).toHaveLength(count)
    expect(f.node().execution?.status).toBe('running')
    expect(f.node().subConvId).toBe('sub_2')
    f.finish(1); await second
    expect(f.node().execution?.status).toBe('delivered')
    expect(updateNodeExecution(f.manager.plan!, 1, f.node().execution!.attemptId, 'running', 'late')).toBe(false)
  })

  it('does not apply completion to a replacement plan with identical node IDs', async () => {
    const f = fixture(); const promise = execSpawnAgent(f.ex, tool()); await Promise.resolve()
    f.manager.plan = createPlanDag('Replacement', [{ description: 'New work' }])
    f.finish(); await promise
    expect(f.node().execution).toBeUndefined()
    expect(f.node().subConvId).toBeUndefined()
  })
})

describe('plan presentation and live targets', () => {
  const cases: Array<[PlanNodeExecutionStatus | undefined, string]> = [[undefined, '未开始'], ['queued', '排队中'], ['running', '执行中'], ['delivered', '已交付，待验收'], ['failed', '执行失败'], ['stopped', '已停止']]
  it.each(cases)('renders %s as %s; only running spins', (status, label) => {
    const plan = createPlanDag('UI', [{ description: 'Task' }])
    if (status) plan.nodes[0].execution = { attemptId: 'a', status }
    expect(planNodeExecutionLabel(plan.nodes[0])).toBe(label)
    const html = renderToStaticMarkup(React.createElement(PlanGraphView, { plan, onJumpToStep: () => {} }))
    expect(html).toContain(`>${label}</text>`)
    expect(html.includes('data-icon="spinner"')).toBe(status === 'running')
    plan.nodes[0].subConvId = 'sub_1'
    expect(resolvePlanNodeTarget(plan.nodes[0], [])).toMatchObject({ live: status === undefined || status === 'running' || status === 'queued' })
  })

  it('accepted state wins over every execution state', () => {
    for (const [status] of cases) {
      const plan = createPlanDag('UI', [{ description: 'Task' }]); const node = plan.nodes[0]
      node.status = 'completed'; node.subConvId = 'sub_1'
      if (status) node.execution = { attemptId: 'a', status }
      expect(planNodeExecutionLabel(node)).toBe('已完成')
      expect(resolvePlanNodeTarget(node, [])).toMatchObject({ live: false })
      const html = renderToStaticMarkup(React.createElement(PlanGraphView, { plan, onJumpToStep: () => {} }))
      expect(html).toContain('>已完成</text>')
      expect(html).not.toContain('data-icon="spinner"')
    }
  })

  it('a queued retry without a session cannot fall back to the previous attempt', () => {
    const plan = createPlanDag('UI', [{ description: 'Task' }])
    plan.nodes[0].execution = { attemptId: 'new', status: 'queued' }
    const old = { ...tool(), subConvId: 'old', planNodeId: 'n1' }
    expect(resolvePlanNodeTarget(plan.nodes[0], [{ id: 'm', role: 'assistant', createdAt: '', contentBlocks: [old] }])).toBeNull()
  })
})
