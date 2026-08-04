import type { ToolUseBlock, AgentMessage, Plan } from '../types/agent'

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

  /** Build a full-plan snapshot for the tool_result the LLM sees next turn. */
  private formatPlanSnapshot(action: string, notes: string): string {
    const plan = this.plan
    if (!plan) return ''

    const total = plan.steps.length
    const parts: string[] = []

    // Intro line — what just happened
    if (plan.completed) {
      parts.push(action === 'finish' ? 'Plan finished early.' : `All ${total} steps completed.`)
    } else if (action === 'fail') {
      parts.push(`Step ${plan.currentStepIndex + 1} failed. Adjust your approach and call advance_plan action="complete" to continue.`)
    } else {
      parts.push(`Step ${plan.currentStepIndex}/${total} completed.`)
    }

    parts.push(`Objective: "${plan.objective}"`)
    parts.push('')

    // Flat checklist — all steps with status markers
    for (let i = 0; i < plan.steps.length; i++) {
      const s = plan.steps[i]
      const marker = s.status === 'completed' ? '[done]' : s.status === 'failed' ? '[fail]' : '[ ]'
      parts.push(`${marker} ${i + 1}. ${s.description}`)
    }

    if (notes) parts.push('', notes)

    return parts.join('\n')
  }

  /** Snapshot for a freshly created plan (all steps pending). */
  private formatCreateSnapshot(notes: string): string {
    const plan = this.plan
    if (!plan) return ''

    const parts: string[] = []
    parts.push(`Plan created with ${plan.steps.length} step(s). Mode: ${plan.mode}.`)
    parts.push('')
    parts.push(`Objective: "${plan.objective}"`)
    parts.push('')

    for (let i = 0; i < plan.steps.length; i++) {
      parts.push(`[ ] ${i + 1}. ${plan.steps[i].description}`)
    }

    if (notes) parts.push('', notes)

    return parts.join('\n')
  }

  async execCreatePlan(t: ToolUseBlock): Promise<void> {
    t.status = 'running'; this.notify()
    try {
      const objective = String(t.input?.objective || '')
      const steps = (t.input?.steps as string[]) || []
      if (!objective.trim()) throw new Error('objective is required')
      if (!steps.length) throw new Error('steps are required')
      if (steps.length > 20) throw new Error('maximum 20 steps allowed')

      const mode = 'delegated'
      this.plan = {
        objective,
        steps: steps.map((s: string) => ({ description: s, status: 'pending' as const })),
        currentStepIndex: 0,
        completed: false,
        mode
      }
      this.notifyPlanChange()

      this.addToolResult(t.id, this.formatCreateSnapshot('All steps run in delegated mode (spawn_agent).'), false)
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

      if (action === 'complete') {
        const idx = plan.currentStepIndex
        plan.steps[idx].status = 'completed'
        const advanceMsg = this.getMessages().find(m => m.role === 'assistant' && m.contentBlocks.some(b => b.type === 'tool_use' && b.id === t.id))
        if (advanceMsg) plan.steps[idx].msgId = advanceMsg.id
        const nextIdx = idx + 1
        if (nextIdx >= plan.steps.length) {
          plan.completed = true
        } else {
          plan.currentStepIndex = nextIdx
        }
        this.addToolResult(t.id, this.formatPlanSnapshot('complete', notes), false)
        t.exitCode = 0
      } else if (action === 'fail') {
        const idx = plan.currentStepIndex
        plan.steps[idx].status = 'failed'
        const failMsg = this.getMessages().find(m => m.role === 'assistant' && m.contentBlocks.some(b => b.type === 'tool_use' && b.id === t.id))
        if (failMsg) plan.steps[idx].msgId = failMsg.id
        this.addToolResult(t.id, this.formatPlanSnapshot('fail', notes), true)
        t.exitCode = 1
      } else if (action === 'finish') {
        for (const step of plan.steps) {
          if (step.status !== 'completed' && step.status !== 'failed') {
            step.status = 'completed'
          }
        }
        const finishMsg = this.getMessages().find(m => m.role === 'assistant' && m.contentBlocks.some(b => b.type === 'tool_use' && b.id === t.id))
        // Assign msgId to the last step so clicking it in the PlanPanel jumps
        // to the finish message (the last step was never individually completed).
        if (finishMsg) plan.steps[plan.steps.length - 1].msgId = finishMsg.id
        plan.completed = true
        this.addToolResult(t.id, this.formatPlanSnapshot('finish', notes), false)
        t.exitCode = 0
      } else {
        throw new Error(`Unknown action: "${action}". Use "complete", "fail", or "finish".`)
      }
    } catch (err) {
      this.addToolResult(t.id, `Error: ${err instanceof Error ? err.message : 'advance_plan failed'}`, true)
      t.exitCode = -1
    }
    this.notifyPlanChange()
    t.status = 'completed'; this.notify()
  }
}
