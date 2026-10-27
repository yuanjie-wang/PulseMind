import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  createPlanDag,
  markNode,
  beginNodeExecution,
  updateNodeExecution,
  formatUpstreamResults,
} from '../src/shared/plan/graph'
import { nextScheduleAction, dispatchableNodes, hasLiveExecution } from '../src/shared/plan/schedule'
import { NODE_HANDOFF_MAX, UPSTREAM_RESULTS_MAX } from '../src/shared/plan/graph'
import { PlanManager } from '../src/renderer/src/agent/plan-manager'
import { PlanScheduler } from '../src/renderer/src/agent/engine/plan-scheduler'
import type { EngineCore } from '../src/renderer/src/agent/engine/engine-core'
import type { AgentMessage, ToolUseBlock } from '../src/renderer/src/types/agent'
import type { Plan } from '../src/shared/types/plan'

/**
 * The auto-scheduler's decision function and its two PlanManager channels
 * (PLAN-plan-scheduler). Three layers, mirroring plan-dispatch-gate:
 *
 *  1. `nextScheduleAction` — the five actions and their PRIORITY order, which
 *     is the whole contract: settle what delivered, then — while attempts are
 *     still live — CHAIN every node their settlement just made ready alongside
 *     the drain (user ruling 2026-09-30: 不应该浪费槽; reverses the old
 *     one-wave-at-a-time barrier), consult failures BEFORE dispatching anything
 *     else (用户裁定：失败立即拉回 LLM — no chain past an unanswered failure
 *     either; those wait for the clean-drain consult), then dispatch the ready
 *     set. Every LLM round the plan still needs falls out of a `false`/none
 *     answer rather than a second decision path.
 *  2. The writer channels — autoSettle (delivery → completed, summary from the
 *     handoff's first line, auto-close on the last settle) and
 *     recordNodeHandoff (attemptId CAS, 6k cap).
 *  3. Wiring scans — the kick() hook sites exist, the mid-drain chaining entry
 *     is wired, and the pre-scheduler ritual copy ("NEVER auto-advances",
 *     "dispatch them ALL yourself") is gone from every prompt surface, while
 *     direct mode keeps its lowercase "never advances on its own" (it still
 *     doesn't).
 */

/** diamond: n1 → (n2, n3) → n4. */
function diamond(mode: 'direct' | 'delegated' = 'delegated'): Plan {
  return createPlanDag('ship it', [
    { description: '调研' },
    { description: '前端', dependsOn: [1] },
    { description: '后端', dependsOn: [1] },
    { description: '发布', dependsOn: [2, 3] },
  ], mode)
}

/** Drive an attempt to `status` the way spawn-tool does: begin, then CAS. */
function attempt(plan: Plan, ref: string | number, attemptId: string, status: 'running' | 'delivered' | 'failed' | 'stopped'): void {
  beginNodeExecution(plan, ref, attemptId)
  if (status !== 'running') updateNodeExecution(plan, ref, attemptId, status)
}

function src(rel: string): string {
  return readFileSync(resolve(__dirname, '..', rel), 'utf8')
}

// ── nextScheduleAction ─────────────────────────────────────────────────────

describe('nextScheduleAction — the four actions and their priority', () => {
  it('walks a diamond wave by wave: dispatch → settle → dispatch → … → none', () => {
    const plan = diamond()
    // Wave 1: only the root is ready.
    expect(nextScheduleAction(plan)).toMatchObject({ type: 'dispatch' })
    expect((nextScheduleAction(plan) as { nodes: Plan[] }).nodes.map(n => n.id)).toEqual(['n1'])

    // n1 delivered but not yet settled → settle wins (results land before
    // anything downstream could read them).
    attempt(plan, 1, 'a1', 'delivered')
    expect(nextScheduleAction(plan)).toMatchObject({ type: 'settle' })
    markNode(plan, 1, 'completed')

    // Wave 2: both children ready, in graph order.
    const wave2 = nextScheduleAction(plan)
    expect(wave2.type).toBe('dispatch')
    expect((wave2 as { nodes: Array<{ id: string }> }).nodes.map(n => n.id)).toEqual(['n2', 'n3'])

    attempt(plan, 2, 'a2', 'delivered')
    attempt(plan, 3, 'a3', 'delivered')
    expect(nextScheduleAction(plan)).toMatchObject({ type: 'settle' })
    markNode(plan, 2, 'completed')
    markNode(plan, 3, 'completed')

    // Wave 3: the join waits for BOTH parents.
    expect((nextScheduleAction(plan) as { nodes: Array<{ id: string }> }).nodes.map(n => n.id)).toEqual(['n4'])
    attempt(plan, 4, 'a4', 'delivered')
    expect(nextScheduleAction(plan)).toMatchObject({ type: 'settle' })
    markNode(plan, 4, 'completed')

    // All terminal → plan auto-closed → not the scheduler's turn any more.
    expect(plan.completed).toBe(true)
    expect(nextScheduleAction(plan)).toEqual({ type: 'none' })
  })

  it('chains a ready node alongside a live attempt — the freed slot goes back to work (2026-09-30)', () => {
    const plan = diamond()
    markNode(plan, 1, 'completed')
    attempt(plan, 2, 'a2', 'running') // queued/running = live
    // n3 became ready while n2 still runs: it chains into the freed slot
    // instead of idling behind the whole-wave barrier (user ruling 2026-09-30
    // 「不应该浪费槽」 — this reverses the old one-wave-at-a-time wait).
    const action = nextScheduleAction(plan)
    expect(action.type).toBe('chain')
    expect((action as { nodes: Array<{ id: string }> }).nodes.map(n => n.id)).toEqual(['n3'])
    expect((action as { live: Array<{ id: string }> }).live.map(n => n.id)).toEqual(['n2'])
  })

  it('does not chain past an unanswered failure — the wave waits for the consult (失败立即拉回 LLM)', () => {
    // diamond + an independent fifth child: without the failure guard this
    // plan would chain n5 while n2 runs — the failure must stop the world.
    const plan = createPlanDag('ship it', [
      { description: '调研' },
      { description: '前端', dependsOn: [1] },
      { description: '后端', dependsOn: [1] },
      { description: '发布', dependsOn: [2, 3] },
      { description: '文档', dependsOn: [1] },
    ])
    markNode(plan, 1, 'completed')
    attempt(plan, 2, 'a2', 'running')
    attempt(plan, 3, 'a3', 'failed')
    // n5 is ready and dispatchable, n2 is live, n3 failed: the consult owns
    // the decision — nothing new dispatches until the model has answered.
    expect(nextScheduleAction(plan)).toMatchObject({ type: 'wait', nodes: [{ id: 'n2' }] })
  })

  it('a settled node unblocks its dependent mid-wave: settle, then chain in the same re-evaluation', () => {
    const plan = createPlanDag('pipe', [
      { description: 'a' },                 // n1
      { description: 'b', dependsOn: [1] }, // n2
      { description: 'c' },                 // n3
    ])
    attempt(plan, 1, 'a1', 'running')
    attempt(plan, 3, 'a3', 'running')
    // n1 delivers first: settle lands before anything reads it…
    attempt(plan, 1, 'a1', 'delivered')
    expect(nextScheduleAction(plan)).toMatchObject({ type: 'settle' })
    markNode(plan, 1, 'completed')
    // …and the same re-evaluation chains n2 alongside the still-running n3.
    const action = nextScheduleAction(plan)
    expect(action.type).toBe('chain')
    expect((action as { nodes: Array<{ id: string }> }).nodes.map(n => n.id)).toEqual(['n2'])
    expect((action as { live: Array<{ id: string }> }).live.map(n => n.id)).toEqual(['n3'])
  })

  it('consults a failure BEFORE dispatching the next wave (失败立即拉回 LLM)', () => {
    const plan = diamond()
    markNode(plan, 1, 'completed')
    attempt(plan, 2, 'a2', 'failed')
    // n3 is ready and dispatchable, but the failed node stops the world first.
    const action = nextScheduleAction(plan)
    expect(action.type).toBe('consult')
    expect((action as { nodes: Array<{ id: string }> }).nodes.map(n => n.id)).toEqual(['n2'])
  })

  it('consults a stopped (interrupted) attempt the same way', () => {
    const plan = diamond()
    attempt(plan, 1, 'a1', 'stopped')
    expect(nextScheduleAction(plan)).toMatchObject({ type: 'consult' })
  })

  it('prefers settle over an in-flight sibling (delivered lands first)', () => {
    const plan = diamond()
    markNode(plan, 1, 'completed')
    attempt(plan, 2, 'a2', 'delivered')
    attempt(plan, 3, 'a3', 'running')
    expect(nextScheduleAction(plan)).toMatchObject({ type: 'settle' })
  })

  it('falls to none for direct mode, a closed plan, no plan, and a blocked graph', () => {
    expect(nextScheduleAction(null)).toEqual({ type: 'none' })
    expect(nextScheduleAction(diamond('direct'))).toEqual({ type: 'none' })

    const closed = diamond()
    markNode(closed, 1, 'completed'); markNode(closed, 2, 'completed')
    markNode(closed, 3, 'completed'); markNode(closed, 4, 'completed')
    expect(closed.completed).toBe(true)
    expect(nextScheduleAction(closed)).toEqual({ type: 'none' })

    // A failed node settles its dependents' fate too: n2 blocked, nothing
    // ready, nothing live → none → the ordinary LLM round is where the model
    // re-plans (the blocked graph is ITS decision to make).
    const blocked = diamond()
    markNode(blocked, 1, 'failed')
    expect(nextScheduleAction(blocked)).toEqual({ type: 'none' })
  })

  it('dispatchableNodes is ready AND never-attempted — delivered/failed/running are excluded', () => {
    const plan = diamond()
    // Fresh: only n1 is ready.
    expect(dispatchableNodes(plan).map(n => n.id)).toEqual(['n1'])
    // A delivered-but-unsettled node is the settle action's input, not the
    // dispatch set's — re-spawning it would run the work twice.
    attempt(plan, 1, 'a1', 'delivered')
    expect(dispatchableNodes(plan)).toEqual([])
    markNode(plan, 1, 'completed')
    attempt(plan, 2, 'a2', 'failed')
    // n2 is still READY by the graph's rule (n1 completed) but has an
    // execution record — the model/scheduler must not double-dispatch it.
    expect(dispatchableNodes(plan).map(n => n.id)).toEqual(['n3'])
  })

  it('hasLiveExecution covers exactly queued and running', () => {
    const plan = diamond()
    expect(hasLiveExecution(plan.nodes[0])).toBe(false)
    beginNodeExecution(plan, 1, 'a1')
    expect(hasLiveExecution(plan.nodes[0])).toBe(true)
    updateNodeExecution(plan, 1, 'a1', 'delivered')
    expect(hasLiveExecution(plan.nodes[0])).toBe(false)
  })
})

// ── PlanScheduler.settleAndChain — the mid-drain entry ─────────────────────

describe('PlanScheduler.settleAndChain — settle now, chain alongside the drain', () => {
  function chainFixture(mgr: PlanManager) {
    const spawned: ToolUseBlock[] = []
    const engine = {
      isCancelled: false,
      isSpawnedSubAgent: false,
      pendingVerbatimReply: null,
      opts: { apiKey: 'k' },
      planManager: mgr,
      messages: [] as AgentMessage[],
      toolUseBlocks: [] as ToolUseBlock[],
      pendingToolIds: new Set<string>(),
      agentStatus: { status: 'executing' },
      notify: () => {},
      addToolResult: () => {},
      toolExecutor: { execSpawnAgent: async (call: ToolUseBlock) => { spawned.push(call) } },
    }
    return { engine, scheduler: new PlanScheduler(engine as unknown as EngineCore), spawned }
  }

  function pipePlan(): Plan {
    return createPlanDag('pipe', [
      { description: 'a' },                 // n1
      { description: 'b', dependsOn: [1] }, // n2
      { description: 'c' },                 // n3
    ])
  }

  it('settles the delivered node and chains its dependent into the live accounting', () => {
    const { mgr } = makeManager()
    mgr.plan = pipePlan()
    mgr.beginNodeExecution(1, 'a1')
    mgr.updateNodeExecution(1, 'a1', 'delivered')
    mgr.recordNodeHandoff(1, 'a1', 'n1 out')
    mgr.beginNodeExecution(3, 'a3') // n3 still running = the live drain
    const { engine, scheduler, spawned } = chainFixture(mgr)

    scheduler.settleAndChain()

    // The delivered node settled without an LLM round…
    expect(mgr.plan!.nodes[0].status).toBe('completed')
    // …and n2 chained: one synthetic spawn batch, registered INTO the live
    // batch's accounting (pendingToolIds / toolUseBlocks), never a second
    // handleToolUseResponse.
    expect(spawned).toHaveLength(1)
    expect(spawned[0].input.planNode).toBe('n2')
    expect(engine.pendingToolIds.has(spawned[0].id)).toBe(true)
    expect(engine.toolUseBlocks).toContain(spawned[0])
    expect(engine.messages).toHaveLength(1)
    expect(engine.messages[0].role).toBe('assistant')
    expect(engine.messages[0].contentBlocks[0]).toBe(spawned[0])
  })

  it('is a no-op when nothing delivered and nothing became ready', () => {
    const { mgr } = makeManager()
    // Two nodes, only the root running: nothing delivered, and n2 is blocked
    // on n1 — there is nothing to settle and nothing to chain.
    mgr.plan = createPlanDag('pipe2', [
      { description: 'a' },
      { description: 'b', dependsOn: [1] },
    ])
    mgr.beginNodeExecution(1, 'a1') // running, not delivered
    const { engine, scheduler, spawned } = chainFixture(mgr)

    scheduler.settleAndChain()
    expect(spawned).toHaveLength(0)
    expect(engine.messages).toHaveLength(0)
    expect(engine.pendingToolIds.size).toBe(0)
  })

  it('never fires the clean-dispatch channel mid-drain — that stays the batch tail\'s kick', () => {
    const { mgr } = makeManager()
    mgr.plan = pipePlan()
    // n1 already settled, n2 ready, nothing live → nextScheduleAction answers
    // `dispatch` (clean). settleAndChain must leave it for the drain's kick:
    // handleToolUseResponse here would clobber the live batch's accounting.
    markNode(mgr.plan!, 1, 'completed')
    const { engine, scheduler, spawned } = chainFixture(mgr)

    scheduler.settleAndChain()
    expect(spawned).toHaveLength(0)
    expect(engine.messages).toHaveLength(0)
    expect(mgr.plan!.nodes[1].status).toBe('pending')
  })
})

// ── PlanManager.autoSettle ─────────────────────────────────────────────────

function makeManager() {
  const results: Array<{ id: string; content: string; isError: boolean }> = []
  const changes: Array<Plan | null> = []
  const mgr = new PlanManager(
    (id, content, isError) => results.push({ id, content, isError }),
    () => {},
    () => [],
    (p) => changes.push(p),
  )
  return { mgr, results, changes }
}

describe('PlanManager.autoSettle — the scheduler\'s settle policy', () => {
  it('settles a delivered pending node, taking the summary from the handoff\'s first line', () => {
    const { mgr, changes } = makeManager()
    mgr.plan = diamond()
    mgr.beginNodeExecution(1, 'a1')
    mgr.updateNodeExecution(1, 'a1', 'delivered')
    mgr.recordNodeHandoff(1, 'a1', 'first line of output\nsecond line')

    expect(mgr.autoSettle(1)).toBe(true)
    const n1 = mgr.plan!.nodes[0]
    expect(n1.status).toBe('completed')
    expect(n1.summary).toBe('first line of output')
    expect(mgr.plan!.completed).toBe(false) // n2..n4 still open
    expect(changes.length).toBeGreaterThan(0) // single-writer notify fired
  })

  it('auto-closes the plan when the last node settles, and keeps an existing summary', () => {
    const { mgr } = makeManager()
    mgr.plan = createPlanDag('one shot', [{ description: 'solo' }])
    mgr.beginNodeExecution(1, 'a1')
    mgr.updateNodeExecution(1, 'a1', 'delivered')
    mgr.plan.nodes[0].summary = 'written by hand' // a later advance_plan notes
    expect(mgr.autoSettle(1)).toBe(true)
    expect(mgr.plan!.completed).toBe(true)
    expect(mgr.plan!.nodes[0].summary).toBe('written by hand')
  })

  it('truncates a >120-char first line to 120 with an ellipsis', () => {
    const { mgr } = makeManager()
    mgr.plan = diamond()
    mgr.beginNodeExecution(1, 'a1')
    mgr.updateNodeExecution(1, 'a1', 'delivered')
    mgr.recordNodeHandoff(1, 'a1', 'x'.repeat(200))
    expect(mgr.autoSettle(1)).toBe(true)
    const summary = mgr.plan!.nodes[0].summary!
    expect(summary).toHaveLength(120)
    expect(summary.endsWith('…')).toBe(true)
  })

  it('is a no-op without a plan, without a delivered attempt, or on an already-settled node', () => {
    const { mgr } = makeManager()
    expect(mgr.autoSettle(1)).toBe(false) // no plan

    mgr.plan = diamond()
    expect(mgr.autoSettle(1)).toBe(false) // no execution at all
    mgr.beginNodeExecution(1, 'a1')
    expect(mgr.autoSettle(1)).toBe(false) // queued ≠ delivered
    mgr.updateNodeExecution(1, 'a1', 'running')
    expect(mgr.autoSettle(1)).toBe(false) // running ≠ delivered

    mgr.updateNodeExecution(1, 'a1', 'delivered')
    expect(mgr.autoSettle(1)).toBe(true)
    expect(mgr.autoSettle(1)).toBe(false) // no double-settle
  })
})

// ── PlanManager.recordNodeHandoff ──────────────────────────────────────────

describe('PlanManager.recordNodeHandoff — the downstream carrier', () => {
  it('records against the LIVE attempt only — a stale attemptId is rejected', () => {
    const { mgr } = makeManager()
    mgr.plan = diamond()
    mgr.beginNodeExecution(1, 'attempt-2') // a retry superseded attempt-1
    expect(mgr.recordNodeHandoff(1, 'attempt-1', 'from the dead attempt')).toBe(false)
    expect(mgr.plan!.nodes[0].handoff).toBeUndefined()
    expect(mgr.recordNodeHandoff(1, 'attempt-2', 'from the live attempt')).toBe(true)
    expect(mgr.plan!.nodes[0].handoff).toBe('from the live attempt')
  })

  it('caps the text at NODE_HANDOFF_MAX and rejects empty or unchanged writes', () => {
    const { mgr, changes } = makeManager()
    mgr.plan = diamond()
    mgr.beginNodeExecution(1, 'a1')

    expect(mgr.recordNodeHandoff(1, 'a1', '   ')).toBe(false) // nothing to hand off
    expect(mgr.recordNodeHandoff(1, 'a1', 'y'.repeat(7000))).toBe(true)
    expect(mgr.plan!.nodes[0].handoff).toHaveLength(NODE_HANDOFF_MAX)

    const before = changes.length
    expect(mgr.recordNodeHandoff(1, 'a1', 'y'.repeat(7000))).toBe(false) // unchanged → no notify
    expect(changes.length).toBe(before)

    expect(mgr.recordNodeHandoff('n9', 'a1', 'unknown ref')).toBe(false)
    expect(mgr.recordNodeHandoff(2, 'a1', 'wrong node')).toBe(false) // n2 has no attempt a1
  })
})

// ── formatUpstreamResults ──────────────────────────────────────────────────

describe('formatUpstreamResults — what a downstream spawn receives', () => {
  it('renders one section per direct dependency, preferring handoff over summary', () => {
    const plan = diamond()
    markNode(plan, 1, 'completed')
    plan.nodes[0].summary = 'summary fallback'
    plan.nodes[0].handoff = 'full upstream output'
    const out = formatUpstreamResults(plan, plan.nodes[1]) // n2 → n1
    expect(out).toContain('## 前序节点处理结果')
    expect(out).toContain('### n1: 调研')
    expect(out).toContain('full upstream output')
    expect(out).not.toContain('summary fallback') // handoff wins
  })

  it('falls back to summary, then to a pointer at the node session', () => {
    const plan = diamond()
    markNode(plan, 1, 'completed')
    plan.nodes[0].summary = 'only a summary'
    expect(formatUpstreamResults(plan, plan.nodes[1])).toContain('only a summary')

    delete plan.nodes[0].summary
    expect(formatUpstreamResults(plan, plan.nodes[1])).toContain('(no recorded output — see its node session)')
  })

  it('returns null for a root node, a null plan, and joins multi-dep sections', () => {
    const plan = diamond()
    expect(formatUpstreamResults(plan, plan.nodes[0])).toBeNull() // n1 has no deps
    expect(formatUpstreamResults(null, plan.nodes[1])).toBeNull()

    markNode(plan, 1, 'completed')
    plan.nodes[0].handoff = 'x'
    markNode(plan, 2, 'completed')
    markNode(plan, 3, 'completed')
    plan.nodes[1].handoff = 'from n2'
    plan.nodes[2].handoff = 'from n3'
    const out = formatUpstreamResults(plan, plan.nodes[3])! // n4 → n2 + n3
    expect(out).toContain('### n2: 前端\nfrom n2')
    expect(out).toContain('### n3: 后端\nfrom n3')
  })

  it('truncates at the 8k budget with a pointer at the full output', () => {
    const plan = diamond()
    markNode(plan, 1, 'completed')
    markNode(plan, 2, 'completed')
    markNode(plan, 3, 'completed')
    plan.nodes[1].handoff = 'A'.repeat(5000)
    plan.nodes[2].handoff = 'B'.repeat(5000)
    const out = formatUpstreamResults(plan, plan.nodes[3])!
    expect(out).toContain("truncated — the full output is in this node's sub-conversation]")
    expect(out.length).toBeLessThan(UPSTREAM_RESULTS_MAX + 200) // note may sit at the edge
    expect(out).toContain('A'.repeat(100)) // first dep landed intact
  })
})

// ── Wiring scans ───────────────────────────────────────────────────────────

describe('scheduler wiring (source scans)', () => {
  it('carries the kick() at all four hook sites', () => {
    // resume, batch drain decision, the tail's live-chained branch (midDrain —
    // review_20260930 中5: the tail's kick must not re-enter a clean dispatch
    // over live chained ids), and the handleEndTurnResponse entry.
    const flow = src('src/renderer/src/agent/engine/execution-flow.ts')
    expect((flow.match(/planScheduler\.kick\(/g) ?? []).length).toBe(4)
    expect(flow).toContain('planScheduler.kick({ midDrain: true })')
    // addToolResult's async straggler tail — plus the mid-drain chain entry
    // that fires on every result which did NOT close the drain.
    const engine = src('src/renderer/src/agent/AgentEngine.ts')
    expect((engine.match(/planScheduler\.kick\(/g) ?? []).length).toBe(1)
    expect(engine).toContain('planScheduler.settleAndChain()')
    // The kick and the concurrent chain channel live in the engine module.
    const scheduler = src('src/renderer/src/agent/engine/plan-scheduler.ts')
    expect(scheduler).toContain('kick(opts?: { midDrain?: boolean })')
    expect(scheduler).toContain('dispatchConcurrent')
  })

  it('has scrubbed the ritual-round copy from every prompt surface', () => {
    const surfaces = [
      'src/shared/plan/graph.ts',
      'src/renderer/src/tools/built-in-tools.ts',
      'src/renderer/src/tools/tool-instructions.ts',
      'src/shared/expert-context.ts',
    ].map(src).join('\n')
    for (const dead of [
      'NEVER auto-advances',
      'SAME response so they run in parallel',
      'the plan does not auto-advance',
      'MANDATORY after each node settles',
      'plan NEVER advances by itself',
      'put them ALL in the same response',
      'Dispatch every READY node with',
      'Settle each node with',
    ]) {
      expect(surfaces).not.toContain(dead)
    }
  })

  it('tells the scheduler story on each surface, and keeps direct mode\'s lowercase contract', () => {
    const graph = src('src/shared/plan/graph.ts')
    expect(graph).toContain('dispatched AUTOMATICALLY by the scheduler')
    expect(graph).toContain('You are consulted at exactly two points')
    // Direct mode is the todo list now (2026-10-25) — still main-agent-run,
    // still never scheduler-driven; the prose teaches todo_write.
    expect(graph).toContain('Work through the list yourself')

    const tools = src('src/renderer/src/tools/built-in-tools.ts')
    expect(tools).toContain('the scheduler runs the plan')
    expect(tools).toContain('never one with a live attempt is accepted')
    expect(tools).toContain('the scheduler settles successful deliveries')

    const instructions = src('src/renderer/src/tools/tool-instructions.ts')
    expect(instructions).toContain('the SCHEDULER dispatches the READY set itself')
    expect(instructions).toContain('Never call advance_plan to report a delivery')

    const summon = src('src/shared/expert-context.ts')
    expect(summon).toContain('the scheduler dispatches every READY node')
  })
})
