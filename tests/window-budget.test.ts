import { describe, expect, it } from 'vitest'
import { DEFAULT_OUTPUT_RESERVE, effectiveInputWindow } from '../src/renderer/src/agent/engine/window-budget'

/**
 * The numbers below are the ones that were WRONG before this module existed:
 * every compaction gate divided by `opts.contextLength`, the provider's total
 * window, while the request built on that decision also asked for `max_tokens`
 * of output. A gate that fires at 0.9 × total therefore arms a request that
 * cannot fit. Each assertion pairs a trigger point with the ceiling it must stay
 * under, so a future change to the reserve fails here rather than in a 400.
 *
 * The reserve EQUALS the ask on purpose. An earlier revision capped it at 21K
 * (copied from ZCode) and the 65_536 case below caught the flaw: reserving 21K
 * while asking for 32K under-reserves by 11K, so the "safe" gate armed a
 * 72_082-token request against a 65_536 window. A cap is only sound alongside a
 * wire-level max_tokens clamp, which this engine does not have.
 */
describe('effectiveInputWindow', () => {
  it('reserves the full output ask out of the total window', () => {
    expect(effectiveInputWindow(200_000, 32_000)).toBe(168_000)
  })

  it('arms the 200K request below its ceiling', () => {
    const input = effectiveInputWindow(200_000, 32_000)
    // hard's passive trigger is 0.9× the denominator. Under the old denominator
    // that meant 180K of input + 32K of output = 212K against a 200K window.
    expect(input * 0.9).toBeCloseTo(151_200, 4)
    expect(input * 0.9 + 32_000).toBeLessThanOrEqual(200_000)
  })

  it('keeps a small provider-reported window solvable', () => {
    // stream-runner re-aims contextLength down to what the provider reports
    // (65_536 is a real value from the 400-oscillation loop). Reserving only
    // the 21K cap here — while still asking 32K — armed 72_082 tokens against
    // this window, i.e. the very loop the re-aim exists to close.
    const input = effectiveInputWindow(65_536, 32_000)
    expect(input).toBe(33_536)
    expect(input * 0.9 + 32_000).toBeLessThanOrEqual(65_536)
  })

  it('honours an output ask smaller than the default', () => {
    // The reservation tracks the real ask in both directions — it is not a
    // fixed 21K subtraction.
    expect(effectiveInputWindow(200_000, 4_000)).toBe(196_000)
  })

  it('reserves whatever a large ask demands', () => {
    // A 64K output limit genuinely needs 64K of headroom; capping it at 21K
    // would under-reserve by 43K.
    expect(effectiveInputWindow(200_000, 64_000)).toBe(136_000)
  })

  it('falls back to the default reserve when the ask is unknown', () => {
    const expected = 200_000 - DEFAULT_OUTPUT_RESERVE
    expect(DEFAULT_OUTPUT_RESERVE).toBe(32_000)
    expect(effectiveInputWindow(200_000)).toBe(expected)
    // 0 and NaN both mean "the caller cannot say", never "reserve nothing".
    expect(effectiveInputWindow(200_000, 0)).toBe(expected)
    expect(effectiveInputWindow(200_000, Number.NaN)).toBe(expected)
    expect(effectiveInputWindow(200_000, -1)).toBe(expected)
  })

  it('never lets the reserve eat more than half the window', () => {
    // A 1000-token window with a 1024 ask: reserving the full ask would leave a
    // 0 budget, and every gate divides by it (`tokens < 0 * ratio` is never
    // true, so a post-turn prewarm would fire every single round).
    expect(effectiveInputWindow(1_000, 1_024)).toBe(500)
    // Half the window stays available for input no matter how large the ask.
    expect(effectiveInputWindow(8_000, 32_000)).toBe(4_000)
  })

  it('floors at zero for a non-positive window', () => {
    expect(effectiveInputWindow(0, 32_000)).toBe(0)
    expect(effectiveInputWindow(-5, 32_000)).toBe(0)
  })
})
