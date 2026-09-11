import { describe, it, expect } from 'vitest'
import { checkCron, nextRun, isDue } from '../src/shared/schedule/cron'

describe('checkCron', () => {
  it('accepts valid 5-field expressions', () => {
    expect(checkCron('0 9 * * 1-5').valid).toBe(true)
    expect(checkCron('*/30 * * * *').valid).toBe(true)
    expect(checkCron('0 0 1 * *').valid).toBe(true)
  })
  it('rejects garbage', () => {
    expect(checkCron('not a cron').valid).toBe(false)
    expect(checkCron('99 99 * * *').valid).toBe(false)
  })
})

describe('nextRun', () => {
  const mondayNoon = new Date('2026-09-14T12:00:00').getTime() // a Monday
  it('computes the next weekday 9am run', () => {
    const next = nextRun('0 9 * * 1-5', mondayNoon)
    const d = new Date(next!)
    expect(d.getDay()).toBe(2) // Tuesday
    expect(d.getHours()).toBe(9)
  })
  it('rolls across month ends', () => {
    const endOfMonth = new Date('2026-09-30T10:00:00').getTime()
    const next = nextRun('0 0 1 * *', endOfMonth)
    expect(new Date(next!).getMonth()).toBe(9) // October
    expect(new Date(next!).getDate()).toBe(1)
  })
  it('returns null for invalid expressions', () => {
    expect(nextRun('bogus', Date.now())).toBeNull()
  })
  it('is strictly in the future', () => {
    const t = new Date('2026-09-11T09:00:00').getTime()
    const next = nextRun('0 9 * * *', t)
    expect(next!).toBeGreaterThan(t)
  })
})

describe('isDue', () => {
  it('is false without a persisted next-run', () => {
    expect(isDue(undefined)).toBe(false)
  })
  it('is true once now passes the timestamp', () => {
    expect(isDue(new Date(Date.now() - 1000).toISOString())).toBe(true)
    expect(isDue(new Date(Date.now() + 60_000).toISOString())).toBe(false)
  })
})
