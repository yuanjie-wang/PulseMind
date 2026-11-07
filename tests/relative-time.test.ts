import { describe, expect, it } from 'vitest'
import { describeRelativeTime, bucketDayByDate, bucketRunByDate, describeSentAt, describeSentAtText, describeSentAtTitle } from '../src/renderer/src/utils/relative-time'

const NOW = Date.parse('2026-09-10T12:00:00')
const at = (offsetMs: number): string => new Date(NOW - offsetMs).toISOString()

describe('describeRelativeTime', () => {
  it('reads the first minute as just now', () => {
    expect(describeRelativeTime(at(0), NOW)?.unit).toBe('justNow')
    expect(describeRelativeTime(at(59_000), NOW)?.unit).toBe('justNow')
  })

  it('counts whole minutes, hours and days', () => {
    expect(describeRelativeTime(at(60_000), NOW)).toMatchObject({ unit: 'minute', value: 1 })
    expect(describeRelativeTime(at(59 * 60_000), NOW)).toMatchObject({ unit: 'minute', value: 59 })
    expect(describeRelativeTime(at(60 * 60_000), NOW)).toMatchObject({ unit: 'hour', value: 1 })
    expect(describeRelativeTime(at(23 * 3_600_000), NOW)).toMatchObject({ unit: 'hour', value: 23 })
    expect(describeRelativeTime(at(24 * 3_600_000), NOW)).toMatchObject({ unit: 'day', value: 1 })
    expect(describeRelativeTime(at(6 * 86_400_000), NOW)).toMatchObject({ unit: 'day', value: 6 })
  })

  it('falls back to the calendar date past a week', () => {
    const rel = describeRelativeTime('2026-08-12T09:30:00', NOW)
    expect(rel).toMatchObject({ unit: 'date', year: 2026, month: 8, day: 12 })
  })

  it('exposes a 1-based month for the date line', () => {
    expect(describeRelativeTime('2026-01-05T09:30:00', NOW)?.month).toBe(1)
  })

  it('treats future timestamps as just now rather than a negative duration', () => {
    expect(describeRelativeTime(at(-5 * 60_000), NOW)?.unit).toBe('justNow')
  })

  it('returns null for missing or unparsable timestamps', () => {
    expect(describeRelativeTime(undefined, NOW)).toBeNull()
    expect(describeRelativeTime(null, NOW)).toBeNull()
    expect(describeRelativeTime('', NOW)).toBeNull()
    expect(describeRelativeTime('not-a-date', NOW)).toBeNull()
  })

  it('accepts epoch millis and Date instances', () => {
    expect(describeRelativeTime(NOW - 2 * 3_600_000, NOW)).toMatchObject({ unit: 'hour', value: 2 })
    expect(describeRelativeTime(new Date(NOW - 3 * 60_000), NOW)).toMatchObject({ unit: 'minute', value: 3 })
  })
})

// ── The calendar-day buckets ──
// Fixtures are built from LOCAL Date constructors and only then converted to
// ISO, so the timestamp's local calendar day is fixed by construction and the
// assertions cannot flip with the machine running the suite (a plain UTC
// '2026-09-15T23:59:00Z' reads as Sep 16 in UTC+8 and would be TODAY there).
const DAY_NOW = new Date(2026, 8, 16, 12, 0).getTime() // Wed 2026-09-16, local noon
const localIso = (y: number, m: number, d: number, hh = 12, mm = 0): string =>
  new Date(y, m - 1, d, hh, mm, 0).toISOString()

describe('bucketDayByDate', () => {
  it('buckets by local calendar day, not by elapsed 24h', () => {
    // Same calendar day, both edges of it.
    expect(bucketDayByDate(localIso(2026, 9, 16, 0, 1), DAY_NOW)).toBe('today')
    expect(bucketDayByDate(localIso(2026, 9, 16, 11, 59), DAY_NOW)).toBe('today')
    // 23:59 yesterday is only 12h01m ago — an elapsed-24h reading calls it
    // today, and that is exactly the bug this must refuse.
    expect(bucketDayByDate(localIso(2026, 9, 15, 23, 59), DAY_NOW)).toBe('yesterday')
    // 00:01 yesterday is ~36h ago — still 昨天.
    expect(bucketDayByDate(localIso(2026, 9, 15, 0, 1), DAY_NOW)).toBe('yesterday')
  })

  it('crosses month and year boundaries by calendar arithmetic', () => {
    expect(bucketDayByDate(localIso(2026, 8, 31), new Date(2026, 8, 1, 12, 0).getTime())).toBe('yesterday')
    expect(bucketDayByDate(localIso(2025, 12, 31, 23), new Date(2026, 0, 1, 12, 0).getTime())).toBe('yesterday')
  })

  it('sends two days back and beyond to 更早', () => {
    expect(bucketDayByDate(localIso(2026, 9, 14), DAY_NOW)).toBe('earlier')
    expect(bucketDayByDate(localIso(2026, 8, 1), DAY_NOW)).toBe('earlier')
  })

  it('degrades to 更早 on missing or unparsable stamps, keeps a same-day clock skew in 今天', () => {
    expect(bucketDayByDate(undefined, DAY_NOW)).toBe('earlier')
    expect(bucketDayByDate('', DAY_NOW)).toBe('earlier')
    expect(bucketDayByDate('not-a-date', DAY_NOW)).toBe('earlier')
    // Future stamps read as clock skew (describeRelativeTime renders them 刚刚);
    // one later today is still the same calendar day.
    expect(bucketDayByDate(localIso(2026, 9, 16, 18), DAY_NOW)).toBe('today')
  })
})

describe('bucketRunByDate', () => {
  it('keeps its fourth 本周 bucket between 昨天 and 更早', () => {
    expect(bucketRunByDate(localIso(2026, 9, 14), DAY_NOW)).toBe('thisWeek') // Monday, 2 days back
    expect(bucketRunByDate(localIso(2026, 9, 13), DAY_NOW)).toBe('earlier') // the Sunday before, one day further
  })

  it('answers 昨天 before the week check — Sunday night is yesterday even on a Monday', () => {
    const monday = new Date(2026, 8, 21, 12, 0).getTime()
    expect(bucketRunByDate(localIso(2026, 9, 20, 23), monday)).toBe('yesterday')
    expect(bucketRunByDate(localIso(2026, 9, 19, 12), monday)).toBe('earlier')
  })
})

// ── The sent-at stamp under a user bubble (2026-11-06) ──
// Local-Date fixtures, same discipline as the buckets above: the wall clock and
// the calendar day asserted here are fixed by construction, so the suite cannot
// flip with the machine's timezone.
const stubTranslate = (path: string, values?: Record<string, string | number>): string =>
  `${path}(${Object.entries(values ?? {}).map(([k, v]) => `${k}=${v}`).join(' ')})`

describe('describeSentAt', () => {
  it('reads the LOCAL wall clock, zero-padded to HH:mm', () => {
    expect(describeSentAt(localIso(2026, 9, 16, 18, 2))).toMatchObject({
      clock: '18:02',
      year: 2026,
      month: 9,
      day: 16
    })
    expect(describeSentAt(localIso(2026, 1, 5, 9, 5))?.clock).toBe('09:05')
    expect(describeSentAt(localIso(2026, 1, 5, 0, 0))?.clock).toBe('00:00')
    expect(describeSentAt(localIso(2026, 1, 5, 23, 59))?.clock).toBe('23:59')
  })

  it('takes no clock of its own — the stamp is a pure function of the message', () => {
    // This is what keeps the render path lint-clean (react-hooks purity rejects
    // Date.now() during render) and free of a per-minute re-render: there is no
    // "now" argument to pass, so the answer cannot drift with the wall clock.
    const stamp = localIso(2026, 9, 16, 18, 2)
    expect(describeSentAt(stamp)).toEqual(describeSentAt(stamp))
    expect(describeSentAt(stamp)?.clock).toBe('18:02')
  })

  it('returns null for missing or unparsable timestamps', () => {
    expect(describeSentAt(undefined)).toBeNull()
    expect(describeSentAt(null)).toBeNull()
    expect(describeSentAt('')).toBeNull()
    expect(describeSentAt('not-a-date')).toBeNull()
  })

  it('accepts epoch millis and Date instances', () => {
    const noon = new Date(2026, 8, 16, 12, 0).getTime()
    expect(describeSentAt(noon)).toMatchObject({ clock: '12:00', day: 16 })
    expect(describeSentAt(new Date(noon))).toMatchObject({ clock: '12:00' })
  })
})

describe('describeSentAtText', () => {
  it('always prints the date with the clock — never a bare time', () => {
    expect(describeSentAtText(localIso(2026, 11, 6, 18, 2), stubTranslate)).toBe('chatView.sentAtDate(month=11 day=6 time=18:02)')
    // Today's own messages keep their date too: "18:02" on its own says nothing
    // once the same transcript is read tomorrow, which is the whole point of the
    // stamp. That is why there is no 今天 branch to drop it.
    expect(describeSentAtText(localIso(2026, 11, 6, 9, 5), stubTranslate)).toBe('chatView.sentAtDate(month=11 day=6 time=09:05)')
  })

  it('leaves the year to the tooltip so the inline stamp stays short', () => {
    const lastYear = localIso(2025, 12, 31, 23, 59)
    expect(describeSentAtText(lastYear, stubTranslate)).not.toContain('year=')
    expect(describeSentAtTitle(lastYear, stubTranslate)).toContain('year=2025')
  })

  it('returns null — not "NaN:NaN" — when the message carries no timestamp', () => {
    expect(describeSentAtText(undefined, stubTranslate)).toBeNull()
    expect(describeSentAtText('', stubTranslate)).toBeNull()
    expect(describeSentAtText('not-a-date', stubTranslate)).toBeNull()
  })
})

describe('describeSentAtTitle', () => {
  it('carries the full date plus the clock, so a scrolled-back stamp is unambiguous', () => {
    expect(describeSentAtTitle(localIso(2025, 12, 31, 23, 59), stubTranslate)).toBe(
      'chatView.sentAtDateWithYear(year=2025 month=12 day=31 time=23:59)'
    )
    expect(describeSentAtTitle(localIso(2026, 9, 16, 18, 2), stubTranslate)).toBe(
      'chatView.sentAtDateWithYear(year=2026 month=9 day=16 time=18:02)'
    )
  })

  it('returns null — not an empty tooltip — when the message carries no timestamp', () => {
    expect(describeSentAtTitle(undefined, stubTranslate)).toBeNull()
    expect(describeSentAtTitle('', stubTranslate)).toBeNull()
    expect(describeSentAtTitle('not-a-date', stubTranslate)).toBeNull()
  })
})
