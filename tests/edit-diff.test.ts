import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseUnifiedDiff, patchContent } from '../src/shared/diff/patch-utils'
import { buildUnifiedDiff, MAX_LCS_CELLS, MAX_DIFF_LINES } from '../src/shared/diff/unified'
import { buildEditDiffModel, countChangedLines, summarizeEditChanges } from '../src/shared/tool-display/edit-diff'

// ── PLAN-coding-contract P0-4: the diff assets moved main → shared. First the
// zero-behavior-change gate on the MOVED functions, then the new pure model
// both render surfaces consume.

describe('moved patch-utils (shared/diff) — migration must not change behavior', () => {
  const file = ['line one', 'line two', 'line three', 'line four'].join('\n')

  it('applies a simple hunk', () => {
    const diff = [
      '--- a.txt',
      '+++ b.txt',
      '@@ -1,4 +1,4 @@',
      ' line one',
      '-line two',
      '+line 2 changed',
      ' line three',
      ' line four',
    ].join('\n')
    const result = patchContent(file, diff)
    expect(result.success).toBe(true)
    expect(result.content).toBe(['line one', 'line 2 changed', 'line three', 'line four'].join('\n'))
    expect(result.replacements).toBe(1)
  })

  it('refuses a hunk that does not match the file', () => {
    const diff = [
      '@@ -1,2 +1,2 @@',
      ' line one',
      '-NOT IN THE FILE',
      '+replacement',
    ].join('\n')
    const result = patchContent(file, diff)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/does not match/i)
  })

  it('keeps CRLF files CRLF (the normalization round-trip)', () => {
    const crlfFile = ['a', 'b', 'c'].join('\r\n')
    const diff = ['@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c'].join('\n')
    const result = patchContent(crlfFile, diff)
    expect(result.success).toBe(true)
    expect(result.content).toBe(['a', 'B', 'c'].join('\r\n'))
  })

  it('parses hunk headers with line counts for the renderers', () => {
    const hunks = parseUnifiedDiff('@@ -10,3 +10,4 @@\n ctx\n-old\n+new1\n+new2\n+new3')
    expect(hunks).toHaveLength(1)
    expect(hunks[0]).toMatchObject({ oldStart: 10, oldCount: 3, newStart: 10, newCount: 4 })
  })
})

describe('moved buildUnifiedDiff (shared/diff) — generator contract', () => {
  it('produces a parseable diff for a small edit', () => {
    const before = ['a', 'b', 'c', 'd'].join('\n')
    const after = ['a', 'b', 'C', 'd'].join('\n')
    const diff = buildUnifiedDiff(before, after)
    const hunks = parseUnifiedDiff(diff)
    expect(hunks.length).toBeGreaterThan(0)
    // The common head/tail is TRIMMED before the LCS runs (the M6 guard), so a
    // single-line edit diffs as exactly its change — no context lines survive.
    expect(hunks[0].lines).toEqual(['-c', '+C'])
  })

  it('emits context between changes inside one region', () => {
    const before = ['x1', 'a', 'b', 'a2'].join('\n')
    const after = ['y1', 'a', 'b', 'y2'].join('\n')
    const hunks = parseUnifiedDiff(buildUnifiedDiff(before, after))
    // one hunk: -x1 +y1, then the common 'a','b' ride INSIDE the region as
    // context, then -a2 +y2 — the interleaved shape the parser feeds us.
    const lines = hunks[0].lines
    expect(lines).toContain(' a')
    expect(lines).toContain(' b')
  })

  it('identical inputs produce an empty diff', () => {
    expect(buildUnifiedDiff('same\ntext', 'same\ntext')).toBe('')
  })

  it('huge changed cores take the guard, not an LCS allocation', () => {
    // Head/tail trimming makes a big append cheap, so the guard needs a big
    // CHANGED CORE: 5001 mutually-different lines each side.
    const mk = (seed: number) => Array.from({ length: MAX_DIFF_LINES + 1 }, (_, i) => `line ${i + seed}`).join('\n')
    const before = mk(0)
    const after = mk(1_000_000)
    const diff = buildUnifiedDiff(before, after)
    expect(diff).toContain('变更过大')
    expect(diff).not.toMatch(/^-/m) // no per-line diff at all
    // and the guard constants keep their reviewed values
    expect(MAX_LCS_CELLS).toBe(4_000_000)
  })
})

describe('buildEditDiffModel — search/replace mode', () => {
  it('models both sides; the trimmed fragment numbers its own changed lines', () => {
    const model = buildEditDiffModel({
      old_str: 'function a() {\n  return 1\n}',
      new_str: 'function a() {\n  return 2\n}',
    })
    expect(model.error).toBeUndefined()
    // Head/tail trim: the braces are common, so the fragment diff is exactly
    // the changed pair — numbered 1 within the fragment (search/replace has no
    // file positions; never a fabricated file line number).
    expect(model.lines).toEqual([
      { type: 'del', text: '  return 1', oldNo: 1 },
      { type: 'add', text: '  return 2', newNo: 1 },
    ])
  })

  it('counts changes for the fold header', () => {
    const model = buildEditDiffModel({ old_str: 'a\nb', new_str: 'a\nc' })
    expect(countChangedLines(model.lines)).toEqual({ added: 1, removed: 1 })
  })

  it('returns an empty model for identical sides and empty input', () => {
    expect(buildEditDiffModel({ old_str: 'x', new_str: 'x' }).lines).toEqual([])
    expect(buildEditDiffModel({}).lines).toEqual([])
    // partial streaming input must not throw
    expect(buildEditDiffModel({ old_str: 'x' }).lines).toEqual([])
  })
})

describe('buildEditDiffModel — diff mode', () => {
  it('keeps REAL file line numbers from the hunk header', () => {
    const model = buildEditDiffModel({
      diff: ['@@ -120,3 +120,3 @@', ' old context', '-stale line', '+fresh line', ' more context'].join('\n'),
    })
    expect(model.lines.map((l) => l.type)).toEqual(['ctx', 'del', 'add', 'ctx'])
    expect(model.lines[0]).toMatchObject({ oldNo: 120, newNo: 120 })
    expect(model.lines[1]).toMatchObject({ type: 'del', text: 'stale line', oldNo: 121 })
    expect(model.lines[2]).toMatchObject({ type: 'add', text: 'fresh line', newNo: 121 })
    expect(model.lines[3]).toMatchObject({ oldNo: 122, newNo: 122 })
  })

  it('diff mode wins when both shapes are present', () => {
    const model = buildEditDiffModel({
      diff: '@@ -5,1 +5,1 @@\n-a\n+b',
      old_str: 'ignored',
      new_str: 'ignored',
    })
    expect(model.lines).toHaveLength(2)
    expect(model.lines[0]).toMatchObject({ oldNo: 5 })
  })

  it('unparseable input surfaces as an error, never as invented lines', () => {
    const model = buildEditDiffModel({ diff: 'this is not a diff' })
    expect(model.error).toBeTruthy()
    expect(model.lines).toEqual([])
  })

  it('oversized sides surface the generator guard as meta lines', () => {
    const mk = (seed: number) => Array.from({ length: MAX_DIFF_LINES + 1 }, (_, i) => `line ${i + seed}`).join('\n')
    const model = buildEditDiffModel({ old_str: mk(0), new_str: mk(1_000_000) })
    expect(model.error).toBeUndefined()
    expect(model.lines.length).toBeGreaterThan(0)
    expect(model.lines.every((l) => l.type === 'meta')).toBe(true)
    expect(model.lines[0].text).toContain('变更过大')
  })
})

// ── The collapsed segment header's 「修改 N 个文件（+a/−d）」 badge (user
// ruling 2026-09-29: header carries the magnitude, the diffs stay in the
// expanded cards; the default-open and header-mini-diff alternatives were
// declined — don't re-propose them).

describe('summarizeEditChanges — the segment header badge', () => {
  const edit = (input: Record<string, unknown>, status: unknown = 'completed') => ({
    type: 'tool_use',
    name: 'edit',
    status,
    input,
  })

  it('aggregates the settled edits across both input shapes', () => {
    const summary = summarizeEditChanges([
      edit({ file_path: '/a.java', old_str: 'a\nb', new_str: 'a\nB\nc' }),
      edit({ diff: '@@ -5,1 +5,3 @@\n-old\n+n1\n+n2' }),
    ])
    // search/replace: +2/−1; diff mode: +2/−1
    expect(summary).toEqual({ added: 4, removed: 2 })
  })

  it('admits completed edits only — the rule the activity narrative counts by', () => {
    const summary = summarizeEditChanges([
      edit({ old_str: 'a', new_str: 'b' }, 'rejected'), // touched nothing
      edit({ old_str: 'x', new_str: 'y' }, 'pending'), // still held / streaming
      { type: 'tool_use', name: 'read', status: 'completed', input: {} },
      { type: 'tool_use', name: 'write', status: 'completed', input: { content: 'w\nw\nw' } }, // no old side
      edit({ old_str: 'k', new_str: 'K' }), // the only admissible call
    ])
    expect(summary).toEqual({ added: 1, removed: 1 })
  })

  it('null when nothing counts — the header stays bare, never +0/−0', () => {
    expect(summarizeEditChanges([])).toBeNull()
    expect(summarizeEditChanges([edit({ old_str: 'same', new_str: 'same' })])).toBeNull() // identical sides
    expect(summarizeEditChanges([edit({ diff: 'not a diff at all' })])).toBeNull() // error model
    expect(summarizeEditChanges([{ type: 'tool_use', name: 'edit', status: 'completed' }])).toBeNull() // no input
  })

  it('one unparseable edit does not sink the batch — it is skipped, others count', () => {
    const summary = summarizeEditChanges([
      edit({ diff: 'garbage' }),
      edit({ old_str: 'a\nb', new_str: 'a\nB' }),
    ])
    expect(summary).toEqual({ added: 1, removed: 1 })
  })
})

describe('wiring — the badge reaches the collapsed header', () => {
  const ROOT = join(__dirname, '..')
  const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

  it('ExecutionSegment consumes the shared model and rides the badge onto 修改', () => {
    const source = read('src/renderer/src/components/chat/ExecutionSegment.tsx')
    expect(source).toContain("from '../../../../shared/tool-display/edit-diff'")
    expect(source).toContain('summarizeEditChanges')
    // The badge composes into the 修改 family line — not a separate part, so
    // the narrative stays 「修改 N 个文件（+a/−d）· 运行 M 条命令」.
    expect(source).toContain('修改 ${writes} 个文件${diffBadge}')
  })
})
