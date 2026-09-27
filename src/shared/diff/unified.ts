/**
 * Unified-diff GENERATOR (LCS line diff, zero dependencies).
 *
 * Moved verbatim from src/main/services/office-snapshot.ts (PLAN-coding-contract
 * P0-4) so the transcript's edit diff views share the same generator, guards and
 * behavior as the office snapshots — do not grow a second LCS here or anywhere.
 *
 * Groups changes into hunks of context + changed lines. The LCS matrix is
 * (n+1)×(m+1) numbers allocated in the CALLING process, inside a tool call — a
 * 20k×20k spreadsheet diff used to mean a ~3.2GB allocation on the main process
 * (M6). Common head/tail is trimmed first (a one-cell edit in a huge sheet
 * diffs like the small core it is); anything still too large gets an honest
 * size summary instead of a per-line diff.
 */
export const MAX_DIFF_LINES = 5_000
export const MAX_LCS_CELLS = 4_000_000 // 2000×2000 — the matrix stays well under 100MB

export interface UnifiedHunk {
  startBefore: number
  startAfter: number
  lines: Array<{ type: ' ' | '+' | '-'; text: string }>
}

export function buildUnifiedDiff(before: string, after: string): string {
  const beforeArr = before.split('\n')
  const afterArr = after.split('\n')

  // Trim the common head/tail so the LCS runs on the changed core only.
  let head = 0
  while (head < beforeArr.length && head < afterArr.length && beforeArr[head] === afterArr[head]) head++
  let tail = 0
  while (tail < beforeArr.length - head && tail < afterArr.length - head &&
         beforeArr[beforeArr.length - 1 - tail] === afterArr[afterArr.length - 1 - tail]) tail++

  const headLines = beforeArr.slice(0, head)
  const tailLines = beforeArr.slice(beforeArr.length - tail)
  const beforeCore = beforeArr.slice(head, beforeArr.length - tail)
  const afterCore = afterArr.slice(head, afterArr.length - tail)

  if (
    beforeCore.length > MAX_DIFF_LINES || afterCore.length > MAX_DIFF_LINES ||
    beforeCore.length * afterCore.length > MAX_LCS_CELLS
  ) {
    const output: string[] = [
      `@@ 变更过大，仅报告规模（原 ${beforeArr.length} 行 → 新 ${afterArr.length} 行）@@`,
      `前 ${headLines.length} 行未变；末 ${tailLines.length} 行未变`,
      `核心差异区：${beforeCore.length} 行 → ${afterCore.length} 行`,
    ]
    return output.join('\n')
  }

  // Simple LCS-based diff
  const lcs = computeLCS(beforeCore, afterCore)
  const hunks: UnifiedHunk[] = []
  let currentHunk: UnifiedHunk | null = null

  let bi = 0, ai = 0, li = 0
  while (bi < beforeCore.length || ai < afterCore.length) {
    if (li < lcs.length && bi < beforeCore.length && ai < afterCore.length && beforeCore[bi] === lcs[li] && afterCore[ai] === lcs[li]) {
      // Common line
      if (currentHunk) {
        currentHunk.lines.push({ type: ' ', text: beforeCore[bi] })
      }
      bi++; ai++; li++
    } else {
      // Change region
      if (!currentHunk) {
        currentHunk = { startBefore: head + bi, startAfter: head + ai, lines: [] }
        hunks.push(currentHunk)
      }
      if (bi < beforeCore.length && (li >= lcs.length || beforeCore[bi] !== lcs[li])) {
        currentHunk.lines.push({ type: '-', text: beforeCore[bi] })
        bi++
      } else if (ai < afterCore.length && (li >= lcs.length || afterCore[ai] !== lcs[li])) {
        currentHunk.lines.push({ type: '+', text: afterCore[ai] })
        ai++
      } else {
        // Both match next LCS entry — close current hunk
        currentHunk = null
      }
    }
  }

  if (hunks.length === 0) return ''

  // Format hunks
  const output: string[] = [`@@ -1,${beforeArr.length} +1,${afterArr.length} @@`]
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      output.push(`${line.type}${line.text}`)
    }
  }
  return output.join('\n')
}

/**
 * Compute Longest Common Subsequence of two string arrays.
 * Used for line-level diff. O(n*m) — acceptable for document-sized text.
 */
function computeLCS(a: string[], b: string[]): string[] {
  const n = a.length, m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }

  // Backtrack
  const result: string[] = []
  let i = n, j = m
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.unshift(a[i - 1])
      i--; j--
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--
    } else {
      j--
    }
  }
  return result
}
