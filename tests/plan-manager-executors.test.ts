import { describe, expect, it } from 'vitest'
import { PlanManager } from '../src/renderer/src/agent/plan-manager'
import type { ToolUseBlock, AgentMessage } from '../src/renderer/src/types/agent'
import type { Plan } from '../src/shared/types/plan'

/**
 * advance_plan / create_plan executors over the v2 DAG (PLAN-plan-dag): node
 * ref parsing, the sole-ready fallback (D5), failure isolation (D4), finish,
 * snapshot text and the PlanPanel jump anchor (msgId).
 */

function makeManager(messages: AgentMessage[] = []) {
  const results: Array<{ id: string; content: string; isError: boolean }> = []
  const notifications: Array<Plan | null> = []
  const mgr = new PlanManager(
    (id, content, isError) => results.push({ id, content, isError }),
    () => {},
    () => messages,
    (p) => notifications.push(p),
  )
  return { mgr, results, notifications }
}

let seq = 0
const tool = (input: Record<string, unknown>): ToolUseBlock =>
  ({ type: 'tool_use', id: `tu_${++seq}`, name: 'advance_plan', input, status: 'pending' }) as ToolUseBlock

const msgAnchoring = (t: ToolUseBlock): AgentMessage[] => [
  {
    id: `assistant-for-${t.id}`,
    role: 'assistant',
    contentBlocks: [{ type: 'tool_use', id: t.id, name: 'advance_plan', input: {} }],
    createdAt: new Date().toISOString(),
  },
]

describe('create_plan executor', () => {
  it('builds the DAG from object steps and reports the ready set', async () => {
    const { mgr, results, notifications } = makeManager()
    const t = tool({
      objective: 'ship',
      steps: [
        { description: 'a' },
        { description: 'b', depends_on: [1], assignee: 'fe' },
        { description: 'c', depends_on: [1] },
      ],
    })
    await mgr.execCreatePlan(t)
    expect(t.exitCode).toBe(0)
    expect(mgr.plan?.version).toBe(2)
    expect(mgr.plan?.nodes.map(n => n.id)).toEqual(['n1', 'n2', 'n3'])
    expect(results[0].content).toContain('Plan created with 3 node(s)')
    expect(results[0].content).toContain('Ready:')
    expect(notifications).toHaveLength(1)
  })

  it('accepts legacy plain-string steps as a chain (D8 fallback)', async () => {
    const { mgr } = makeManager()
    await mgr.execCreatePlan(tool({ objective: 'o', steps: ['one', 'two'] }))
    expect(mgr.plan?.nodes[1].dependsOn).toEqual(['n1'])
  })

  it('rejects a cyclic graph with the error in the tool result', async () => {
    const { mgr, results } = makeManager()
    const t = tool({
      objective: 'o',
      steps: [
        { description: 'a', depends_on: [2] },
        { description: 'b', depends_on: [1] },
      ],
    })
    await mgr.execCreatePlan(t)
    expect(t.exitCode).toBe(-1)
    expect(results[0].isError).toBe(true)
    expect(results[0].content).toContain('dependency cycle')
    expect(mgr.plan).toBeNull()
  })
})

describe('advance_plan executor', () => {
  async function seeded() {
    const { mgr, results } = makeManager()
    await mgr.execCreatePlan(tool({
      objective: 'ship',
      steps: [{ description: 'a' }, { description: 'b', depends_on: [1] }, { description: 'c', depends_on: [1] }],
    }))
    return { mgr, results }
  }

  it('completes by number, by "n" id, and anchors the panel jump (msgId)', async () => {
    const t1 = tool({ action: 'complete', node: 1, notes: 'done a' })
    const t2 = tool({ action: 'complete', node: 'n3' })
    const { mgr, results } = makeManager([...msgAnchoring(t1), ...msgAnchoring(t2)])
    await mgr.execCreatePlan(tool({
      objective: 'ship',
      steps: [{ description: 'a' }, { description: 'b', depends_on: [1] }, { description: 'c', depends_on: [1] }],
    }))
    await mgr.execAdvancePlan(t1)
    expect(mgr.plan?.nodes[0].status).toBe('completed')
    expect(mgr.plan?.nodes[0].summary).toBe('done a')
    expect(mgr.plan?.nodes[0].msgId).toBe(`assistant-for-${t1.id}`)
    expect(results[results.length - 1].content).toContain('Node n1 completed')

    await mgr.execAdvancePlan(t2)
    expect(mgr.plan?.nodes[2].status).toBe('completed')
    expect(mgr.plan?.nodes[2].msgId).toBe(`assistant-for-${t2.id}`)
  })

  it('falls back to the sole ready node when node is omitted (D5)', async () => {
    const { mgr } = await seeded()
    await mgr.execAdvancePlan(tool({ action: 'complete' }))
    expect(mgr.plan?.nodes[0].status).toBe('completed')
  })

  it('errors when several nodes are ready and node is omitted', async () => {
    const { mgr, results } = await seeded()
    await mgr.execAdvancePlan(tool({ action: 'complete', node: 1 }))
    const t = tool({ action: 'complete' })
    await mgr.execAdvancePlan(t)
    expect(t.exitCode).toBe(-1)
    expect(results[results.length - 1].content).toContain('Multiple nodes are ready')
    expect(mgr.plan?.nodes[1].status).toBe('pending')
  })

  it('fail marks its own node, keeps dependents pending (D4), exitCode 1', async () => {
    const { mgr, results } = await seeded()
    const t = tool({ action: 'fail', node: 1, notes: 'blocked upstream' })
    await mgr.execAdvancePlan(t)
    expect(mgr.plan?.nodes[0].status).toBe('failed')
    expect(mgr.plan?.nodes[1].status).toBe('pending')
    expect(t.exitCode).toBe(1)
    expect(results[results.length - 1].isError).toBe(true)
    expect(results[results.length - 1].content).toContain('n1 FAILED')
  })

  it('retry: completing a failed node settles it as completed', async () => {
    const { mgr } = await seeded()
    await mgr.execAdvancePlan(tool({ action: 'fail', node: 1 }))
    await mgr.execAdvancePlan(tool({ action: 'complete', node: 1 }))
    expect(mgr.plan?.nodes[0].status).toBe('completed')
    expect(mgr.plan?.nodes[1].status).toBe('pending')
  })

  it('skip abandons the node', async () => {
    const { mgr } = await seeded()
    await mgr.execAdvancePlan(tool({ action: 'skip', node: 2 }))
    expect(mgr.plan?.nodes[1].status).toBe('skipped')
  })

  it('finish force-completes everything and closes the plan', async () => {
    const { mgr } = await seeded()
    await mgr.execAdvancePlan(tool({ action: 'finish' }))
    expect(mgr.plan?.completed).toBe(true)
    expect(mgr.plan?.nodes.every(n => n.status === 'completed')).toBe(true)
  })

  it('rejects unknown refs, unknown actions and advance without a plan', async () => {
    const { mgr, results } = await seeded()
    const bad = tool({ action: 'complete', node: 99 })
    await mgr.execAdvancePlan(bad)
    expect(bad.exitCode).toBe(-1)
    expect(results[results.length - 1].content).toContain('Unknown node "99"')

    const weird = tool({ action: 'teleport', node: 1 })
    await mgr.execAdvancePlan(weird)
    expect(weird.exitCode).toBe(-1)
    expect(results[results.length - 1].content).toContain('Unknown action')

    const empty = makeManager()
    const noPlan = tool({ action: 'complete', node: 1 })
    await empty.mgr.execAdvancePlan(noPlan)
    expect(noPlan.exitCode).toBe(-1)
    expect(empty.results[0].content).toContain('No active plan')
  })
})

/** The node→sub-conversation link (PLAN-workbench W12): spawn_agent reports the
 *  session it just created, and the plan is where that link lives — it is the
 *  only carrier persisted (plan_json), i.e. the one the DAG's node click can
 *  still resolve after a restart. */
describe('linkNodeSession', () => {
  it('records the session on the node and persists once', async () => {
    const { mgr, notifications } = makeManager()
    await mgr.execCreatePlan(tool({ objective: 'ship', steps: ['a', 'b'] }))
    expect(notifications).toHaveLength(1)

    mgr.linkNodeSession('n2', 'sub_abc')
    expect(mgr.plan?.nodes[1].subConvId).toBe('sub_abc')
    expect(notifications).toHaveLength(2) // written through onPlanChange

    mgr.linkNodeSession('n2', 'sub_abc') // unchanged → no extra write
    expect(notifications).toHaveLength(2)
  })

  it('is status-neutral and tolerates a missing plan or a stale ref', async () => {
    const { mgr } = makeManager()
    mgr.linkNodeSession('n1', 'sub_none') // no plan yet
    await mgr.execCreatePlan(tool({ objective: 'ship', steps: ['a'] }))
    mgr.linkNodeSession('n9', 'sub_bad') // unknown node
    mgr.linkNodeSession('n1', 'sub_ok')
    expect(mgr.plan?.nodes[0]).toMatchObject({ subConvId: 'sub_ok', status: 'pending' })
  })
})
