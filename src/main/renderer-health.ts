// ── Renderer health heartbeat ─────────────────────────────────────────────
// The post-sleep freeze of 2026-11-18 is the failure mode every existing
// recovery is blind to. The renderer process stayed alive (the compositor kept
// repainting carets, main.log kept being written, CPU ~2%), but it no longer
// received IPC: the resume notification timed out, and the `reload()` sent in
// its place never reached it either — a reload is also just an IPC command.
// Chromium's own 'unresponsive' event never fires in that state: the renderer's
// message loop is *idle* (sample: parked in kevent64), not blocked. From the
// outside the window looked alive, and the user's only way out was a restart.
//
// So this watchdog asks the one question main can actually answer: can the
// renderer still receive a message and answer it? The preload answers PING from
// the renderer's own JS thread (never through React), so a missing pong covers
// both shapes — a dead channel and a blocked thread. The verdict is a process
// kill (forcefullyCrashRenderer), which does not travel over the dead channel:
// render-process-gone then reloads the window and the new renderer opens a
// fresh channel.
//
// False positives are as bad as misses, so elapsed time is treated with
// suspicion: a tick that arrives much later than its interval (system sleep, a
// main-thread stall) says nothing about the renderer and only resets the
// countdown. DevTools being open may mean a paused breakpoint is holding the
// thread on purpose — that skip loses a real freeze but never a debugging
// session.
import { IPC_CHANNELS } from '../shared/ipc-channels'

/** Ping cadence. Cheap enough (one IPC round-trip) to keep the age tight. */
export const RENDERER_PING_INTERVAL_MS = 5_000
/** Silence longer than this = the renderer cannot reach main at all. */
export const RENDERER_ALIVE_TIMEOUT_MS = 30_000
/** A tick arriving later than interval + this means sleep/stall, not silence. */
export const RENDERER_CLOCK_JUMP_MS = 10_000

/** The slice of webContents the watchdog needs — typed structurally so tests
 *  hand it a stub instead of an Electron object (same DEPS style as
 *  gate-escape.ts). */
export interface RendererHealthTarget {
  isDestroyed(): boolean
  isDevToolsOpened(): boolean
  send(channel: string): void
}

export interface RendererHealthDeps {
  target: RendererHealthTarget
  /** The renderer has not answered for `idleMs`: kill it. Re-fired only after
   *  another full timeout, so a failed kill retries instead of going silent. */
  onWedged: (idleMs: number) => void
  /** A wedge was found but deliberate user state (open DevTools) forbids the
   *  kill. */
  onSkip?: (reason: string, idleMs: number) => void
  /** Clock/timer seam for tests. */
  now?: () => number
  setInterval?: (callback: () => void, ms: number) => ReturnType<typeof setInterval>
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void
}

export interface RendererHealth {
  /** The renderer proved it can reach main (pong / resume ack / finished
   *  load): restart the countdown. */
  markAlive(): void
  /** Start the ping loop; idempotent. Returns the disposer. */
  start(): () => void
}

export function createRendererHealth(deps: RendererHealthDeps): RendererHealth {
  const now = deps.now ?? Date.now
  const setIntervalFn = deps.setInterval ?? setInterval
  const clearIntervalFn = deps.clearInterval ?? clearInterval
  const { target, onWedged, onSkip } = deps

  let lastAliveAt = now()
  let lastTickAt = lastAliveAt
  let lastWedgeAt = Number.NEGATIVE_INFINITY
  let started = false
  let timer: ReturnType<typeof setInterval> | null = null

  const tick = (): void => {
    const at = now()
    const drift = at - lastTickAt - RENDERER_PING_INTERVAL_MS
    lastTickAt = at
    // Sleep / blocked main thread: the interval's own promise is broken, so
    // the age means nothing. Reset rather than reading it as renderer silence.
    if (drift > RENDERER_CLOCK_JUMP_MS) {
      lastAliveAt = at
      return
    }
    if (target.isDestroyed()) return
    const idle = at - lastAliveAt
    if (idle <= RENDERER_ALIVE_TIMEOUT_MS) {
      try {
        target.send(IPC_CHANNELS.APP_RENDERER_PING)
      } catch {
        // Channel already gone; the misses that follow will speak for it.
      }
      return
    }
    // Still unanswered. Kill at most once per timeout — a kill that somehow
    // did not land must be retried, not silently dropped.
    if (at - lastWedgeAt < RENDERER_ALIVE_TIMEOUT_MS) return
    if (target.isDevToolsOpened()) {
      lastAliveAt = at
      onSkip?.('devtools-open', idle)
      return
    }
    lastWedgeAt = at
    onWedged(idle)
  }

  const stop = (): void => {
    // Same falsy-handle caveat as start(): 0 is a legitimate stub handle, so
    // the null check — not truthiness — decides whether there is a timer to clear.
    if (timer !== null) clearIntervalFn(timer)
    timer = null
    started = false
  }

  return {
    markAlive(): void {
      lastAliveAt = now()
      lastWedgeAt = Number.NEGATIVE_INFINITY
    },
    start(): () => void {
      // A falsy timer handle is not proof of "not started" (stub timers hand
      // back 0), so the flag — not the handle — gates the second call.
      if (!started) {
        started = true
        timer = setIntervalFn(tick, RENDERER_PING_INTERVAL_MS)
      }
      return stop
    },
  }
}
