import { describe, expect, it } from 'vitest'
import { applyPatch, parseUnifiedDiff } from '../src/shared/diff/patch-utils'

// ── full_20261011 M12-P0-2: pure-insertion hunks (oldCount === 0) spliced on
// the RAW line number with no content check and no clamping. A drifted line
// number dropped the bytes somewhere else and still reported success, and the
// git-style `@@ -0,0 +1,K @@` computed oldStart = -1, which JS splice reads as
// "before the LAST line" — the probe put `X` between l4 and l5 for an
// "insert before line 0" diff. patch(1) semantics: -0,0 means APPEND TO END;
// row 1 means before the first line. Context lines the hunk carries must
// match at the target position, same discipline as non-zero hunks.

describe('applyPatch — pure insertion hunks anchor like patch(1) (M12-P0-2)', () => {
  const FIVE = 'l1\nl2\nl3\nl4\nl5'

  it('`@@ -0,0 +1,K @@` appends to the END, not before the last line', () => {
    const r = applyPatch(FIVE, parseUnifiedDiff('--- a\n+++ b\n@@ -0,0 +1,1 @@\n+X\n'))
    expect(r.success).toBe(true)
    if (!r.success) return
    expect(r.content).toBe('l1\nl2\nl3\nl4\nl5\nX')
  })

  it('`@@ -1,0 @@` inserts before the FIRST line', () => {
    const r = applyPatch(FIVE, parseUnifiedDiff('--- a\n+++ b\n@@ -1,0 +1,1 @@\n+X\n'))
    expect(r.success).toBe(true)
    if (!r.success) return
    expect(r.content).toBe('X\nl1\nl2\nl3\nl4\nl5')
  })

  it('a mid-file insertion whose context lines match lands exactly there', () => {
    const r = applyPatch(FIVE, parseUnifiedDiff('--- a\n+++ b\n@@ -3,0 +1,1 @@\n+X\n l3\n'))
    expect(r.success).toBe(true)
    if (!r.success) return
    expect(r.content).toBe('l1\nl2\nX\nl3\nl4\nl5')
  })

  it('a drifted insertion with context lines is REFUSED with the mismatch error, not written astray', () => {
    // The hunk claims "before l3" but names l4 as its context — the old code
    // inserted before l3 anyway and reported success.
    const r = applyPatch(FIVE, parseUnifiedDiff('--- a\n+++ b\n@@ -3,0 +1,1 @@\n+X\n l4\n'))
    expect(r.success).toBe(false)
    if (r.success) return
    expect(r.error).toContain('l4')
  })

  it('an insertion number beyond EOF clamps to append (still honest: no context lied)', () => {
    const r = applyPatch(FIVE, parseUnifiedDiff('--- a\n+++ b\n@@ -99,0 +1,1 @@\n+X\n'))
    expect(r.success).toBe(true)
    if (!r.success) return
    expect(r.content.endsWith('\nX')).toBe(true)
  })
})
