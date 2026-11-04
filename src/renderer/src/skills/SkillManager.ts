import type { SkillDefinition, SkillPreferences } from './types'
import { BUILT_IN_SKILLS } from './built-in-skills'
import { FeatureManager } from '../types/manager'

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export class SkillManager extends FeatureManager<SkillDefinition> {
  private prefs: SkillPreferences = { enabledSkills: [], disabledSkills: [] }

  constructor() {
    super()
    this.registry.registerBuiltIn(BUILT_IN_SKILLS)
    this.applyPreferences()
  }

  // --- Domain alias methods ---

  getAllSkills() { return this.getAll() }
  getEnabledSkills() { return this.getEnabled() }
  getSkill(name: string) { return this.get(name) }

  /**
   * Register a user-installed skill. New skills default to ON (2026-11-04
   * ruling 「把缺省当作打开」) — a template-carried or zip-imported skill must be
   * usable without the user hunting for a toggle. An explicit opt-out recorded
   * in prefs stays sticky across re-registration (disk refresh, live import).
   */
  registerSkill(definition: SkillDefinition): boolean {
    const registered = this.register(definition, true)
    if (registered) {
      if ((this.prefs.disabledSkills || []).includes(definition.name)) {
        this.registry.disable(definition.name)
      }
      this.seedTriggers()
    }
    return registered
  }

  // --- Initialization ---

  /**
   * Apply persisted preferences. `disabledSkills` is the AUTHORITY: everything
   * registered is enabled unless it appears there, and built-ins are never
   * disabled at all. `enabledSkills` from old installs is ignored on purpose —
   * it used to be an exact allow-list, so every skill missing from it (all
   * template/imported skills on a fresh machine) came up off.
   */
  applyPreferences(prefs?: SkillPreferences): void {
    if (prefs) this.prefs = { ...prefs, disabledSkills: prefs.disabledSkills || [] }
    const disabled = new Set(this.prefs.disabledSkills)
    for (const skill of BUILT_IN_SKILLS) disabled.delete(skill.name)
    const enabledNames = this.getAll()
      .map((s) => s.definition.name)
      .filter((name) => !disabled.has(name))
    this.registry.applyPreferences(enabledNames)
    this.seedTriggers()
  }

  /**
   * Seed each registered skill's frontmatter `triggers` as its keyword list so
   * keyword-based auto-activation works without an LLM backfill round. Union,
   * never overwrite: backfilled/edited keywords win over the declaration.
   * Runs over ALL skills, not just built-ins — a template skill's triggers are
   * the only auto-activation signal it has on a fresh install.
   */
  private seedTriggers(): void {
    for (const skill of this.getAll()) {
      const triggers = skill.definition.triggers
      if (!triggers || triggers.length === 0) continue
      if (!this.prefs.skillKeywords) this.prefs.skillKeywords = {}
      const existing = this.prefs.skillKeywords[skill.definition.name]
      if (!existing) {
        this.prefs.skillKeywords[skill.definition.name] = [...triggers]
      } else {
        for (const t of triggers) {
          if (!existing.includes(t)) existing.push(t)
        }
      }
    }
  }

  getPreferences(): SkillPreferences {
    const all = this.getAll()
    const enabledNames = all.filter((s) => s.enabled).map((s) => s.definition.name)
    const prefs: SkillPreferences = {
      // Legacy/diagnostic snapshot; `disabledSkills` is what drives state.
      enabledSkills: enabledNames,
      disabledSkills: all.filter((s) => !s.enabled).map((s) => s.definition.name),
    }
    if (this.prefs.skillKeywords && Object.keys(this.prefs.skillKeywords).length > 0) {
      prefs.skillKeywords = { ...this.prefs.skillKeywords }
    }
    return prefs
  }

  // --- Prompt Construction ---

  /** `allowedNames` is the expert / sub-agent whitelist (SkillDefinition.name).
   *  `undefined` = no restriction; an EMPTY ARRAY = nothing is advertised (that
   *  expert allows no skill). Either way the catalog never dangles a skill the
   *  session cannot actually use. */
  getSystemPromptAppendix(skillsDir?: string, allowedNames?: string[]): string {
    const whitelist = allowedNames ? new Set(allowedNames) : null
    const enabled = this.getEnabled().filter((s) => !whitelist || whitelist.has(s.definition.name))
    if (enabled.length === 0) return ''

    const lines: string[] = ['# Available Skills', '<available_skills>']
    for (const s of enabled) {
      const def = s.definition
      const location = skillsDir
        ? `${skillsDir}/${def.name}/SKILL.md`
        : `${def.name}/SKILL.md`
      lines.push('  <skill>')
      lines.push(`    <name>${escapeXml(def.name)}</name>`)
      lines.push(`    <description>${escapeXml(def.description)}</description>`)
      lines.push(`    <location>${escapeXml(location)}</location>`)
      lines.push('  </skill>')
    }
    lines.push('</available_skills>')
    return lines.join('\n')
  }
}
