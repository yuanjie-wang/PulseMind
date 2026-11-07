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

/** How many ROWS a direct-mode todo list keeps at all (outstanding + settled
 *  history). Deliberately separate from MAX_PLAN_NODES (2026-11-06): that one
 *  bounds OUTSTANDING work, this one bounds the array so the prompt section and
 *  the panel stay finite. Charging settled history against the outstanding
 *  budget made the cap un-escapable — retire soft-skips a row but keeps it, so
 *  after 20 lifetime entries every append was refused and the refusal pointed at
 *  "retire finished entries", the one action that frees nothing. Kept at exactly
 *  2× the outstanding budget so there is always enough settled history to drop.
 *  Nothing derives a node's number from its position, so trimming settled rows
 *  leaves every surviving id exactly as the model last saw it. */
export const MAX_TODO_HISTORY = MAX_PLAN_NODES * 2

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

export const isTerminal = (status: PlanNodeStatus): boolean => status !== 'pending' && status !== 'blocked'

/** Whether a status leaves the entry OUTSTANDING — what the todo budget counts.
 *  `in_progress` is an INPUT-only claim (it lands as pending + the current
 *  marker) that isTerminal would call terminal, so it is spelled out rather than
 *  inferred. `undefined` means "no claim": the caller decides whether that reads
 *  as unchanged (an existing entry) or as the pending default (a new one). */
export const isOutstanding = (status: PlanNodeStatus | TodoItem['status'] | undefined): boolean =>
  status === undefined || status === 'pending' || status === 'blocked' || status === 'in_progress'

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

export type SettleStatus = Exclude<PlanNodeStatus, 'pending' | 'blocked'>

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
  if (node.status !== 'pending') return { completed: '已完成', failed: '失败', skipped: '跳过', split: '已拆分', blocked: '已阻塞' }[node.status]
  switch (node.execution?.status) {
    case 'queued': return '排队中'
    case 'running': return '执行中'
    // 「待验收」3 字（full_20261011 M3-P1-1）：7 字旧词在 12px 字号下起点
    // 68，与声明徽标（终点 78）重叠 10px——row 1 的槽位在字号提升时没像
    // row 2 那样重算。3 字起点 116，留 38px 缝；「已交付」由验收态本身表达。
    case 'delivered': return '待验收'
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

// ── Todo reconcile (the direct-mode writer) ──────────────────────────────
// todo_write's backing policy: a direct-mode plan IS a todo list — flat (no
// edges), never dispatched, statuses self-reported. The write is a
// FULL-LIST-REPLACE reconcile (TodoWrite semantics): the incoming list is the
// truth, but settled entries are immutable, so the diff lands as append +
// soft-skip. This is PlanManager's FOURTH write policy, next to
// advance_plan / autoSettle / split-merge — same single-writer class.

/** One todo_write list item. Absent status = keep whatever the node carries
 *  (a matched pending stays pending); 'in_progress' marks the entry the agent
 *  is working on NOW (last one wins); 'blocked' = live work waiting on
 *  something outside the agent's control (say what in `note`). */
export interface TodoItem {
  description: string
  /** The entry's identity ("n2" — the numbers every snapshot row carries).
   *  THE reference path, full stop: present → claim that entry (open entries
   *  reword in place, a retired entry revives, a settled entry ignores
   *  wording and status claims); ABSENT → a NEW entry, no wording fallback.
   *  A forgotten id on an existing step forks it (new + old retires) — the
   *  retire∧add caution in the delta is the net for exactly that. */
  id?: string
  status?: 'pending' | 'in_progress' | 'completed' | 'blocked'
  /** One-line context riding the entry (what a blocked one waits on, a key
   *  result, a pointer) — carried on `PlanNode.summary` so the panel and the
   *  snapshot render it with zero new vocabulary. Live entries only: a note
   *  on an already-settled entry is ignored (the immutability red line). */
  note?: string
}

export interface TodoReconcileStats {
  added: number
  retired: number
  completed: number
  /** id-claimed settled entries whose incoming wording was ignored (settled
   *  is immutable) — surfaced so the delta result can say so out loud instead
   *  of silently swallowing the model's edit. */
  keptWording: number
  /** Blocked entries that dropped off the list and were retired. They get
   *  their own callout in the delta result: blocked is the state most likely
   *  to be forgotten (nothing pushes it forward), and silently losing a task
   *  that was waiting on something is worse than naming the loss. */
  retiredBlocked?: Array<{ id: string; note?: string }>
}

export interface TodoReconcileResult {
  plan: Plan
  stats: TodoReconcileStats
  /** true = a fresh todo was minted (no live direct plan); false = the live
   *  todo was reconciled in place. The executor picks the snapshot's
   *  create/update voice from this — the text differs and so does the
   *  model's next move. */
  minted: boolean
  /** Entries TOUCHED this pass (status move, append, retire, in-place
   *  reword, note, current-marker) — the delta snapshot renders ONLY these;
   *  the model's own tool input already carries the full list it sent, so
   *  re-echoing it is pure redundancy. */
  changed: string[]
}

function normalizeTodoItems(raw: unknown): TodoItem[] {
  const arr = Array.isArray(raw) ? raw : []
  return arr.map((r) => {
    const o = (r ?? {}) as { description?: unknown; status?: unknown; note?: unknown; id?: unknown }
    const status = o.status === 'in_progress' || o.status === 'completed' || o.status === 'pending' || o.status === 'blocked'
      ? o.status
      : undefined
    const note = typeof o.note === 'string' && o.note.trim() ? o.note.trim() : undefined
    const id = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : undefined
    return {
      description: String(o.description ?? '').trim(),
      ...(id ? { id } : {}),
      ...(status ? { status } : {}),
      ...(note ? { note } : {}),
    }
  })
}

/** Full-list-replace reconcile over the direct plan. `plan` null (or not a
 *  live direct plan) MINTS a fresh todo; a live direct plan reconciles in
 *  place. Throws model-facing messages (same contract as createPlanDag). */
export function reconcileTodo(
  plan: Plan | null,
  objective: string,
  rawItems: unknown,
  fix?: { msgId?: string; fresh?: boolean },
): TodoReconcileResult {
  const items = normalizeTodoItems(rawItems)
  for (let i = 0; i < items.length; i++) {
    if (!items[i].description) throw new Error(`item ${i + 1}: description is required`)
  }
  // A settled todo list is CONTINUED, not replaced (2026-11-06). Minting on
  // `completed` was the second half of the lost-id bug: mint numbers entries by
  // POSITION and ignores the ids it was handed, so a model carrying stale
  // numbering got a silent renumber instead of an error. `fresh` is the explicit
  // way to discard the old list; a delegated plan still mints (mode differs).
  const live = !fix?.fresh && plan && (plan.mode ?? 'delegated') === 'direct' ? plan : null

  if (!live) {
    if (items.length === 0) throw new Error('items are required — a todo list starts with at least one entry')
    if (!objective.trim()) throw new Error('objective is required')
    if (items.length > MAX_TODO_HISTORY) throw new Error(`maximum ${MAX_TODO_HISTORY} rows per list`)
    const mintedOutstanding = items.filter(it => isOutstanding(it.status)).length
    if (mintedOutstanding > MAX_PLAN_NODES) {
      throw new Error(`maximum ${MAX_PLAN_NODES} outstanding entries — this call starts with ${mintedOutstanding}; settle the extra ones in the same call (settled rows do not count against the cap)`)
    }
    const next: Plan = {
      id: mintPlanId(),
      objective: objective.trim(),
      nodes: items.map((it, i) => ({ id: `n${i + 1}`, description: it.description, status: 'pending', dependsOn: [] })),
      completed: false,
      version: 2,
      mode: 'direct',
    }
    const minted = applyTodoStatuses(next, items, fix)
    // Derive on mint too (2026-11-06): a list minted already fully settled (a
    // post-compaction re-send, e.g.) must not claim to be open — the prompt
    // section and nextScheduleAction both read this flag.
    minted.completed = minted.nodes.every(n => isTerminal(n.status))
    return {
      plan: minted,
      stats: { added: items.length, retired: 0, completed: countTodoCompleted(items), keptWording: 0 },
      minted: true,
      changed: next.nodes.map(n => n.id),
    }
  }

  const stats: TodoReconcileStats = { added: 0, retired: 0, completed: 0, keptWording: 0 }
  // Simulate the whole claim/append pass OFF-LINE first (mergeSplitProposal's
  // whole-unit rule): every gate — id resolution, duplicates, and the node
  // budget, which a later append can breach AFTER earlier appends already
  // landed — throws before the first byte of `live` moves. A rejected
  // todo_write must leave the caller's plan exactly as it was.
  const working = live.nodes.map(n => ({ id: n.id, status: n.status, taken: false }))
  const paired: Array<{ item: TodoItem; nodeId: string; isNew: boolean; viaId: boolean }> = []
  // Numbers are NOT contiguous any more once history trimming has run, so every
  // "which ids exist" message quotes the HIGHEST number instead of a range.
  const highest = working.reduce((max, w) => Math.max(max, Number(w.id.slice(1))), 0)
  // Pass A — id claims are the ONLY reference path (2026-10-25: identity is
  // the id, not the wording — the same model the plan tools always had, and
  // the reword trap is structurally gone because rewording rides the id).
  // Naming a retired entry by id IS the recovery path for an accidental
  // retirement.
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.id === undefined) continue
    const nid = `n${item.id.toLowerCase().replace(/^n/, '')}`
    if (!/^n\d+$/.test(nid)) {
      throw new Error(`item ${i + 1}: id "${item.id}" is not an entry number — use an id exactly as the last list showed it (highest is n${highest}), brackets omitted`)
    }
    const hit = working.find(w => w.id === nid)
    if (!hit) throw new Error(`item ${i + 1}: id "${nid}" does not exist — the list carries ids up to n${highest}; nothing answers to "${nid}"`)
    if (paired.some(p => p.nodeId === nid)) throw new Error(`item ${i + 1}: id "${nid}" is claimed twice — one list entry per id`)
    hit.taken = true
    paired[i] = { item, nodeId: nid, isNew: false, viaId: true }
  }
  // Pass B — everything without an id is a NEW entry, period. There is no
  // wording fallback: a forgotten id on an existing step forks it (new entry
  // + the old one retires), and the retire∧add caution in the delta is the
  // net that flags exactly that — the one failure mode left, and it is a
  // discipline slip with a visible outcome, not a silent correctness trap.
  for (let i = 0; i < items.length; i++) {
    if (paired[i]) continue
    const nextNum = working.reduce((max, w) => Math.max(max, Number(w.id.slice(1))), 0) + 1
    const id = `n${nextNum}`
    working.push({ id, status: 'pending', taken: true })
    paired[i] = { item: items[i], nodeId: id, isNew: true, viaId: false }
  }
  // The budget counts OUTSTANDING entries on the PROJECTED list (2026-11-06) —
  // never the array length, which charged settled history and made the cap
  // reachable but not releasable. Projected, not current, so one call may settle
  // twenty rows and append three. An existing entry absent from the incoming list
  // retires as skipped (the retire pass below), so it projects as settled.
  const outstandingAfter = working.filter((w) => {
    const claim = paired.find(p => p.nodeId === w.id)
    if (!claim) return false
    return isOutstanding(claim.item.status ?? (w.status as PlanNodeStatus))
  }).length
  if (outstandingAfter > MAX_PLAN_NODES) {
    throw new Error(`maximum ${MAX_PLAN_NODES} outstanding entries — this call would leave ${outstandingAfter}; settle or drop ${outstandingAfter - MAX_PLAN_NODES} of them first (settled rows never count against the cap)`)
  }

  // Mutation phase — cannot throw: append the new nodes, then apply.
  const changed = new Set<string>()
  const byId = new Map(live.nodes.map(n => [n.id, n]))
  for (const { item, nodeId, isNew } of paired) {
    if (!isNew) continue
    live.nodes.push({ id: nodeId, description: item.description, status: 'pending', dependsOn: [] })
    stats.added++
    changed.add(nodeId)
  }
  for (const { item, nodeId, viaId } of paired) {
    const node = byId.get(nodeId) ?? live.nodes.find(n => n.id === nodeId)!
    let touched = false
    // (a) Revive — an explicit id on a retired entry brings it back (its
    // status becomes the item's, defaulting to pending; a completed claim
    // rides the check-off below). Runs BEFORE the reword so a revived entry
    // picks up the new wording too.
    if (viaId && node.status === 'skipped') {
      node.status = item.status === 'blocked' ? 'blocked' : 'pending'
      touched = true
    }
    // (b) In-place reword — the id escape hatch. Only OPEN entries rewrite:
    // settled is immutable, and its incoming wording is counted so the delta
    // result can say it was ignored instead of eating it silently.
    if (viaId && (node.status === 'pending' || node.status === 'blocked') && item.description !== node.description) {
      node.description = item.description
      touched = true
    } else if (viaId && (node.status === 'completed' || node.status === 'failed') && item.description !== node.description) {
      stats.keptWording++
    }
    const openNow = node.status === 'pending' || node.status === 'blocked'
    // (c) Notes ride any OPEN entry (including one just revived, and the
    // settle moment below). Already-settled entries ignore them — settled is
    // immutable, full stop (the one-rule form; the id corrects nothing on a
    // settled entry, a correction re-opens work as a new entry).
    if (openNow && item.note !== undefined && node.summary !== item.note) {
      node.summary = item.note || undefined
      touched = true
    }
    // (d) Status transitions.
    if (node.status === 'pending' && item.status === 'blocked') {
      node.status = 'blocked'
      touched = true
    }
    // Recovery: an explicit pending / in_progress / completed claim on a
    // blocked entry un-blocks it first (in_progress lands through the
    // current-marker below, completed through the check-off).
    if (node.status === 'blocked' && item.status !== undefined && item.status !== 'blocked') {
      node.status = 'pending'
      touched = true
    }
    if (node.status === 'pending' && item.status === 'completed') {
      markNode(live, node.id, 'completed', { msgId: fix?.msgId })
      stats.completed++
      touched = true
    }
    if (touched) changed.add(node.id)
  }
  // Retire: open nodes (pending or blocked) absent from the incoming list are
  // obsolete (soft-skip; their row stays as history — and shows up in the
  // delta, which is what makes the reword caution readable). A BLOCKED
  // retirement is not a normal rescope — it is named in the stats so the
  // delta result can call it out (a forgotten wait is a lost task).
  const claimed = new Set(paired.map(({ nodeId }) => nodeId))
  for (const n of live.nodes) {
    if (!claimed.has(n.id) && (n.status === 'pending' || n.status === 'blocked')) {
      const wasBlocked = n.status === 'blocked'
      n.status = 'skipped'
      stats.retired++
      changed.add(n.id)
      if (wasBlocked) stats.retiredBlocked = [...(stats.retiredBlocked ?? []), { id: n.id, note: n.summary }]
    }
  }
  // in_progress is DERIVED from the incoming list alone (full-replace purity:
  // the list above IS the current truth) — last valid claim wins, absence
  // means nothing is in progress. A claim on a settled node is not valid: the
  // work is done, the marker dies with it. Marker moves land in the delta
  // too — both the new current and the one it left.
  const claimedCurrent = [...paired].reverse().find(({ item, nodeId }) => item.status === 'in_progress' && (byId.get(nodeId) ?? live.nodes.find(n => n.id === nodeId))!.status === 'pending')
  if (claimedCurrent) {
    if (live.currentNodeId !== claimedCurrent.nodeId) changed.add(claimedCurrent.nodeId)
    live.currentNodeId = claimedCurrent.nodeId
  } else {
    if (live.currentNodeId) changed.add(live.currentNodeId)
    delete live.currentNodeId
  }
  if (objective.trim()) live.objective = objective.trim()
  // Derived BOTH ways (2026-11-06). Setting it only on the all-settled edge left
  // a closed list closed forever: appending a fresh pending entry to it kept
  // completed=true, so the panel, the prompt section and nextScheduleAction all
  // went on calling the list finished while the new entry was outstanding.
  live.completed = live.nodes.every(n => isTerminal(n.status))
  // Keep the array bounded (2026-11-06). MAX_TODO_HISTORY is 2× the outstanding
  // budget, so dropping the oldest settled rows can always restore the bound: only
  // terminal rows the current call did not touch are candidates, and ids are never
  // derived from position — every surviving number stays exactly as the model last
  // saw it (a dropped id simply stops resolving, which the "does not exist" error
  // names against the list that is actually there).
  if (live.nodes.length > MAX_TODO_HISTORY) {
    const excess = live.nodes.length - MAX_TODO_HISTORY
    const dropped = new Set(
      live.nodes.filter(n => isTerminal(n.status) && !changed.has(n.id)).slice(0, excess).map(n => n.id),
    )
    live.nodes = live.nodes.filter(n => !dropped.has(n.id))
  }
  return { plan: live, stats, minted: false, changed: [...changed] }
}

function countTodoCompleted(items: TodoItem[]): number {
  return items.filter(i => i.status === 'completed').length
}

// ── Pre-narration detection（预写返回检测，2026-10-25）─────────────────────
// The snapshot format is DETERMINISTIC — a model that knows the reconcile
// rules can compute `+0 added, 0 retired, 1 completed` before the tool runs,
// and prose that quotes it reads as evidence while being fabrication. These
// patterns match the UPDATE-SNAPSHOT voice only — the voice no legal prose
// can use pre-call: citing the list's CURRENT state from <session-state>
// (「n1 已完成，现在标 n2」) is recitation and stays legal; entry-row markers
// ([done]/[~]) are ambiguous with state-block quotes and are deliberately
// NOT detected. The executor prefixes the REAL result with a correction when
// this fires — in-loop teaching at the highest-salience position.

const PRE_NARRATION_PATTERNS: RegExp[] = [
  /\+\d+\s+added\b/,
  /\b\d+\s+retired\b/,
  /\b\d+\/\d+\s+settled\b/,
  /Todo list (created|updated)\b/,
  /Heads-up: n\d+ was BLOCKED/,
  /Caution: this update both retired and added/,
]

/** True when the text speaks in the update-snapshot's voice — the voice that
 *  only a real tool result can earn. Intent prose and state-block recitation
 *  never match. */
export function detectPreNarration(text: string): boolean {
  return PRE_NARRATION_PATTERNS.some(p => p.test(text))
}

/** The correction header the executor prepends to the real result. */
export const PRE_NARRATION_NOTICE =
  '⚠ Pre-narrated return detected: the prose in your message quoted snapshot output before this tool ran — that text was computed, not received, and is not evidence. The content below is the REAL result; quote only this.\n\n'

/** Status pass over a freshly minted todo: pre-marked currents, pre-blocked
 *  entries and opening notes all land here (a mint may carry any live shape). */
function applyTodoStatuses(plan: Plan, items: TodoItem[], fix?: { msgId?: string }): Plan {
  items.forEach((item, i) => {
    const node = plan.nodes[i]
    if (item.note) node.summary = item.note
    if (item.status === 'blocked') node.status = 'blocked'
    if (item.status === 'completed') markNode(plan, `n${i + 1}`, 'completed', { msgId: fix?.msgId })
  })
  const current = [...items].reverse().find(i => i.status === 'in_progress')
  if (current) plan.currentNodeId = `n${items.indexOf(current) + 1}`
  return plan
}

// ── Text rendering (prompt section + tool snapshot) ──────────────────────

const STATUS_MARKER: Record<PlanNodeStatus, string> = { pending: '[ ]', blocked: '[wait]', completed: '[done]', failed: '[fail]', skipped: '[skip]', split: '[split]' }

/** One todo line — the direct-mode sibling of describeNode: status marker +
 *  number + words, no dependency vocabulary (a todo has no edges). */
function describeTodoNode(node: PlanNode, current: string | null): string {
  const inFlight = node.status === 'pending' && current === node.id
  let line = `${inFlight ? '[~]' : STATUS_MARKER[node.status]} n${nodeNumberOf(node)}: ${node.description}`
  if (inFlight) line += ' — IN PROGRESS'
  if (node.status === 'blocked') line += ' — BLOCKED'
  if (node.summary) line += ` — ${node.summary}`
  return line
}

const isTodoPlan = (plan: Plan): boolean => (plan.mode ?? 'delegated') === 'direct'
export { isTodoPlan }

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
  if (!active) return null
  const todo = isTodoPlan(active)
  // A CLOSED todo list must stay visible (2026-11-06). The delta snapshot renders
  // ONLY the entries a call touched, on the explicit assumption that THIS section
  // re-injects the full list next turn (see PlanSnapshotInfo.changed). Bailing out
  // on `completed` broke that loop exactly when the list went all-green: the model
  // lost every id it had, could not tell a settled list from no list at all, and
  // could only guess the next number — while mint-by-position silently renumbered
  // whatever it guessed. A settled DELEGATED plan keeps the old behaviour: the DAG
  // is over, nothing invites a follow-up.
  if (active.completed && !todo) return null
  const byId = idMap(active)
  const ready = new Set(readyNodes(active).map(n => n.id))
  const lines: string[] = ['## Current Plan', '', `Objective: "${active.objective}"`, `Mode: ${active.mode ?? 'delegated'}`, '']
  if (active.completed) {
    const last = active.nodes.reduce((max, n) => Math.max(max, nodeNumberOf(n)), 0)
    lines.push(`STATE: CLOSED — all ${active.nodes.length} entr${active.nodes.length === 1 ? 'y' : 'ies'} settled (highest is n${last}); nothing is in progress.`)
    lines.push(`The list itself stays live: todo_write continues it — an item WITHOUT an id appends (the next number is n${last + 1}), an item naming an existing n-number revives that entry in place. Up to ${MAX_PLAN_NODES} entries may be outstanding at once; settled rows never count against that cap. Pass fresh=true ONLY to start an unrelated list (its numbering restarts at n1).`)
    return lines.join('\n')
  }
  for (const node of active.nodes) lines.push(todo ? describeTodoNode(node, active.currentNodeId ?? null) : describeNode(node, byId, ready))
  lines.push('', '### Rules')
  if (!todo) {
    // PLAN-plan-scheduler S1: the scheduler owns dispatch and settlement, so
    // the rules tell the model what it is actually consulted for — anything
    // vaguer produces ritual spawn/advance rounds the scheduler exists to kill.
    lines.push('1. READY nodes are dispatched AUTOMATICALLY by the scheduler (each to its assignee, in parallel) — do NOT call spawn_agent for them yourself, and do NOT report their delivery.')
    lines.push('2. Never execute a delegated node yourself.')
    lines.push('3. You are consulted at exactly two points: a node FAILED (decide: re-dispatch it to retry, or `advance_plan` action="fail" / action="skip" with node=<its number>), and the final settle (write the answer for the user; action="finish" only to close early).')
  } else {
    // A todo list runs itself down: no dispatcher, no spawns — the agent is
    // the only executor, and todo_write is the only state channel.
    lines.push('1. Work through the list yourself, one entry at a time — no spawn_agent, no delegation, no advance_plan.')
    lines.push('2. Mark exactly ONE entry in_progress while working on it; the moment it settles call todo_write with the updated list (that entry completed). Work pinned on something outside your control is blocked (+ a note saying what it waits on) — never in_progress.')
    lines.push('3. Rescope freely: send the full list every time — existing entries carry their id (no id = a NEW entry), dropped entries retire as skipped, settled entries never change.')
  }
  return lines.join('\n')
}

export interface PlanSnapshotInfo {
  action: 'create' | 'complete' | 'fail' | 'skip' | 'finish' | 'update'
  node?: string | number
  notes?: string
  /** todo update delta: the entries touched this pass — the result renders
   *  ONLY these rows, because the model's own tool input already carries the
   *  full list it sent (the state block re-injects the full list next turn).
   *  Absent → render everything (defensive / non-executor callers). */
  changed?: string[]
  /** reconcile stats for the update header, the reword caution and the
   *  blocked-drop-off callouts. */
  stats?: TodoReconcileStats
}

/** Full-plan snapshot returned as the create_plan / advance_plan / todo_write
 *  tool_result — the model's view of the graph after the mutation. Delegated
 *  plans render whole; todo updates render as a DELTA (see PlanSnapshotInfo). */
export function formatPlanSnapshot(plan: Plan | null, info: PlanSnapshotInfo): string {
  const active = normalizePlanShape(plan)
  if (!active) return ''
  const todo = isTodoPlan(active)
  const parts: string[] = []
  const ref = info.node !== undefined ? resolveNodeRef(active, info.node) : null
  const num = ref ? nodeNumberOf(ref) : null
  if (info.action === 'create') {
    parts.push((active.mode ?? 'delegated') === 'delegated'
      ? `Plan created with ${active.nodes.length} node(s), numbered n1..n${active.nodes.length} — the numbering is fixed. Mode: delegated. All nodes start pending. The scheduler dispatches READY nodes and settles each one on delivery — you are consulted only when a node fails.`
      : `Todo list created with ${active.nodes.length} entr${active.nodes.length === 1 ? 'y' : 'ies'} — work through them yourself and call todo_write with the updated list as you go (the entry you are on in_progress, settled ones completed).`)
  }
  else if (info.action === 'update') {
    const s = info.stats
    parts.push(`Todo list updated${s ? ` — +${s.added} added, ${s.retired} retired, ${s.completed} completed` : ''}.`)
    if (s && s.keptWording > 0) {
      parts.push(`${s.keptWording} settled entr${s.keptWording === 1 ? 'y' : 'ies'} kept their wording — settled steps are immutable; their row above is unchanged.`)
    }
    if (s && s.retired > 0 && s.added > 0) {
      parts.push('Caution: this update both retired and added entries. If one of those pairs is a REWORD of the same step, you broke its thread — next time re-send that entry with its id (the n-number, e.g. { "id": "n2" }) to rewrite it in place, or to bring a retired entry back.')
    }
    for (const rb of s?.retiredBlocked ?? []) {
      parts.push(`Heads-up: ${rb.id} was BLOCKED when it dropped off the list${rb.note ? ` (was waiting on: ${rb.note})` : ''} — it is retired now. Re-send it with its id to bring it back if the wait still stands.`)
    }
  }
  else if (active.completed && info.action === 'complete') parts.push(`Node n${num} completed — every node is settled, the plan is complete.`)
  else if (info.action === 'complete' && num !== null) parts.push(`Node n${num} completed.`)
  else if (info.action === 'fail' && num !== null) parts.push(`Node n${num} FAILED. Its dependents are blocked — retry it (action="complete") or give up on it (action="skip").`)
  else if (info.action === 'skip' && num !== null) parts.push(`Node n${num} skipped.`)
  else if (info.action === 'finish') parts.push('Plan finished early — remaining nodes were force-completed.')
  parts.push(`Objective: "${active.objective}"`, '')

  const byId = idMap(active)
  const ready = new Set(readyNodes(active).map(n => n.id))
  const changedSet = info.changed ? new Set(info.changed) : null
  for (const node of active.nodes) {
    if (todo && changedSet && !changedSet.has(node.id)) continue
    parts.push(todo ? describeTodoNode(node, active.currentNodeId ?? null) : describeNode(node, byId, ready))
  }

  if (!active.completed) {
    parts.push('')
    if (todo) {
      const open = active.nodes.filter(n => n.status === 'pending' || n.status === 'blocked').length
      parts.push(`${active.nodes.length - open}/${active.nodes.length} settled — keep exactly ONE entry in_progress while working on it.`)
      const blockedCount = active.nodes.filter(n => n.status === 'blocked').length
      if (blockedCount > 0) parts.push(`${blockedCount} blocked — open work waiting on something outside your control, NOT settled progress.`)
    } else {
      const readyList = active.nodes.filter(n => ready.has(n.id)).map(nodeNumberOf)
      // Scheduler-aligned wording (the plan-tool 2026-10-25 evaluation): the
      // old "start these, in parallel" invited a manual spawn_agent round the
      // rules above and the scheduler both forbid — a node dispatched twice,
      // once by the model and once by the scheduler, is the exact confusion
      // that produced it.
      parts.push(readyList.length > 0
        ? `Ready: ${readyList.map(n => `n${n}`).join(', ')} — the scheduler dispatches these automatically; do NOT call spawn_agent for them.`
        : 'Nothing is ready — every open node waits on dependencies.')
    }
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
