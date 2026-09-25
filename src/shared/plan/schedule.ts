/**
 * The auto-scheduler's decision function (PLAN-plan-scheduler S3). Pure and
 * DOM-free like its sibling graph.ts: given only the plan, say what the
 * scheduler should do next — the engine-side kick (engine/plan-scheduler.ts)
 * performs the action, and every LLM consult the plan needs falls out of the
 * call sites getting a `false` back (normal LLM round) rather than from a
 * second decision path.
 *
 * Priority is the contract: settle what already delivered (so a wave's results
 * land before anything reads them), then wait out in-flight attempts (a drain
 * that isn't clean yet), then consult the model on failures BEFORE dispatching
 * anything else (user ruling 2026-09-25: 失败立即拉回 LLM — a failure stops the
 * world, it does not queue behind the next wave), then dispatch the ready set,
 * then fall through to the ordinary LLM round.
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
  if (live.length > 0) return { type: 'wait', nodes: live }

  const failed = pending.filter(n => n.execution?.status === 'failed' || n.execution?.status === 'stopped')
  if (failed.length > 0) return { type: 'consult', nodes: failed }

  const dispatchable = dispatchableNodes(plan)
  if (dispatchable.length > 0) return { type: 'dispatch', nodes: dispatchable }

  return { type: 'none' }
}
