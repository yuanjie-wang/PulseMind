const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
/** Past this many days a duration reads worse than the date itself. */
const DAYS_BEFORE_ABSOLUTE_DATE = 7

/** Interval for the `now` these stamps render against. Relative times only move
 *  at minute granularity, so that is the cheapest honest clock — every ticking
 *  caller (sidebar rows, welcome band, welcome project cards) shares it. */
export const CLOCK_TICK_MS = 60_000

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

/** Calendar bucket for a timestamp, relative to `now`. The routines sidebar
 *  groups recent runs into 今天 / 昨天 / 本周 / 更早 — a pure function so the
 *  render path never calls Date.now() directly (the component passes its
 *  fetchedAt clock, same contract as describeRelativeTimeText). */
export type DateBucket = 'today' | 'yesterday' | 'thisWeek' | 'earlier'

export function bucketRunByDate(timestamp: string | number | Date | null | undefined, now: number = Date.now()): DateBucket {
  const rel = describeRelativeTime(timestamp, now)
  if (!rel) return 'earlier'
  const nowDate = new Date(now)
  const nowYear = nowDate.getFullYear()
  const nowMonth = nowDate.getMonth() + 1
  const nowDay = nowDate.getDate()
  // Compute calendar-day ordinal for both dates (ordinal date within the year).
  const ordinal = (y: number, m: number, d: number): number => {
    // Days before the start of month `m` in a non-leap year, plus leap day if applicable.
    const cum = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334]
    let ord = cum[m - 1] + d
    if (m > 2 && ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0)) ord += 1
    return ord
  }
  // Day count across years — cheap full-day delta.
  const dayOrdinal = (y: number, m: number, d: number): number =>
    y * 365 + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) + ordinal(y, m, d)
  const nowOrd = dayOrdinal(nowYear, nowMonth, nowDay)
  const runOrd = dayOrdinal(rel.year, rel.month, rel.day)
  // Same calendar day.
  if (runOrd === nowOrd) return 'today'
  if (nowOrd - runOrd === 1) return 'yesterday'
  // Same ISO week (Monday-based) and within the current week.
  // getDay: 0=Sun..6=Sat. ISO week starts Monday → shift so Monday=0.
  const isoWeekday = (d: Date): number => (d.getDay() + 6) % 7
  const nowWeekStart = nowOrd - isoWeekday(nowDate)
  if (runOrd >= nowWeekStart && runOrd <= nowWeekStart + 6) return 'thisWeek'
  return 'earlier'
}

/** The conversation sidebar's three buckets (今天 / 昨天 / 更早) — the same
 *  calendar-day arithmetic as bucketRunByDate with 本周 folded into 更早.
 *  Calendar-day, not elapsed-24h: yesterday 23:59 stays 昨天 even when it is
 *  only minutes behind us, and a 今天 00:01 stops being 今天 the moment the
 *  clock crosses midnight. */
export type DayBucket = 'today' | 'yesterday' | 'earlier'

export function bucketDayByDate(timestamp: string | number | Date | null | undefined, now: number = Date.now()): DayBucket {
  const bucket = bucketRunByDate(timestamp, now)
  return bucket === 'thisWeek' ? 'earlier' : bucket
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

// ── Chat bubble sent-at stamp ───────────────────────────────────────────
// The hover toolbar under a user bubble carries the send time (2026-11-06) as
// the LOCAL calendar date plus the clock — "11月6日 18:02". The date shows on
// every message, not only on older ones: a transcript is read days after the
// fact, and a bare clock only answers "when" for the few bubbles sent in the
// last hours. Deciding "today → drop the date", or "same year → drop the year",
// needs a "now" — and a now in this render path is either forbidden (react-hooks
// purity: "Cannot call impure function during render" rejects Date.now()) or
// bought with a clock threaded down from ChatView, which would invalidate the
// memo of every MessageGroup on every tick and re-render the whole transcript
// once a minute for a fact that changes once a day. So the stamp stays a pure
// function of the message, and the year — the one part only a clock could prove
// redundant — rides on describeSentAtTitle, one hover away.

export interface SentAt {
  /** Zero-padded local wall clock, "18:02" — the clock the user sent at. */
  clock: string
  /** Local calendar date; month is 1-based, as in RelativeTime. */
  year: number
  month: number
  day: number
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/**
 * The parts of a sent-at stamp — a pure function of the message, so the render
 * path needs no clock and nothing re-renders when the minute rolls over.
 * Returns null for a missing or unparsable timestamp, so the caller leaves the
 * slot empty instead of printing "NaN:NaN" — conversations persisted before the
 * field existed carry none.
 */
export function describeSentAt(timestamp: string | number | Date | null | undefined): SentAt | null {
  if (timestamp == null) return null
  const time = timestamp instanceof Date ? timestamp.getTime() : typeof timestamp === 'number' ? timestamp : Date.parse(timestamp)
  if (!Number.isFinite(time)) return null

  const at = new Date(time)
  return {
    clock: `${pad2(at.getHours())}:${pad2(at.getMinutes())}`,
    year: at.getFullYear(),
    month: at.getMonth() + 1,
    day: at.getDate()
  }
}

/**
 * The stamp text shown in the toolbar — local date plus clock, "11月6日 18:02"
 * (en: "11/6 18:02"). 24h numeric in both locales, like every other time of day
 * written in the app. null when the message carries no timestamp.
 */
export function describeSentAtText(
  timestamp: string | number | Date | null | undefined,
  t: Translate
): string | null {
  const sent = describeSentAt(timestamp)
  if (!sent) return null
  return t('chatView.sentAtDate', { month: sent.month, day: sent.day, time: sent.clock })
}

/**
 * Tooltip text for the stamp — the full local date WITH the year plus the clock,
 * so a transcript spanning a new year stays unambiguous even though the inline
 * stamp omits the year. null when the message carries no timestamp.
 */
export function describeSentAtTitle(
  timestamp: string | number | Date | null | undefined,
  t: Translate
): string | null {
  const sent = describeSentAt(timestamp)
  if (!sent) return null
  return t('chatView.sentAtDateWithYear', { year: sent.year, month: sent.month, day: sent.day, time: sent.clock })
}
