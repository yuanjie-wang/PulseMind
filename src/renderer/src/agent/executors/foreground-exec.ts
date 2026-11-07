/**
 * Foreground exec → background promotion registry (PLAN-background-tasks A).
 *
 * A running FOREGROUND exec parks its turn on the process's exit; the 「转入
 * 后台」 button needs the one handle that can end that park early without
 * killing the process. Both exec dispatch sites register here:
 *  - the auto path (execSkillCommand, executors/domain-tools.ts) — its span
 *    promise resolves with 'promoted' and the executor settles the tool result
 *    with the background envelope (backgroundPid=N);
 *  - the approve-released path (execution-flow.ts approveTool) — the handler
 *    settles the block inline, because that path has no promise to resolve.
 *
 * DOM-free pure state: the agent graph runs in BOTH processes (G28), and the
 * registry is per-engine-process module state keyed by tool_use id — an id is
 * registered once (span claim) and unregistered exactly once (exit / error /
 * promote), so a stale entry can never double-settle a call.
 */

export interface ForegroundExecHandle {
  /** The per-command processId the terminal bus broadcasts under. */
  processId: string
  /** End the foreground park: stop consuming terminal events for this call and
   *  let the registered site settle it as a background process instead. */
  promote: () => void
}

const foregroundExecs = new Map<string, ForegroundExecHandle>()

export function registerForegroundExec(toolUseId: string, handle: ForegroundExecHandle): void {
  foregroundExecs.set(toolUseId, handle)
}

export function unregisterForegroundExec(toolUseId: string): void {
  foregroundExecs.delete(toolUseId)
}

/** Promote a running foreground exec to background. Returns false when the id
 *  is unknown (never ran, already exited, already promoted) — the caller turns
 *  that into a user-visible error toast, not silence. */
export function promoteForegroundExec(toolUseId: string): boolean {
  const entry = foregroundExecs.get(toolUseId)
  if (!entry) return false
  foregroundExecs.delete(toolUseId)
  entry.promote()
  return true
}
