import { describe, expect, it } from 'vitest'
import { planIncrementalSave, INCREMENTAL_TAIL_RESAVE } from '../src/renderer/src/utils/incremental-save'

function ids(n: number): Array<{ id: string }> {
  return Array.from({ length: n }, (_, i) => ({ id: `m${i}` }))
}

describe('planIncrementalSave', () => {
  it('first save (no saved set) appends everything from index 0', () => {
    expect(planIncrementalSave(ids(30), undefined)).toEqual({ mode: 'append', fromIdx: 0, hasNew: true })
  })

  it('all messages already saved: re-save only the tail, no new message ids', () => {
    const saved = new Set(ids(30).map(m => m.id))
    const plan = planIncrementalSave(ids(30), saved)
    expect(plan).toEqual({ mode: 'append', fromIdx: 30 - INCREMENTAL_TAIL_RESAVE, hasNew: false })
  })

  it('new messages arrive: start before the first new one by the tail width', () => {
    const saved = new Set(ids(28).map(m => m.id)) // m0..m27 persisted
    const plan = planIncrementalSave(ids(30), saved) // m28, m29 arrived
    expect(plan).toEqual({ mode: 'append', fromIdx: 28 - INCREMENTAL_TAIL_RESAVE, hasNew: true })
  })

  it('history shrank below the persisted set: fall back to a full save', () => {
    const saved = new Set(ids(30).map(m => m.id))
    expect(planIncrementalSave(ids(10), saved)).toEqual({ mode: 'full' })
  })

  it('short conversations never produce a negative fromIdx', () => {
    const saved = new Set(ids(3).map(m => m.id))
    const plan = planIncrementalSave(ids(3), saved)
    expect(plan).toEqual({ mode: 'append', fromIdx: 0, hasNew: false })
  })

  it('honours a custom tail width', () => {
    const saved = new Set(ids(10).map(m => m.id))
    expect(planIncrementalSave(ids(10), saved, 3)).toEqual({ mode: 'append', fromIdx: 7, hasNew: false })
  })
})
