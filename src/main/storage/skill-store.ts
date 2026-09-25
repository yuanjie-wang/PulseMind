import { readFile, writeFile, mkdir, rm, readdir, cp } from 'node:fs/promises'
import { join, basename, dirname, relative } from 'node:path'
import type { SkillPreferences, SkillPreferencesPatch, SkillDefinition } from '../../shared/types/skill-types'
import { SKILLS_DIR } from './index'
import { getDb } from './database'

const SKILL_PREFS_FALLBACK: SkillPreferences = { enabledSkills: ['create_skill', 'create_mcp'] }
import { withZipExtraction, findSkillFiles } from '../utils/zip-extractor'
import { parseSkillMarkdown, formatSkillMd, validateSkillSpec, skillContentSignature, type ParsedFrontmatter } from '../utils/skill-parser'
import { seedSkillResources } from '../utils/skill-resources'
import { RETIRED_BUILT_IN_SKILLS } from '../../renderer/src/skills/built-in-skills'
import { parseJsonColumn } from '../utils/json'

/** Map parsed frontmatter onto a user-installed SkillDefinition, keeping spec/extra fields. */
function toDefinition(parsed: ParsedFrontmatter): SkillDefinition {
  return {
    name: parsed.name,
    description: parsed.description,
    category: parsed.category,
    triggers: parsed.triggers,
    systemPrompt: parsed.systemPrompt,
    builtIn: false,
    sourceConversationId: parsed.sourceConversationId,
    createdAt: parsed.createdAt,
    license: parsed.license,
    compatibility: parsed.compatibility,
    metadata: parsed.metadata,
    allowedTools: parsed.allowedTools,
    extra: parsed.extra
  }
}

/**
 * Provenance of the SKILL.md files this app seeds: skill name → the
 * `skillContentSignature` of the definition it was written from. A dot-file
 * beside the skills it describes (listImported reads `<dir>/SKILL.md` per
 * entry, so a plain file never registers as a skill), recorded when
 * `ensureBuiltInSkills` writes a file or adopts an existing one whose content
 * equals the live built-in.
 *
 * This is what lets a retirement still recognize its own seed after the
 * built-in's text has moved on — content-only matching cannot: a seed of the
 * v1 text is not the v2 text the skill retired with. It also makes the check
 * independent of `formatSkillMd` drift: the recorded value was never a byte
 * comparison, only a fingerprint of the meaning.
 */
const SEED_MANIFEST_PATH = join(SKILLS_DIR, '.seed-hashes.json')

async function readSeedManifest(): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await readFile(SEED_MANIFEST_PATH, 'utf-8')) as {
      seeds?: Record<string, string>
    }
    return parsed.seeds && typeof parsed.seeds === 'object' ? parsed.seeds : {}
  } catch {
    return {} // absent or damaged — every file falls back to content matching
  }
}

async function writeSeedManifest(seeds: Record<string, string>): Promise<void> {
  await writeFile(SEED_MANIFEST_PATH, JSON.stringify({ version: 1, seeds }, null, 2), 'utf-8')
}

export class SkillStore {
  // --- Preferences ---

  get(): SkillPreferences {
    const row = getDb().prepare('SELECT * FROM skill_preferences WHERE id = 1').get() as any
    if (!row) return { ...SKILL_PREFS_FALLBACK }
    return {
      enabledSkills: parseJsonColumn(row.enabled_skills, SKILL_PREFS_FALLBACK.enabledSkills),
      skillKeywords: parseJsonColumn(row.skill_keywords, SKILL_PREFS_FALLBACK.skillKeywords ?? {}),
      processedConversations: parseJsonColumn(row.processed_conversations, [])
    }
  }

  set(prefs: SkillPreferences): void {
    getDb().prepare('INSERT OR REPLACE INTO skill_preferences (id, enabled_skills, skill_keywords, processed_conversations) VALUES (1, ?, ?, ?)').run(
      JSON.stringify(prefs.enabledSkills),
      JSON.stringify(prefs.skillKeywords || {}),
      JSON.stringify(prefs.processedConversations || [])
    )
  }

  /**
   * Patch-shaped atomic update (PLAN-parallel-experts T10). See
   * SkillPreferencesPatch in shared/types/skill-types.ts for why this exists:
   * every branch is applied between one synchronous get() and one set() — no
   * await — so concurrent writers merge instead of clobbering.
   */
  update(patch: SkillPreferencesPatch): void {
    const prefs = this.get()
    if (patch.setKeywordIfAbsent) {
      const kw = { ...(prefs.skillKeywords || {}) }
      for (const [name, keywords] of Object.entries(patch.setKeywordIfAbsent)) {
        if (!kw[name]) kw[name] = keywords
      }
      prefs.skillKeywords = kw
    }
    if (patch.replaceEnabledSkills) {
      prefs.enabledSkills = patch.replaceEnabledSkills
    }
    if (patch.removeSkill) {
      prefs.enabledSkills = (prefs.enabledSkills || []).filter((s) => s !== patch.removeSkill)
      if (prefs.skillKeywords?.[patch.removeSkill]) {
        const kw = { ...prefs.skillKeywords }
        delete kw[patch.removeSkill]
        prefs.skillKeywords = kw
      }
    }
    this.set(prefs)
  }

  /**
   * Calibrate skill preferences against actual skills on disk.
   * Removes stale entries for skills whose SKILL.md no longer exists.
   */
  async calibrate(): Promise<void> {
    let prefs: SkillPreferences
    try {
      prefs = { ...SKILL_PREFS_FALLBACK, ...this.get() }
    } catch {
      return // No prefs yet, nothing to calibrate
    }

    // Get actual skill directory names on disk
    let onDisk: Set<string>
    try {
      onDisk = new Set(await readdir(SKILLS_DIR))
    } catch {
      return // Skills dir doesn't exist yet
    }

    const valid = (name: string) => onDisk.has(name)

    const enabledSkills = (prefs.enabledSkills || []).filter(valid)
    const skillKeywords: Record<string, string[]> = {}
    for (const [name, keywords] of Object.entries(prefs.skillKeywords || {})) {
      if (valid(name)) skillKeywords[name] = keywords
    }

    const changed =
      enabledSkills.length !== (prefs.enabledSkills || []).length ||
      Object.keys(skillKeywords).length !== Object.keys(prefs.skillKeywords || {}).length

    if (changed) {
      const removed = (prefs.enabledSkills || []).length - enabledSkills.length
      prefs.enabledSkills = enabledSkills
      prefs.skillKeywords = skillKeywords
      this.set(prefs)
      console.log(`[skill-store] Calibrated: removed ${removed} stale skill pref(s)`)
    }
  }

  // --- Import ---

  private async ensureSkillsDir(): Promise<void> {
    await mkdir(SKILLS_DIR, { recursive: true })
  }

  /** Import skills from a .zip file. Returns imported definitions + any errors/warnings. */
  async importFromZip(zipPath: string): Promise<{
    imported: SkillDefinition[]
    errors: string[]
    warnings: string[]
  }> {
    await this.ensureSkillsDir()
    const imported: SkillDefinition[] = []
    const errors: string[] = []
    const warnings: string[] = []

    await withZipExtraction(zipPath, async (extractDir) => {
      const skillFiles = await findSkillFiles(extractDir)

      if (skillFiles.length === 0) {
        errors.push('No SKILL.md files found in the .zip')
        return
      }

      for (const filePath of skillFiles) {
        const content = await readFile(filePath, 'utf-8')
        let parsed
        try {
          parsed = parseSkillMarkdown(content, basename(filePath))
        } catch (err) {
          errors.push(err instanceof Error ? err.message : `Failed to parse ${basename(filePath)}`)
          continue
        }
        warnings.push(
          ...validateSkillSpec(parsed, basename(dirname(filePath))).map((w) => `${parsed.name}: ${w}`)
        )

        // Check for duplicate
        const skillDir = join(SKILLS_DIR, parsed.name)
        try {
          await readdir(skillDir)
          errors.push(`Skill "${parsed.name}" already exists — skipped`)
          continue
        } catch {
          // Directory doesn't exist, good to proceed
        }

        // Write skill file — copy the entire directory containing SKILL.md
        // so that supporting files (scripts, configs, assets) are preserved.
        await mkdir(skillDir, { recursive: true })
        const skillSrcDir = dirname(filePath)
        await cp(skillSrcDir, skillDir, { recursive: true })

        imported.push(toDefinition(parsed))
      }
    })

    return { imported, errors, warnings }
  }

  /** List all imported skill definitions from disk. */
  async listImported(): Promise<SkillDefinition[]> {
    try {
      await this.ensureSkillsDir()
    } catch {
      return []
    }

    const results: SkillDefinition[] = []
    let dirs: string[]
    try {
      dirs = await readdir(SKILLS_DIR)
    } catch {
      return results
    }

    for (const dir of dirs) {
      const skillDir = join(SKILLS_DIR, dir)
      const mdPath = join(skillDir, 'SKILL.md')
      try {
        const content = await readFile(mdPath, 'utf-8')
        const parsed = parseSkillMarkdown(content, `${dir}/SKILL.md`)
        results.push(toDefinition(parsed))
      } catch {
        // Skip broken skill files — don't block startup
      }
    }

    return results
  }

  /** Delete an imported skill from disk. */
  async deleteImported(name: string): Promise<void> {
    const skillDir = join(SKILLS_DIR, name)
    await rm(skillDir, { recursive: true, force: true })
  }

  /**
   * Install a skill that has been written to disk.
   * Reads the SKILL.md from ~/.pulsemind/skills/<name>/SKILL.md,
   * parses it, and returns a SkillDefinition (or null if not found).
   */
  async install(name: string): Promise<SkillDefinition | null> {
    const mdPath = join(SKILLS_DIR, name, 'SKILL.md')
    try {
      const content = await readFile(mdPath, 'utf-8')
      const parsed = parseSkillMarkdown(content, `${name}/SKILL.md`)
      return toDefinition(parsed)
    } catch {
      return null
    }
  }

  /**
   * Write a skill definition to disk as a SKILL.md file.
   * Creates the directory structure automatically.
   */
  async write(skill: SkillDefinition): Promise<void> {
    await this.ensureSkillsDir()
    const skillDir = join(SKILLS_DIR, skill.name)
    await mkdir(skillDir, { recursive: true })
    const mdPath = join(skillDir, 'SKILL.md')
    await writeFile(mdPath, formatSkillMd(skill), 'utf-8')
  }

  /** Read the raw content of a skill's SKILL.md file. */
  async readRawContent(name: string): Promise<string | null> {
    const mdPath = join(SKILLS_DIR, name, 'SKILL.md')
    try {
      return await readFile(mdPath, 'utf-8')
    } catch {
      return null
    }
  }

  /** The skill directory, or null when the name is empty or escapes SKILLS_DIR. */
  private resolveSkillDir(name: string): string | null {
    if (!name) return null
    const skillDir = join(SKILLS_DIR, name)
    return relative(SKILLS_DIR, skillDir).startsWith('..') ? null : skillDir
  }

  /**
   * List every file in a skill directory as skill-relative paths (recursive),
   * e.g. ['SKILL.md', 'scripts/run.py']. Returns [] for unknown skills.
   */
  async listFiles(name: string): Promise<string[]> {
    const skillDir = this.resolveSkillDir(name)
    if (!skillDir) return []

    const files: string[] = []
    const walk = async (dir: string, prefix: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => null)
      if (!entries) return
      for (const entry of entries) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          await walk(join(dir, entry.name), rel)
        } else if (entry.isFile()) {
          files.push(rel)
        }
      }
    }
    await walk(skillDir, '')
    return files.sort()
  }

  /**
   * Read a file inside a skill directory by skill-relative path.
   * Rejects paths that escape the skill directory; returns null on failure.
   */
  async readFileContent(name: string, relPath: string): Promise<string | null> {
    const skillDir = this.resolveSkillDir(name)
    if (!skillDir || !relPath) return null
    const filePath = join(skillDir, relPath)
    if (relative(skillDir, filePath).startsWith('..')) return null
    try {
      return await readFile(filePath, 'utf-8')
    } catch {
      return null
    }
  }

  /**
   * Ensure built-in skills exist on disk so the `read` tool can access them.
   * Only writes files that don't already exist (never overwrites user modifications).
   * Also sweeps copies of retired built-ins (RETIRED_BUILT_IN_SKILLS) — otherwise
   * `listImported` would re-register the seeded SKILL.md as a user skill after the
   * built-in is gone.
   *
   * A directory is swept only when the app can ACCOUNT for its content, from
   * either arm of the provenance check: the seed manifest says this is the file
   * the app wrote (or adopted, while the built-in was live), or the content's
   * `skillContentSignature` still equals the definition the skill last shipped
   * with. Both are format-independent, because the seeded copy and the
   * reference may have been serialized by different versions of `formatSkillMd`
   * — the old whole-file byte compare died on exactly that drift (the
   * 2026-09-15 parser rewrite started quoting descriptions, so a seed written
   * before it could never round-trip again, and stayed registered as a user
   * skill). Everything the two arms cannot account for — a user edit, an
   * unparseable file, a body from before the manifest — is kept: the check can
   * only ever fail towards keeping.
   *
   * Stale preference entries (enabled/keywords) for a swept name are pruned by
   * the startup `calibrate()` once the directory is gone.
   */
  async ensureBuiltInSkills(skills: SkillDefinition[]): Promise<void> {
    await this.ensureSkillsDir()
    const seeds = await readSeedManifest()
    let seedsDirty = false
    const recordSeed = (name: string, signature: string) => {
      if (seeds[name] === signature) return
      seeds[name] = signature
      seedsDirty = true
    }

    for (const skill of skills) {
      const skillDir = join(SKILLS_DIR, skill.name)
      const mdPath = join(skillDir, 'SKILL.md')
      const signature = skillContentSignature(skill)
      try {
        const existing = await readFile(mdPath, 'utf-8')
        // Already exists, skip to avoid overwriting user changes — but adopt
        // its provenance when it IS this built-in's own content: a copy seeded
        // before the manifest existed has no other way to become recognizable
        // at retirement, and semantic equality is the only claim that holds
        // after the formatter has moved on.
        try {
          if (skillContentSignature(parseSkillMarkdown(existing, `${skill.name}/SKILL.md`)) === signature) {
            recordSeed(skill.name, signature)
          }
        } catch {
          // Unparseable counts as user content: never adopted, never overwritten.
        }
      } catch {
        // Doesn't exist — write it
        await mkdir(skillDir, { recursive: true })
        await writeFile(mdPath, formatSkillMd(skill), 'utf-8')
        recordSeed(skill.name, signature)
      }
      // Bundled references are seeded independently of SKILL.md: a built-in
      // that grows a new reference file must land it on the next launch of an
      // install that already has the skill's SKILL.md.
      await seedSkillResources(skillDir, skill.resources).catch((e) =>
        console.error(`[skill-store] Failed to seed resources for ${skill.name}:`, e)
      )
    }

    for (const retired of RETIRED_BUILT_IN_SKILLS) {
      const skillDir = join(SKILLS_DIR, retired.name)
      const mdPath = join(skillDir, 'SKILL.md')
      let content: string
      try {
        content = await readFile(mdPath, 'utf-8')
      } catch {
        continue // never seeded, or already swept
      }
      let signature: string
      try {
        signature = skillContentSignature(parseSkillMarkdown(content, `${retired.name}/SKILL.md`))
      } catch {
        continue // an unparseable file counts as user content
      }
      // Arm 1 — provenance: the manifest recorded this exact content when the
      // app wrote (or adopted) it, even if the built-in's text has since moved
      // on. Arm 2 — content: still the definition the skill last shipped with,
      // which is what recognizes a pre-manifest seed regardless of which
      // formatter wrote its frontmatter.
      if (signature !== seeds[retired.name] && signature !== retired.contentHash) continue
      await rm(skillDir, { recursive: true, force: true })
      if (retired.name in seeds) {
        delete seeds[retired.name]
        seedsDirty = true
      }
    }

    if (seedsDirty) {
      await writeSeedManifest(seeds).catch((e) =>
        console.error('[skill-store] Failed to write seed manifest:', e)
      )
    }
  }
}

export const skillStore = new SkillStore()
