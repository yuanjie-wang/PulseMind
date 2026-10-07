// ── chart-draw's derived series palette (2026-10-07) ── companions walk the
// golden angle off the accent hue; near-neutral accents walk a lightness
// ladder. The accent itself always rides first verbatim — the values below
// were computed once by hand and pin the derivation against regressions.

import { describe, expect, it } from 'vitest'
import { seriesPalette } from '../src/main/office-export/chart-draw'

/** The test's own hex→HSL reader (the painter's helper is private). */
function hslOf(hex: string): { h: number; s: number; l: number } {
  const r = parseInt(hex.slice(0, 2), 16) / 255
  const g = parseInt(hex.slice(2, 4), 16) / 255
  const b = parseInt(hex.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l }
  const s = d / (1 - Math.abs(2 * l - 1))
  let h: number
  if (max === r) h = 60 * (((g - b) / d) % 6)
  else if (max === g) h = 60 * ((b - r) / d + 2)
  else h = 60 * ((r - g) / d + 4)
  return { h: (h + 360) % 360, s, l }
}

describe('seriesPalette (accent-derived companions)', () => {
  it('the accent rides first verbatim (with or without #)', () => {
    expect(seriesPalette('C2483B', 1)).toEqual(['C2483B'])
    expect(seriesPalette('#2F54EB', 2)[0]).toBe('2F54EB')
  })

  it('red accent: companions are the golden-angle walk (green/violet/yellow/cyan)', () => {
    // C2483B: hue ≈ 5.8°, s ≈ 0.53, l ≈ 0.50 — all inside the legible bands,
    // so companions keep the accent's own S/L and only rotate hue.
    expect(seriesPalette('C2483B', 5)).toEqual(['C2483B', '3BC26F', '973BC2', 'C2BE3B', '3B9EC2'])
  })

  it('blue accent: same derivation, different family — theme unity is the point', () => {
    expect(seriesPalette('2F54EB', 3)).toEqual(['2F54EB', 'E64534', '34E679'])
  })

  it('near-neutral accents walk a lightness ladder (greys stay grey)', () => {
    const palette = seriesPalette('8C8C8C', 4)
    expect(palette).toEqual(['8C8C8C', 'C9C9C9', '4F4F4F', 'F0F0F0'])
    for (const hex of palette.slice(1)) {
      const r = parseInt(hex.slice(0, 2), 16)
      const g = parseInt(hex.slice(2, 4), 16)
      const b = parseInt(hex.slice(4, 6), 16)
      expect(r).toBe(g)
      expect(g).toBe(b)
      expect(r).not.toBe(0x8c) // each companion is a DIFFERENT shade
    }
  })

  it('extreme accents clamp into the chart-legible S/L bands', () => {
    // #FF0000: s=1, l=0.5 → the companion clamps s to 0.78 (hue rotates, but
    // the fill never ships fully saturated)
    const hot = seriesPalette('FF0000', 2)
    expect(hot[0]).toBe('FF0000')
    expect(hslOf(hot[1]).s).toBeCloseTo(0.78, 2)
  })

  it('a 12-slice pie gets 12 distinct hues from one accent', () => {
    const palette = seriesPalette('C2483B', 12)
    expect(new Set(palette).size).toBe(12)
  })
})
