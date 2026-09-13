// ── Welcome page slice selectors ──
// Pure "which one do I show" decisions for the welcome cards — the newest
// conversation worth resuming, the last routine run, the next scheduled
// routine, the newest knowledge material. Kept out of the components so the
// ordering rules (and their tie-breaks) are testable without a DOM.

/** Fields the resume pick reads; the caller keeps its richer record. */
export interface ResumeCandidate {
  id: string
  title: string
  updatedAt?: string
  messageCount: number
}

/**
 * The conversation to offer as "continue": most recently updated, skipping
 * empty ones — a conversation with no messages has nothing to resume into.
 */
export function pickResumeConversation<T extends ResumeCandidate>(list: T[]): T | null {
  const eligible = list.filter((c) => c.messageCount > 0)
  if (eligible.length === 0) return null
  return eligible.reduce((best, cur) => ((cur.updatedAt || '') > (best.updatedAt || '') ? cur : best))
}

/** The most recent run by start time; ties keep the earlier entry in the list. */
export function pickLatestRun<T extends { startedAt?: string }>(runs: T[]): T | null {
  if (runs.length === 0) return null
  return runs.reduce((best, cur) => ((cur.startedAt || '') > (best.startedAt || '') ? cur : best))
}

/** Sorts a missing `nextRunAt` last, so a never-yet-scheduled routine loses. */
const NO_NEXT_RUN = '9999'

/**
 * The routine whose next run comes soonest, among enabled ones that have a
 * schedule. Returns null when nothing is actually scheduled.
 */
export function pickNextScheduledRoutine<T extends { enabled: boolean; schedule?: unknown; nextRunAt?: string }>(routines: T[]): T | null {
  const scheduled = routines.filter((r) => r.enabled && r.schedule)
  if (scheduled.length === 0) return null
  return scheduled.reduce((best, cur) =>
    (cur.nextRunAt ?? NO_NEXT_RUN) < (best.nextRunAt ?? NO_NEXT_RUN) ? cur : best)
}

/** A scheduled routine whose time has passed — the scheduler has not caught up yet. */
export function isRunOverdue(nextRunAt: string | undefined, now: number): boolean {
  if (!nextRunAt) return false
  const at = Date.parse(nextRunAt)
  return Number.isFinite(at) && at <= now
}

/** The material most recently added to the knowledge base. */
export function pickNewestKnowledge<T extends { createdAt?: string }>(files: T[]): T | null {
  if (files.length === 0) return null
  return files.reduce((best, cur) => ((cur.createdAt || '') > (best.createdAt || '') ? cur : best))
}
