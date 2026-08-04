import AdmZip from 'adm-zip'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { readdir, stat } from 'node:fs/promises'

/**
 * Extract a .zip file to a temporary directory, run the callback,
 * then clean up the temporary directory.
 */
export async function withZipExtraction<T>(
  zipPath: string,
  callback: (extractDir: string) => Promise<T>
): Promise<T> {
  const tempDir = await mkdtemp(join(tmpdir(), 'pulsemind-skill-'))
  try {
    const zip = new AdmZip(zipPath)
    zip.extractAllTo(tempDir, true)
    return await callback(tempDir)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

/**
 * Recursively find all SKILL.md files in the extracted directory.
 */
export async function findSkillFiles(extractDir: string): Promise<string[]> {
  const results: string[] = []

  async function walk(dir: string): Promise<void> {
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      return
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry)
      let st
      try {
        st = await stat(fullPath)
      } catch {
        continue
      }

      if (st.isDirectory()) {
        // Skip hidden directories and __MACOSX
        if (entry.startsWith('.') || entry === '__MACOSX') continue
        await walk(fullPath)
      } else if (st.isFile() && basename(entry) === 'SKILL.md') {
        results.push(fullPath)
      }
    }
  }

  await walk(extractDir)
  return results
}
