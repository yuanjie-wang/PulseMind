import { describe, it, expect } from 'vitest'
import { decideScheduleFire } from '../src/shared/schedule/schedule-decision'

const now = new Date('2026-09-11T10:00:00').getTime()
const dueTs = new Date('2026-09-11T09:59:00').toISOString()
const futureTs = new Date('2026-09-11T10:05:00').toISOString()
const base = { enabled: true, cron: '0 10 * * *' }
const opts = { tickMs: 30_000, hasRunningRun: false }

describe('decideScheduleFire', () => {
  it('disabled or missing cron never fires', () => {
    expect(decideScheduleFire({ ...base, enabled: false, nextRunAt: dueTs }, now, opts).reason).toBe('not-enabled')
    expect(decideScheduleFire({ ...base, cron: '', nextRunAt: dueTs }, now, opts).reason).toBe('not-enabled')
  })
  it('invalid cron does not fire', () => {
    expect(decideScheduleFire({ ...base, cron: 'nope', nextRunAt: dueTs }, now, opts).reason).toBe('invalid-cron')
  })
  it('not yet due does not fire but seeds nextRun for the first tick', () => {
    const d = decideScheduleFire({ ...base, nextRunAt: futureTs }, now, opts)
    expect(d.fire).toBe(false)
    expect(d.advanceTo).toBeUndefined()
    const firstTick = decideScheduleFire({ ...base }, now, opts)
    expect(firstTick.reason).toBe('not-due')
    expect(firstTick.advanceTo).toBeGreaterThan(now)
  })
  it('fires when due and advances', () => {
    const d = decideScheduleFire({ ...base, nextRunAt: dueTs }, now, opts)
    expect(d.fire).toBe(true)
    expect(d.advanceTo).toBeGreaterThan(now)
  })
  it('skips when the previous run is still running', () => {
    const d = decideScheduleFire({ ...base, nextRunAt: dueTs }, now, { ...opts, hasRunningRun: true })
    expect(d.fire).toBe(false)
    expect(d.reason).toBe('overlap')
    expect(d.advanceTo).toBeGreaterThan(now)
  })
  it('catchUp=once runs a missed fire', () => {
    const missedTs = new Date('2026-09-11T08:00:00').toISOString()
    const d = decideScheduleFire({ ...base, nextRunAt: missedTs, catchUp: 'once' }, now, opts)
    expect(d.fire).toBe(true)
  })
  it('catchUp=skip drops a missed fire to the next slot', () => {
    const missedTs = new Date('2026-09-11T08:00:00').toISOString()
    const d = decideScheduleFire({ ...base, nextRunAt: missedTs, catchUp: 'skip' }, now, opts)
    expect(d.fire).toBe(false)
    expect(d.reason).toBe('missed-skip')
    expect(d.advanceTo).toBeGreaterThan(now)
  })
})
