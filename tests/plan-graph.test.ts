import { describe, expect, it } from 'vitest'
import {
  MAX_PLAN_NODES,
  blockedNodes,
  completeAllNodes,
  createPlanDag,
  formatPlanForPrompt,
  formatPlanSnapshot,
  markNode,
  migrateLinearPlan,
  nodeNumberOf,
  planLayers,
  readyNodes,
  resolveNodeRef,
} from '../src/shared/plan/graph'
import type { Plan } from '../src/shared/types/plan'

/** diamond: n1 → (n2, n3) → n4 — the minimal parallel shape. */
function diamond(): Plan {
  return createPlanDag('ship it', [
    { description: '调研' },
    { description: '前端', dependsOn: [1], assignee: 'fe-expert' },
    { description: '后端', dependsOn: [1] },
    { description: '发布', dependsOn: [2, 3] },
  ])
}

describe('createPlanDag', () => {
  it('assigns ids by input order and resolves 1-based dependency indexes to ids', () => {
    const plan = diamond()
    expect(plan.nodes.map(n => n.id)).toEqual(['n1', 'n2', 'n3', 'n4'])
    expect(plan.nodes[3].dependsOn).toEqual(['n2', 'n3'])
    expect(plan.nodes[1].assignee).toBe('fe-expert')
    expect(plan.version).toBe(2)
    expect(plan.completed).toBe(false)
    expect(plan.mode).toBe('delegated')
  })

  it('rejects empty objective / empty steps / over-cap plans / blank descriptions', () => {
    expect(() => createPlanDag('  ', [{ description: 'x' }])).toThrow('objective is required')
    expect(() => createPlanDag('obj', [])).toThrow('steps are required')
    expect(() => createPlanDag('obj', Array.from({ length: MAX_PLAN_NODES + 1 }, () => ({ description: 'x' })))).toThrow('maximum 20 nodes')
    expect(() => createPlanDag('obj', [{ description: 'x' }, { description: '  ' }])).toThrow('step 2')
  })

  it('rejects out-of-range, self and cyclic dependencies', () => {
    expect(() => createPlanDag('o', [{ description: 'a', dependsOn: [5] }])).toThrow('out of range')
    expect(() => createPlanDag('o', [{ description: 'a', dependsOn: [1] }])).toThrow('cannot depend on itself')
    expect(() => createPlanDag('o', [
      { description: 'a', dependsOn: [2] },
      { description: 'b', dependsOn: [1] },
    ])).toThrow('dependency cycle')
  })

  it('dedupes repeated dependencies', () => {
    const plan = createPlanDag('o', [{ description: 'a' }, { description: 'b', dependsOn: [1, 1] }])
    expect(plan.nodes[1].dependsOn).toEqual(['n1'])
  })
})

describe('derivation: ready / blocked / layers', () => {
  it('the diamond starts with one ready node, then two, and blocks on failure without cascading', () => {
    const plan = diamond()
    expect(readyNodes(plan).map(n => n.id)).toEqual(['n1'])

    markNode(plan, 1, 'completed')
    expect(readyNodes(plan).map(n => n.id)).toEqual(['n2', 'n3'])

    // n2 fails: n4 is blocked (its chain includes the failure), n3 stays ready — no cascade.
    markNode(plan, 'n2', 'failed')
    expect(readyNodes(plan).map(n => n.id)).toEqual(['n3'])
    expect(blockedNodes(plan).map(n => n.id)).toEqual(['n4'])

    // retry path: completing a failed node unblocks downstream again.
    markNode(plan, 2, 'completed', { summary: 'retry ok' })
    expect(blockedNodes(plan)).toEqual([])
    expect(readyNodes(plan).map(n => n.id)).toEqual(['n3'])
  })

  it('skipping a node blocks its dependents but not its siblings', () => {
    const plan = diamond()
    markNode(plan, 1, 'completed')
    markNode(plan, 2, 'skipped')
    expect(blockedNodes(plan).map(n => n.id)).toEqual(['n4'])
    expect(readyNodes(plan).map(n => n.id)).toEqual(['n3'])
  })

  it('layers follow the longest dependency path', () => {
    expect(planLayers(diamond()).map(w => w.map(n => n.id))).toEqual([['n1'], ['n2', 'n3'], ['n4']])
  })
})

describe('markNode / completeAllNodes', () => {
  it('resolves 3, "3" and "n3" to the same node and rejects unknown refs', () => {
    const plan = diamond()
    expect(resolveNodeRef(plan, 3)?.id).toBe('n3')
    expect(resolveNodeRef(plan, '3')?.id).toBe('n3')
    expect(resolveNodeRef(plan, 'n3')?.id).toBe('n3')
    expect(resolveNodeRef(plan, 'n99')).toBeNull()
    expect(() => markNode(plan, 99, 'completed')).toThrow('Unknown node "99"')
  })

  it('closes the plan automatically when the last pending node settles, not earlier', () => {
    const plan = diamond()
    markNode(plan, 1, 'completed')
    expect(plan.completed).toBe(false)
    markNode(plan, 2, 'completed')
    markNode(plan, 3, 'completed')
    expect(plan.completed).toBe(false)
    markNode(plan, 4, 'completed', { msgId: 'msg-9' })
    expect(plan.completed).toBe(true)
    expect(plan.nodes[3].msgId).toBe('msg-9')
  })

  it('finish force-completes every pending node', () => {
    const plan = diamond()
    markNode(plan, 1, 'completed')
    completeAllNodes(plan)
    expect(plan.nodes.every(n => n.status === 'completed')).toBe(true)
    expect(plan.completed).toBe(true)
  })
})

describe('migrateLinearPlan', () => {
  it('turns a v1 linear plan into a lossless chain', () => {
    const plan = migrateLinearPlan({
      objective: 'old plan',
      steps: [
        { description: 'one', status: 'completed' },
        { description: 'two', status: 'in_progress' },
        { description: 'three' },
      ],
      currentStepIndex: 1,
      mode: 'delegated',
    })!
    expect(plan.version).toBe(2)
    expect(plan.nodes.map(n => n.id)).toEqual(['n1', 'n2', 'n3'])
    expect(plan.nodes.map(n => n.status)).toEqual(['completed', 'pending', 'pending'])
    expect(plan.nodes[1].dependsOn).toEqual(['n1'])
    expect(readyNodes(plan).map(n => n.id)).toEqual(['n2'])
  })

  it('returns null for non-plan shapes and accepts a legacy completed flag', () => {
    expect(migrateLinearPlan(null)).toBeNull()
    expect(migrateLinearPlan({})).toBeNull()
    expect(migrateLinearPlan({ objective: 'x', steps: [] })).toBeNull()
    expect(migrateLinearPlan({ objective: 'x', steps: [{ description: 'a' }], completed: true })!.completed).toBe(true)
  })
})

describe('text rendering', () => {
  it('prompt section marks READY / blocked nodes and states the scheduler contract (delegated)', () => {
    const plan = diamond()
    markNode(plan, 1, 'completed')
    markNode(plan, 2, 'failed')
    const text = formatPlanForPrompt(plan)!
    expect(text).toContain('## Current Plan')
    expect(text).toContain('[done] n1: 调研')
    expect(text).toContain('[fail] n2: 前端')
    expect(text).toContain('n4: 发布 — blocked (waiting on: n2)')
    expect(text).toContain('n3: 后端 — READY')
    expect(text).toContain('(assignee: fe-expert)')
    // PLAN-plan-scheduler: the delegated rules no longer ask the model to
    // transcribe the READY set or report deliveries — the scheduler owns both.
    expect(text).toContain('dispatched AUTOMATICALLY by the scheduler')
    expect(text).toContain('consulted at exactly two points')
    expect(text).not.toContain('SAME response so they run in parallel')
    expect(text).not.toContain('NEVER auto-advances')
    const closed = diamond()
    closed.completed = true
    expect(formatPlanForPrompt(closed)).toBeNull()
  })

  it('direct mode renders the todo contract (the scheduler never touches it)', () => {
    // Since 2026-10-25 direct mode IS the todo list — todo_write is its only
    // writer and the prompt rules teach the checklist discipline.
    const plan = diamond()
    plan.mode = 'direct'
    plan.currentNodeId = 'n1'
    const text = formatPlanForPrompt(plan)!
    expect(text).toContain('[~] n1: 调研 — IN PROGRESS')
    expect(text).toContain('Work through the list yourself')
    expect(text).toContain('todo_write')
    expect(text).not.toContain('AUTOMATICALLY')
  })

  it('snapshot reports the mutation, the ready set and notes', () => {
    const plan = diamond()
    markNode(plan, 1, 'completed')
    const snap = formatPlanSnapshot(plan, { action: 'complete', node: 1, notes: '调研完成' })
    expect(snap).toContain('Node n1 completed.')
    // Scheduler-aligned wording (2026-10-25 plan-tool evaluation): the old
    // "start these, in parallel" invited the manual spawn round the rules
    // forbid — the snapshot contradicted its own create header.
    expect(snap).toContain('Ready: n2, n3 — the scheduler dispatches these automatically; do NOT call spawn_agent for them.')
    expect(snap).toContain('调研完成')

    markNode(plan, 2, 'completed'); markNode(plan, 3, 'completed'); markNode(plan, 4, 'completed')
    const final = formatPlanSnapshot(plan, { action: 'complete', node: 4 })
    expect(final).toContain('every node is settled, the plan is complete')
    expect(final).not.toContain('Ready now')

    expect(formatPlanSnapshot(diamond(), { action: 'fail', node: 2 })).toContain('n2 FAILED')
    expect(formatPlanSnapshot(diamond(), { action: 'skip', node: 2 })).toContain('n2 skipped')
    expect(formatPlanSnapshot(diamond(), { action: 'finish' })).toContain('finished early')
  })

  it('exposes 1-based numbers for snapshots', () => {
    expect(nodeNumberOf(diamond().nodes[2])).toBe(3)
  })
})
