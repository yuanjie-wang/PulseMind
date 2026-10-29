import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { editMissError, findSimilarRegion, hunkMismatchError, stripReadNumbering } from '../src/shared/diff/edit-similarity'
import { patchContent } from '../src/shared/diff/patch-utils'

// ── PLAN-coding-contract (harness 反馈层): a failed edit used to surface the
// bare one-liner `old_str not found in <path>` — zero data for the retry. The
// similarity helper must turn one failed edit into a self-sufficient error:
// where the closest region is (line numbers), what the file actually says
// there (verbatim preview), and whether the miss is only whitespace.

const FILE = [
  'const config = {',
  '  MODE: "safe",',
  '  RETRIES: 2,',
  '}',
  '',
  'function padLeft(text, width) {',
  '  return " ".repeat(width - text.length) + text',
  '}',
  '',
  'module.exports = { config, padLeft }',
].join('\n')

describe('findSimilarRegion — locating the closest region', () => {
  it('calls out a whitespace-only mismatch (indentation drift, the common miss)', () => {
    // The model reproduced the block from memory with 4-space indent; the file
    // uses 2-space. Exact match fails; trimmed match must be perfect.
    const needle = ['function padLeft(text, width) {', '    return " ".repeat(width - text.length) + text', '}'].join('\n')
    const region = findSimilarRegion(FILE, needle)
    expect(region).not.toBeNull()
    expect(region!.whitespaceOnly).toBe(true)
    expect(region!.matchedLines).toBe(3)
    expect(region!.totalLines).toBe(3)
    expect(region!.startLine).toBe(6)
    expect(region!.endLine).toBe(8)
  })

  it('scores a partial match with the matched-line count and the verbatim preview', () => {
    const needle = ['function padLeft(text, width) {', '  return "x".repeat(width) + text', '}'].join('\n')
    const region = findSimilarRegion(FILE, needle)
    expect(region).not.toBeNull()
    expect(region!.whitespaceOnly).toBe(false)
    expect(region!.matchedLines).toBe(2) // first and last lines line up
    expect(region!.startLine).toBe(6)
    expect(region!.preview).toContain('6 | function padLeft(text, width) {')
    expect(region!.preview).toContain('return " ".repeat(width - text.length) + text')
  })

  it('returns null when no needle line appears in the file at all', () => {
    // The needle must not share a single line with the file (a trailing `}`
    // would pass the gate and land in the fragmentary branch instead — that
    // shape used to fall out of the sub-bar null and read as "none matched").
    expect(findSimilarRegion(FILE, 'function totallyDifferent() {\n  return 42')).toBeNull()
    expect(findSimilarRegion(FILE, '   ')).toBeNull() // blank needle
  })

  it('a gate-passing but sub-bar scan returns the FRAGMENTARY region, not null (review 2026-10-10 中3)', () => {
    // `function padLeft…` and `}` exist verbatim (the cheap gate passes) but
    // the best window scores 1/4 — under the quality bar. The old null made
    // the error claim NONE of the lines appear, disproved by the gate itself.
    const needle = ['function padLeft(text, width) {', '  totally unrelated body', '  another unrelated line', '}'].join('\n')
    const region = findSimilarRegion(FILE, needle)
    expect(region).not.toBeNull()
    expect(region!.fragmentary).toBe(true)
    expect(region!.matchedLines).toBe(1)
    expect(region!.startLine).toBe(1) // 1-hit windows tie; the earliest wins
    expect(region!.preview).toContain('4 | }')
    // A region at/above the bar is never flagged (3/4 lines line up here).
    const aligned = findSimilarRegion(FILE, ['function padLeft(text, width) {', '  return " ".repeat(width - text.length) + text', '}', '}'].join('\n'))
    expect(aligned!.fragmentary).toBeFalsy()
    expect(aligned!.matchedLines).toBe(3)
  })

  it('tolerates CRLF content — the \\r rides the trimmed comparison', () => {
    const region = findSimilarRegion('a\r\nb\r\nc\r\n', 'a\nb\nc')
    expect(region).not.toBeNull()
    expect(region!.whitespaceOnly).toBe(true)
    expect(region!.startLine).toBe(1)
  })

  it('a needle longer than the file still scores its best partial window', () => {
    const region = findSimilarRegion('x\ny\nz', 'x\ny\nz\nw\nv')
    expect(region).not.toBeNull()
    expect(region!.matchedLines).toBe(3)
    expect(region!.endLine).toBe(3)
  })

  it('ties keep the EARLIEST region (the likeliest edit target)', () => {
    const twin = ['function go() {', '  return 1', '}', '', 'function go() {', '  return 1', '}'].join('\n')
    const region = findSimilarRegion(twin, 'function go() {\n  return 1\n}')
    expect(region!.startLine).toBe(1)
  })

  it('previews are line-numbered, capped, and clip pathological lines', () => {
    const long = 'x'.repeat(500)
    const body = Array.from({ length: 30 }, (_, i) => `line ${i}`).concat([long]).join('\n')
    const region = findSimilarRegion(body, body) // self-match: the full window
    expect(region!.whitespaceOnly).toBe(true)
    expect(region!.preview.split('\n').filter((l) => l.startsWith('  ')).length).toBeLessThanOrEqual(13) // 12 lines + the (+N more) tail
    expect(region!.preview).toContain('… (+')
    expect(region!.preview).toContain(`${'x'.repeat(200)}…`)
  })
})

describe('editMissError — the edit tool\'s not-found surface', () => {
  it('keeps the original prefix (longitudinal log greps) and adds the region', () => {
    const msg = editMissError('/ws/a.js', FILE, 'function padLeft(text, width) {\n    return " ".repeat(width - text.length) + text\n}')
    expect(msg.startsWith('old_str not found in /ws/a.js.')).toBe(true)
    expect(msg).toContain('lines 6–8')
    expect(msg).toContain('whitespace is ignored')
    expect(msg).toContain('6 | function padLeft(text, width) {')
  })

  it('a partial miss reports the match ratio instead of pretending certainty', () => {
    const msg = editMissError('/ws/a.js', FILE, 'function padLeft(text, width) {\n  return "x".repeat(width) + text\n}')
    expect(msg).toContain('2/3 line(s) line up')
    expect(msg).toContain('retry with old_str taken verbatim from the lines above')
  })

  it('never steers a miss toward the diff form (2026-10-29: hunks are not re-anchored)', () => {
    // The old fallback 「pass a unified diff — hunks re-anchor on context, not
    // exact text」 was false: applyPatch splices at the exact start line and
    // demands byte-exact context, so a whitespace miss in old_str is the same
    // miss in a hunk PLUS a line number to get right. Measured on the app's
    // flash-class models, diff-form edits failed 59–91% vs ~2% for
    // search/replace — the advice pushed a struggling model into the weaker form.
    const whitespace = editMissError('/ws/a.js', FILE, 'function padLeft(text, width) {\n    return " ".repeat(width - text.length) + text\n}')
    const fragmentary = editMissError('/ws/a.js', FILE, ['function padLeft(text, width) {', '  totally unrelated body', '  another unrelated line', '}'].join('\n'))
    const partial = editMissError('/ws/a.js', FILE, 'function padLeft(text, width) {\n  return "x".repeat(width) + text\n}')
    for (const msg of [whitespace, fragmentary, partial]) {
      expect(msg).not.toContain('unified diff')
      expect(msg).not.toContain('re-anchor')
      expect(msg).not.toContain('`diff` parameter')
    }
  })

  it('a needle absent from the file says so — usually the wrong file', () => {
    // No line of this needle exists in the file, so the cheap gate fails and
    // the wording is true. (A needle sharing even a `}` line lands in the
    // fragmentary branch instead.)
    const msg = editMissError('/ws/a.js', FILE, 'function nope() {\n  return 1')
    expect(msg).toContain("None of old_str's lines appear")
    expect(msg).toContain('Re-read the target file')
  })

  it('a sub-bar scan says FRAGMENTARY, never "none of the lines appear" (review 2026-10-10 中3)', () => {
    // The gate passed (two lines exist verbatim), so the old null-branch
    // wording was a false claim that steered the model to the wrong file.
    const needle = ['function padLeft(text, width) {', '  totally unrelated body', '  another unrelated line', '}'].join('\n')
    const msg = editMissError('/ws/a.js', FILE, needle)
    expect(msg.startsWith('old_str not found in /ws/a.js.')).toBe(true)
    expect(msg).toContain('Only 1/4')
    expect(msg).toContain('fragmentary resemblance')
    expect(msg).not.toContain("None of old_str's lines appear")
    expect(msg).toContain('lines 1–4')
    expect(msg).toContain('4 | }')
  })
})

describe('hunkMismatchError — the diff mode counterpart', () => {
  it('locates where the hunk\'s expected lines actually live', () => {
    const msg = hunkMismatchError(50, ['  MODE: "safe",', '  RETRIES: 2,'], FILE)
    expect(msg.startsWith('Hunk at line 50 does not match file content.')).toBe(true)
    expect(msg).toContain('lines 2–3')
    expect(msg).toContain('2 |   MODE: "safe",')
  })

  it('empty expected sequence degrades to the bare one-liner', () => {
    expect(hunkMismatchError(5, [], FILE)).toBe('Hunk at line 5 does not match file content. Expected different content in the target region.')
  })

  it('a sub-bar scan reports the fragment instead of claiming nothing appears', () => {
    const msg = hunkMismatchError(50, ['function padLeft(text, width) {', '  totally unrelated body', '  another unrelated line', '}'], FILE)
    expect(msg).toContain('Only 1/4')
    expect(msg).toContain('fragmentary resemblance')
    expect(msg).not.toContain('None of the hunk')
    expect(msg).toContain('lines 1–4')
    expect(msg).toContain('4 | }')
  })
})

// ── B12 (review 2026-10-28): read prints every content line with a `%6d\t`
// number, and a needle pasted verbatim from that output misses even the
// trimmed similarity gate (the number survives trim mid-line) — landing in
// the "wrong file?" branch while the tool itself just printed the prefixes.
// The errors must NAME the prefix, but only when the de-numbered text really
// matches the file, so `N\t`-shaped content (TSV) is never misdiagnosed.

describe('stripReadNumbering — the verbatim-read-copy shape', () => {
  it('strips a %6d prefix (leading spaces are the number field alignment)', () => {
    expect(stripReadNumbering('     2\tbeta line two')).toBe('beta line two')
    expect(stripReadNumbering('    12\t  indented code()')).toBe('  indented code()')
    expect(stripReadNumbering('1234567\tno padding needed')).toBe('no padding needed')
  })

  it('an empty file line copies as the bare prefix and strips to empty', () => {
    expect(stripReadNumbering('     5\t\n     6\tconst a = 1')).toBe('\nconst a = 1')
  })

  it('any line without the prefix (or a trailing newline) is not a read copy → null', () => {
    expect(stripReadNumbering('function padLeft() {\n     7\t  return x\n}')).toBeNull()
    expect(stripReadNumbering('     1\tx\n')).toBeNull() // trailing '' fails the all-lines rule; normal diagnosis handles it
    expect(stripReadNumbering('')).toBeNull()
  })
})

describe('read-prefix detection in the miss errors (B12)', () => {
  it('the B12 repro: a prefixed old_str is named as such and shown its bare match', () => {
    const file = 'alpha line\nbeta line two\ngamma'
    const msg = editMissError('/ws/f.txt', file, '     2\tbeta line two')
    expect(msg.startsWith('old_str not found in /ws/f.txt.')).toBe(true)
    expect(msg).toContain("line-number prefix")
    expect(msg).toContain('Strip the prefixes and retry')
    expect(msg).toContain('lines 2–2')
    expect(msg).toContain('2 | beta line two')
    expect(msg).not.toContain("None of old_str's lines appear")
    expect(msg).not.toContain('wrong file')
  })

  it('a fully prefixed multi-line needle reports where the bare text matches', () => {
    const needle = [
      '     6\tfunction padLeft(text, width) {',
      '     7\t  return " ".repeat(width - text.length) + text',
      '     8\t}',
    ].join('\n')
    const msg = editMissError('/ws/a.js', FILE, needle)
    expect(msg).toContain('line-number prefix')
    expect(msg).toContain('lines 6–8')
    expect(msg).toContain('7 |   return " ".repeat(width - text.length) + text')
  })

  it('a prefixed needle whose bare text is not in the file keeps the honest miss wording', () => {
    const msg = editMissError('/ws/a.js', FILE, '     1\tfunction nope() {\n     2\t  return 1')
    expect(msg).toContain("None of old_str's lines appear")
    expect(msg).not.toContain('line-number prefix')
  })

  it('a TSV-shaped needle (genuinely `N\\t` content) is never misread as a read copy', () => {
    const tsv = 'id\tname\n1\talpha\n2\tbeta'
    // '2\tbeta' exists verbatim in the file, '3\tgamma' does not — a drifted
    // TSV needle, not a read copy. Stripping would look for bare 'beta'/'gamma',
    // which do not exist either, so the prefix branch must stay out and the
    // fragmentary diagnosis (the one honest reading) fires.
    const msg = editMissError('/ws/data.tsv', tsv, '2\tbeta\n3\tgamma')
    expect(msg).toContain('fragmentary resemblance')
    expect(msg).toContain('Only 1/2')
    expect(msg).not.toContain('line-number prefix')
  })

  it('partially prefixed needles keep the normal diagnosis', () => {
    const needle = ['function padLeft(text, width) {', '     7\t  return " ".repeat(width - text.length) + text', '}']
    const msg = editMissError('/ws/a.js', FILE, needle.join('\n'))
    expect(msg).toContain('2/3 line(s) line up')
    expect(msg).not.toContain('line-number prefix')
  })

  it('hunkMismatchError: prefixed context/removed lines are named with the bare region', () => {
    const msg = hunkMismatchError(50, ['     2\t  MODE: "safe",', '     3\t  RETRIES: 2,'], FILE)
    expect(msg.startsWith('Hunk at line 50 does not match file content.')).toBe(true)
    expect(msg).toContain('line-number prefix')
    expect(msg).toContain('Rebuild the hunk from the bare text')
    expect(msg).toContain('lines 2–3')
    expect(msg).not.toContain('None of the hunk')
  })

  it('hunkMismatchError: mixed typed/prefixed lines keep the closest-region wording', () => {
    const msg = hunkMismatchError(50, ['  MODE: "safe",', '     3\t  RETRIES: 2,'], FILE)
    expect(msg).toContain('fragmentary resemblance')
    expect(msg).not.toContain('line-number prefix')
  })
})

describe('patchContent integration — the mismatch error now carries the hint', () => {
  it('a stale line number is diagnosable from the error alone', () => {
    const diff = ['@@ -50,2 +50,2 @@', ' MODE: "safe",', '-RETRIES: 2,', '+RETRIES: 5,'].join('\n')
    const result = patchContent(FILE, diff)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/does not match/i) // the frozen phrase (longitudinal)
    expect(result.error).toContain('lines 2–3') // where the expected lines really sit
    expect(result.error).toContain('-RETRIES: 2,'.slice(1)) // verbatim file text in the preview
  })
})

// ── 2026-10-29 (edit-form steering): on this app's flash-class models the
// diff form failed 59–91% of calls while search/replace held at ~2% (882
// calls measured, scripts/probe-edit-failure-stats.mjs), and the hunk errors
// used to end with 「regenerate the diff」 — keeping the model on the weaker
// form at exactly the moment it was failing. Every reachable hunk failure
// now ends by steering to search/replace, and the zero-hunk rejection says
// a single-file change needs no header at all.

describe('hunk failures steer to search/replace instead of a diff retry', () => {
  const STEER = 'Redo this change as search/replace'

  it('every reachable hunkMismatchError branch carries the switch', () => {
    const closest = hunkMismatchError(50, ['  MODE: "safe",', '  RETRIES: 2,'], FILE)
    const whitespace = hunkMismatchError(50, ['function padLeft(text, width) {', '    return " ".repeat(width - text.length) + text', '}'], FILE)
    const fragmentary = hunkMismatchError(50, ['function padLeft(text, width) {', '  totally unrelated body', '  another unrelated line', '}'], FILE)
    const none = hunkMismatchError(50, ['function nope() {', '  return 1'], FILE)
    for (const msg of [closest, whitespace, fragmentary, none]) {
      expect(msg).toContain(STEER)
      expect(msg).toContain('hunks are never re-anchored')
      expect(msg).not.toContain('regenerate the diff')
    }
  })

  it('the read-prefix branch offers the bare text as old_str, keeping its own accusation', () => {
    const msg = hunkMismatchError(50, ['     2\t  MODE: "safe",', '     3\t  RETRIES: 2,'], FILE)
    expect(msg).toContain('line-number prefix')
    expect(msg).toContain('Rebuild the hunk from the bare text')
    expect(msg).toContain('use that bare text as `old_str` in a search/replace')
  })

  it('the bare one-liner (unreachable from applyPatch) stays frozen', () => {
    expect(hunkMismatchError(5, [], FILE)).not.toContain(STEER)
  })

  it('a zero-hunk diff is told that a single-file change needs no header', () => {
    const result = patchContent(FILE, '@@\n-RETRIES: 2,\n+RETRIES: 5,')
    expect(result.success).toBe(false)
    expect(result.error).toContain('No valid hunks found in diff')
    expect(result.error).toContain('prefer search/replace (`old_str`/`new_str`) — it needs no hunk header at all')
  })
})

// ── wiring: the hints must be REACHABLE from the real failure paths, or the
// pure function above proves nothing about the tool.

describe('wiring — file-ops and patch-utils consume the helper', () => {
  const ROOT = join(__dirname, '..')
  const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

  it('svcEditFile routes the count===0 branch through editMissError', () => {
    const src = read('src/main/services/file-ops.ts')
    expect(src).toContain("from '../../shared/diff/edit-similarity'")
    expect(src).toContain('editMissError(input.filePath, normalizedContent, oldStr)')
  })

  it('applyPatch routes the mismatch branch through hunkMismatchError', () => {
    const src = read('src/shared/diff/patch-utils.ts')
    expect(src).toContain("from './edit-similarity'")
    expect(src).toContain('hunkMismatchError(hunk.oldStart, expectedSequence, fileLines.join(\'\\n\'))')
  })
})
