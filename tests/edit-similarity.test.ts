import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { editMissError, findSimilarRegion, hunkMismatchError } from '../src/shared/diff/edit-similarity'
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
    expect(findSimilarRegion(FILE, 'function totallyDifferent() {\n  return 42\n}')).toBeNull()
    expect(findSimilarRegion(FILE, '   ')).toBeNull() // blank needle
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
    expect(msg).toContain('unified diff')
  })

  it('a needle absent from the file says so — usually the wrong file', () => {
    const msg = editMissError('/ws/a.js', FILE, 'function nope() {\n  return 1\n}')
    expect(msg).toContain("None of old_str's lines appear")
    expect(msg).toContain('Re-read the target file')
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
