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

import { createHash } from 'node:crypto'
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
 * Provenance for the seed-upgrade arm, wired to skill-store's
 * `.seed-hashes.json` manifest. Keys are `${skillName}#${relPath}`, values the
 * sha256 of the content LAST SEEDED — the same shape the SKILL.md arm records
 * under the bare skill name. `record` must mark the manifest dirty upstream;
 * without provenance the function stays write-once (the pre-2026-10-07
 * behavior).
 */
export interface ResourceSeedProvenance {
  seeds: Record<string, string>
  record: (key: string, signature: string) => void
  skillName: string
}

const hashContent = (content: string): string => createHash('sha256').update(content, 'utf8').digest('hex')

/**
 * Write a built-in skill's bundled files, creating parent directories as
 * needed. Policy mirrors SKILL.md seeding:
 *  - absent file → lay it down;
 *  - existing file that IS the shipped content → adopt its provenance (a
 *    pre-manifest seed becomes recognizable);
 *  - existing file the manifest recorded as OUR last seed and the shipped
 *    text has moved on → seed-upgrade in place. Without this arm every edit
 *    to a built-in's reference stranded the old copy on every existing
 *    install FOREVER — the model kept reading the stale rules (hit for real
 *    2026-10-07: the design-route upgrades never reached `pptx.md`);
 *  - anything else on disk is user content → never overwritten.
 *
 * Runs independently of the SKILL.md existence check, so adding a reference
 * to an already-seeded built-in still lands on the next launch.
 *
 * Returns the absolute paths actually written — the test asserts on this.
 */
export async function seedSkillResources(
  skillDir: string,
  resources: Record<string, string> | undefined,
  provenance?: ResourceSeedProvenance
): Promise<string[]> {
  if (!resources) return []
  const written: string[] = []
  for (const [relPath, content] of Object.entries(resources)) {
    const target = resolveSkillResourcePath(skillDir, relPath)
    if (!target) continue
    const desiredSig = hashContent(content)
    const key = provenance ? `${provenance.skillName}#${relPath}` : ''
    let existing: string | null = null
    try {
      existing = await readFile(target, 'utf-8')
    } catch {
      // Absent — lay it down.
    }
    if (existing === null) {
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content, 'utf-8')
      provenance?.record(key, desiredSig)
      written.push(target)
      continue
    }
    if (!provenance) continue // no manifest wired — write-once, user's copy wins
    const existingSig = hashContent(existing)
    if (existingSig === desiredSig) {
      provenance.record(key, existingSig) // adopt — already our content
      continue
    }
    if (provenance.seeds[key] === existingSig) {
      // The manifest recorded seeding exactly this content and the user has
      // not touched the file since — the seed upgrades in place.
      await writeFile(target, content, 'utf-8')
      provenance.record(key, desiredSig)
      written.push(target)
    }
  }
  return written
}
