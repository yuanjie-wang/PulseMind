import { readFile, writeFile, mkdir, rm, readdir, cp } from 'node:fs/promises'
import { join, basename, dirname } from 'node:path'
import type { SkillPreferences, SkillDefinition } from '../../shared/types/skill-types'
import { SKILLS_DIR } from './index'
import { getDb } from './database'

const SKILL_PREFS_FALLBACK: SkillPreferences = { enabledSkills: ['create_skill', 'create_mcp'] }
import { withZipExtraction, findSkillFiles } from '../utils/zip-extractor'
import { parseSkillMarkdown } from '../utils/skill-parser'
import { parseJsonColumn } from '../utils/json'

/** Format a skill as a valid SKILL.md document with YAML frontmatter. */
function formatSkillMd(skill: SkillDefinition): string {
  const lines = ['---', `name: ${skill.name}`, `description: ${skill.description}`]
  if (skill.category) lines.push(`category: ${skill.category}`)
  if (skill.triggers?.length) {
    lines.push('triggers:')
    for (const t of skill.triggers) lines.push(`  - ${t}`)
  }
  if (skill.sourceConversationId) lines.push(`sourceConversationId: ${skill.sourceConversationId}`)
  if (skill.createdAt) lines.push(`createdAt: ${skill.createdAt}`)
  lines.push('---', '', skill.systemPrompt)
  return lines.join('\n')
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

  /** Import skills from a .zip file. Returns imported definitions + any errors. */
  async importFromZip(zipPath: string): Promise<{
    imported: SkillDefinition[]
    errors: string[]
  }> {
    await this.ensureSkillsDir()
    const imported: SkillDefinition[] = []
    const errors: string[] = []

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

        imported.push({
          name: parsed.name,
          description: parsed.description,
          category: parsed.category,
          triggers: parsed.triggers,
          systemPrompt: parsed.systemPrompt,
          builtIn: false,
          sourceConversationId: parsed.sourceConversationId,
          createdAt: parsed.createdAt
        })
      }
    })

    return { imported, errors }
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
        results.push({
          name: parsed.name,
          description: parsed.description,
          category: parsed.category,
          triggers: parsed.triggers,
          systemPrompt: parsed.systemPrompt,
          builtIn: false,
          sourceConversationId: parsed.sourceConversationId,
          createdAt: parsed.createdAt
        })
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
      return {
        name: parsed.name,
        description: parsed.description,
        category: parsed.category,
        triggers: parsed.triggers,
        systemPrompt: parsed.systemPrompt,
        builtIn: false,
        sourceConversationId: parsed.sourceConversationId,
        createdAt: parsed.createdAt
      }
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

  /**
   * Ensure built-in skills exist on disk so the `read` tool can access them.
   * Only writes files that don't already exist (never overwrites user modifications).
   */
  async ensureBuiltInSkills(skills: SkillDefinition[]): Promise<void> {
    await this.ensureSkillsDir()
    for (const skill of skills) {
      const skillDir = join(SKILLS_DIR, skill.name)
      const mdPath = join(skillDir, 'SKILL.md')
      try {
        await readFile(mdPath, 'utf-8')
        // Already exists, skip to avoid overwriting user changes
      } catch {
        // Doesn't exist — write it
        await mkdir(skillDir, { recursive: true })
        await writeFile(mdPath, formatSkillMd(skill), 'utf-8')
      }
    }
  }
}

export const skillStore = new SkillStore()
