// ── The auto-send edge rule (暂存消息的自动发送时机) ──
// Pure, because the rule is the whole safety story of the staged queue and the
// effect that consumes it cannot be mounted under vitest (node-env, no React) —
// the edge cases below ARE the tests. Two product decisions are pinned here:
// a turn that ends in error / pause / loop-limit does NOT auto-send (the user
// decides; the strip keeps showing the message with a settled hint), and only
// `completed` counts as "the loop ended".
//
// The trap this shape exists to avoid: an effect keyed on the status VALUE
// re-fires on mount, on conversation switch and on StrictMode's second pass —
// a value check (`status === 'completed'`) would drain a queue whose turn
// ended long ago, twice, or into a conversation just switched to. Draining on
// the TRANSITION (previous observation was a busy turn of the SAME
// conversation → now completed) makes every one of those a rebase instead.

/** Statuses in which the engine owes the conversation a turn still running.
 *  The awaiting_* parks are mid-turn (a decision the loop resumes after), not
 *  turn ends — so they count as busy: their later path to `completed` is the
 *  edge that drains. `idle`/`error`/`awaiting_continue`/`awaiting_extension`
 *  are turn ends TOO, but the ones the user ended or that failed — deliberately
 *  absent from this set (决策 #2: error/暂停态不自动发送). */
export const ACTIVE_TURN_STATUSES: ReadonlySet<string> = new Set([
  'streaming',
  'executing',
  'retrying',
  'awaiting_approval',
  'awaiting_user_input',
])

export interface StatusObservation {
  convId: string | null
  status: string
}

/** The last status seen per conversation, null before the first observation. */
export type PreviousObservation = StatusObservation | null

/**
 * Should the staged queue for `next` drain (send its head) right now?
 *
 * - No conversation → never.
 * - Next is not `completed` → never (error / paused / loop-limit / mid-turn).
 * - First observation, or the convId changed → drain only when the status is
 *   `completed`: the turn may have ENDED while unobserved (the user staged,
 *   switched away, the loop finished in the background, the user came back —
 *   v1 only auto-sends what the active view can watch, so returning is the
 *   moment it catches up). A still-running or idle conv drains nothing, and an
 *   empty queue makes even the `completed` case a no-op at the take.
 * - Same conversation → only a busy → completed edge. `completed → completed`
 *   (a re-render, StrictMode's second pass, a later notify) is not an edge.
 */
export function shouldDrainOnStatusChange(
  prev: PreviousObservation,
  next: StatusObservation
): boolean {
  if (!next.convId || next.status !== 'completed') return false
  if (!prev) return true
  if (prev.convId !== next.convId) return true
  return ACTIVE_TURN_STATUSES.has(prev.status)
}
