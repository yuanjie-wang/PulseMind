import { describe, expect, it } from 'vitest'
import { planIncrementalSave, INCREMENTAL_TAIL_RESAVE, sweepKeyOf, sweepKeysMatch } from '../src/renderer/src/utils/incremental-save'

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

// M2 (review 2026-09-18): the 10s sweep must not pay a whole-session deep
// clone for a conversation nothing mutated. The gate is reference equality
// on the engine's messages array (every engine/mirror mutation replaces it)
// plus the summary pair.
describe('sweep gate (sweepKeyOf / sweepKeysMatch)', () => {
  const engine = (msgs: unknown[], text?: string, firstKeptId?: string) => ({
    messages: msgs,
    getHistorySummary: () => (text === undefined ? null : { text, firstKeptId }),
  })

  it('the same untouched engine matches its recorded key — capture skipped', () => {
    const e = engine([{ id: 'a' }], 'summary', 'm0')
    const key = sweepKeyOf(e)
    expect(sweepKeysMatch(key, sweepKeyOf(e))).toBe(true)
  })

  it('any mutation (new array reference) opens the gate — capture runs', () => {
    const e = engine([{ id: 'a' }])
    const key = sweepKeyOf(e)
    // exists on arrays; the engine replaces the whole array
    expect(typeof e.messages.push).toBe('function')
    const mutated = engine([{ id: 'a' }, { id: 'b' }])
    expect(sweepKeysMatch(key, sweepKeyOf(mutated))).toBe(false)
  })

  it('a reference-equal array with a changed summary pair opens the gate', () => {
    const shared = [{ id: 'a' }]
    const e = engine(shared, 'old summary')
    const key = sweepKeyOf(e)
    const changed = engine(shared, 'new summary')
    expect(sweepKeysMatch(key, sweepKeyOf(changed))).toBe(false)
    const changedFrontier = engine(shared, 'old summary', 'm1')
    expect(sweepKeysMatch(key, sweepKeyOf(changedFrontier))).toBe(false)
  })

  it('an absent previous key never matches (first tick always checks)', () => {
    const key = sweepKeyOf(engine([{ id: 'a' }]))
    expect(sweepKeysMatch(undefined, key)).toBe(false)
  })

  it('an undefined summary normalizes to null so two summary-less reads match', () => {
    const shared = [{ id: 'a' }]
    const key = sweepKeyOf(engine(shared))
    const again = engine(shared)
    expect(key.summary).toBeNull()
    expect(sweepKeysMatch(key, sweepKeyOf(again))).toBe(true)
  })
})
