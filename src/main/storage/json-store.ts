import { readFile, writeFile, rename, unlink } from 'fs/promises'
import { ensureDataDir } from './index'

/**
 * Read a JSON file from disk, returning a fallback value on any error.
 * Only a MISSING file writes the default (first launch); a CORRUPT or
 * unreadable file keeps its bytes on disk — overwriting it with the default
 * turned "hand-edited comma / crash-truncated write" into an unrecoverable
 * silent reset of the MCP server list (full_20261011 M9-P1-2).
 */
export async function readJson<T>(path: string, defaultVal: T): Promise<T> {
  let data: string
  try {
    data = await readFile(path, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') await writeJson(path, defaultVal).catch(() => {})
    return defaultVal
  }
  try {
    return JSON.parse(data) as T
  } catch (err) {
    console.warn(`[json-store] ${path} 解析失败，保留原文件并返回默认值:`, err)
    return defaultVal
  }
}

/**
 * Write a value as JSON to disk atomically (tmp + rename, settings-store's
 * shape): a crash mid-write used to leave a truncated file that the NEXT
 * readJson then treated as corrupt.
 */
export async function writeJson<T>(path: string, value: T): Promise<void> {
  ensureDataDir()
  const tmp = `${path}.${process.pid}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2), 'utf-8')
    await rename(tmp, path)
  } catch (err) {
    await unlink(tmp).catch(() => {})
    throw err
  }
}
