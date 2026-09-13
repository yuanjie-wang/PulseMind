// ── Cron display text ──
// Human-facing text for a routine's cron schedule. Shared by the routine
// center and the welcome page's daily-routine card.
import { checkCron, nextRun } from '../../../shared/schedule/cron'

/** null = no schedule (on-demand routine); invalid expressions surface as-is
 *  so the user sees what to fix; valid ones read as the next fire time. */
export function describeCron(cron: string): string | null {
  if (!cron) return null
  const check = checkCron(cron)
  if (!check.valid) return `无效表达式：${cron}`
  const next = nextRun(cron)
  return next ? new Date(next).toLocaleString() : cron
}
