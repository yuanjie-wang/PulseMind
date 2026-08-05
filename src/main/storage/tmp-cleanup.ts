import { readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { DATA_DIR } from './index'

const DAY = 24 * 60 * 60 * 1000

/** Per-bucket sweep config: subdir name, file extension filter, age threshold. */
interface BucketSpec {
  dir: string
  ext: string
  ttlMs: number
}

const BUCKETS: BucketSpec[] = [
  // True cache — eviction only means re-running markitdown, so a long TTL.
  { dir: 'read-cache', ext: '.md', ttlMs: 30 * DAY },
  // Referenced by message content (chat scroll-back), keep long enough to review old turns.
  { dir: 'screenshot', ext: '.jpg', ttlMs: 30 * DAY },
  // Offloaded tool-result overflow, only re-read within the same loop — shortest TTL.
  { dir: 'trunc', ext: '.txt', ttlMs: 7 * DAY },
]

/** Legacy files written to the tmp root before bucket subdivision. */
const LEGACY_TTL_MS = 7 * DAY

const TMP_DIR = join(DATA_DIR, 'tmp')

export const TMP_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000

let inFlight = false

/** Delete files matching `ext` in `dir` older than `ttlMs`. Async fs ops — never blocks the UI event loop. */
async function sweep(dir: string, ext: string, ttlMs: number): Promise<void> {
  const now = Date.now()
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return // dir not created yet — writers create it lazily
  }
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile() || !entry.name.endsWith(ext)) return
    const filePath = join(dir, entry.name)
    try {
      const s = await stat(filePath)
      if (now - s.mtimeMs > ttlMs) await unlink(filePath)
    } catch { /* already gone or raced */ }
  }))
}

/** Remove pre-bucketization files from the tmp root (any file older than the legacy TTL). */
async function sweepLegacyRoot(): Promise<void> {
  const now = Date.now()
  let entries
  try {
    entries = await readdir(TMP_DIR, { withFileTypes: true })
  } catch {
    return
  }
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile() || entry.name.startsWith('.')) return
    const filePath = join(TMP_DIR, entry.name)
    try {
      const s = await stat(filePath)
      if (now - s.mtimeMs > LEGACY_TTL_MS) await unlink(filePath)
    } catch { /* already gone or raced */ }
  }))
}

/** Sweep all tmp buckets. Overlapping calls no-op. */
export async function runTmpCleanup(): Promise<void> {
  if (inFlight) return
  inFlight = true
  try {
    for (const b of BUCKETS) await sweep(join(TMP_DIR, b.dir), b.ext, b.ttlMs)
    await sweepLegacyRoot()
  } finally {
    inFlight = false
  }
}
