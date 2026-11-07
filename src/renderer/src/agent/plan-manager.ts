/**
 * Plan tool executors (PLAN-plan-dag): create_plan / advance_plan, plus the
 * auto-scheduler's two channels (PLAN-plan-scheduler S2: autoSettle /
 * recordNodeHandoff). All graph rules (validation, ready/blocked derivation,
 * snapshot text) live in shared/plan/graph.ts — this class only adapts callers
 * to it and anchors jump targets. The plan's ONLY writer is this class
 * (single-writer); the writer has FOUR policies — the model's advance_plan
 * executor, the scheduler's delivery→completed settle, the split merge, and
 * todo_write's direct-mode reconcile (the todo list IS a direct plan) — not
 * one. Sub-agents never touch the plan.
 */
import type { ToolUseBlock, AgentMessage } from '../types/agent'
import type { Plan, PlanNode, PlanNodeExecutionStatus } from '../../../shared/types/plan'
import type { SummonedExpert } from '../../../shared/expert-context'
import {
  beginNodeExecution,
  mergeSplitProposal as applySplitMerge,
  updateNodeExecution,
  completeAllNodes,
  createPlanDag,
  detectPreNarration,
  formatPlanSnapshot,
  linkNodeSession,
  markNode,
  NODE_HANDOFF_MAX,
  PRE_NARRATION_NOTICE,
  readyNodes,
  reconcileTodo,
  resolveNodeRef,
  type RawPlanNode,
} from '../../../shared/plan/graph'
import type { SplitChildSpec } from '../../../shared/plan/split-proposal'
import { mintPlanId } from '../../../shared/plan/exchange'

const SETTLE_STATUS = { complete: 'completed', fail: 'failed', skip: 'skipped' } as const

export class PlanManager {
  plan: Plan | null = null

  constructor(
    private addToolResult: (toolUseId: string, content: string, isError: boolean) => void,
    private notify: () => void,
    private getMessages: () => AgentMessage[],
    private onPlanChange?: (plan: Plan | null) => void,
    /** 当前回合被 @召唤的专家（多专家召唤 → 计划模式）。A getter, not a snapshot:
     *  the summons belongs to the turn, and create_plan is where it is enforced. */
    private getSummonedExperts?: () => SummonedExpert[],
  ) { }

  /** Fired on every real plan mutation (a create, a settle, a node link) — the
   *  engine reads it as "the plan tooling has been used in this turn", which is
   *  what retires the multi-expert summons nudge. */
  onMutated?: () => void

  private notifyPlanChange(): void {
    this.onMutated?.()
    this.onPlanChange?.(this.plan)
  }

  /** Record the sub-conversation a spawn runs a node in (PLAN-workbench W12).
   *  The plan is the ONLY place this link persists — the spawn tool block's own
   *  copy lives on the live status diff and dies with the message — so the
   *  executor reports it here and the DAG's node click reads it back. */
  linkNodeSession(ref: string | number, subConvId: string): void {
    if (!this.plan) return
    try {
      const before = resolveNodeRef(this.plan, ref)?.subConvId
      if (before === subConvId) return
      linkNodeSession(this.plan, ref, subConvId)
      this.notifyPlanChange()
    } catch (err) {
      // A stale/unknown ref must never fail the dispatch itself.
      console.warn('[PlanManager] linkNodeSession failed:', err)
    }
  }

  /** Parent-only execution channel. Beginning is explicit so a late queued
   *  update cannot reclaim a node from a newer dispatch. Also the lazy mint
   *  point for `plan.id` (PLAN-plan-exchange E1): a plan persisted before the
   *  exchange spec has no id, and every dispatch saves the plan anyway — so
   *  minting here gives legacy plans an exchange area with zero extra
   *  persistence paths. Single writer preserved (this is PlanManager). */
  beginNodeExecution(ref: string | number, attemptId: string): void {
    if (!this.plan) return
    if (!this.plan.id) this.plan.id = mintPlanId()
    if (beginNodeExecution(this.plan, ref, attemptId)) this.notifyPlanChange()
  }

  /** Record a node's delivered report file (PLAN-plan-exchange E3) — CAS on
   *  attemptId like recordNodeHandoff: a straggler from a superseded retry
   *  cannot stamp the newer attempt's node. declaredStatus is advisory data
   *  for downstream readers, never plan state. */
  recordNodeReport(
    ref: string | number, attemptId: string, reportPath: string, declaredStatus?: 'success' | 'partial' | 'failed',
  ): boolean {
    const plan = this.plan
    if (!plan || !attemptId || !reportPath) return false
    const node = resolveNodeRef(plan, ref)
    if (!node || node.execution?.attemptId !== attemptId) return false
    if (node.reportPath === reportPath && node.declaredStatus === declaredStatus) return false
    node.reportPath = reportPath
    node.declaredStatus = declaredStatus
    this.notifyPlanChange()
    return true
  }

  updateNodeExecution(ref: string | number, attemptId: string, status: PlanNodeExecutionStatus, subConvId?: string): void {
    if (this.plan && updateNodeExecution(this.plan, ref, attemptId, status, subConvId)) this.notifyPlanChange()
  }

  /** Auto-scheduler settlement (PLAN-plan-scheduler S2/S10): a node whose
   *  attempt DELIVERED is accepted without an LLM round — the whole point of
   *  the scheduler. Same single-writer class, second policy: markNode's
   *  auto-close on the last settle is reused, and the summary defaults to the
   *  handoff's first line (a later advance_plan notes still overwrites it).
   *  Only a genuinely delivered, still-pending node settles; anything else is
   *  a no-op so a stale kick cannot double-settle or revive a node. */
  autoSettle(ref: string | number): boolean {
    const plan = this.plan
    if (!plan) return false
    const node = resolveNodeRef(plan, ref)
    if (!node || node.status !== 'pending' || node.execution?.status !== 'delivered') return false
    const firstLine = PlanManager.handoffFirstLine(node)
    markNode(plan, node.id, 'completed', firstLine !== undefined ? { summary: node.summary ?? firstLine } : undefined)
    this.notifyPlanChange()
    return true
  }

  /** CAS the delivered node's output onto the plan (PLAN-plan-scheduler S8) —
   *  the downstream hand-off medium. attemptId must match the LIVE attempt
   *  (same discipline as updateNodeExecution): a straggler from a superseded
   *  retry can never overwrite the newer attempt's handoff. Capped at
   *  NODE_HANDOFF_MAX on the way in, so plan_json stays bounded. */
  recordNodeHandoff(ref: string | number, attemptId: string, text: string): boolean {
    const plan = this.plan
    if (!plan || !attemptId) return false
    const node = resolveNodeRef(plan, ref)
    if (!node || node.execution?.attemptId !== attemptId) return false
    const trimmed = text.slice(0, NODE_HANDOFF_MAX)
    if (!trimmed.trim() || node.handoff === trimmed) return false
    node.handoff = trimmed
    this.notifyPlanChange()
    return true
  }

  /** Split merge (PLAN-plan-split P3/P8) — the plan's THIRD write policy, next
   *  to advance_plan and autoSettle. The graph function owns every gate (CAS
   *  on attemptId, gen cap, node budget, acyclicity) and rejects whole-unit;
   *  the plan is notified only on a real merge — a rejection changed nothing
   *  and must not mark the plan mutated. */
  mergeSplitProposal(
    ref: string | number, attemptId: string, children: SplitChildSpec[], reason?: string,
  ): { ok: true; nodeIds: string[] } | { ok: false; reason: string } {
    if (!this.plan) return { ok: false, reason: 'no active plan' }
    const result = applySplitMerge(this.plan, ref, attemptId, children, reason)
    if (!result.ok) return result
    this.notifyPlanChange()
    return { ok: true, nodeIds: result.children.map(c => c.id) }
  }

  /** First non-empty line of the handoff, ≤120 chars — autoSettle's default
   *  summary (S10), so snapshots and the panel show what the node produced
   *  without the model writing a notes line it never gets the chance to. */
  private static handoffFirstLine(node: PlanNode): string | undefined {
    const line = (node.handoff ?? '').split('\n').map(s => s.trim()).find(s => s.length > 0)
    if (!line) return undefined
    return line.length > 120 ? `${line.slice(0, 119)}…` : line
  }

  /** The assistant message carrying this tool call — the panel's jump anchor. */
  private anchorOf(toolUseId: string): string | undefined {
    return this.getMessages().find(m => m.role === 'assistant' && m.contentBlocks.some(b => b.type === 'tool_use' && b.id === toolUseId))?.id
  }

  /** Tool steps arrive as plain strings (weak model / legacy form → a chain)
   *  or as {description, depends_on, assignee} objects (the DAG form). A
   *  string chains to its predecessor: the v1 ordered list IS the dependency
   *  order, so legacy callers keep serial semantics. */
  private static normalizeSteps(input: unknown): RawPlanNode[] {
    const arr = Array.isArray(input) ? input : []
    return arr.map((s, i) => {
      if (typeof s === 'string') return { description: s, ...(i > 0 ? { dependsOn: [i] } : {}) }
      const o = (s ?? {}) as { description?: unknown; depends_on?: unknown; assignee?: unknown; report_spec?: unknown }
      const dependsOn = Array.isArray(o.depends_on)
        ? o.depends_on.map(d => Number(d)).filter(d => Number.isFinite(d))
        : undefined
      return {
        description: String(o.description ?? ''),
        ...(dependsOn && dependsOn.length > 0 ? { dependsOn } : {}),
        ...(o.assignee ? { assignee: String(o.assignee) } : {}),
        ...(o.report_spec ? { reportSpec: String(o.report_spec) } : {}),
      }
    })
  }

  /** 多专家 @召唤的覆盖检查：每位被召唤的专家都必须成为某个节点的 assignee。
   *  A plain chat turn has no summons and skips this entirely. Enforced HERE
   *  rather than in prose because the failure is otherwise silent: the model
   *  returns a plan, the user believes their experts were assigned, and one of
   *  them simply never appears. The error goes back as a tool_result the model
   *  can act on inside the same loop — which is also why it names who is
   *  missing AND who is already covered. */
  private assertSummonCoverage(plan: Plan): void {
    const summoned = this.getSummonedExperts?.() ?? []
    if (summoned.length === 0) return
    const assigned = new Set(plan.nodes.map(n => n.assignee).filter((a): a is string => !!a))
    const missing = summoned.filter(e => !assigned.has(e.id))
    if (missing.length === 0) return
    const covered = summoned.filter(e => assigned.has(e.id)).map(e => e.name)
    throw new Error(
      `The user summoned ${summoned.length} expert(s) by @-mention and EACH of them must own at least one node — missing: ${missing.map(e => `${e.name} (id: ${e.id})`).join(', ')}.` +
      (covered.length > 0 ? ` Already assigned: ${covered.join(', ')}.` : '') +
      ' Rewrite the steps so every summoned expert appears as an `assignee` (the node description is their assignment), then call create_plan again.'
    )
  }

  async execCreatePlan(t: ToolUseBlock): Promise<void> {
    t.status = 'running'; this.notify()
    try {
      const objective = String(t.input?.objective || '')
      const next = createPlanDag(objective, PlanManager.normalizeSteps(t.input?.steps))
      // Coverage first, assignment second: a rejected plan must leave the live
      // one (and the summons it may already satisfy) untouched.
      this.assertSummonCoverage(next)
      this.plan = next
      this.notifyPlanChange()
      this.addToolResult(t.id, formatPlanSnapshot(this.plan, { action: 'create' }), false)
      t.exitCode = 0
    } catch (err) {
      this.addToolResult(t.id, `Error: ${err instanceof Error ? err.message : 'create_plan failed'}`, true)
      t.exitCode = -1
    }
    t.status = 'completed'; this.notify()
  }

  /** todo_write (the direct-mode channel): the model's full todo list, applied
   *  through reconcileTodo — append new entries, soft-skip retired pendings,
   *  never touch settled ones. Routing is enforced HERE, not in prose: a
   *  summons means delegation (create_plan), a live delegated plan means the
   *  DAG owns this conversation until it closes. */
  async execTodoWrite(t: ToolUseBlock): Promise<void> {
    t.status = 'running'; this.notify()
    try {
      const summoned = this.getSummonedExperts?.() ?? []
      if (summoned.length > 0) {
        throw new Error(
          `The user summoned ${summoned.length} expert(s) — that work is DELEGATED. Build the assignment DAG with create_plan (every summoned expert owns a node) instead of a todo list.`,
        )
      }
      if (this.plan && (this.plan.mode ?? 'delegated') !== 'direct' && !this.plan.completed) {
        throw new Error('A delegated plan is active — settle it (or close it with advance_plan action="finish") before opening a todo list.')
      }
      const result = reconcileTodo(
        this.plan,
        String(t.input?.objective || ''),
        t.input?.items,
        { msgId: this.anchorOf(t.id), fresh: t.input?.fresh === true },
      )
      this.plan = result.plan
      this.notifyPlanChange()
      const snapshot = formatPlanSnapshot(this.plan, {
        action: result.minted ? 'create' : 'update',
        changed: result.changed,
        stats: result.stats,
      })
      // Soft gate (2026-10-27): the manual's rule 2 (「exactly one
      // in_progress」) echoed in the result when the SUBMITTED list claims
      // several. A note, never a rejection — reconcileTodo derives the live
      // state anyway, and the panel's own rendering is the authority.
      const items = Array.isArray(t.input?.items) ? t.input.items : []
      const activeCount = items.filter((i: unknown) => (i as { status?: string } | null)?.status === 'in_progress').length
      const activeNote = activeCount > 1
        ? `\n\n(Note: ${activeCount} steps claim in_progress — exactly one step is actively worked at a time; keep the others pending or blocked.)`
        : ''
      // Pre-narration correction (2026-10-25): when the call's own message
      // already speaks in the snapshot's voice, the model pre-wrote a return
      // (a deterministic format it can compute before the tool runs — fabricated
      // evidence in the most trusted format). Prepend the correction to the REAL
      // result: highest-salience teaching, zero loop cost, and the transcript
      // keeps both sides adjacent for audit.
      const anchorId = this.anchorOf(t.id)
      const anchorText = anchorId
        ? (this.getMessages().find(m => m.id === anchorId)?.contentBlocks ?? [])
            .filter(b => b.type === 'text')
            .map(b => (b as { text: string }).text)
            .join('\n')
        : ''
      this.addToolResult(t.id, detectPreNarration(anchorText) ? `${PRE_NARRATION_NOTICE}${snapshot}${activeNote}` : snapshot + activeNote, false)
      t.exitCode = 0
    } catch (err) {
      this.addToolResult(t.id, `Error: ${err instanceof Error ? err.message : 'todo_write failed'}`, true)
      t.exitCode = -1
    }
    t.status = 'completed'; this.notify()
  }

  async execAdvancePlan(t: ToolUseBlock): Promise<void> {
    t.status = 'running'; this.notify()
    try {
      const plan = this.plan
      if (!plan || plan.completed) throw new Error('No active plan. Call create_plan first.')
      if ((plan.mode ?? 'delegated') === 'direct') {
        throw new Error('This is a todo list (direct mode) — update it with todo_write (send the full list with updated statuses), not advance_plan.')
      }

      const action = String(t.input?.action || '')
      const notes = String(t.input?.notes || '')
      const rawRef = t.input?.node
      const ref = rawRef !== undefined && rawRef !== null && rawRef !== '' ? rawRef : undefined

      if (action === 'finish') {
        completeAllNodes(plan)
        // Anchor the finish jump on the last node (it was never individually settled).
        plan.nodes[plan.nodes.length - 1].msgId = this.anchorOf(t.id) ?? plan.nodes[plan.nodes.length - 1].msgId
        this.addToolResult(t.id, formatPlanSnapshot(plan, { action: 'finish', notes }), false)
        t.exitCode = 0
      } else if (action === 'complete' || action === 'fail' || action === 'skip') {
        const node = ref !== undefined
          ? resolveNodeRef(plan, ref as string | number)
          : PlanManager.soleReadyNode(plan)
        if (!node) {
          throw new Error(ref !== undefined
            ? `Unknown node "${String(ref)}". Use a step number (1..${plan.nodes.length}) or id (n1..n${plan.nodes.length}).`
            : 'No unique ready node — pass node=<number> explicitly.')
        }
        markNode(plan, node.id, SETTLE_STATUS[action], { msgId: this.anchorOf(t.id), summary: notes || undefined })
        this.addToolResult(t.id, formatPlanSnapshot(plan, { action, node: node.id, notes }), action === 'fail')
        t.exitCode = action === 'fail' ? 1 : 0
      } else {
        throw new Error(`Unknown action: "${action}". Use "complete", "fail", "skip", or "finish".`)
      }
    } catch (err) {
      this.addToolResult(t.id, `Error: ${err instanceof Error ? err.message : 'advance_plan failed'}`, true)
      t.exitCode = -1
    }
    this.notifyPlanChange()
    t.status = 'completed'; this.notify()
  }

  /** node omitted (D5): allowed only when exactly one node is ready, so a
   *  single-chain plan never needs the parameter. Ambiguity is an error that
   *  lists the ready set. */
  private static soleReadyNode(plan: Plan): ReturnType<typeof readyNodes>[number] | null {
    const ready = readyNodes(plan)
    if (ready.length === 1) return ready[0]
    if (ready.length === 0) throw new Error('Nothing is ready — every open node waits on dependencies. Pass node=<number>.')
    throw new Error(`Multiple nodes are ready (n${ready.map(n => n.id.slice(1)).join(', n')}) — pass node=<number> to say which one settled.`)
  }
}
