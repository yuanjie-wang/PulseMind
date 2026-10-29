/**
 * Unified diff parser and applier.
 *
 * Supports the standard unified diff format:
 * ```
 * --- original_file
 * +++ modified_file
 * @@ -start,count +start,count @@
 *  context
 * -removed
 * +added
 * ```
 *
 * Lives in shared/ (PLAN-coding-contract P0-4): the transcript diff views on
 * both the desktop and the extension panel consume the parser, and it was
 * already zero-import — moved verbatim from src/main/utils/, appliers
 * (file-ops) included, so the edit tool's diff semantics and the renderers'
 * read of those diffs can never drift.
 */

import { hunkMismatchError } from './edit-similarity'

export interface DiffHunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  /** 1-based line number in the original file this hunk applies to. Set during apply. */
  lines: string[]
}

/** The zero-hunk rejection (PLAN-tool-issues #3, 2026-10-28). parseUnifiedDiff
 *  silently skips everything before the first `@@` header, so a payload whose
 *  header is malformed — or that is not a diff at all — collapses to zero
 *  hunks, and this used to die as a bare one-liner: the model could not tell a
 *  wrong FORMAT from a wrong FILE, and fell back to one search/replace edit
 *  per change. The hint names which of the two it is: no `@@` line anywhere
 *  (payload is not a unified diff), or a near-miss header quoted with its line
 *  number against the exact expected shape. */
export function noHunksError(diff: string): string {
  const lines = diff.split('\n')
  const atLines = lines.map((l, i) => ({ l, n: i + 1 })).filter((x) => x.l.startsWith('@@'))
  const shape =
    'Expected header shape: `@@ -start,count +start,count @@` (the count may be omitted when it is 1), followed by body lines each prefixed with a space (context), `-` (removed) or `+` (added).' +
    // The example's counts must equal its own body's sums (old = context +
    // removed, new = context + added): an overstated header count is applied
    // verbatim by applyPatch's splice and silently eats the trailing line, so
    // a teaching example whose arithmetic does not add up teaches exactly that
    // mistake to the models likeliest to copy it verbatim.
    '\nExample:\n@@ -12,2 +12,2 @@\n unchanged context line\n-removed line\n+added line' +
    '\nFor a change inside ONE file, prefer search/replace (`old_str`/`new_str`) — it needs no hunk header at all.'
  const headerRe = /^@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/
  if (atLines.length === 0) {
    return `No valid hunks found in diff: there is no \`@@\` hunk header anywhere in the payload, so it does not parse as a unified diff at all. ${shape}`
  }
  const first = atLines[0]
  if (!headerRe.test(first.l)) {
    return `No valid hunks found in diff: line ${first.n} looks like a hunk header but does not match the expected shape — \`${first.l.slice(0, 120)}\`. ${shape}`
  }
  return `No valid hunks found in diff: a \`@@\` header exists on line ${first.n} but produced no applicable hunk. ${shape}`
}

/**
 * Parse a unified diff string into hunks.
 * Skips the ---/+++ headers and extracts only the hunks.
 */
export function parseUnifiedDiff(diff: string): DiffHunk[] {  const hunks: DiffHunk[] = []
  const lines = diff.split('\n')
  // A trailing newline yields an empty final element that is not a real hunk line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  let current: DiffHunk | null = null

  for (const raw of lines) {
    // Skip header lines
    if (raw.startsWith('--- ') || raw.startsWith('+++ ')) continue
    if (raw.startsWith('\\ ')) continue // no newline at end of file

    // Hunk header
    const headerMatch = raw.match(/^@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/)
    if (headerMatch) {
      if (current) hunks.push(current)
      current = {
        oldStart: parseInt(headerMatch[1], 10),
        oldCount: headerMatch[2] ? parseInt(headerMatch[2], 10) : 1,
        newStart: parseInt(headerMatch[3], 10),
        newCount: headerMatch[4] ? parseInt(headerMatch[4], 10) : 1,
        lines: []
      }
      continue
    }

    if (!current) continue

    // Accumulate hunk body lines with their type prefix
    current.lines.push(raw)
  }

  if (current) hunks.push(current)
  return hunks
}

export interface PatchResult {
  success: boolean
  replacements: number
  error?: string
}

/**
 * Apply parsed hunks to file content.
 * Returns the new content on success, or an error string on failure.
 */
export function applyPatch(content: string, hunks: DiffHunk[]): { success: true; content: string } | { success: false; error: string } {
  const fileLines = content.split('\n')

  // Apply hunks in reverse order (bottom-up) so line numbers stay valid
  const sorted = [...hunks].sort((a, b) => b.oldStart - a.oldStart)

  for (const hunk of sorted) {
    const oldStart = hunk.oldStart - 1 // convert to 0-based
    const oldCount = hunk.oldCount

    // The region is: [oldStart, oldStart + oldCount)
    const region = fileLines.slice(oldStart, oldStart + oldCount)

    // Pure insertion (oldCount === 0 in diff header). An insertion used to
    // splice on the raw line number with NO content check — a drifted number
    // dropped the bytes somewhere else and still reported success, and the
    // git-style `@@ -0,0 +1,K @@` computed oldStart = -1, which JS splice
    // reads as "before the LAST line" (full_20261011 M12-P0-2, probe). Two
    // rules close it: patch(1)'s own semantics for -0,0 is APPEND TO END
    // (row 1 = before the first line), and any context lines the hunk
    // carries must match at the target position — same discipline as the
    // non-zero hunks below, miss goes through the same diagnosable error.
    if (hunk.oldCount === 0) {
      const at = hunk.oldStart === 0
        ? fileLines.length
        : Math.min(Math.max(hunk.oldStart - 1, 0), fileLines.length)
      const ctxLines = hunk.lines.filter(l => l.startsWith(' ')).map(l => l.slice(1))
      if (ctxLines.length > 0 && ctxLines.some((l, k) => fileLines[at + k] !== l)) {
        return { success: false, error: hunkMismatchError(hunk.oldStart, ctxLines, content) }
      }
      const insertLines = hunk.lines.filter(l => l.startsWith('+')).map(l => l.slice(1))
      fileLines.splice(at, 0, ...insertLines)
      continue
    }

    // Check: all context lines and removed lines must match sequentially.
    // Build expected sequence: context + removed interleaved as in the hunk
    let mismatch = false
    const expectedSequence: string[] = []
    for (const line of hunk.lines) {
      if (line.startsWith(' ')) {
        expectedSequence.push(line.slice(1))
      } else if (line.startsWith('-')) {
        expectedSequence.push(line.slice(1))
      } else if (line === '') {
        expectedSequence.push('')
      }
    }

    if (expectedSequence.length > 0) {
      for (let i = 0; i < expectedSequence.length && i < region.length; i++) {
        if (region[i] !== expectedSequence[i]) {
          mismatch = true
          break
        }
      }
      if (region.length < expectedSequence.length) {
        mismatch = true
      }
    }

    if (mismatch) {
      // The bare one-liner left the model guessing where the hunk SHOULD go;
      // hunkMismatchError reports the closest region whose text resembles the
      // hunk's context/removed lines, so a stale line number or a whitespace
      // drift is diagnosable from the error alone (same family as the
      // string-edit miss hint in edit-similarity).
      return {
        success: false,
        error: hunkMismatchError(hunk.oldStart, expectedSequence, fileLines.join('\n'))
      }
    }

    // Replace the region: remove old lines, then insert new ones
    // Build the new region: context lines that aren't removed + added lines
    const newRegion: string[] = []

    // Walk through the hunk lines to rebuild the region with additions applied
    let hunkLineIdx = 0
    let regionIdx = 0
    while (hunkLineIdx < hunk.lines.length) {
      const hl = hunk.lines[hunkLineIdx]
      if (hl.startsWith('+')) {
        newRegion.push(hl.slice(1))
        hunkLineIdx++
      } else if (hl.startsWith('-')) {
        // Skip this line from the original region
        hunkLineIdx++
        regionIdx++
      } else if (hl.startsWith(' ') || hl === '') {
        // Keep this context line
        if (regionIdx < region.length) {
          newRegion.push(region[regionIdx])
        }
        hunkLineIdx++
        regionIdx++
      } else {
        hunkLineIdx++
      }
    }

    // Replace the region
    fileLines.splice(oldStart, oldCount, ...newRegion)
  }

  return { success: true, content: fileLines.join('\n') }
}

/**
 * Parse a unified diff string and apply it to the given file content.
 * Returns the result with the new content or an error.
 */
export function patchContent(content: string, diff: string): PatchResult & { content?: string } {
  try {
    // Line-ending tolerance: model-generated diffs are always LF, but files on
    // Windows may be CRLF. Normalize for matching, then restore the original
    // line ending on write so the whole file stays consistent.
    const isCRLF = content.includes('\r\n')
    const normalizedContent = isCRLF ? content.replace(/\r\n/g, '\n') : content
    const normalizedDiff = diff.replace(/\r\n/g, '\n')
    const hunks = parseUnifiedDiff(normalizedDiff)
    if (hunks.length === 0) {
      return { success: false, replacements: 0, error: noHunksError(normalizedDiff) }
    }

    const result = applyPatch(normalizedContent, hunks)
    if (!result.success) {
      return { success: false, replacements: 0, error: result.error }
    }

    const out = isCRLF ? result.content.replace(/\n/g, '\r\n') : result.content
    return { success: true, replacements: hunks.length, content: out }
  } catch (err) {
    return {
      success: false,
      replacements: 0,
      error: err instanceof Error ? err.message : 'Unknown patch error'
    }
  }
}

// ── Multi-file git-style diffs ─────────────────────────────────────────────
//
// The `edit` tool's atomic multi-file form: when the model omits file_path and
// sends a git-style diff, each `diff --git` section names its own file and the
// whole call applies all-or-nothing (file-ops svcPatchFiles). Splitting lives
// here next to the single-file parser so the executor, the approval-side path
// extraction (agent-utils editToolTargetPaths) and the transcript renderers
// (tool-display/edit-diff) can never disagree about where one file's hunks end.

export interface MultiFileSection {
  /** Target path with the git `a/`/`b/` prefix stripped — workspace-relative
   *  or absolute, exactly what resolveWorkspacePath expects. */
  path: string
  /** The section's own diff text INCLUDING its ---/+++ headers, feedable to
   *  patchContent unchanged (which supplies CRLF tolerance, anchored hunk
   *  validation and the diagnosable mismatch error). */
  diff: string
  /** `--- /dev/null` — the section creates the file; it must not exist. */
  isNew: boolean
  /** `+++ /dev/null` — a deletion. Not supported: callers must reject with
   *  guidance (exec rm); writing an empty file would not be a deletion. */
  isDelete: boolean
  /** `rename from/to` present — unsupported here (a rename is a create plus a
   *  delete, neither expressible as content hunks). */
  isRename: boolean
}

/** git quotes unusual paths as one `"a/x"` string and may suffix a tab +
 *  timestamp; strip in that order (tab first — the quotes wrap the path
 *  BEFORE the timestamp, so a trailing-quote check must run after the cut),
 *  then the a/ b/ prefix (git apply -p1 semantics). */
function stripDiffPath(p: string, prefix: 'a/' | 'b/'): string {
  let s = p.trim()
  const tab = s.indexOf('\t')
  if (tab >= 0) s = s.slice(0, tab)
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) s = s.slice(1, -1)
  if (s.startsWith(prefix)) s = s.slice(2)
  return s.trim()
}

/**
 * Split a git-style multi-file diff into per-file sections.
 * Returns null when the text carries no `diff --git` marker at all — that is
 * the single-file diff shape, whose headers are ignored and whose file_path
 * parameter is authoritative. Structural details git emits between the
 * section header and the hunks (index / mode lines) are dropped by the same
 * "before the first hunk" rule parseUnifiedDiff already applies.
 */
export function parseMultiFileDiff(diff: string): MultiFileSection[] | null {
  const text = diff.replace(/\r\n/g, '\n')
  if (!/^diff --git /m.test(text)) return null
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  const bounds: number[] = []
  lines.forEach((l, i) => { if (l.startsWith('diff --git ')) bounds.push(i) })

  const sections: MultiFileSection[] = []
  for (let b = 0; b < bounds.length; b++) {
    const sectionLines = lines.slice(bounds[b], b + 1 < bounds.length ? bounds[b + 1] : lines.length)
    let isNew = false
    let isDelete = false
    let isRename = false
    let sourcePath = ''
    let targetPath = ''
    const body: string[] = []
    for (const raw of sectionLines) {
      if (raw.startsWith('--- ')) {
        const p = stripDiffPath(raw.slice(4), 'a/')
        if (p === '/dev/null') isNew = true
        else sourcePath = p
        body.push(raw)
      } else if (raw.startsWith('+++ ')) {
        const p = stripDiffPath(raw.slice(4), 'b/')
        if (p === '/dev/null') isDelete = true
        else targetPath = p
        body.push(raw)
      } else {
        if (raw.startsWith('rename ')) isRename = true
        body.push(raw)
      }
    }
    // The post-image path names where the hunks land; a deletion names the
    // file only on the source side. Last resort: the `diff --git` header.
    const headerPaths = sectionLines[0].slice('diff --git '.length).trim()
    const headerParts = headerPaths.startsWith('"')
      ? (headerPaths.match(/^"(.*?)"\s+"(.*?)"$/) ?? []).slice(1)
      : headerPaths.split(' ')
    const path = isDelete
      ? (sourcePath || stripDiffPath(headerParts[0] ?? '', 'a/'))
      : (targetPath || stripDiffPath(headerParts[1] ?? '', 'b/'))
    sections.push({ path, diff: body.join('\n'), isNew, isDelete, isRename })
  }
  return sections
}
