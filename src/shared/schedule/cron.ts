// ── Cron wrapper (PLAN-0.4.0 M4 / D8) ──
// Thin, dependency-isolated façade over cron-parser v4 (CJS). All schedule
// math goes through here so tests can mock time and a future library swap
// touches one file. Times are LOCAL (cron fields are evaluated in the host's
// timezone; timezone support stays a passthrough option).

// cron-parser v4 ships CJS exports; named imports survive esbuild/vite interop.
import parser from 'cron-parser'

export interface CronCheck {
  valid: boolean
  error?: string
}

export function checkCron(expr: string): CronCheck {
  try {
    parser.parseExpression(expr)
    return { valid: true }
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Next fire strictly after `from` (epoch ms). null when the expression is invalid. */
export function nextRun(expr: string, from: number = Date.now()): number | null {
  try {
    const interval = parser.parseExpression(expr, { currentDate: new Date(from) })
    return interval.next().getTime()
  } catch {
    return null
  }
}

/** Whether a schedule with lastRun/nextRun is due at `now`. */
export function isDue(nextRunAt: string | undefined, now: number = Date.now()): boolean {
  if (!nextRunAt) return false
  const at = Date.parse(nextRunAt)
  if (!Number.isFinite(at)) return false
  return now >= at
}
