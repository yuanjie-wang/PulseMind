// ── create_sub_plan implementation (PLAN-plan-split v2 R1, sub-agent-only) ──
// The sub-agent's one growth channel: normalize the proposed subtasks and
// merge them into the PARENT plan through the spawn-manager bridge. The graph
// layer (mergeSplitProposal) owns every gate — CAS on the dispatch attemptId,
// gen cap, 2..5, the 20-node budget, whole-unit rejection — so this executor
// only shapes input and reports; a rejection is an ordinary tool error the
// sub-agent can correct and retry in-loop.

import type { ToolExecContext } from './context'
import type { ToolUseBlock } from '../../types/agent'
import type { SplitChildSpec } from '../../../../shared/plan/split-proposal'

/** Sub-task description cap — mirrors the text-protocol parser's rule so both
 *  channels enforce the same shape. */
const DESCRIPTION_MAX = 500

export async function execCreateSubPlanTool(ex: ToolExecContext, t: ToolUseBlock): Promise<void> {
  t.status = 'running'; ex.notify()
  try {
    if (!ex.opts.spawnPlanSplit) {
      throw new Error('create_sub_plan is only available to a sub-agent executing a splittable plan node.')
    }
    const raw = Array.isArray(t.input?.subtasks) ? t.input.subtasks : []
    const children: SplitChildSpec[] = raw.map((s) => {
      if (typeof s === 'string') return { description: s.trim() }
      const o = (s ?? {}) as { description?: unknown; depends_on?: unknown; report_spec?: unknown }
      const dependsOn = Array.isArray(o.depends_on)
        ? o.depends_on.map(Number).filter(d => Number.isFinite(d))
        : undefined
      return {
        description: String(o.description ?? '').trim(),
        ...(dependsOn && dependsOn.length > 0 ? { dependsOn } : {}),
        ...(o.report_spec ? { reportSpec: String(o.report_spec) } : {}),
      }
    })
    const reason = String(t.input?.reason || '').trim() || undefined
    const bad = children.findIndex(c => !c.description || c.description.length > DESCRIPTION_MAX)
    if (bad !== -1) throw new Error(`sub-task ${bad + 1}: description must be 1–${DESCRIPTION_MAX} characters`)

    const result = ex.createSubPlan?.(children, reason)
    if (!result) throw new Error('no parent plan channel — the bridge was not wired')
    if (!result.ok) throw new Error(result.reason)

    const ids = result.nodeIds
    const range = ids.length > 1 ? `${ids[0]}..${ids[ids.length - 1]}` : ids[0]
    t.exitCode = 0
    ex.addToolResult(
      t.id,
      `Merged into the parent plan as ${range}${reason ? ` (${reason})` : ''}.\n\n`
      + `The new nodes are NOT yours — the parent's scheduler dispatches them once your node settles. `
      + `Continue only YOUR remaining scope and deliver normally. `
      + `If the remainder still exceeds you, you may call this tool again (the plan budget permitting); `
      + `do NOT re-state a split you already made.`,
      false,
    )
  } catch (err) {
    t.exitCode = -1
    ex.addToolResult(
      t.id,
      `Error: ${err instanceof Error ? err.message : 'create_sub_plan failed'} — correct the call and retry, or continue the work yourself.`,
      true,
    )
  }
  t.status = 'completed'; ex.notify()
}
