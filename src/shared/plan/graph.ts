/**
 * Pure graph operations over the plan DAG (PLAN-plan-dag). DOM-free and
 * host-free by construction: the engine, the state-block builder, the tool
 * snapshot and the PlanPanel all read through these functions, so derivation
 * rules (ready / blocked / layers) exist in exactly one place.
 */
import type { Plan, PlanNode, PlanNodeStatus, PlanNodeExecutionStatus } from '../types/plan'
import type { SplitChildSpec } from './split-proposal'
import { mintPlanId } from './exchange'

export const MAX_PLAN_NODES = 20

/** Split generations (PLAN-plan-split P5): 0 = an original node (splittable),
 *  1 = the product of a split (not splittable). One level only — the bound
 *  that makes dynamic splitting determinately terminating; the spawn prompt
 *  gate is the structural half, this constant backs the merge-time re-check. */
export const MAX_SPLIT_GEN = 1

/** Per-node handoff cap (PLAN-plan-scheduler S8/S9): the completed node's
 *  output text stored on `PlanNode.handoff` and persisted with plan_json.
 *  Worst case 20 × 6k = 120k on the conversation row — SQLite TEXT, fine; the
 *  full output always remains in the node's sub-conversation. */
export const NODE_HANDOFF_MAX = 6_000

/** Total budget for the `## 前序节点处理结果` section injected into a
 *  dependent spawn's prompt (S8). Direct dependencies only; overflow truncates
 *  with a pointer to the sub-conversation rather than dropping sections. */
export const UPSTREAM_RESULTS_MAX = 8_000

export interface RawPlanNode {
  description: string
  /** 1-based indexes into the input array — the tool protocol form (D3). */
  dependsOn?: number[]
  assignee?: string
  /** PLAN-plan-exchange E2: authored report-format requirements, injected on
   *  top of the standard skeleton in this node's admission contract. */
  reportSpec?: string
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
      ...(r.reportSpec ? { reportSpec: r.reportSpec } : {}),
    }
  })

  const plan: Plan = { id: mintPlanId(), objective: objective.trim(), nodes, completed: false, version: 2, mode }
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
 *  retries or skips upstream (D4: failure never cascades by itself). `split`
 *  is in the dead set DEFENSIVELY only: after a merge no node still references
 *  the split node (the rewire removes every such edge), so this arm exists
 *  for hand-edited/破 invariant JSON — the dependent shows blocked instead of
 *  silently waiting forever. */
const DEAD_DEP_STATUSES: PlanNodeStatus[] = ['failed', 'skipped', 'split']

export function blockedNodes(plan: Plan): PlanNode[] {
  const byId = idMap(plan)
  return plan.nodes.filter(n =>
    n.status === 'pending' && n.dependsOn.some(d => {
      const s = byId.get(d)?.status
      return s !== undefined && DEAD_DEP_STATUSES.includes(s)
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

// ── Split merge (PLAN-plan-split v2 R3, midprocess shape) ────────────────

export interface SplitMergeOk { ok: true; source: PlanNode; children: PlanNode[] }
export interface SplitMergeFail { ok: false; reason: string }

/** Merge a split proposal (create_sub_plan tool or a trailing `### Split
 *  Proposal`) into the live plan. MIDPROCESS shape: node X keeps doing its own
 *  work and settles naturally — the merge only APPENDS children that carry
 *  X's remainder. Whole-unit: every rejection leaves the plan untouched.
 *
 *  - CAS on attemptId: a straggler proposal from a superseded retry can never
 *    mutate the plan (same discipline as updateNodeExecution).
 *  - append-only: children take n{max+1}..; nothing is renumbered.
 *  - child deps = [X] ∪ the proposal's internal deps: the children carry X's
 *    REMAINDER, so they wait for X to settle — and X's handoff (partial work
 *    included) reaches them through formatUpstreamResults with no extra
 *    mechanism. X's own deps are long completed and add nothing.
 *  - downstream: every node that depended on X now ALSO depends on all
 *    children (union kept — X's partial output plus the remainder). X itself
 *    is untouched: it keeps executing and settles completed (or failed —
 *    which blocks the children into the existing consult path; a successful
 *    retry unblocks them with zero new machinery).
 *  - gates: X pending, live attemptId, X.gen < MAX_SPLIT_GEN (children get
 *    X's + 1), 2..5 children, non-empty descriptions, and the
 *    MAX_PLAN_NODES budget wall — exceeding it rejects the whole proposal.
 *  - Multiple splits of one node are allowed (each covers work X will NOT
 *    do); the budget wall bounds the total.
 */
export function mergeSplitProposal(
  plan: Plan,
  ref: string | number,
  attemptId: string,
  children: SplitChildSpec[],
  // Accepted for protocol symmetry (both channels carry one); the midprocess
  // shape deliberately does NOT stamp X with it — the reason travels in the
  // parent-facing envelope note instead.
  _reason?: string,
): SplitMergeOk | SplitMergeFail {
  const node = resolveNodeRef(plan, ref)
  if (!node) return { ok: false, reason: `Unknown node "${ref}".` }
  if (node.status !== 'pending') return { ok: false, reason: `Plan node ${node.id} is already ${node.status}.` }
  if (!attemptId || node.execution?.attemptId !== attemptId) {
    return { ok: false, reason: `Attempt mismatch on ${node.id} — the proposal came from a superseded (or unknown) attempt.` }
  }
  if ((node.gen ?? 0) >= MAX_SPLIT_GEN) {
    return { ok: false, reason: `Plan node ${node.id} is itself a split product — split products are not splittable.` }
  }
  if (children.length < 2 || children.length > 5) {
    return { ok: false, reason: `a split carries 2..5 sub-tasks, got ${children.length}` }
  }
  for (let i = 0; i < children.length; i++) {
    const d = String(children[i].description ?? '').trim()
    if (!d || d.length > 500) return { ok: false, reason: `sub-task ${i + 1}: description must be 1–500 characters` }
  }
  if (plan.nodes.length + children.length > MAX_PLAN_NODES) {
    return {
      ok: false,
      reason: `splitting ${node.id} into ${children.length} would exceed the ${MAX_PLAN_NODES}-node budget (${plan.nodes.length} existing + ${children.length} new)`,
    }
  }

  // depends_on 范围闸（full_20261011 M12-P0-3）：d 是本提案内 1-based 的
  // 子任务序号，越界/自引用曾把 childIds[d-1] 的 undefined 塞进 dependsOn
  // （落盘后成 null）——节点既不 ready 也不 blocked、永不派发、计划永不
  // 收尾，而工具照样报「Merged」。文本协议（validateSplitProposal）与
  // create_plan 通道都有这道闸；这里是所有通道的汇合点，闸设在最汇合处。
  // 措辞与两条兄弟通道同款，子代理可据此在循环内改正重试。
  for (let ci = 0; ci < children.length; ci++) {
    for (const d of children[ci]?.dependsOn ?? []) {
      if (d === ci + 1) return { ok: false, reason: `sub-task ${ci + 1} depends on itself` }
      if (!Number.isInteger(d) || d < 1 || d > children.length) {
        return { ok: false, reason: `sub-task ${ci + 1}: dependency ${d} is out of range (1..${children.length})` }
      }
      if (d > ci + 1) return { ok: false, reason: `sub-task ${ci + 1}: dependency ${d} must reference an EARLIER sub-task (forward references only)` }
    }
  }

  // Append-only ids: continue after the highest number ever used.
  const nextNum = plan.nodes.reduce((max, n) => Math.max(max, nodeNumberOf(n)), 0) + 1
  const childIds = children.map((_, i) => `n${nextNum + i}`)
  const newNodes: PlanNode[] = children.map((c, i) => ({
    id: childIds[i],
    description: String(c.description ?? '').trim(),
    status: 'pending',
    dependsOn: [...new Set([node.id, ...(c.dependsOn ?? []).map(d => childIds[d - 1])])],
    gen: (node.gen ?? 0) + 1,
    ...(c.reportSpec ? { reportSpec: c.reportSpec } : {}),
  }))

  // Built off-line, mutated only after every gate passes — a rejected merge
  // must leave the caller's plan exactly as it was. X is NOT in the map
  // branch: its row moves to the candidate unchanged.
  const candidate: PlanNode[] = [
    ...plan.nodes.map(n => n.dependsOn.includes(node.id)
      ? { ...n, dependsOn: [...new Set([...n.dependsOn, ...childIds])] }
      : n),
    ...newNodes,
  ]

  try {
    assertAcyclic(candidate)
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'the split would create a dependency cycle' }
  }

  plan.nodes = candidate
  return { ok: true, source: node, children: newNodes }
}

export function planNodeExecutionLabel(node: PlanNode): string {
  if (node.status !== 'pending') return { completed: '已完成', failed: '失败', skipped: '跳过', split: '已拆分' }[node.status]
  switch (node.execution?.status) {
    case 'queued': return '排队中'
    case 'running': return '执行中'
    case 'delivered': return '已交付，待验收'
    case 'failed': return '执行失败'
    case 'stopped': return '已停止'
    default: return '未开始'
  }
}

/** The sub-agent's OWN declared outcome (PLAN-plan-exchange 准出) — one
 *  vocabulary for every reader of it: formatUpstreamResults' handoff line and
 *  the UI's declared-status chip must not drift apart, and 「声明状态可对照」
 *  is only meaningful when both sides use the same words. */
export const DECLARED_STATUS_LABEL: Record<NonNullable<PlanNode['declaredStatus']>, string> = {
  success: '成功',
  partial: '部分成功',
  failed: '失败',
}

/** The declared label, or null when the node never filed a report. */
export const planNodeDeclaredLabel = (node: PlanNode): string | null =>
  (node.declaredStatus && DECLARED_STATUS_LABEL[node.declaredStatus]) || null

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
  return { id: mintPlanId(), objective: String(legacy.objective ?? ''), nodes, completed, version: 2, mode: legacy.mode ?? 'delegated' }
}

// ── Text rendering (prompt section + tool snapshot) ──────────────────────

const STATUS_MARKER: Record<PlanNodeStatus, string> = { pending: '[ ]', completed: '[done]', failed: '[fail]', skipped: '[skip]', split: '[split]' }

/** One node line, shared by the prompt section and the snapshot so the model
 *  sees the same node vocabulary in both places. */
function describeNode(node: PlanNode, byId: Map<string, PlanNode>, ready: Set<string>): string {
  let line = `${STATUS_MARKER[node.status]} n${nodeNumberOf(node)}: ${node.description}`
  if (node.status === 'pending') {
    const failedOrSkipped = node.dependsOn.filter(d => {
      const s = byId.get(d)?.status
      return s !== undefined && DEAD_DEP_STATUSES.includes(s)
    })
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

/** The `## 前序节点处理结果` section for a spawn of `node`
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

  const sections: string[] = ['## 前序节点处理结果', '', '每个小节的 Report 文件可用 read 直接读取——那里面是全量数据，下面的小节只是交接摘要。']
  let used = sections.join('\n\n').length
  for (const dep of deps) {
    const body = (dep.handoff ?? dep.summary ?? '').trim() || '(no recorded output — see its node session)'
    const report = dep.reportPath
      ? `\nReport: ${dep.reportPath}${dep.declaredStatus ? `（声明状态: ${DECLARED_STATUS_LABEL[dep.declaredStatus]}）` : ''}`
      : ''
    let block = `### ${dep.id}: ${dep.description}\n${body}${report}`
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
