// ── Gate-period escape, refined (review 2026-09-26 中4; 2026-09-28) ──
// Why an escape exists at all: app-start gates the main window on the launch
// hooks, and during the gate the only user-closeable window is the hook's own
// login window. Close it and Windows reaches `window-all-closed` with the
// startup incomplete — quitting there would kill a login that may still be
// polling to completion (and once reproduced the 「启动即闪退」 auto-close
// bug), but not quitting leaves a process with no window, no tray, no
// taskbar presence, killable only from Task Manager.
//
// The 2026-09-26 escape surfaced a modal dialog the instant that state
// appeared. Refined: the decision now waits out a short grace first, which
// absorbs the two shapes that made the dialog mostly noise —
//   • the user finished approving on their phone and closed the page; the
//     hook's server-side poll lands seconds later and the gate releases by
//     itself (the dialog's own 继续等待 button, automated);
//   • the watchdog abandoned a stuck hook and closed its window a beat
//     before the gate released — the dialog used to be able to flash there.
// When the grace expires with the gate still held, the most recent
// hook-window close being the USER's (hook-browser's
// wasLastHookWindowUserClosed) is read as intent — 「别等了」 — and the gate
// is skipped silently: skipLaunchHooks never kills the hook, a late env var
// still lands. The dialog survives only for a zero-window state no user
// close explains — no current window type can produce one (the splash is
// frameless and destroyed programmatically), so the dialog is the defensive
// face that keeps the process reachable if a future flow grows one.

/** How long a zero-window gate state is tolerated before the escape decides. */
export const GATE_ESCAPE_GRACE_MS = 5_000

export interface GateEscapeDeps {
  /** True while the launch gate holds AND startup has not finished. */
  gateHeld(): boolean
  /** True when the most recent hook-window close came from the user. */
  lastHookWindowCloseFromUser(): boolean
  /** Release the gate without waiting (skipLaunchHooks). */
  skipGate(): void
  /** The fallback dialog (offerGateSkipDialog, async fire-and-forget). */
  showDialog(): void
  log(message: string): void
}

let timer: ReturnType<typeof setTimeout> | null = null

/** `window-all-closed` reached us during the gate. Arms the grace; the
 *  decision happens when it expires (or never, if the gate releases first).
 *  Idempotent while the grace runs — window-all-closed cannot re-fire while
 *  zero windows are open, but arming twice would double-skip. */
export function beginGateEscape(deps: GateEscapeDeps): void {
  if (timer || !deps.gateHeld()) return
  timer = setTimeout(() => {
    timer = null
    if (!deps.gateHeld()) return
    if (deps.lastHookWindowCloseFromUser()) {
      deps.log(`gate still holds ${GATE_ESCAPE_GRACE_MS}ms after the user closed the hook window — skipping it`)
      deps.skipGate()
      return
    }
    deps.log('zero windows, gate held, no user close — offering the wait/skip dialog')
    deps.showDialog()
  }, GATE_ESCAPE_GRACE_MS)
}

/** A hook window opened again: the zero-window premise is gone, so a pending
 *  grace must not decide behind a live login window (auto-skipping the gate
 *  while the user is mid-login would be worse than the dialog ever was). If
 *  it closes again, `window-all-closed` re-fires and re-arms from scratch. */
export function cancelGateEscape(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}
