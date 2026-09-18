/**
 * P2.5 — Office file snapshot and diff generation.
 *
 * Snapshots originals to the conversation workspace's `.versions/` directory
 * (not the global tmp) and generates text diffs via markitdown for the model
 * to summarise changes.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { basename, join, extname } from 'node:path'
import { MarkItDown } from 'markitdown-js'

const VERSIONS_DIR = '.versions'
const MAX_VERSIONS_PER_NAME = 5

/** Only THIS file's own snapshots: the old `startsWith(`${stem}-`)` prune
 *  counted (and evicted) `报告-终稿-<stamp>.docx`'s versions under
 *  `报告.docx`'s quota (M5). The stamp is always an ISO date head — anchor. */
function ownSnapshotFiles(names: string[], stem: string, ext: string): string[] {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^${esc(stem)}-\\d{4}-\\d{2}-\\d{2}T.*\\${ext}$`)
  return names.filter((f) => re.test(f))
}

/**
 * Store the original file in the conversation workspace's `.versions/` directory.
 * LRU-prunes to MAX_VERSIONS_PER_NAME per filename stem.
 * Returns the snapshot path, or undefined if the workspace is unavailable.
 */
export async function snapshotToWorkspace(
  originalPath: string,
  workspaceDir: string | undefined
): Promise<string | undefined> {
  if (!workspaceDir) return undefined

  const versionsDir = join(workspaceDir, VERSIONS_DIR)
  try {
    await mkdir(versionsDir, { recursive: true })
    const original = await readFile(originalPath)
    const stem = basename(originalPath, extname(originalPath))
    const ext = extname(originalPath)
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const dest = join(versionsDir, `${stem}-${ts}${ext}`)
    await writeFile(dest, original)

    // LRU prune: keep only the most recent N per stem
    const { readdirSync } = await import('node:fs')
    const entries = ownSnapshotFiles(readdirSync(versionsDir), stem, ext).sort()
    while (entries.length > MAX_VERSIONS_PER_NAME) {
      const oldest = entries.shift()!
      try { await import('node:fs/promises').then((fs) => fs.unlink(join(versionsDir, oldest))) } catch { /* best-effort */ }
    }
    return dest
  } catch {
    return undefined
  }
}

let _converter: MarkItDown | null = null
function getConverter(): MarkItDown {
  if (!_converter) _converter = new MarkItDown()
  return _converter
}

/**
 * Generate a line-by-line unified diff of two office files via markitdown conversion.
 * Returns a unified-diff string, or undefined if either conversion fails.
 * Deliberately does NOT write the diff to disk — it goes into the tool result only.
 */
export async function generateOfficeDiff(
  beforePath: string,
  afterPath: string
): Promise<string | undefined> {
  try {
    const md = getConverter()
    const [beforeResult, afterResult] = await Promise.all([
      md.convert(beforePath),
      md.convert(afterPath),
    ])
    const beforeText = (beforeResult as { textContent: string }).textContent || ''
    const afterText = (afterResult as { textContent: string }).textContent || ''
    if (beforeText === afterText) return undefined
    return buildUnifiedDiff(beforeText, afterText)
  } catch {
    return undefined
  }
}

/**
 * Build a simple unified-diff string (no library dependency).
 * Groups changes into hunks of context + changed lines.
 * The LCS matrix is (n+1)×(m+1) numbers allocated in THIS process, inside a
 * tool call — a 20k×20k spreadsheet diff used to mean a ~3.2GB allocation on
 * the main process (M6). Common head/tail is trimmed first (a one-cell edit
 * in a huge sheet diffs like the small core it is); anything still too large
 * gets an honest size summary instead of a per-line diff.
 */
const MAX_DIFF_LINES = 5_000
const MAX_LCS_CELLS = 4_000_000 // 2000×2000 — the matrix stays well under 100MB

function buildUnifiedDiff(before: string, after: string): string {
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

interface UnifiedHunk {
  startBefore: number
  startAfter: number
  lines: Array<{ type: ' ' | '+' | '-'; text: string }>
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

/**
 * Build a structured change summary from op results.
 * Example: "replace_text: 3 处替换（段落 2, 5, 8）；insert_paragraph: 在段落 4 后插入 1 段"
 */
export function buildChangeSummary(
  results: Array<{ index: number; op: string; ok: boolean; detail: string }>
): string {
  const okResults = results.filter((r) => r.ok)
  if (okResults.length === 0) return '无变更'

  const byOp = new Map<string, string[]>()
  for (const r of okResults) {
    const list = byOp.get(r.op) ?? []
    list.push(r.detail)
    byOp.set(r.op, list)
  }

  const parts: string[] = []
  for (const [op, details] of byOp) {
    parts.push(`${op} (${details.length}): ${details.join('; ')}`)
  }
  return parts.join('\n')
}
