// ── Schedule fire decision (PLAN-0.4.0 M4.6) ──
// Pure decision core of the routine scheduler, extracted so vitest can cover
// catch-up / overlap-free arithmetic without a store. The scheduler supplies
// store facts (hasRunningRun) separately.

import { isDue, nextRun } from './cron'

export interface ScheduleDecision {
  fire: boolean
  /** New persisted next-run timestamp (epoch ms) after this tick. */
  advanceTo?: number
  reason?: 'not-enabled' | 'invalid-cron' | 'not-due' | 'overlap' | 'missed-skip' | 'fire'
}

export interface ScheduleInput {
  enabled: boolean
  cron: string
  nextRunAt?: string
  catchUp?: 'once' | 'skip'
}

export function decideScheduleFire(
  input: ScheduleInput,
  now: number,
  opts: { tickMs: number; hasRunningRun: boolean },
): ScheduleDecision {
  if (!input.enabled || !input.cron) return { fire: false, reason: 'not-enabled' }
  const next = nextRun(input.cron, now)
  if (next == null) return { fire: false, reason: 'invalid-cron' }
  if (!isDue(input.nextRunAt, now)) {
    return { fire: false, advanceTo: input.nextRunAt ? undefined : next, reason: 'not-due' }
  }
  if (opts.hasRunningRun) return { fire: false, advanceTo: next, reason: 'overlap' }

  const scheduledAt = input.nextRunAt ? Date.parse(input.nextRunAt) : now
  const missed = now - scheduledAt > opts.tickMs * 2
  if (missed && (input.catchUp ?? 'once') === 'skip') {
    return { fire: false, advanceTo: next, reason: 'missed-skip' }
  }
  return { fire: true, advanceTo: next, reason: 'fire' }
}
