// ── main.log sink for modules outside the entry ─────────────────────────
// index.ts owns the canonical writeLog but lives in the entry bundle; modules
// elsewhere append here with the SAME line format — `[ISO] [LEVEL] <source>:
// <message>` — so ~/.pulsemind/logs/main.log stays one coherent record. The
// first consumer was preview serving (2026-10-29 白屏排查, logServe in
// serve-preview.ts). Hooks joined 2026-11-05: their failures were
// console-only, and a packaged GUI launch (Linux .deb / Windows portable)
// never shows a console — on the UOS deployment a crashed hook and a working
// hook were indistinguishable from the log's "launch hooks completed" line.
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function logMain(level: 'INFO' | 'WARN' | 'ERROR', source: string, message: string): void {
  // vitest drives these modules from plain Node — the unit tests must not
  // write into the developer's real main.log (logServe's guard, verbatim).
  if (!process.versions.electron) return
  try {
    const dir = join(homedir(), '.pulsemind', 'logs')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'main.log'), `[${new Date().toISOString()}] [${level}] ${source}: ${message}\n`)
  } catch {
    // Logging must never take the app down.
  }
}

/** Render a thrown value for a log line: stack when there is one, message
 *  otherwise, String() for non-errors. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.stack || err.message
  return String(err)
}
