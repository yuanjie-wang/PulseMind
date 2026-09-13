const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
/** Past this many days a duration reads worse than the date itself. */
const DAYS_BEFORE_ABSOLUTE_DATE = 7

export type RelativeTimeUnit = 'justNow' | 'minute' | 'hour' | 'day' | 'date'

export interface RelativeTime {
  unit: RelativeTimeUnit
  /** Elapsed whole minutes / hours / days; 0 for the other units. */
  value: number
  /** Local calendar date of the timestamp; 1-based month (January is 1). */
  year: number
  month: number
  day: number
}

/**
 * Describe `timestamp` as a duration elapsed up to `now` — the sidebar shows it under each
 * conversation title. Returns null when the timestamp is missing or unparsable, so callers
 * can leave the line out entirely. Timestamps in the future (clock skew) read as "just now".
 */
export function describeRelativeTime(timestamp: string | number | Date | null | undefined, now: number = Date.now()): RelativeTime | null {
  if (timestamp == null) return null
  const time = timestamp instanceof Date ? timestamp.getTime() : typeof timestamp === 'number' ? timestamp : Date.parse(timestamp)
  if (!Number.isFinite(time)) return null

  const at = new Date(time)
  const calendar = { year: at.getFullYear(), month: at.getMonth() + 1, day: at.getDate() }
  const elapsed = now - time

  if (elapsed < MINUTE_MS) return { unit: 'justNow', value: 0, ...calendar }
  if (elapsed < HOUR_MS) return { unit: 'minute', value: Math.floor(elapsed / MINUTE_MS), ...calendar }
  if (elapsed < DAY_MS) return { unit: 'hour', value: Math.floor(elapsed / HOUR_MS), ...calendar }
  if (elapsed < DAYS_BEFORE_ABSOLUTE_DATE * DAY_MS) return { unit: 'day', value: Math.floor(elapsed / DAY_MS), ...calendar }
  return { unit: 'date', value: 0, ...calendar }
}

/** Minimal structural type of the i18n translator, so this util stays decoupled
 *  from the React context. */
type Translate = (path: string, values?: Record<string, string | number>) => string

/** Localized text for describeRelativeTime — shared by the sidebar and the
 *  welcome page's recent list. Returns null when there is nothing to show. */
export function describeRelativeTimeText(timestamp: string | undefined, now: number, t: Translate): string | null {
  const relative = describeRelativeTime(timestamp, now)
  if (!relative) return null
  switch (relative.unit) {
    case 'justNow':
      return t('conversationSidebar.time.justNow')
    case 'minute':
      return t('conversationSidebar.time.minutesAgo', { count: relative.value })
    case 'hour':
      return t('conversationSidebar.time.hoursAgo', { count: relative.value })
    case 'day':
      return t('conversationSidebar.time.daysAgo', { count: relative.value })
    default:
      return relative.year === new Date(now).getFullYear()
        ? t('conversationSidebar.time.date', { month: relative.month, day: relative.day })
        : t('conversationSidebar.time.dateWithYear', { year: relative.year, month: relative.month, day: relative.day })
  }
}
