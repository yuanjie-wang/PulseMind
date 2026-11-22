import { describe, expect, it } from 'vitest'
import {
  CAL_MAX,
  CAL_MIN,
  parseCalibrationLine,
  quantile,
  summarizeCalibration,
} from '../scripts/probe-context-calibration.mjs'

/** The two on-disk shapes the audit must read: the renderer console line and
 *  the logMain line (main-log.ts:21 puts `source: message` after the ISO tag). */
const CONSOLE_LINE =
  '[ContextCalibration] raw=100000 wire=117000 want=1.1700 applied=1.1700 clamp=no b=168000 model=gpt-4o conv=conv_a'
const LOGMAIN_LINE =
  '[2026-11-22T02:38:41.046Z] [INFO] ContextCalibration: raw=50000 wire=200000 want=4.0000 applied=2.5000 clamp=hit b=168000 model=deepseek-chat conv=conv_b'

describe('parseCalibrationLine', () => {
  it('reads the renderer console shape', () => {
    expect(parseCalibrationLine(CONSOLE_LINE)).toMatchObject({
      raw: 100000,
      wire: 117000,
      want: 1.17,
      applied: 1.17,
      clamp: 'no',
      b: 168000,
      model: 'gpt-4o',
      conv: 'conv_a',
    })
  })

  it('reads the logMain shape with ISO/INFO prefix and source colon', () => {
    expect(parseCalibrationLine(LOGMAIN_LINE)).toMatchObject({
      raw: 50000,
      wire: 200000,
      want: 4,
      applied: CAL_MAX,
      clamp: 'hit',
      model: 'deepseek-chat',
      conv: 'conv_b',
    })
  })

  it('ignores unrelated lines and malformed records', () => {
    expect(parseCalibrationLine('[INFO] preview-nav start frame=main')).toBeNull()
    expect(parseCalibrationLine('[ContextCalibration] raw=0 wire=100 want=0')).toBeNull()
    expect(parseCalibrationLine('[ContextCalibration] raw=abc wire=100')).toBeNull()
    expect(parseCalibrationLine(null)).toBeNull()
  })

  it('derives want/applied/clamp when an older line omits them', () => {
    const rec = parseCalibrationLine('[ContextCalibration] raw=100 wire=50')
    expect(rec).toMatchObject({ want: 0.5, applied: 0.5, clamp: 'no' })
  })

  it('recomputes clamp=hit from the delta when the tag is missing', () => {
    const rec = parseCalibrationLine('[ContextCalibration] raw=100 wire=1000 want=10 applied=2.5')
    expect(rec?.clamp).toBe('hit')
  })
})

describe('quantile', () => {
  it('uses nearest-rank over a sorted sample', () => {
    const a = [1, 2, 3, 4, 5]
    expect(quantile(a, 0.5)).toBe(3)
    expect(quantile(a, 0.75)).toBe(4)
    expect(quantile(a, 1)).toBe(5)
    expect(quantile([], 0.5)).toBeNull()
  })
})

describe('summarizeCalibration', () => {
  it('reports zero state for an empty sample', () => {
    expect(summarizeCalibration([])).toMatchObject({ count: 0, conversations: 0, models: {} })
  })

  it('keeps the two clamp directions distinct — low is over-compaction, high is under-report', () => {
    // raw=500 wire=100 → want=0.2 (floor, raw over-reads 5×) → price=100 vs wire=100: boundary
    const floor = parseCalibrationLine('[ContextCalibration] raw=600 wire=100 want=0.1667 applied=0.2 clamp=hit model=m1 conv=c1')
    // raw=100 wire=500 → want=5 → applied=2.5 → price=250 < 0.95×500: under-report
    const ceiling = parseCalibrationLine('[ContextCalibration] raw=100 wire=500 want=5 applied=2.5 clamp=hit model=m2 conv=c2')
    const s = summarizeCalibration([floor!, ceiling!])
    expect(s.clamp).toMatchObject({ low: 1, high: 1, hit: 2 })
    expect(s.underreport).toBe(1)
    // raw/wire=6 on the floor record is past 1/CAL_MIN=5, so clamp to 0.2
    // still leaves price at 1.2×wire — the floor is not an infinite guard.
    expect(s.overreport).toBe(1)
    expect(s.conversations).toBe(2)
    expect(s.models).toEqual({ m1: 1, m2: 1 })
  })

  it('counts convergence inside [1/MAX, 1/MIN] and flags over-report past 1.05×wire', () => {
    // raw/wire = 1.0 → inside, price = wire exactly
    const inside = parseCalibrationLine('[ContextCalibration] raw=100 wire=100 want=1 applied=1 clamp=no model=m conv=c')
    // raw/wire = 6 → outside (past 1/MIN=5), applied=0.2 → price=120 > 1.05×20
    const outside = parseCalibrationLine('[ContextCalibration] raw=120 wire=20 want=0.1667 applied=0.2 clamp=hit model=m conv=c')
    const s = summarizeCalibration([inside!, outside!])
    expect(s.convergent).toMatchObject({ lo: 1 / CAL_MAX, hi: 1 / CAL_MIN, inside: 1, rate: 0.5 })
    expect(s.underreport).toBe(0)
    expect(s.overreport).toBe(1)
  })

  it('computes raw/wire percentiles; price/wire converges to 1 when applied = wire/raw', () => {
    const recs = [1, 2, 3].map((n) =>
      parseCalibrationLine(`[ContextCalibration] raw=${n * 100} wire=100 want=${100 / (n * 100)} applied=${100 / (n * 100)} clamp=no`),
    )
    const s = summarizeCalibration(recs as NonNullable<ReturnType<typeof parseCalibrationLine>>[])
    expect(s.rawWire.p50).toBe(2)
    expect(s.rawWire.mean).toBe(2)
    // applied = wire/raw is exactly the convergence condition — every shipped
    // price lands on the measured wire, so price/wire is 1 across the sample.
    expect(s.priceWire.p50).toBe(1)
    expect(s.priceWire.max).toBe(1)
    expect(s.underreport).toBe(0)
    expect(s.overreport).toBe(0)
  })
})
