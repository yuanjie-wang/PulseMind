// ── edit/read tool input → preview reveal target (PLAN-ide-linkage 刀一 1b/1c) ──
//
// Pure display-side derivation, positioned exactly like edit-diff.ts: turns a
// tool call's input into the smallest payload that lets the preview pane scroll
// to where a change landed. Deliberately derives AT MOST a line number or a
// short text anchor — never retains the raw strings (write.content may reach
// 500K; the renderer must not hold a second copy of it in a long-lived store).
//
// The honesty split from edit-diff.ts applies verbatim:
//  - `input.diff` (unified diff): hunks carry REAL file positions, so the first
//    hunk's newStart is the reveal line.
//  - `old_str`/`new_str`: there is no position information in that mode →
//    text-anchor; the preview locates the first non-empty line of the new text
//    by content after it loads.
// A multi-file diff carries no file_path; section paths come from
// parseMultiFileDiff (the executor's own parser) — the first section is the
// reveal target, the remaining sections only need reload bumps.

import { parseMultiFileDiff, parseUnifiedDiff } from '../diff/patch-utils'

export type EditRevealTarget =
  | { mode: 'line'; line: number }
  | { mode: 'text'; text: string }

const REVEAL_TEXT_CAP = 120

function firstMeaningfulLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed) return trimmed.slice(0, REVEAL_TEXT_CAP)
  }
  return ''
}

/** First new-side position of a unified diff text: the first hunk's newStart.
 *  A pure deletion (newCount 0) has no new content to land on. */
function firstDiffLine(diff: string): number | null {
  const first = parseUnifiedDiff(diff)[0]
  return first && first.newCount > 0 ? first.newStart : null
}

function newStrReveal(newStr: unknown): EditRevealTarget | null {
  if (typeof newStr !== 'string') return null
  const text = firstMeaningfulLine(newStr)
  return text ? { mode: 'text', text } : null
}

/** Where the preview should land for ONE file's edit input (the shape a
 *  CommandCard carries — the card names its own file_path). Multi-file diffs
 *  have no single anchor: null (the sync path uses deriveEditTargets instead). */
export function deriveEditReveal(input: { file_path?: unknown; diff?: unknown; new_str?: unknown } | null | undefined): EditRevealTarget | null {
  if (!input) return null
  if (typeof input.diff === 'string' && input.diff.trim().length > 0) {
    const hasOwnPath = typeof input.file_path === 'string' && input.file_path.trim().length > 0
    if (!hasOwnPath) return null
    const line = firstDiffLine(input.diff)
    return line != null ? { mode: 'line', line } : null
  }
  return newStrReveal(input.new_str)
}

/** read card click → its range start. `offset` IS the absolute file line in
 *  read's own numbering (the input is parsed loose — tool inputs ride SSE as
 *  strings); default page (offset 1 / absent) needs no scroll. */
export function deriveReadReveal(input: { offset?: unknown } | null | undefined): EditRevealTarget | null {
  const line = Math.floor(Number(input?.offset))
  return Number.isFinite(line) && line > 1 ? { mode: 'line', line } : null
}

export interface EditRevealMeta {
  /** Primary target path (workspace-relative or absolute, as written). */
  path: string
  reveal: EditRevealTarget | null
  /** Multi-file diff: the remaining target files — reload bumps only, no
   *  reveal (the pane shows one file at a time). */
  extraPaths?: string[]
}

/** Full derivation for an edit call's input: primary path + reveal + the
 *  sibling files of a multi-file diff. Null when no target file can be named
 *  (no file_path and the diff does not parse into sections). */
export function deriveEditTargets(input: { file_path?: unknown; diff?: unknown; new_str?: unknown } | null | undefined): EditRevealMeta | null {
  if (!input) return null
  if (typeof input.diff === 'string' && input.diff.trim().length > 0) {
    const hasOwnPath = typeof input.file_path === 'string' && input.file_path.trim().length > 0
    if (hasOwnPath) {
      return { path: (input.file_path as string).trim(), reveal: lineRevealOf(firstDiffLine(input.diff)) }
    }
    const sections = parseMultiFileDiff(input.diff)
    if (!sections || sections.length === 0) return null
    const primary = sections.find((s) => !s.isDelete && !s.isRename) ?? sections[0]
    const rest = sections.filter((s) => s !== primary).map((s) => s.path)
    // A created file opens from the top — nothing to scroll to.
    const reveal = primary.isNew ? null : lineRevealOf(firstDiffLine(primary.diff))
    return { path: primary.path, reveal, extraPaths: rest.length > 0 ? rest : undefined }
  }
  const filePath = input.file_path
  if (typeof filePath === 'string' && filePath.trim().length > 0) {
    return { path: filePath.trim(), reveal: newStrReveal(input.new_str) }
  }
  return null
}

function lineRevealOf(line: number | null): EditRevealTarget | null {
  return line != null ? { mode: 'line', line } : null
}
