// ── parseZoomInput: the click-to-type percentage in the shared ZoomControls ──
// Pure parsing/clamping, so it lives here; the editor's DOM behavior (focus,
// Enter/blur/Escape) is probe territory (node env has no focus model).
import { describe, expect, it } from 'vitest'
import { parseZoomInput } from '../src/renderer/src/components/preview/ZoomControls'

describe('parseZoomInput', () => {
  it('parses a plain percent into a scale', () => {
    expect(parseZoomInput('75')).toBe(0.75)
    expect(parseZoomInput('100')).toBe(1)
    expect(parseZoomInput('12.5')).toBe(0.125)
  })

  it('tolerates a trailing % and surrounding whitespace', () => {
    expect(parseZoomInput('75%')).toBe(0.75)
    expect(parseZoomInput(' 200 ')).toBe(2)
  })

  it('clamps into the supported range instead of erroring', () => {
    expect(parseZoomInput('5')).toBe(0.1)
    expect(parseZoomInput('-50')).toBe(0.1)
    expect(parseZoomInput('9999')).toBe(8)
  })

  it('returns null for non-numbers so the editor can just close', () => {
    expect(parseZoomInput('abc')).toBeNull()
    expect(parseZoomInput('')).toBeNull()
    expect(parseZoomInput('%')).toBeNull()
  })
})
