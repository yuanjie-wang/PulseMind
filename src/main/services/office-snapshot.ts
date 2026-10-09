/**
 * P2.5 — Office file snapshot and diff generation.
 *
 * Snapshots originals to the conversation workspace's `.versions/` directory
 * (not the global tmp) and generates text diffs via markitdown for the model
 * to summarise changes.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { basename, join, extname } from 'node:path'
import type { MarkItDown } from 'markitdown-js'
import { buildUnifiedDiff } from '../../shared/diff/unified'

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
// Deferred like the extractor's converter (same ~390ms require, same launch
// chain: xlsx-ops / docx-ops / pptx-ops import this module at load).
async function getConverter(): Promise<MarkItDown> {
  if (!_converter) {
    try {
      const { MarkItDown } = await import('markitdown-js')
      _converter = new MarkItDown()
    } catch (err) {
      // Same visibility constraint as the extractor's converter: the only
      // caller (generateOfficeDiff) swallows everything into `undefined`, so
      // a load failure would silently cost every office_edit its diff.
      console.error('[markitdown] converter load failed (office-snapshot):', err)
      throw err
    }
  }
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
    const md = await getConverter()
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

// Unified diff GENERATOR — moved to shared/diff/unified.ts (PLAN-coding-contract
// P0-4) so the transcript's edit-diff views share this exact generator, guards
// and LCS. Import site only: never re-inline a second LCS here.

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
