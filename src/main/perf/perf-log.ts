// Gated main-thread timing (PLAN-long-task-perf M0-T2). One call site each in
// `emitMessages` (the every-notify full-history diff) and `saveConversation`
// (the synchronous SQLite write) — the two suspects the plan named B1/B6 — so
// a real long task prints its own cost curve to the console.
//
// The gate follows request-dump's shape (on in dev, opt-in in a packaged build
// via `debugPerfLogs` in settings.json), with one twist the test/probe
// environments force: `electron`'s named `app` export does not exist outside a
// real Electron main process (vitest aliases a stub whose app is not the real
// one; ELECTRON_RUN_AS_NODE gets a path string), so "dev" there is decided by
// `PM_PERF=1` instead of `app.isPackaged`. All three exits live at the top of
// perfTime — the packaged branch must be a SIBLING of the dev check, not a
// step after it: the 2026-09-21 review caught an earlier shape whose first
// line early-returned on `!realElectronDev()`, which made the packaged branch
// unreachable and `debugPerfLogs` dead in every packaged build (a broken gate
// looks exactly like the flag is off). The setting is never awaited on the hot
// path: refreshPackagedGate reads it in the background (one read / 5s) and the
// packaged branch consults only the cache, so a cold cache stays silent for
// that one call and every later call honours the flag. Off stays zero-cost: a
// few booleans. Truth table pinned by tests/perf-log-gate.test.ts.
import { app } from 'electron'
import { settingsStore } from '../storage/settings-store'

/** Cached packaged-mode gate; null until the first background refresh lands. */
let cachedPackaged: boolean | null = null
let lastCheck = 0

function realElectronDev(): boolean {
  try {
    return typeof (app as { isPackaged?: boolean } | undefined)?.isPackaged === 'boolean' && app.isPackaged === false
  } catch {
    return false
  }
}

/** True only in a real packaged Electron main process; the optional chain
 *  keeps the path-string/undefined `app` of non-Electron runtimes (vitest,
 *  ELECTRON_RUN_AS_NODE) from throwing. */
function packagedBuild(): boolean {
  try {
    return (app as { isPackaged?: boolean } | undefined)?.isPackaged === true
  } catch {
    return false
  }
}

function refreshPackagedGate(): void {
  const now = Date.now()
  if (now - lastCheck < 5000) return
  lastCheck = now
  void settingsStore
    .get()
    .then((s) => { cachedPackaged = s.debugPerfLogs === true })
    .catch(() => { cachedPackaged = false })
}

function timed<T>(label: string, fn: () => T): T {
  const t0 = performance.now()
  try {
    return fn()
  } finally {
    console.log(`[perf] ${label} ${(performance.now() - t0).toFixed(1)}ms`)
  }
}

/** Time `fn` and print `[perf] <label> <ms>ms` when the gate is on. Sync on
 *  purpose — the whole point is the length of a synchronous main-process
 *  stretch, which an async wrapper would hide from itself. */
export function perfTime<T>(label: string, fn: () => T): T {
  if (process.env.PM_PERF === '1' || realElectronDev()) return timed(label, fn)
  if (!packagedBuild()) return fn()
  if (cachedPackaged !== true) {
    refreshPackagedGate()
    return fn()
  }
  return timed(label, fn)
}
