import { describe, expect, it } from 'vitest'
import { describeRelativeTime } from '../src/renderer/src/utils/relative-time'

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
