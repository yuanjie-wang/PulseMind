// ── edit tool → diff line model (PLAN-coding-contract P0-4 #18) ──
//
// Pure display logic, deliberately positioned like shared/tool-display/result-summary.ts:
// both chat renderers (desktop CommandCard and the extension panel's
// MessageBlocks) consume THIS — the model is computed once and identically, so
// the two hand-mirrored surfaces cannot drift in what they show (they still
// style it themselves; the panel has no antd).
//
// Two edit input shapes map onto one line model:
//  - `input.diff` (unified diff): hunks carry REAL file positions, so the
//    line numbers shown are the file's.
//  - `old_str`/`new_str`: there is no position information in that mode, so
//    buildUnifiedDiff's fragment-relative numbering (1-based within the two
//    sides) is what gets shown — honest, and never a fabricated file line.
// Oversized inputs ride buildUnifiedDiff's own guards and surface as `meta`
// lines, never as a truncated diff (the display fold below the renderers is a
// presentation concern and happens on the full model).

import { parseMultiFileDiff, parseUnifiedDiff, type MultiFileSection } from '../diff/patch-utils'
import { buildUnifiedDiff } from '../diff/unified'

export interface EditDiffLine {
  type: 'ctx' | 'add' | 'del' | 'meta'
  text: string
  /** File (diff mode) or fragment (search/replace mode) line numbers, 1-based. */
  oldNo?: number
  newNo?: number
}

export interface EditDiffModel {
  lines: EditDiffLine[]
  /** Set when the input could not be read as either shape — renderers show it
   *  instead of guessing. */
  error?: string
}

/** Counts a change produces, for the fold header (「共 N 行变更」). */
export function countChangedLines(lines: EditDiffLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of lines) {
    if (line.type === 'add') added++
    else if (line.type === 'del') removed++
  }
  return { added, removed }
}

export function buildEditDiffModel(input: { file_path?: unknown; diff?: unknown; old_str?: unknown; new_str?: unknown }): EditDiffModel {
  // diff mode first — it is the authoritative shape when both are present.
  if (typeof input?.diff === 'string' && input.diff.trim().length > 0) {
    // The multi-file shape is the executor's ONLY when file_path is absent —
    // with a file_path the `diff --git` headers are ignored (single-file
    // semantics), so the display must ignore them too.
    const hasOwnPath = typeof input?.file_path === 'string' && input.file_path.trim().length > 0
    if (!hasOwnPath) {
      const sections = parseMultiFileDiff(input.diff)
      if (sections && sections.length > 0) return multiFileToModel(sections)
    }
    return hunksToModel(parseUnifiedDiff(input.diff), input.diff)
  }
  if (typeof input?.old_str === 'string' && typeof input?.new_str === 'string') {
    const diffText = buildUnifiedDiff(input.old_str, input.new_str)
    if (diffText === '') return { lines: [] } // identical sides — nothing to show
    return hunksToModel(parseUnifiedDiff(diffText), diffText)
  }
  return { lines: [] }
}

export interface EditChangesSummary {
  added: number
  removed: number
}

/**
 * Aggregates the changed-line counts of a tool batch's settled `edit` calls —
 * the number behind the collapsed segment header's 「修改 N 个文件（+a/−d）」
 * badge (ExecutionSegment's activity narrative; user ruling 2026-09-29: the
 * header carries the magnitude, the real diffs stay in the expanded cards —
 * the default-open-card and header-mini-diff alternatives were declined).
 * Same admission rule the narrative counts by: completed only, a rejected
 * call touched nothing. `write` has no old side to diff against, so its
 * magnitude rides the file count only. Returns null when nothing counts —
 * the header stays bare rather than reading +0/−0. The param is structural
 * so the renderer can pass its ToolUseBlock directly.
 */
export function summarizeEditChanges(
  blocks: ReadonlyArray<{ name?: unknown; status?: unknown; input?: unknown }>
): EditChangesSummary | null {
  let added = 0
  let removed = 0
  let counted = false
  for (const block of blocks) {
    if (block?.name !== 'edit' || block.status !== 'completed') continue
    const model = buildEditDiffModel((block.input ?? {}) as { file_path?: unknown; diff?: unknown; old_str?: unknown; new_str?: unknown })
    if (model.error) continue
    const counts = countChangedLines(model.lines)
    if (counts.added === 0 && counts.removed === 0) continue
    added += counts.added
    removed += counts.removed
    counted = true
  }
  return counted ? { added, removed } : null
}

function hunksToModel(hunks: ReturnType<typeof parseUnifiedDiff>, rawDiff: string): EditDiffModel {
  if (hunks.length === 0) {
    // Not parseable as a unified diff. The one expected case is the generator's
    // size guard, which reports scale instead of lines — surface it verbatim as
    // meta. Anything else is not a diff at all: an error, never invented lines.
    if (rawDiff.includes('变更过大')) {
      const meta = rawDiff.split('\n').filter((l) => l.trim().length > 0)
      return { lines: meta.map((text) => ({ type: 'meta' as const, text })) }
    }
    return { lines: [], error: 'diff 中没有可解析的 hunk' }
  }
  const lines: EditDiffLine[] = []
  for (const hunk of hunks) {
    let oldNo = hunk.oldStart
    let newNo = hunk.newStart
    for (const raw of hunk.lines) {
      if (raw.startsWith('+')) {
        lines.push({ type: 'add', text: raw.slice(1), newNo })
        newNo++
      } else if (raw.startsWith('-')) {
        lines.push({ type: 'del', text: raw.slice(1), oldNo })
        oldNo++
      } else if (raw.startsWith(' ') || raw === '') {
        lines.push({ type: 'ctx', text: raw.slice(1), oldNo, newNo })
        oldNo++
        newNo++
      } else {
        lines.push({ type: 'meta', text: raw })
      }
    }
  }
  return { lines }
}

/** One atomic multi-file call renders as one card: a meta boundary line per
 *  file, then that file's hunks with per-file numbering (each section is a
 *  real unified diff against its own file, so its hunk numbers restart —
 *  carrying them across the boundary would fabricate line numbers). Both
 *  renderers already display meta lines, so no component changes. */
function multiFileToModel(sections: MultiFileSection[]): EditDiffModel {
  const lines: EditDiffLine[] = []
  for (const s of sections) {
    lines.push({ type: 'meta', text: `── ${s.path}${s.isNew ? '（新建）' : ''}${s.isDelete ? '（删除）' : ''} ──` })
    const m = hunksToModel(parseUnifiedDiff(s.diff), s.diff)
    if (m.error) {
      lines.push({ type: 'meta', text: m.error })
      continue
    }
    lines.push(...m.lines)
  }
  return { lines }
}
