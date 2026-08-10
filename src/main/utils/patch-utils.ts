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
 */

export interface DiffHunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  /** 1-based line number in the original file this hunk applies to. Set during apply. */
  lines: string[]
}

/**
 * Parse a unified diff string into hunks.
 * Skips the ---/+++ headers and extracts only the hunks.
 */
export function parseUnifiedDiff(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = []
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

    // Pure insertion (oldCount === 0 in diff header)
    if (hunk.oldCount === 0) {
      const insertLines = hunk.lines.filter(l => l.startsWith('+')).map(l => l.slice(1))
      fileLines.splice(oldStart, 0, ...insertLines)
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
      return {
        success: false,
        error: `Hunk at line ${hunk.oldStart} does not match file content. Expected different content in the target region.`
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
    const hunks = parseUnifiedDiff(diff.replace(/\r\n/g, '\n'))
    if (hunks.length === 0) {
      return { success: false, replacements: 0, error: 'No valid hunks found in diff' }
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
