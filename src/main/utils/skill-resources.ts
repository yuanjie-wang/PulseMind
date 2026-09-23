/**
 * Seeding for a built-in skill's bundled files (SkillDefinition.resources).
 *
 * A built-in skill ships one SKILL.md plus, optionally, files the SKILL.md
 * names but does not inline — the office skill's per-format rule sets are the
 * reason this exists: a picked skill should not drag every scenario spec into
 * the context it was picked for. `pick_skill` only ever returns the body, so
 * the files have to reach disk for the `read` tool to reach them.
 *
 * Lives in utils (not storage) because skill-store's module graph pulls in
 * better-sqlite3, which cannot load under plain Node — the path boundary below
 * is the security-relevant half and needs to be testable on its own.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'

/** Absolute or drive-lettered (`C:\…`) paths are never skill-relative. */
const WINDOWS_ABSOLUTE_RE = /^[A-Za-z]:[\\/]/

/**
 * Resolve one skill-relative resource path to an absolute path inside the
 * skill directory. Returns null when the path is empty, absolute, or escapes
 * the directory — the caller skips those rather than writing outside a skill.
 * A resource map is our own data (not user input), so a null here is a bug the
 * test suite catches, not a runtime condition to report.
 */
export function resolveSkillResourcePath(skillDir: string, relPath: string): string | null {
  const rel = relPath.trim()
  if (!rel || isAbsolute(rel) || WINDOWS_ABSOLUTE_RE.test(rel)) return null
  const target = join(skillDir, rel)
  const back = relative(skillDir, target)
  if (!back || back.startsWith('..') || isAbsolute(back)) return null
  return target
}

/**
 * Write a built-in skill's bundled files, creating parent directories as
 * needed. Same policy as SKILL.md seeding: an existing file is NEVER
 * overwritten, so a user who edited a shipped reference keeps their copy (and
 * gets the new upstream one only by deleting it). Runs independently of the
 * SKILL.md existence check, so adding a reference to an already-seeded
 * built-in still lands on the next launch.
 *
 * Returns the absolute paths actually written — the test asserts on this.
 */
export async function seedSkillResources(
  skillDir: string,
  resources: Record<string, string> | undefined
): Promise<string[]> {
  if (!resources) return []
  const written: string[] = []
  for (const [relPath, content] of Object.entries(resources)) {
    const target = resolveSkillResourcePath(skillDir, relPath)
    if (!target) continue
    try {
      await readFile(target, 'utf-8')
      continue // Already there — the user's copy wins.
    } catch {
      // Absent — lay it down.
    }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, 'utf-8')
    written.push(target)
  }
  return written
}
