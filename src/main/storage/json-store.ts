import { readFile, writeFile } from 'fs/promises'
import { ensureDataDir } from './index'

/**
 * Read a JSON file from disk, returning a fallback value on any error.
 * On first-launch (file missing), the default is written to disk for consistency.
 */
export async function readJson<T>(path: string, defaultVal: T): Promise<T> {
  try {
    const data = await readFile(path, 'utf-8')
    return JSON.parse(data)
  } catch {
    await writeJson(path, defaultVal).catch(() => {})
    return defaultVal
  }
}

/**
 * Write a value as JSON to disk. Creates the data directory if needed.
 */
export async function writeJson<T>(path: string, value: T): Promise<void> {
  ensureDataDir()
  await writeFile(path, JSON.stringify(value, null, 2), 'utf-8')
}
