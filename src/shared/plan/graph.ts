/**
 * Pure graph operations over the plan DAG (PLAN-plan-dag). DOM-free and
 * host-free by construction: the engine, the state-block builder, the tool
 * snapshot and the PlanPanel all read through these functions, so derivation
 * rules (ready / blocked / layers) exist in exactly one place.
 */
import type { Plan, PlanNode, PlanNodeStatus } from '../types/plan'

export const MAX_PLAN_NODES = 20

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

/** Settle a node in place. Completing a failed node is a retry (D4). When the
 *  last pending node settles, the plan closes. The ONLY writers are the main
 *  agent's advance_plan calls (D6/D7 — single-writer). */
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
    lines.push('1. READY nodes are independent — dispatch EACH one now with `spawn_agent` (subAgentId = its assignee, task = the node description). Multiple READY nodes: put multiple spawn_agent calls in the SAME response so they run in parallel.')
    lines.push('2. Never execute a delegated node yourself.')
  } else {
    lines.push('1. Execute READY nodes yourself in dependency order.')
  }
  lines.push('2. When a node settles call `advance_plan` with node=<its number> — the plan NEVER auto-advances. action="complete" (retrying a failed node = retry), action="fail", action="skip".')
  lines.push('3. Close with action="finish" once the objective is met; the plan auto-closes when the last node settles.')
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
  if (info.action === 'create') parts.push(`Plan created with ${active.nodes.length} node(s), numbered n1..n${active.nodes.length} — the numbering is fixed; dispatch nodes with spawn_agent planNode=<n> and settle them with advance_plan node=<n>. Mode: ${active.mode ?? 'delegated'}. All nodes start pending.`)
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
