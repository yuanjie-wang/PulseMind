/**
 * Plan tool executors (PLAN-plan-dag): create_plan / advance_plan. All graph
 * rules (validation, ready/blocked derivation, snapshot text) live in
 * shared/plan/graph.ts — this class only adapts tool input to it and anchors
 * jump targets. The plan's ONLY writers are these two executors, i.e. the main
 * agent's explicit tool calls (single-writer; sub-agents never touch it).
 */
import type { ToolUseBlock, AgentMessage } from '../types/agent'
import type { Plan } from '../../../shared/types/plan'
import {
  completeAllNodes,
  createPlanDag,
  formatPlanSnapshot,
  markNode,
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
  ) { }

  private notifyPlanChange(): void {
    this.onPlanChange?.(this.plan)
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

  async execCreatePlan(t: ToolUseBlock): Promise<void> {
    t.status = 'running'; this.notify()
    try {
      const objective = String(t.input?.objective || '')
      this.plan = createPlanDag(objective, PlanManager.normalizeSteps(t.input?.steps))
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
