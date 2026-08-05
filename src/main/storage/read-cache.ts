import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DATA_DIR } from './index'
import { extractWithMarkitdown } from './extractors/markitdown-extractor'

const CACHE_DIR = join(DATA_DIR, 'tmp', 'read-cache')

/**
 * Cache key from file identity + metadata. Stat-only lookup — no content read
 * on hit. markitdown output is a pure function of file content, so metadata
 * that matches means the cached markdown is current (barring a forged
 * size+mtime, which is out of scope for a read cache).
 */
function keyFor(filePath: string, size: number, mtimeMs: number): string {
  return createHash('md5').update(`${filePath}:${size}:${mtimeMs}`).digest('hex')
}

/**
 * Convert a file to markdown, caching the result at tmp/read-cache/{key}.md.
 * Fixed includeFrontmatter=false (the frontmatter embeds a timestamp and would
 * defeat caching). Returns null when markitdown cannot convert — callers fall
 * back to a raw read. A stat failure converts without caching.
 */
export async function getOrConvert(filePath: string): Promise<{ content: string; cachePath: string; hit: boolean } | null> {
  let size: number
  let mtimeMs: number
  try {
    const s = await stat(filePath)
    size = s.size
    mtimeMs = s.mtimeMs
  } catch {
    const result = await extractWithMarkitdown(filePath, false)
    return result ? { content: result.content, cachePath: '', hit: false } : null
  }

  const cachePath = join(CACHE_DIR, `${keyFor(filePath, size, mtimeMs)}.md`)
  try {
    const cached = await readFile(cachePath, 'utf-8')
    return { content: cached, cachePath, hit: true }
  } catch {
    // miss — fall through to convert
  }

  const result = await extractWithMarkitdown(filePath, false)
  if (!result) return null
  try {
    await mkdir(CACHE_DIR, { recursive: true })
    await writeFile(cachePath, result.content, 'utf-8')
  } catch {
    // cache write failure is non-fatal — content is still returned
  }
  return { content: result.content, cachePath, hit: false }
}
