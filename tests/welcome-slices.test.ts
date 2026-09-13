import { describe, it, expect } from 'vitest'
import {
  isRunOverdue,
  pickLatestRun,
  pickNewestKnowledge,
  pickNextScheduledRoutine,
  pickResumeConversation,
} from '../src/renderer/src/utils/welcome-slices'

// The welcome cards pick one item out of each list and say something about it.
// Those picks are the whole content of the band, but two of their branches —
// what a populated knowledge base shows, and when a routine counts as overdue —
// cannot be reached from a UI check without writing into the user's own data.
// The ordering rules live here so a wrong pick (an empty conversation offered as
// "continue", an overdue run reported as merely scheduled) fails a test instead
// of shipping silently.

describe('pickResumeConversation', () => {
  const conv = (id: string, updatedAt: string, messageCount: number) => ({ id, title: `t-${id}`, updatedAt, messageCount })

  it('picks the most recently updated conversation', () => {
    const picked = pickResumeConversation([
      conv('a', '2026-09-13T10:00:00.000Z', 4),
      conv('b', '2026-09-13T12:00:00.000Z', 2),
      conv('c', '2026-09-12T23:00:00.000Z', 9),
    ])
    expect(picked?.id).toBe('b')
  })

  it('skips conversations that hold no messages', () => {
    // The sidebar list includes freshly created, still-empty conversations; one
    // of those must never become the card's headline.
    const picked = pickResumeConversation([
      conv('empty-newest', '2026-09-13T13:00:00.000Z', 0),
      conv('real', '2026-09-13T09:00:00.000Z', 3),
    ])
    expect(picked?.id).toBe('real')
  })

  it('returns null when every conversation is empty', () => {
    expect(pickResumeConversation([conv('a', '2026-09-13T10:00:00.000Z', 0)])).toBeNull()
    expect(pickResumeConversation([])).toBeNull()
  })

  it('tolerates a missing updatedAt instead of throwing', () => {
    const picked = pickResumeConversation([
      { id: 'no-stamp', title: 'x', messageCount: 2 },
      { id: 'stamped', title: 'y', messageCount: 1, updatedAt: '2026-09-13T10:00:00.000Z' },
    ])
    expect(picked?.id).toBe('stamped')
  })
})

describe('pickLatestRun', () => {
  it('picks the most recently started run', () => {
    const picked = pickLatestRun([
      { routineId: 'r1', startedAt: '2026-09-13T08:00:00.000Z', status: 'success' as const },
      { routineId: 'r2', startedAt: '2026-09-13T11:30:00.000Z', status: 'failed' as const },
      { routineId: 'r1', startedAt: '2026-09-12T08:00:00.000Z', status: 'skipped' as const },
    ])
    expect(picked?.routineId).toBe('r2')
    expect(picked?.status).toBe('failed')
  })

  it('returns null with no runs, so the card falls back to the schedule', () => {
    expect(pickLatestRun([])).toBeNull()
  })
})

describe('pickNextScheduledRoutine', () => {
  const routine = (id: string, enabled: boolean, nextRunAt?: string, schedule = true) => ({
    id, name: id, enabled, nextRunAt, schedule: schedule ? { cron: '0 9 * * *' } : undefined,
  })

  it('picks the soonest upcoming run', () => {
    const picked = pickNextScheduledRoutine([
      routine('later', true, '2026-09-14T01:00:00.000Z'),
      routine('sooner', true, '2026-09-13T23:00:00.000Z'),
    ])
    expect(picked?.id).toBe('sooner')
  })

  it('ignores disabled routines and ones without a schedule', () => {
    const picked = pickNextScheduledRoutine([
      routine('disabled', false, '2026-09-13T20:00:00.000Z'),
      routine('unscheduled', true, '2026-09-13T21:00:00.000Z', false),
      routine('real', true, '2026-09-13T22:00:00.000Z'),
    ])
    expect(picked?.id).toBe('real')
  })

  it('ranks a routine with no nextRunAt last rather than first', () => {
    const picked = pickNextScheduledRoutine([
      routine('never-run', true, undefined),
      routine('scheduled', true, '2026-09-14T09:00:00.000Z'),
    ])
    expect(picked?.id).toBe('scheduled')
  })

  it('returns null when nothing is scheduled', () => {
    expect(pickNextScheduledRoutine([routine('off', false), routine('plain', true, undefined, false)])).toBeNull()
    expect(pickNextScheduledRoutine([])).toBeNull()
  })
})

describe('isRunOverdue', () => {
  const now = Date.parse('2026-09-13T12:00:00.000Z')

  it('is true only once the scheduled time has passed', () => {
    expect(isRunOverdue('2026-09-13T11:59:00.000Z', now)).toBe(true)
    expect(isRunOverdue('2026-09-13T12:00:00.000Z', now)).toBe(true)
    expect(isRunOverdue('2026-09-13T12:01:00.000Z', now)).toBe(false)
  })

  it('is false for a missing or unparsable stamp', () => {
    expect(isRunOverdue(undefined, now)).toBe(false)
    expect(isRunOverdue('not a date', now)).toBe(false)
  })
})

describe('pickNewestKnowledge', () => {
  it('picks the most recently added material', () => {
    const picked = pickNewestKnowledge([
      { id: 'old', createdAt: '2026-09-01T00:00:00.000Z' },
      { id: 'new', createdAt: '2026-09-13T07:00:00.000Z' },
    ])
    expect(picked?.id).toBe('new')
  })

  it('returns null so the card can show its import guidance', () => {
    expect(pickNewestKnowledge([])).toBeNull()
  })
})
