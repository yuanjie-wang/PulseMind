import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MAX_PLAN_NODES,
  MAX_TODO_HISTORY,
  createPlanDag,
  detectPreNarration,
  formatPlanForPrompt,
  formatPlanSnapshot,
  planNodeExecutionLabel,
  reconcileTodo,
} from '../src/shared/plan/graph'
import { nextScheduleAction } from '../src/shared/plan/schedule'
import { PlanManager } from '../src/renderer/src/agent/plan-manager'
import { BUILT_IN_TOOLS, SUB_AGENT_DENY_TOOLS } from '../src/renderer/src/tools/built-in-tools'
import { toolInstructions } from '../src/renderer/src/tools/tool-instructions'
import type { ToolUseBlock, AgentMessage } from '../src/renderer/src/types/agent'
import type { Plan, PlanNode } from '../src/shared/types/plan'

// ── todo_write = the direct-mode plan (2026-10-25) ─────────────────────────
// The plan system's dormant 'direct' mode becomes the todo list's carrier:
// flat entries (no edges), never dispatched, statuses self-reported, written
// ONLY through reconcileTodo (PlanManager's fourth policy). Identity is the
// ID (2026-10-25 第二次收缩): an item WITHOUT an id is a NEW entry, period —
// there is no wording fallback, so the reword trap is structurally gone and
// the one remaining failure mode (a forgotten id) is a visible fork that the
// retire∧add caution names. The routing contract the whole feature rests on:
// create_plan always delegates, todo_write never spawns.

const ROOT = join(__dirname, '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

const list = (...items: Array<string | { description: string; status?: string; note?: string; id?: string }>): unknown =>
  items.map(i => (typeof i === 'string' ? { description: i } : i))

/** Reference an existing entry by id (the only way to address one). */
const ref = (n: number, description: string, extra?: { status?: string; note?: string }): { description: string; id: string; status?: string; note?: string } =>
  ({ id: `n${n}`, description, ...(extra?.status ? { status: extra.status } : {}), ...(extra?.note ? { note: extra.note } : {}) })

describe('reconcileTodo — mint', () => {
  it('builds a flat direct-mode plan; no deps, no assignee, pre-marked current', () => {
    const { plan } = reconcileTodo(null, 'refactor auth', list('a', { description: 'b', status: 'in_progress' }, 'c'))
    expect(plan.mode).toBe('direct')
    expect(plan.version).toBe(2)
    expect(plan.completed).toBe(false)
    expect(plan.nodes.map(n => n.id)).toEqual(['n1', 'n2', 'n3'])
    expect(plan.nodes.every(n => n.dependsOn.length === 0 && !n.assignee)).toBe(true)
    expect(plan.currentNodeId).toBe('n2')
  })

  it('requires objective and at least one entry; rejects blank descriptions', () => {
    expect(() => reconcileTodo(null, '  ', list('a'))).toThrow('objective is required')
    expect(() => reconcileTodo(null, 'o', [])).toThrow('items are required')
    expect(() => reconcileTodo(null, 'o', [{ description: ' ' }])).toThrow('description is required')
    expect(() => reconcileTodo(null, 'o', [{ description: 'a' }, { description: '' }])).toThrow('item 2')
  })

  it('respects the node cap on mint', () => {
    const tooMany = Array.from({ length: MAX_PLAN_NODES + 1 }, (_, i) => ({ description: `s${i}` }))
    expect(() => reconcileTodo(null, 'o', tooMany)).toThrow(`maximum ${MAX_PLAN_NODES}`)
  })
})

describe('reconcileTodo — full-list replace over a live todo', () => {
  const mint = (): Plan => reconcileTodo(null, 'o', list('a', 'b', 'c')).plan

  it('re-sending the same list BY ID updates in place — no duplicates', () => {
    const plan = mint()
    const { plan: after, stats } = reconcileTodo(plan, '', list(ref(1, 'a'), ref(2, 'b'), ref(3, 'c')))
    expect(after.nodes.map(n => n.id)).toEqual(['n1', 'n2', 'n3'])
    expect(stats.added).toBe(0)
    expect(stats.retired).toBe(0)
  })

  it('check-off completes the node and the plan auto-closes on the last settle', () => {
    const plan = mint()
    const { plan: after } = reconcileTodo(plan, '', list(ref(1, 'a', { status: 'completed' }), ref(2, 'b', { status: 'completed' }), ref(3, 'c', { status: 'completed' })))
    expect(after.nodes.every(n => n.status === 'completed')).toBe(true)
    expect(after.completed).toBe(true)
    expect(after.currentNodeId).toBeUndefined()
  })

  it('appends new entries and retires dropped pendings as skipped', () => {
    const plan = mint()
    const { plan: after, stats } = reconcileTodo(plan, '', list(ref(1, 'a'), 'd'))
    expect(after.nodes.map(n => n.description)).toEqual(['a', 'b', 'c', 'd'])
    expect(after.nodes.find(n => n.description === 'b')?.status).toBe('skipped')
    expect(after.nodes.find(n => n.description === 'c')?.status).toBe('skipped')
    expect(stats.added).toBe(1)
    expect(stats.retired).toBe(2)
  })

  it('settled entries are immutable: absent survive, id-claimed wording/status changes never touch them', () => {
    const plan = mint()
    reconcileTodo(plan, '', list(ref(1, 'a', { status: 'completed' }), ref(2, 'b')))
    const a = plan.nodes[0]
    const before = JSON.stringify(a)
    // id-claimed reword + status claim on a settled entry → ignored, counted
    const { plan: after, stats } = reconcileTodo(plan, '', list(ref(1, 'a2'), ref(2, 'b')))
    expect(JSON.stringify(after.nodes.find(n => n.id === 'n1'))).toBe(before)
    expect(stats.keptWording).toBe(1)
    expect(stats.added).toBe(0)
    expect(stats.retired).toBe(0) // n1 settled (not swept), n3 already skipped
  })

  it('an id-less re-list of a retired entry appends a NEW node — revival needs the id', () => {
    const plan = mint()
    const { plan: p2 } = reconcileTodo(plan, '', list(ref(1, 'a'), ref(3, 'c'))) // b retired
    const { plan: after } = reconcileTodo(p2, '', list(ref(1, 'a'), 'b', ref(3, 'c')))
    const bs = after.nodes.filter(n => n.description === 'b')
    expect(bs).toHaveLength(2)
    expect(bs[0].status).toBe('skipped')
    expect(bs[1].status).toBe('pending')
  })

  it('id-claimed failed entries stay failed (a todo retried = a new entry)', () => {
    const plan = mint()
    plan.nodes[0].status = 'failed'
    const { plan: after, stats } = reconcileTodo(plan, '', list(ref(1, 'a'), ref(2, 'b'), ref(3, 'c')))
    expect(after.nodes[0].status).toBe('failed')
    expect(stats.added).toBe(0)
  })

  it('in_progress is derived from the incoming list alone: last claim wins, absence clears, settled claims never stick', () => {
    const plan = mint()
    const { plan: p2 } = reconcileTodo(plan, '', list(ref(1, 'a'), ref(2, 'b', { status: 'in_progress' }), ref(3, 'c', { status: 'in_progress' })))
    expect(p2.currentNodeId).toBe('n3') // last wins
    const { plan: p3 } = reconcileTodo(p2, '', list(ref(1, 'a'), ref(2, 'b'), ref(3, 'c', { status: 'completed' })))
    expect(p3.nodes[2].status).toBe('completed')
    expect(p3.currentNodeId).toBeUndefined() // no in_progress sent → nothing in progress
    const { plan: p4 } = reconcileTodo(p3, '', list(ref(1, 'a'), ref(2, 'b', { status: 'in_progress' }), ref(3, 'c')))
    expect(p4.currentNodeId).toBe('n2')
    const { plan: p5 } = reconcileTodo(p4, '', list(ref(1, 'a'), ref(2, 'b'), ref(3, 'c'))) // re-sent, no claim
    expect(p5.currentNodeId).toBeUndefined()
  })

  it('the node budget rejects whole-unit — the live plan is untouched', () => {
    const plan = mint() // 3 nodes
    for (let i = 4; i <= MAX_PLAN_NODES; i++) {
      reconcileTodo(plan, '', [...plan.nodes.map(n => ref(Number(n.id.slice(1)), n.description)), { description: `extra${i}` }])
    }
    expect(plan.nodes).toHaveLength(MAX_PLAN_NODES)
    const snapshot = JSON.stringify(plan)
    expect(() => reconcileTodo(plan, '', list(...plan.nodes.map(n => ref(Number(n.id.slice(1)), n.description)), 'one-too-many')))
      .toThrow(`maximum ${MAX_PLAN_NODES}`)
    expect(JSON.stringify(plan)).toBe(snapshot)
  })

  // The cap counts OUTSTANDING entries, not rows (2026-11-06). Charging settled
  // history made it un-escapable: retire soft-skips a row but keeps it, so after
  // 20 lifetime entries every append was refused — and the refusal pointed at
  // "retire finished entries", the one action that frees nothing.
  it('the budget counts OUTSTANDING entries — settled history never blocks an append', () => {
    const all = Array.from({ length: MAX_PLAN_NODES }, (_, i) => ({ description: `s${i + 1}`, status: 'completed' as const }))
    const settled = reconcileTodo(null, 'o', all).plan
    expect(settled.nodes).toHaveLength(MAX_PLAN_NODES)
    expect(settled.completed).toBe(true)
    const { plan: after } = reconcileTodo(settled, 'o', list(...settled.nodes.map(n => ref(Number(n.id.slice(1)), n.description, { status: 'completed' })), 'next'))
    expect(after.nodes).toHaveLength(MAX_PLAN_NODES + 1)
    expect(after.nodes[MAX_PLAN_NODES].id).toBe(`n${MAX_PLAN_NODES + 1}`)
    expect(after.completed).toBe(false)
  })

  it('settling and appending in ONE call is legitimate — the budget judges the projected list', () => {
    const plan = reconcileTodo(null, 'o', Array.from({ length: MAX_PLAN_NODES }, (_, i) => ({ description: `s${i + 1}` }))).plan
    const done = plan.nodes.map(n => ref(Number(n.id.slice(1)), n.description, { status: 'completed' as const }))
    const { plan: after } = reconcileTodo(plan, 'o', list(...done, 'fresh-1', 'fresh-2'))
    expect(after.nodes.filter(n => n.status === 'pending')).toHaveLength(2)
    expect(after.completed).toBe(false)
  })

  it('the OUTSTANDING cap still bites — 20 open + one more is rejected whole-unit', () => {
    const plan = reconcileTodo(null, 'o', Array.from({ length: MAX_PLAN_NODES }, (_, i) => ({ description: `s${i + 1}` }))).plan
    const snapshot = JSON.stringify(plan)
    expect(() => reconcileTodo(plan, 'o', list(...plan.nodes.map(n => ref(Number(n.id.slice(1)), n.description)), 'one-too-many')))
      .toThrow(`maximum ${MAX_PLAN_NODES} outstanding`)
    expect(JSON.stringify(plan)).toBe(snapshot)
  })

  it('rows past the history cap drop the OLDEST settled ones — surviving numbers never renumber', () => {
    let plan = reconcileTodo(null, 'o', Array.from({ length: MAX_PLAN_NODES }, (_, i) => ({ description: `s${i + 1}`, status: 'completed' as const }))).plan
    for (let i = 0; i < MAX_TODO_HISTORY; i++) {
      plan = reconcileTodo(plan, 'o', list({ description: `x${i + 1}`, status: 'completed' })).plan
    }
    expect(plan.nodes).toHaveLength(MAX_TODO_HISTORY)
    expect(plan.nodes.some(n => n.id === 'n1')).toBe(false)
    expect(plan.nodes[plan.nodes.length - 1].id).toBe(`n${MAX_PLAN_NODES + MAX_TODO_HISTORY}`)
    // A dropped id stops resolving, and the message names what IS there.
    expect(() => reconcileTodo(plan, 'o', list(ref(1, 'gone')))).toThrow('does not exist')
  })

  it('the completion anchor rides fix.msgId onto the nodes settled this pass', () => {
    const plan = mint()
    const { plan: after } = reconcileTodo(plan, '', list(ref(1, 'a', { status: 'completed' }), ref(2, 'b')), { msgId: 'assistant-1' })
    expect(after.nodes[0].msgId).toBe('assistant-1')
    expect(after.nodes[1].msgId).toBeUndefined()
  })

  it('a delegated plan is not reconciled — a fresh todo mints', () => {
    const delegated = createPlanDag('dag', [{ description: 'x' }])
    const { plan } = reconcileTodo(delegated, 'todo', list('a'))
    expect(plan.mode).toBe('direct')
    expect(plan.nodes.map(n => n.description)).toEqual(['a'])
  })

  // The lost-id bug (2026-11-06): a closed list used to MINT, which renumbers by
  // position and ignores the incoming ids — a model holding stale numbering got a
  // silent rewrite instead of an error, and could only guess the next number.
  it('a CLOSED todo is continued in place: numbering keeps counting, a new pending re-opens it', () => {
    const settled = reconcileTodo(reconcileTodo(null, 'o', list('a', 'b')).plan, 'o', list(ref(1, 'a', { status: 'completed' }), ref(2, 'b', { status: 'completed' }))).plan
    expect(settled.completed).toBe(true)
    const { plan: after, minted } = reconcileTodo(settled, 'o', list(ref(1, 'a', { status: 'completed' }), ref(2, 'b', { status: 'completed' }), 'c'))
    expect(minted).toBe(false)
    expect(after.nodes.map(n => n.description)).toEqual(['a', 'b', 'c'])
    expect(after.nodes[2].id).toBe('n3')
    expect(after.completed).toBe(false)
  })

  it('fresh=true discards the closed list instead of renumbering it silently', () => {
    const settled = reconcileTodo(reconcileTodo(null, 'o', list('a', 'b')).plan, 'o', list(ref(1, 'a', { status: 'completed' }), ref(2, 'b', { status: 'completed' }))).plan
    expect(settled.completed).toBe(true)
    const { plan: fresh, minted } = reconcileTodo(settled, 'new', list('x'), { fresh: true })
    expect(minted).toBe(true)
    expect(fresh.nodes.map(n => n.description)).toEqual(['x'])
    expect(fresh.nodes[0].id).toBe('n1')
    expect(fresh.nodes[0].status).toBe('pending')
  })
})

describe('scheduler fall-through', () => {
  it('a direct-mode plan never enters the scheduler — every action is none', () => {
    const { plan } = reconcileTodo(null, 'o', list({ description: 'a', status: 'in_progress' }, 'b'))
    expect(nextScheduleAction(plan).type).toBe('none')
    expect(nextScheduleAction(createPlanDag('dag', [{ description: 'x' }])).type).toBe('dispatch')
  })
})

// ── Executors over the real PlanManager ────────────────────────────────────

function makeManager(messages: AgentMessage[] = [], summoned: Array<{ id: string; name: string }> = []) {
  const results: Array<{ id: string; content: string; isError: boolean }> = []
  const notifications: Array<Plan | null> = []
  const mgr = new PlanManager(
    (id, content, isError) => results.push({ id, content, isError }),
    () => {},
    () => messages,
    (p) => notifications.push(p),
    () => summoned,
  )
  return { mgr, results, notifications }
}

let seq = 0
const todoCall = (input: Record<string, unknown>): ToolUseBlock =>
  ({ type: 'tool_use', id: `tu_${++seq}`, name: 'todo_write', input, status: 'pending' }) as ToolUseBlock

const anchorMessage = (t: ToolUseBlock): AgentMessage[] => [
  {
    id: `assistant-for-${t.id}`,
    role: 'assistant',
    contentBlocks: [{ type: 'tool_use', id: t.id, name: 'todo_write', input: {} }],
    createdAt: new Date().toISOString(),
  },
]

describe('execTodoWrite', () => {
  it('mints the todo, reports the snapshot and notifies', async () => {
    const { mgr, results, notifications } = makeManager()
    await mgr.execTodoWrite(todoCall({ objective: 'ship', items: list('a', 'b') }))
    expect(mgr.plan?.mode).toBe('direct')
    expect(results[0].isError).toBe(false)
    expect(results[0].content).toContain('Todo list created with 2 entries')
    expect(notifications).toHaveLength(1)
  })

  it('reconciles the live todo on the second call, with the append/retire note', async () => {
    const { mgr, results } = makeManager()
    await mgr.execTodoWrite(todoCall({ objective: 'ship', items: list('a', 'b') }))
    await mgr.execTodoWrite(todoCall({ items: list(ref(1, 'a', { status: 'completed' }), 'c') }))
    expect(mgr.plan?.nodes.map(n => `${n.description}:${n.status}`)).toEqual(['a:completed', 'b:skipped', 'c:pending'])
    expect(results[1].content).toContain('Todo list updated')
    expect(results[1].content).toContain('+1 added')
    expect(results[1].content).toContain('1 retired')
  })

  it('anchors completed entries to the calling assistant message', async () => {
    const t = todoCall({ objective: 'o', items: list({ description: 'a', status: 'completed' }) })
    const { mgr } = makeManager(anchorMessage(t))
    await mgr.execTodoWrite(t)
    expect(mgr.plan?.nodes[0].msgId).toBe(`assistant-for-${t.id}`)
  })

  it('refuses under a summons — delegation owns the turn (create_plan)', async () => {
    const { mgr, results } = makeManager([], [{ id: 'exp1', name: '翻译官' }])
    await mgr.execTodoWrite(todoCall({ objective: 'o', items: list('a') }))
    expect(results[0].isError).toBe(true)
    expect(results[0].content).toContain('create_plan')
    expect(mgr.plan).toBeNull()
  })

  it('refuses while a delegated plan is live', async () => {
    const { mgr, results } = makeManager()
    mgr.plan = createPlanDag('dag', [{ description: 'x' }])
    await mgr.execTodoWrite(todoCall({ objective: 'o', items: list('a') }))
    expect(results[0].isError).toBe(true)
    expect(results[0].content).toContain('delegated plan is active')
    expect(mgr.plan?.mode).toBe('delegated')
  })

  it('create_plan still mints delegated plans — the DAG contract is unchanged', async () => {
    const { mgr } = makeManager()
    await mgr.execCreatePlan({ type: 'tool_use', id: 'tu_cp', name: 'create_plan', input: { objective: 'o', steps: [{ description: 'x' }] }, status: 'pending' } as ToolUseBlock)
    expect(mgr.plan?.mode).toBe('delegated')
  })
})

describe('execAdvancePlan against a todo', () => {
  it('rejects with the routing lesson — todos update via todo_write', async () => {
    const { mgr, results } = makeManager()
    await mgr.execTodoWrite(todoCall({ objective: 'o', items: list('a', 'b') }))
    await mgr.execAdvancePlan({ type: 'tool_use', id: 'tu_ap', name: 'advance_plan', input: { action: 'complete', node: '1' }, status: 'pending' } as ToolUseBlock)
    expect(results[1].isError).toBe(true)
    expect(results[1].content).toContain('todo_write')
    expect(mgr.plan?.nodes[0].status).toBe('pending')
  })
})

// ── Rendering branches ──────────────────────────────────────────────────────

describe('prompt section and snapshot rendering', () => {
  it('formatPlanForPrompt: the todo branch teaches todo_write discipline, no scheduler vocabulary', () => {
    const { plan } = reconcileTodo(null, 'ship', list({ description: 'a', status: 'completed' }, { description: 'b', status: 'in_progress' }, 'c'))
    const text = formatPlanForPrompt(plan) ?? ''
    expect(text).toContain('Mode: direct')
    expect(text).toContain('[done] n1: a')
    expect(text).toContain('[~] n2: b — IN PROGRESS')
    expect(text).toContain('todo_write')
    expect(text).not.toContain('dispatched AUTOMATICALLY')
    expect(text).not.toContain('delegated node yourself')
  })

  // The delta snapshot renders ONLY the entries a call touched, on the explicit
  // assumption that this section re-injects the full list next turn. Returning
  // null for a closed list broke that loop exactly when it mattered.
  it('formatPlanForPrompt: a CLOSED todo still injects its numbering and the way back in', () => {
    const { plan } = reconcileTodo(null, 'ship', list({ description: 'a', status: 'completed' }, { description: 'b', status: 'completed' }))
    expect(plan.completed).toBe(true)
    const text = formatPlanForPrompt(plan) ?? ''
    expect(text).toContain('STATE: CLOSED')
    expect(text).toContain('highest is n2')
    expect(text).toContain('n3')
    expect(text).toContain('fresh=true')
    expect(text).not.toContain('dispatched AUTOMATICALLY')
  })

  it('formatPlanForPrompt: delegated plans keep the scheduler rules verbatim', () => {
    const text = formatPlanForPrompt(createPlanDag('dag', [{ description: 'x' }])) ?? ''
    expect(text).toContain('dispatched AUTOMATICALLY')
    expect(text).toContain('Never execute a delegated node yourself')
  })

  it('formatPlanSnapshot: create/update arms speak todo', () => {
    const { plan } = reconcileTodo(null, 'ship', list('a', 'b'))
    const created = formatPlanSnapshot(plan, { action: 'create' })
    expect(created).toContain('Todo list created with 2 entries')
    expect(created).toContain('todo_write')
    const updated = formatPlanSnapshot(plan, { action: 'update' })
    expect(updated).toContain('Todo list updated')
    expect(updated).toContain('keep exactly ONE entry in_progress')
  })
})

// ── blocked + note（评审采纳项，2026-10-25）─────────────────────────────────

describe('blocked + note', () => {
  const mint = (): Plan => reconcileTodo(null, 'o', list('a', 'b')).plan

  it('blocked carries its note; the plan stays open while blocked work remains', () => {
    const plan = mint()
    const { plan: p2 } = reconcileTodo(plan, '', list(ref(1, 'a', { status: 'blocked', note: '等信源A' }), ref(2, 'b')))
    expect(p2.nodes[0].status).toBe('blocked')
    expect(p2.nodes[0].summary).toBe('等信源A')
    expect(p2.completed).toBe(false)
    const { plan: p3 } = reconcileTodo(p2, '', list(ref(1, 'a', { status: 'blocked', note: '等信源A' }), ref(2, 'b', { status: 'completed' })))
    expect(p3.completed).toBe(false) // blocked is NOT terminal — the plan cannot close under it
    const { plan: p4 } = reconcileTodo(p3, '', list(ref(1, 'a', { status: 'completed', note: '拿到了' }), ref(2, 'b', { status: 'completed' })))
    expect(p4.completed).toBe(true)
    expect(p4.nodes[0].summary).toBe('拿到了') // note lands at the settle moment
  })

  it('blocked recovers: in_progress resumes as current, explicit pending re-opens, bare re-list keeps it blocked', () => {
    const plan = mint()
    const { plan: p2 } = reconcileTodo(plan, '', list(ref(1, 'a', { status: 'blocked', note: '等' }), ref(2, 'b')))
    const { plan: p3 } = reconcileTodo(p2, '', list(ref(1, 'a', { status: 'in_progress' }), ref(2, 'b')))
    expect(p3.nodes[0].status).toBe('pending')
    expect(p3.currentNodeId).toBe('n1')
    const { plan: p4 } = reconcileTodo(p3, '', list(ref(1, 'a', { status: 'pending' }), ref(2, 'b')))
    expect(p4.nodes[0].status).toBe('pending')
    expect(p4.currentNodeId).toBeUndefined()
    const { plan: p5 } = reconcileTodo(mint(), '', list(ref(1, 'a', { status: 'blocked' }), ref(2, 'b')))
    const { plan: p6 } = reconcileTodo(p5, '', list(ref(1, 'a'), ref(2, 'b'))) // bare re-list: state kept
    expect(p6.nodes[0].status).toBe('blocked')
  })

  it('blocked work absent from the list retires like any open entry', () => {
    const plan = mint()
    const { plan: p2 } = reconcileTodo(plan, '', list(ref(1, 'a', { status: 'blocked' }), ref(2, 'b')))
    const { plan: p3, stats } = reconcileTodo(p2, '', list(ref(2, 'b')))
    expect(p3.nodes[0].status).toBe('skipped')
    expect(stats.retired).toBe(1)
  })

  it('notes attach to live entries — never to already-settled ones, even via id', () => {
    const plan = mint()
    const { plan: p2 } = reconcileTodo(plan, '', list(ref(1, 'a', { status: 'in_progress', note: '用方案B' }), ref(2, 'b')))
    expect(p2.nodes[0].summary).toBe('用方案B')
    const { plan: p3 } = reconcileTodo(p2, '', list(ref(1, 'a', { status: 'completed' }), ref(2, 'b')))
    expect(p3.nodes[0].summary).toBe('用方案B') // pre-settle note rides into the settled row
    const { plan: p4 } = reconcileTodo(p3, '', list(ref(1, 'a', { note: '试图改口' }), ref(2, 'b')))
    expect(p4.nodes[0].summary).toBe('用方案B') // bare re-list: settled note untouched
    const { plan: p5 } = reconcileTodo(p4, '', list(ref(1, 'a', { note: '试图改口' }), ref(2, 'b')))
    expect(p5.nodes[0].summary).toBe('用方案B') // settled is fully immutable — the id rewrites nothing on it
  })

  it('rendering: [wait] marker, BLOCKED suffix, and the tail counts blocked as open work', () => {
    const { plan } = reconcileTodo(null, 'ship', list({ description: 'a', status: 'blocked', note: '等回信' }, 'b'))
    const snap = formatPlanSnapshot(plan, { action: 'update' })
    expect(snap).toContain('[wait] n1: a — BLOCKED — 等回信')
    expect(snap).toContain('0/2 settled')
    expect(snap).toContain('1 blocked — open work waiting on something outside your control, NOT settled progress.')
    const prompt = formatPlanForPrompt(plan) ?? ''
    expect(prompt).toContain('[wait] n1: a — BLOCKED')
    expect(prompt).toContain('blocked (+ a note saying what it waits on)')
  })

  it('mint carries pre-blocked entries and their notes', () => {
    const { plan } = reconcileTodo(null, 'o', list({ description: 'a', status: 'blocked', note: '等审批' }, 'b'))
    expect(plan.nodes[0].status).toBe('blocked')
    expect(plan.nodes[0].summary).toBe('等审批')
    expect(plan.completed).toBe(false)
  })

  it('label vocabulary: blocked reads 已阻塞 in both panel and tooltip paths', () => {
    expect(planNodeExecutionLabel({ status: 'blocked' } as PlanNode)).toBe('已阻塞')
  })

  it('schema wiring: blocked in the enum, note on the item, manual teaches the vocabulary', () => {
    const def = BUILT_IN_TOOLS.find(t => t.name === 'todo_write')!
    const itemSchema = (def.input_schema.properties.items as { items: { properties: Record<string, { enum?: string[] }> } }).items
    expect(itemSchema.properties.status.enum).toEqual(['pending', 'in_progress', 'completed', 'blocked'])
    expect(itemSchema.properties.note).toBeDefined()
    expect(toolInstructions.todo_write).toContain('Blocked is for waiting')
    expect(def.description).toContain('blocked')
  })
})

// ── id claims + delta result（评审「一票之选」，2026-10-25）────────────────

describe('id claims + delta result', () => {
  const mint = (): Plan => reconcileTodo(null, 'o', list('a', 'b', 'c')).plan

  it('reword via id keeps the thread: in-place description, zero retire, zero append', () => {
    const plan = mint()
    const { plan: p2, stats, changed } = reconcileTodo(plan, '', list(ref(1, 'a'), ref(2, 'b 修订版'), ref(3, 'c')))
    expect(p2.nodes.map(n => n.id)).toEqual(['n1', 'n2', 'n3'])
    expect(p2.nodes[1].description).toBe('b 修订版')
    expect(stats.added).toBe(0)
    expect(stats.retired).toBe(0)
    expect(changed).toContain('n2')
  })

  it('the migrated trap: an id-less reword appends + retires — the one failure mode, cautioned', () => {
    const plan = mint()
    const { plan: p2, stats } = reconcileTodo(plan, '', list(ref(1, 'a'), 'b 修订版', ref(3, 'c')))
    expect(p2.nodes.find(n => n.description === 'b')?.status).toBe('skipped')
    expect(p2.nodes.filter(n => n.description === 'b 修订版')).toHaveLength(1)
    expect(stats.retired).toBe(1)
    expect(stats.added).toBe(1)
  })

  it('an id-less item that duplicates an existing wording is STILL a new entry — no wording fallback', () => {
    const plan = mint()
    const { plan: p2, stats } = reconcileTodo(plan, '', list(ref(1, 'a'), ref(2, 'b'), ref(3, 'c'), 'a'))
    const as = p2.nodes.filter(n => n.description === 'a')
    expect(as).toHaveLength(2) // n1 untouched, n4 appended
    expect(as[0].status).toBe('pending')
    expect(as[1].status).toBe('pending')
    expect(stats.added).toBe(1)
    expect(stats.retired).toBe(0)
  })

  it('id on a retired entry revives it — bare, straight to completed, or as blocked with a note', () => {
    const { plan: p2 } = reconcileTodo(mint(), '', list(ref(1, 'a'), ref(3, 'c'))) // b retired
    const b = p2.nodes.find(n => n.description === 'b')!
    expect(b.status).toBe('skipped')
    const { plan: p3, changed } = reconcileTodo(p2, '', list(ref(1, 'a'), ref(2, 'b 修订版'), ref(3, 'c')))
    expect(p3.nodes.find(n => n.id === b.id)?.status).toBe('pending')
    expect(p3.nodes.find(n => n.id === b.id)?.description).toBe('b 修订版')
    expect(changed).toContain(b.id)
    const { plan: p4 } = reconcileTodo(mint(), '', list(ref(1, 'a'), ref(3, 'c')))
    const b4 = p4.nodes.find(n => n.description === 'b')!
    const { plan: p5 } = reconcileTodo(p4, '', list(ref(1, 'a'), ref(2, 'b', { status: 'completed' }), ref(3, 'c')))
    expect(p5.nodes.find(n => n.id === b4.id)?.status).toBe('completed')
    const { plan: p6 } = reconcileTodo(mint(), '', list(ref(1, 'a'), ref(3, 'c')))
    const b6 = p6.nodes.find(n => n.description === 'b')!
    const { plan: p7 } = reconcileTodo(p6, '', list(ref(1, 'a'), ref(2, 'b', { status: 'blocked', note: '又等上了' }), ref(3, 'c')))
    expect(p7.nodes.find(n => n.id === b6.id)?.status).toBe('blocked')
    expect(p7.nodes.find(n => n.id === b6.id)?.summary).toBe('又等上了')
  })

  it('id on a settled entry: wording ignored and counted, status claims ignored', () => {
    const plan = mint()
    reconcileTodo(plan, '', list(ref(1, 'a', { status: 'completed' }), ref(2, 'b'), ref(3, 'c')))
    const { plan: p2, stats } = reconcileTodo(plan, '', list(ref(1, 'a2', { status: 'pending' }), ref(2, 'b'), ref(3, 'c')))
    expect(p2.nodes[0].description).toBe('a')
    expect(p2.nodes[0].status).toBe('completed')
    expect(stats.keptWording).toBe(1)
  })

  it('id gates: unknown / malformed / duplicate throw model-facing — plan untouched', () => {
    const plan = mint()
    const before = JSON.stringify(plan)
    expect(() => reconcileTodo(plan, '', list({ id: 'n9', description: 'x' }))).toThrow('does not exist')
    expect(() => reconcileTodo(plan, '', list({ id: 'abc', description: 'x' }))).toThrow('not an entry number')
    expect(() => reconcileTodo(plan, '', list({ id: 'n1', description: 'x' }, { id: 'n1', description: 'y' }))).toThrow('claimed twice')
    expect(JSON.stringify(plan)).toBe(before)
  })

  it('delta snapshot: update renders only touched rows; the state block stays full', () => {
    const plan = mint()
    const { plan: p2, changed, stats } = reconcileTodo(plan, '', list(ref(1, 'a'), ref(2, 'b', { status: 'completed' }), ref(3, 'c')))
    expect(changed).toEqual(['n2'])
    const snap = formatPlanSnapshot(p2, { action: 'update', changed, stats })
    expect(snap).toContain('Todo list updated — +0 added, 0 retired, 1 completed')
    expect(snap).toContain('[done] n2: b')
    expect(snap).not.toContain('n1: a')
    expect(snap).not.toContain('n3: c')
    expect(snap).toContain('1/3 settled')
    const prompt = formatPlanForPrompt(p2) ?? ''
    expect(prompt).toContain('n1: a')
    expect(prompt).toContain('n3: c')
  })

  it('the reword caution fires only when a call both retires and adds', () => {
    const plan = mint()
    const { plan: p2, changed, stats } = reconcileTodo(plan, '', list(ref(1, 'a'), 'b2', ref(3, 'c')))
    expect(stats.retired).toBe(1)
    expect(stats.added).toBe(1)
    const snap = formatPlanSnapshot(p2, { action: 'update', changed, stats })
    expect(snap).toContain('Caution')
    const { plan: p3, changed: ch3, stats: s3 } = reconcileTodo(p2, '', list(ref(1, 'a'), ref(4, 'b2', { status: 'completed' }), ref(3, 'c')))
    const snap3 = formatPlanSnapshot(p3, { action: 'update', changed: ch3, stats: s3 })
    expect(snap3).not.toContain('Caution')
  })

  it('kept wording is announced, not swallowed', () => {
    const plan = mint()
    reconcileTodo(plan, '', list(ref(1, 'a', { status: 'completed' }), ref(2, 'b'), ref(3, 'c')))
    const { plan: p2, changed, stats } = reconcileTodo(plan, '', list(ref(1, 'a2'), ref(2, 'b'), ref(3, 'c')))
    const snap = formatPlanSnapshot(p2, { action: 'update', changed, stats })
    expect(snap).toContain('kept their wording')
  })

  it('executor passes the delta through — the result shows only touched rows', async () => {
    const { mgr, results } = makeManager()
    await mgr.execTodoWrite(todoCall({ objective: 'ship', items: list('a', 'b', 'c') }))
    await mgr.execTodoWrite(todoCall({ items: list(ref(1, 'a'), ref(2, 'b', { status: 'completed' }), ref(3, 'c')) }))
    expect(results[1].content).toContain('[done] n2: b')
    expect(results[1].content).not.toContain('n1: a')
    expect(results[1].content).toContain('+0 added, 0 retired, 1 completed')
  })

  it('schema wiring: item.id exists, manual teaches the id law', () => {
    const def = BUILT_IN_TOOLS.find(t => t.name === 'todo_write')!
    const itemSchema = (def.input_schema.properties.items as { items: { properties: Record<string, { type?: string }> } }).items
    expect(itemSchema.properties.id?.type).toBe('string')
    expect(toolInstructions.todo_write).toContain('Identity is the id')
  })
})

// ── blocked 蒸发护栏 + settled note 更正（第三轮评审采纳项）────────────────

describe('blocked drop-off callout + settled note correction', () => {
  const mint = (): Plan => reconcileTodo(null, 'o', list('a', 'b', 'c')).plan

  it('a blocked entry that drops off the list is named in the result — a pending one is not', () => {
    const plan = mint()
    const { plan: p2 } = reconcileTodo(plan, '', list(ref(1, 'a', { status: 'blocked', note: '等信源A' }), ref(2, 'b'), ref(3, 'c')))
    const { plan: p3, changed: ch3, stats: s3 } = reconcileTodo(p2, '', list(ref(2, 'b'), ref(3, 'c')))
    expect(p3.nodes[0].status).toBe('skipped')
    expect(s3.retiredBlocked).toEqual([{ id: 'n1', note: '等信源A' }])
    const snap = formatPlanSnapshot(p3, { action: 'update', changed: ch3, stats: s3 })
    expect(snap).toContain('Heads-up: n1 was BLOCKED when it dropped off the list (was waiting on: 等信源A)')
    expect(snap).toContain('Re-send it with its id')
    // a PENDING retirement is a normal rescope — no callout
    const { plan: p4, changed: ch4, stats: s4 } = reconcileTodo(p3, '', list(ref(3, 'c')))
    expect(p4.nodes[1].status).toBe('skipped')
    expect(s4.retiredBlocked).toBeUndefined()
    const snap4 = formatPlanSnapshot(p4, { action: 'update', changed: ch4, stats: s4 })
    expect(snap4).not.toContain('Heads-up')
  })

  it('the callout names every blocked drop-off, and carries no note when it never had one', () => {
    const plan = mint()
    const { plan: p2 } = reconcileTodo(plan, '', list(ref(1, 'a', { status: 'blocked' }), ref(2, 'b', { status: 'blocked', note: '等B' }), ref(3, 'c')))
    const { stats: s3 } = reconcileTodo(p2, '', list(ref(3, 'c')))
    expect(s3.retiredBlocked).toEqual([
      { id: 'n1', note: undefined },
      { id: 'n2', note: '等B' },
    ])
  })
})

// ── Pre-narration detection（预写返回检测，2026-10-25）─────────────────────

describe('pre-narration detection', () => {
  it('matches the update-snapshot voice in all its families', () => {
    expect(detectPreNarration('已更新：+0 added, 0 retired, 1 completed')).toBe(true)
    expect(detectPreNarration('其中 2 retired')).toBe(true)
    expect(detectPreNarration('清单 1/3 settled，进展正常')).toBe(true)
    expect(detectPreNarration('Todo list updated — the list above is the current truth')).toBe(true)
    expect(detectPreNarration('Todo list created with 3 entries')).toBe(true)
    expect(detectPreNarration('Heads-up: n1 was BLOCKED when it dropped off the list')).toBe(true)
    expect(detectPreNarration('Caution: this update both retired and added entries')).toBe(true)
  })

  it('never matches intent prose or state recitation — the recitation line stays legal', () => {
    expect(detectPreNarration('现在标记 n2 完成，然后处理 n3')).toBe(false)
    expect(detectPreNarration('n1 已完成（见当前清单），接下来做 n2')).toBe(false)
    // entry-row markers are ambiguous with state-block quotes — deliberately legal
    expect(detectPreNarration('清单当前状态：[done] n1: a / [~] n2: b')).toBe(false)
    expect(detectPreNarration('把 n3 标成 blocked，等信源回复')).toBe(false)
  })

  it('a call whose message pre-narrates a return gets the correction prefix on the REAL result', async () => {
    const t = todoCall({ objective: 'ship', items: list('a', 'b') })
    const messages: AgentMessage[] = [
      {
        id: 'fab',
        role: 'assistant',
        contentBlocks: [
          { type: 'text', text: '清单已更新：Todo list updated — +0 added, 0 retired, 2 completed。1/2 settled。' },
          { type: 'tool_use', id: t.id, name: 'todo_write', input: {} },
        ],
        createdAt: new Date().toISOString(),
      },
    ]
    const { mgr, results } = makeManager(messages)
    await mgr.execTodoWrite(t)
    expect(results[0].content).toContain('⚠ Pre-narrated return detected')
    expect(results[0].content).toContain('The content below is the REAL result')
    expect(results[0].content).toContain('Todo list created with 2 entries')
  })

  it('a call with intent-only prose gets the plain snapshot', async () => {
    const t = todoCall({ objective: 'ship', items: list('a', 'b') })
    const messages: AgentMessage[] = [
      {
        id: 'clean',
        role: 'assistant',
        contentBlocks: [
          { type: 'text', text: '现在建立任务清单，然后逐项执行。' },
          { type: 'tool_use', id: t.id, name: 'todo_write', input: {} },
        ],
        createdAt: new Date().toISOString(),
      },
    ]
    const { mgr, results } = makeManager(messages)
    await mgr.execTodoWrite(t)
    expect(results[0].content).not.toContain('Pre-narrated')
    expect(results[0].content).toContain('Todo list created with 2 entries')
  })
})

// ── Wiring scans (the DB layer's lesson: pin the seams, not just the logic) ─

describe('todo_write wiring', () => {
  it('is a registered system built-in with its manual, and allowed to sub-agents (2026-10-26)', () => {
    const def = BUILT_IN_TOOLS.find(t => t.name === 'todo_write')
    expect(def).toBeDefined()
    expect(def?.category).toBe('system')
    expect(def?.builtIn).toBe(true)
    expect(def?.instructions).toBe(toolInstructions.todo_write)
    expect(def?.input_schema.required).toEqual(['items'])
    // 2026-10-26 (user: 允许子代理用todo_write) — left the deny list it had
    // joined 2026-10-25; a sub-agent tracks its own list in its own PlanManager.
    expect(SUB_AGENT_DENY_TOOLS).not.toContain('todo_write')
  })

  it('rides the trusted system group in BOTH dispatch sites, dispatching for main AND spawned engines', () => {
    const src = read('src/renderer/src/agent/engine/execution-flow.ts')
    const lists = src.match(/const isSystemTool = \(name: string\): boolean =>[^\n]+/g) ?? []
    expect(lists.length).toBe(2)
    for (const l of lists) expect(l).toContain("'todo_write'")
    // No spawnedToolset guard on this branch — the sub-agent's own PlanManager
    // takes the call like the main engine's does.
    expect(src).toMatch(/name === 'todo_write'[\s\S]{0,400}planManager\.execTodoWrite\(t\)/)
    expect(src).not.toMatch(/todo_write'[\s\S]{0,200}subAgentDeniedTool/)
  })

  it('the routing lives in the tool surfaces, not just prose', () => {
    const def = BUILT_IN_TOOLS.find(t => t.name === 'create_plan')
    expect(def?.description).toContain('todo_write')
    expect(toolInstructions.create_plan).toContain('todo_write')
    expect(toolInstructions.todo_write).toContain('create_plan')
  })

  it('both locales label the tool card', () => {
    expect(read('src/renderer/src/i18n/locales/zh.ts')).toMatch(/todo_write: '更新任务清单'/)
    expect(read('src/renderer/src/i18n/locales/en.ts')).toMatch(/todo_write: 'Update todo list'/)
    expect(read('src/renderer/src/components/chat/tool-summary.ts')).toMatch(/'todo_write'/)
  })

  it('the plan type carries the current-node marker and the graph exports the mode predicate', () => {
    expect(read('src/shared/types/plan.ts')).toMatch(/currentNodeId\?: string/)
    expect(read('src/shared/plan/graph.ts')).toMatch(/export \{ isTodoPlan \}/)
  })

  it('fresh is forwarded end-to-end: schema declares it, the manual teaches it, the executor passes it (2026-11-06)', () => {
    // review_20261106 中1：声明（schema）、教学（manual 第 6 条）、引擎门
    // （reconcileTodo 的 !fix?.fresh）三处齐备，唯独执行器没转发——模型传了
    // fresh:true 却被静默按「继续」处理。四段链缺一段即红。
    expect(read('src/renderer/src/agent/plan-manager.ts')).toMatch(
      /reconcileTodo\([\s\S]{0,300}input\?\.fresh === true/,
    )
    const def = BUILT_IN_TOOLS.find(t => t.name === 'todo_write')
    expect((def?.input_schema.properties as Record<string, unknown>).fresh).toBeDefined()
    expect(toolInstructions.todo_write).toContain('`fresh: true`')
    expect(read('src/shared/plan/graph.ts')).toContain('!fix?.fresh')
  })
})
