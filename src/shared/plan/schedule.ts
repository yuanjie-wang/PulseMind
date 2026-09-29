/**
 * The auto-scheduler's decision function (PLAN-plan-scheduler S3). Pure and
 * DOM-free like its sibling graph.ts: given only the plan, say what the
 * scheduler should do next — the engine-side kick (engine/plan-scheduler.ts)
 * performs the action, and every LLM consult the plan needs falls out of the
 * call sites getting a `false` back (normal LLM round) rather than from a
 * second decision path.
 *
 * Priority is the contract: settle what already delivered (so a wave's results
 * land before anything reads them), then — while attempts are still live —
 * CHAIN every node their settlement just made ready alongside the drain
 * (user ruling 2026-09-30: 不应该浪费槽 — a freed slot goes back to work the
 * moment its node settles, instead of idling behind a whole-wave barrier;
 * this reverses the 2026-06 wave-at-a-time shape). A failure still stops the
 * world: no chain past an unanswered failure (user ruling 2026-09-25: 失败
 * 立即拉回 LLM) — those waves wait for the clean-drain consult, which is why
 * consult-before-dispatch keeps its old precedence on a clean drain. Then
 * dispatch the ready set, then fall through to the ordinary LLM round.
 */
import type { Plan, PlanNode } from '../types/plan'
import { readyNodes } from './graph'

export type ScheduleAction =
  /** Pending nodes whose attempt delivered — mark them completed (autoSettle). */
  | { type: 'settle'; nodes: PlanNode[] }
  /** An attempt is queued/running — not a clean drain; do nothing, wait for it. */
  | { type: 'wait'; nodes: PlanNode[] }
  /** A pending node's attempt failed/stopped — the model decides retry/fail/skip. */
  | { type: 'consult'; nodes: PlanNode[] }
  /** Ready nodes with no attempt yet — this wave's synthetic spawn batch. */
  | { type: 'dispatch'; nodes: PlanNode[] }
  /** Ready nodes whose dependencies settled while OTHER attempts are still
   *  live — chain them alongside the drain through the freed slots, never as
   *  a second `handleToolUseResponse` batch (that call owns the engine's
   *  whole batch state; the concurrent channel registers into the live
   *  accounting instead — see PlanScheduler.dispatchConcurrent). */
  | { type: 'chain'; nodes: PlanNode[]; live: PlanNode[] }
  /** Nothing to do: closed plan, direct mode, or everything blocked → normal LLM round. */
  | { type: 'none' }

/** An attempt is live while queued or running — a node in that state is being
 *  (or is about to be) worked on and must not be dispatched again. */
export function hasLiveExecution(node: PlanNode): boolean {
  return node.execution?.status === 'queued' || node.execution?.status === 'running'
}

/** Ready AND never attempted — the scheduler's dispatch set. `readyNodes` alone
 *  is not enough: a node the model already spawned in its create round is still
 *  pending (execution is not acceptance), and re-spawning it would run the work
 *  twice. Delivered-but-unsettled nodes are excluded too — they are the settle
 *  action's input, not the dispatch set's. */
export function dispatchableNodes(plan: Plan): PlanNode[] {
  return readyNodes(plan).filter(n => !n.execution)
}

export function nextScheduleAction(plan: Plan | null): ScheduleAction {
  // Applicability baked in so every caller shares one answer: a closed plan,
  // a direct-mode plan (the main agent executes those nodes itself — that IS
  // the LLM's job) and no plan at all all mean "not the scheduler's turn".
  if (!plan || plan.completed || (plan.mode ?? 'delegated') !== 'delegated') return { type: 'none' }

  const pending = plan.nodes.filter(n => n.status === 'pending')

  const delivered = pending.filter(n => n.execution?.status === 'delivered')
  if (delivered.length > 0) return { type: 'settle', nodes: delivered }

  const live = pending.filter(hasLiveExecution)

  // The chain (2026-09-30): a settled node can unblock a dependent while its
  // wave-mates still run. Only when NOTHING has failed — a failure pulls the
  // model in at the clean drain before any new work goes out, so a mid-wave
  // failure defers to `wait` exactly like it always did.
  if (live.length > 0) {
    const failedNow = pending.filter(n => n.execution?.status === 'failed' || n.execution?.status === 'stopped')
    if (failedNow.length === 0) {
      const chainable = dispatchableNodes(plan)
      if (chainable.length > 0) return { type: 'chain', nodes: chainable, live }
    }
    return { type: 'wait', nodes: live }
  }

  const failed = pending.filter(n => n.execution?.status === 'failed' || n.execution?.status === 'stopped')
  if (failed.length > 0) return { type: 'consult', nodes: failed }

  const dispatchable = dispatchableNodes(plan)
  if (dispatchable.length > 0) return { type: 'dispatch', nodes: dispatchable }

  return { type: 'none' }
}
