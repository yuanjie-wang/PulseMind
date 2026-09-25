/**
 * Plan tool executors (PLAN-plan-dag): create_plan / advance_plan, plus the
 * auto-scheduler's two channels (PLAN-plan-scheduler S2: autoSettle /
 * recordNodeHandoff). All graph rules (validation, ready/blocked derivation,
 * snapshot text) live in shared/plan/graph.ts — this class only adapts callers
 * to it and anchors jump targets. The plan's ONLY writer is this class
 * (single-writer); what changed in PLAN-plan-scheduler is that the writer has
 * two policies — the model's advance_plan executor and the scheduler's
 * delivery→completed settle — not one. Sub-agents never touch the plan.
 */
import type { ToolUseBlock, AgentMessage } from '../types/agent'
import type { Plan, PlanNode, PlanNodeExecutionStatus } from '../../../shared/types/plan'
import type { SummonedExpert } from '../../../shared/expert-context'
import {
  beginNodeExecution,
  updateNodeExecution,
  completeAllNodes,
  createPlanDag,
  formatPlanSnapshot,
  linkNodeSession,
  markNode,
  NODE_HANDOFF_MAX,
  readyNodes,
  resolveNodeRef,
  type RawPlanNode,
} from '../../../shared/plan/graph'

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
   *  update cannot reclaim a node from a newer dispatch. */
  beginNodeExecution(ref: string | number, attemptId: string): void {
    if (this.plan && beginNodeExecution(this.plan, ref, attemptId)) this.notifyPlanChange()
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
      const o = (s ?? {}) as { description?: unknown; depends_on?: unknown; assignee?: unknown }
      const dependsOn = Array.isArray(o.depends_on)
        ? o.depends_on.map(d => Number(d)).filter(d => Number.isFinite(d))
        : undefined
      return {
        description: String(o.description ?? ''),
        ...(dependsOn && dependsOn.length > 0 ? { dependsOn } : {}),
        ...(o.assignee ? { assignee: String(o.assignee) } : {}),
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

  async execAdvancePlan(t: ToolUseBlock): Promise<void> {
    t.status = 'running'; this.notify()
    try {
      const plan = this.plan
      if (!plan || plan.completed) throw new Error('No active plan. Call create_plan first.')

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
