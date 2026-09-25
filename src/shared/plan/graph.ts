/**
 * Pure graph operations over the plan DAG (PLAN-plan-dag). DOM-free and
 * host-free by construction: the engine, the state-block builder, the tool
 * snapshot and the PlanPanel all read through these functions, so derivation
 * rules (ready / blocked / layers) exist in exactly one place.
 */
import type { Plan, PlanNode, PlanNodeStatus, PlanNodeExecutionStatus } from '../types/plan'

export const MAX_PLAN_NODES = 20

/** Per-node handoff cap (PLAN-plan-scheduler S8/S9): the completed node's
 *  output text stored on `PlanNode.handoff` and persisted with plan_json.
 *  Worst case 20 × 6k = 120k on the conversation row — SQLite TEXT, fine; the
 *  full output always remains in the node's sub-conversation. */
export const NODE_HANDOFF_MAX = 6_000

/** Total budget for the `## Upstream Node Results` section injected into a
 *  dependent spawn's prompt (S8). Direct dependencies only; overflow truncates
 *  with a pointer to the sub-conversation rather than dropping sections. */
export const UPSTREAM_RESULTS_MAX = 8_000

export interface RawPlanNode {
  description: string
  /** 1-based indexes into the input array — the tool protocol form (D3). */
  dependsOn?: number[]
  assignee?: string
}

// ── Creation ─────────────────────────────────────────────────────────────

/** Validate + build a plan: indexes → ids, acyclicity, node cap. Throws with a
 *  model-facing message the create_plan executor can pass through verbatim. */
export function createPlanDag(
  objective: string,
  raw: RawPlanNode[],
  mode: 'direct' | 'delegated' = 'delegated',
): Plan {
  if (!objective.trim()) throw new Error('objective is required')
  if (raw.length === 0) throw new Error('steps are required')
  if (raw.length > MAX_PLAN_NODES) throw new Error(`maximum ${MAX_PLAN_NODES} nodes allowed`)

  const nodes: PlanNode[] = raw.map((r, i) => {
    if (!String(r.description || '').trim()) throw new Error(`step ${i + 1}: description is required`)
    const deps = dedupe(r.dependsOn ?? [])
    for (const d of deps) {
      if (d === i + 1) throw new Error(`step ${i + 1} cannot depend on itself`)
      if (d < 1 || d > raw.length) throw new Error(`step ${i + 1}: dependency ${d} is out of range (1..${raw.length})`)
    }
    return {
      id: `n${i + 1}`,
      description: r.description.trim(),
      status: 'pending',
      dependsOn: deps.map(d => `n${d}`),
      ...(r.assignee ? { assignee: r.assignee } : {}),
    }
  })

  const plan: Plan = { objective: objective.trim(), nodes, completed: false, version: 2, mode }
  assertAcyclic(nodes)
  return plan
}

function dedupe(indexes: number[]): number[] {
  return [...new Set(indexes)]
}

/** DFS color-walk — a plan that survived createPlanDag is acyclic, but this
 *  also guards migrated/hand-edited JSON before any Math.max(...deps) walk. */
function assertAcyclic(nodes: PlanNode[]): void {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (id: string): void => {
    const s = state.get(id)
    if (s === 'done') return
    if (s === 'visiting') throw new Error('plan steps contain a dependency cycle')
    state.set(id, 'visiting')
    for (const d of byId.get(id)?.dependsOn ?? []) visit(d)
    state.set(id, 'done')
  }
  for (const n of nodes) visit(n.id)
}

// ── Derivation ───────────────────────────────────────────────────────────

export const isTerminal = (status: PlanNodeStatus): boolean => status !== 'pending'

/** Pending and every dependency completed — the parallel-dispatch set (D1). */
export function readyNodes(plan: Plan): PlanNode[] {
  const byId = idMap(plan)
  return plan.nodes.filter(n =>
    n.status === 'pending' && n.dependsOn.every(d => byId.get(d)?.status === 'completed'),
  )
}

/** Pending but a dependency failed or was skipped — dead until the model
 *  retries or skips upstream (D4: failure never cascades by itself). */
export function blockedNodes(plan: Plan): PlanNode[] {
  const byId = idMap(plan)
  return plan.nodes.filter(n =>
    n.status === 'pending' && n.dependsOn.some(d => {
      const s = byId.get(d)?.status
      return s === 'failed' || s === 'skipped'
    }),
  )
}

/** Topological waves: layer(n) = 1 + max(layer(deps)). Wave i+1 is exactly the
 *  work that can start once wave i settles — the PlanPanel's grouping (D9). */
export function planLayers(plan: Plan): PlanNode[][] {
  const byId = new Map(plan.nodes.map(n => [n.id, n]))
  const layerOf = new Map<string, number>()
  const layerOfId = (id: string, path: Set<string>): number => {
    const memo = layerOf.get(id)
    if (memo !== undefined) return memo
    if (path.has(id)) return 1 // defensive: never happens for validated plans
    path.add(id)
    const deps = byId.get(id)?.dependsOn ?? []
    const layer = deps.length === 0 ? 1 : 1 + Math.max(...deps.map(d => layerOfId(d, path)))
    layerOf.set(id, layer)
    return layer
  }
  for (const n of plan.nodes) layerOfId(n.id, new Set())
  const waves: PlanNode[][] = []
  for (const n of plan.nodes) {
    const l = layerOf.get(n.id) ?? 1
    ;(waves[l - 1] ??= []).push(n)
  }
  return waves.filter(Boolean)
}

function idMap(plan: Plan): Map<string, PlanNode> {
  return new Map(plan.nodes.map(n => [n.id, n]))
}

// ── Mutation ─────────────────────────────────────────────────────────────

export type SettleStatus = Exclude<PlanNodeStatus, 'pending'>

/** Accepts `3`, `'3'` and `'n3'` for node n3 (D5); null when unresolved. */
export function resolveNodeRef(plan: Plan, ref: string | number): PlanNode | null {
  const id = `n${String(ref).trim().toLowerCase().replace(/^n/, '')}`
  return idMap(plan).get(id) ?? null
}

/** 1-based number of a node, for snapshots and error messages. */
export const nodeNumberOf = (node: PlanNode): number => Number(node.id.slice(1))

/** spawn_agent 的 planNode 派发门 — resolve the ref AND enforce that the node
 *  is actually dispatchable: pending AND every dependency completed. The
 *  pending check alone cannot do this (a node whose upstream is still running
 *  is also pending), which would make depends_on a prompt-level suggestion
 *  instead of an execution-level gate. Throws with a model-facing message
 *  naming exactly which nodes are still open. */
export function resolveReadyNode(plan: Plan, ref: string | number): PlanNode {
  const node = resolveNodeRef(plan, ref)
  if (!node) throw new Error(`Unknown planNode "${ref}" — valid: n1..n${plan.nodes.length}.`)
  if (node.status !== 'pending') throw new Error(`Plan node ${node.id} is already ${node.status} — pick a node from the READY set.`)
  // Live-attempt guard (PLAN-plan-scheduler S7): a pending node with a queued
  // or running attempt is ALREADY dispatched — by the scheduler or by an
  // earlier call in the same response. pending + deps-completed alone cannot
  // tell that apart, so without this the model double-spawns the same work.
  if (node.execution && (node.execution.status === 'queued' || node.execution.status === 'running')) {
    throw new Error(
      `Plan node ${node.id} already has a live attempt (${node.execution.status}) — it is being dispatched; wait for it to settle.`,
    )
  }
  const byId = idMap(plan)
  const open = (node.dependsOn ?? []).filter(d => byId.get(d)?.status !== 'completed')
  if (open.length > 0) {
    const detail = open.map(d => `${d} (${byId.get(d)?.status ?? 'unknown'})`).join(', ')
    throw new Error(
      `Plan node ${node.id} is not ready — waiting on ${detail}. Dispatch and settle those nodes first; spawn_agent only accepts a node from the READY set.`,
    )
  }
  return node
}

/** Settle a node in place. Completing a failed node is a retry (D4). When the
 *  last pending node settles, the plan closes. Writers (D7, amended by
 *  PLAN-plan-scheduler S2): still PlanManager alone — its advance_plan
 *  executor AND its autoSettle (the scheduler's delivery→completed path) both
 *  come through here; nothing else touches node status. */
export function markNode(
  plan: Plan,
  ref: string | number,
  status: SettleStatus,
  fix?: { msgId?: string; summary?: string },
): PlanNode {
  const node = resolveNodeRef(plan, ref)
  if (!node) throw new Error(`Unknown node "${ref}". Use a step number (1..${plan.nodes.length}) or id (n1..n${plan.nodes.length}).`)
  node.status = status
  if (fix?.msgId) node.msgId = fix.msgId
  if (fix?.summary !== undefined) node.summary = fix.summary || undefined
  if (plan.nodes.every(n => isTerminal(n.status))) plan.completed = true
  return node
}

/** advance_plan action="finish": force every pending node to completed. */
export function completeAllNodes(plan: Plan): void {
  for (const n of plan.nodes) if (n.status === 'pending') n.status = 'completed'
  plan.completed = true
}

/** Record which sub-conversation implements a node (PLAN-workbench W12).
 *  Status-neutral by design: a dispatch does not settle anything — only
 *  advance_plan does that — so this writes the link and nothing else. */
export function linkNodeSession(plan: Plan, ref: string | number, subConvId: string): PlanNode {
  const node = resolveNodeRef(plan, ref)
  if (!node) throw new Error(`Unknown node "${ref}". Use a step number (1..${plan.nodes.length}) or id (n1..n${plan.nodes.length}).`)
  node.subConvId = subConvId
  return node
}

/** The parent executor dispatches a node: mark the attempt queued (the plan
 *  carries one live attempt at a time; it never forks per spawn). Later links
 *  and outcomes land only through updateNodeExecution's compare-and-set.
 * Drop its previous session link immediately: queued retries must not open
 * the old child's session. Acceptance and dependencies remain untouched. */
export function beginNodeExecution(plan: Plan, ref: string | number, attemptId: string): boolean {
  const node = resolveNodeRef(plan, ref)
  if (!node || node.status !== 'pending' || !attemptId) return false
  node.execution = { attemptId, status: 'queued' }
  delete node.subConvId
  return true
}

/** Compare-and-set: late completions (or links) from an older attempt cannot
 *  overwrite a retry. A terminal execution cannot be revived by a late event. */
export function updateNodeExecution(
  plan: Plan, ref: string | number, attemptId: string, status: PlanNodeExecutionStatus, subConvId?: string,
): boolean {
  const node = resolveNodeRef(plan, ref)
  const execution = node?.execution
  if (!node || !execution || execution.attemptId !== attemptId) return false
  if (execution.status !== 'queued' && execution.status !== 'running') return false
  if (execution.status === 'running' && status === 'queued') return false
  if (execution.status === status && (!subConvId || node.subConvId === subConvId)) return false
  node.execution = { attemptId, status }
  if (subConvId) node.subConvId = subConvId
  return true
}

export function planNodeExecutionLabel(node: PlanNode): string {
  if (node.status !== 'pending') return { completed: '已完成', failed: '失败', skipped: '跳过' }[node.status]
  switch (node.execution?.status) {
    case 'queued': return '排队中'
    case 'running': return '执行中'
    case 'delivered': return '已交付，待验收'
    case 'failed': return '执行失败'
    case 'stopped': return '已停止'
    default: return '未开始'
  }
}

// ── Migration (v1 linear → v2 DAG) ───────────────────────────────────────

interface LegacyPlan {
  objective?: string
  steps?: Array<{ description?: string; status?: string; msgId?: string }>
  completed?: boolean
  mode?: 'direct' | 'delegated'
}

/** v1 plans were a cursor over an ordered list — a chain by construction, so
 *  the migration is lossless: each step depends on its predecessor, statuses
 *  carry over ('in_progress' decays to pending). Null when not plan-shaped. */
export function migrateLinearPlan(old: unknown): Plan | null {
  const legacy = old as LegacyPlan
  if (!legacy || typeof legacy !== 'object' || !Array.isArray(legacy.steps) || legacy.steps.length === 0) return null
  const nodes: PlanNode[] = legacy.steps.map((s, i) => ({
    id: `n${i + 1}`,
    description: String(s.description ?? ''),
    status: s.status === 'completed' ? 'completed' : s.status === 'failed' ? 'failed' : 'pending',
    dependsOn: i === 0 ? [] : [`n${i}`],
  }))
  const completed = legacy.completed === true || nodes.every(n => isTerminal(n.status))
  return { objective: String(legacy.objective ?? ''), nodes, completed, version: 2, mode: legacy.mode ?? 'delegated' }
}

// ── Text rendering (prompt section + tool snapshot) ──────────────────────

const STATUS_MARKER: Record<PlanNodeStatus, string> = { pending: '[ ]', completed: '[done]', failed: '[fail]', skipped: '[skip]' }

/** One node line, shared by the prompt section and the snapshot so the model
 *  sees the same node vocabulary in both places. */
function describeNode(node: PlanNode, byId: Map<string, PlanNode>, ready: Set<string>): string {
  let line = `${STATUS_MARKER[node.status]} n${nodeNumberOf(node)}: ${node.description}`
  if (node.status === 'pending') {
    const failedOrSkipped = node.dependsOn.filter(d => { const s = byId.get(d)?.status; return s === 'failed' || s === 'skipped' })
    const open = node.dependsOn.filter(d => byId.get(d)?.status === 'pending')
    if (ready.has(node.id)) line += ' — READY'
    else if (failedOrSkipped.length > 0) line += ` — blocked (waiting on: ${failedOrSkipped.join(', ')})`
    else if (open.length > 0) line += ` — waiting (deps: ${open.join(', ')})`
    else line += ' — READY'
  }
  if (node.assignee) line += ` (assignee: ${node.assignee})`
  if (node.summary) line += ` — ${node.summary}`
  return line
}

/** Accepts v2 plans and legacy v1 JSON (stale persisted rows, old fixtures) —
 *  the format layer never crashes on shape, it migrates. Null when the object
 *  is not plan-shaped at all. */
function normalizePlanShape(plan: Plan | null): Plan | null {
  if (!plan) return null
  if (Array.isArray((plan as Plan).nodes)) return plan
  return migrateLinearPlan(plan)
}

/** The `## Current Plan` state-block section. Null when there is no active
 *  plan — the caller omits the section entirely. */
export function formatPlanForPrompt(plan: Plan | null): string | null {
  const active = normalizePlanShape(plan)
  if (!active || active.completed) return null
  const byId = idMap(active)
  const ready = new Set(readyNodes(active).map(n => n.id))
  const lines: string[] = ['## Current Plan', '', `Objective: "${active.objective}"`, `Mode: ${active.mode ?? 'delegated'}`, '']
  for (const node of active.nodes) lines.push(describeNode(node, byId, ready))
  lines.push('', '### Rules')
  if ((active.mode ?? 'delegated') === 'delegated') {
    // PLAN-plan-scheduler S1: the scheduler owns dispatch and settlement, so
    // the rules tell the model what it is actually consulted for — anything
    // vaguer produces ritual spawn/advance rounds the scheduler exists to kill.
    lines.push('1. READY nodes are dispatched AUTOMATICALLY by the scheduler (each to its assignee, in parallel) — do NOT call spawn_agent for them yourself, and do NOT report their delivery.')
    lines.push('2. Never execute a delegated node yourself.')
    lines.push('3. You are consulted at exactly two points: a node FAILED (decide: re-dispatch it to retry, or `advance_plan` action="fail" / action="skip" with node=<its number>), and the final settle (write the answer for the user; action="finish" only to close early).')
  } else {
    lines.push('1. Execute READY nodes yourself in dependency order.')
    lines.push('2. When a node settles call `advance_plan` with node=<its number> — the plan never advances on its own. action="complete" (retrying a failed node = retry), action="fail", action="skip".')
    lines.push('3. Close with action="finish" once the objective is met; the plan auto-closes when the last node settles.')
  }
  return lines.join('\n')
}

export interface PlanSnapshotInfo {
  action: 'create' | 'complete' | 'fail' | 'skip' | 'finish'
  node?: string | number
  notes?: string
}

/** Full-plan snapshot returned as the create_plan / advance_plan tool_result —
 *  the model's view of the graph after the mutation, with the ready set called
 *  out. */
export function formatPlanSnapshot(plan: Plan | null, info: PlanSnapshotInfo): string {
  const active = normalizePlanShape(plan)
  if (!active) return ''
  const parts: string[] = []
  const ref = info.node !== undefined ? resolveNodeRef(active, info.node) : null
  const num = ref ? nodeNumberOf(ref) : null
  if (info.action === 'create') {
    const delegated = (active.mode ?? 'delegated') === 'delegated'
    parts.push(`Plan created with ${active.nodes.length} node(s), numbered n1..n${active.nodes.length} — the numbering is fixed. Mode: ${active.mode ?? 'delegated'}. All nodes start pending.`
      + (delegated
        ? ' The scheduler dispatches READY nodes and settles each one on delivery — you are consulted only when a node fails.'
        : ' Dispatch nodes with spawn_agent planNode=<n> and settle them with advance_plan node=<n>.'))
  }
  else if (active.completed && info.action === 'complete') parts.push(`Node n${num} completed — every node is settled, the plan is complete.`)
  else if (info.action === 'complete' && num !== null) parts.push(`Node n${num} completed.`)
  else if (info.action === 'fail' && num !== null) parts.push(`Node n${num} FAILED. Its dependents are blocked — retry it (action="complete") or give up on it (action="skip").`)
  else if (info.action === 'skip' && num !== null) parts.push(`Node n${num} skipped.`)
  else if (info.action === 'finish') parts.push('Plan finished early — remaining nodes were force-completed.')
  parts.push(`Objective: "${active.objective}"`, '')

  const byId = idMap(active)
  const ready = new Set(readyNodes(active).map(n => n.id))
  for (const node of active.nodes) parts.push(describeNode(node, byId, ready))

  const readyList = active.nodes.filter(n => ready.has(n.id)).map(nodeNumberOf)
  if (!active.completed) {
    parts.push('')
    parts.push(readyList.length > 0
      ? `Ready now (start these, in parallel for delegated mode): ${readyList.map(n => `n${n}`).join(', ')}`
      : 'Nothing is ready — every open node waits on dependencies.')
  }
  if (info.notes) parts.push('', info.notes)
  return parts.join('\n')
}

/** The `## Upstream Node Results` section for a spawn of `node`
 *  (PLAN-plan-scheduler S8) — the downstream hand-off, code-authored so it
 *  cannot be lost to a model that forgets to transcribe. One sub-section per
 *  DIRECT dependency (transitivity is the graph's job, not the prompt's):
 *  the dependency's handoff text, falling back to its one-line summary, falling
 *  back to an explicit "no recorded output". Total budget UPSTREAM_RESULTS_MAX
 *  — overflow truncates the tail and says where the full output lives.
 *  Null when there is nothing to hand over (no deps, or the node is unknown). */
export function formatUpstreamResults(plan: Plan | null, node: PlanNode): string | null {
  if (!plan) return null
  const byId = idMap(plan)
  const deps = node.dependsOn.map(id => byId.get(id)).filter((d): d is PlanNode => !!d)
  if (deps.length === 0) return null

  const sections: string[] = ['## Upstream Node Results']
  let used = sections[0].length
  for (const dep of deps) {
    const body = (dep.handoff ?? dep.summary ?? '').trim() || '(no recorded output — see its node session)'
    let block = `### ${dep.id}: ${dep.description}\n${body}`
    if (used + block.length + 2 > UPSTREAM_RESULTS_MAX) {
      const room = UPSTREAM_RESULTS_MAX - used - 2
      if (room > 0) block = block.slice(0, Math.max(0, room)) + '\n[... truncated — the full output is in this node\'s sub-conversation]'
      else break
      sections.push(block)
      used += block.length + 2
      break
    }
    sections.push(block)
    used += block.length + 2
  }
  if (sections.length === 1) return null
  return sections.join('\n\n')
}
