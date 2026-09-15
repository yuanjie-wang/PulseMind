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
  private prefs: SkillPreferences = { enabledSkills: ['create_skill', 'create_mcp'] }

  constructor() {
    super()
    this.registry.registerBuiltIn(BUILT_IN_SKILLS, new Set(['create_skill', 'create_mcp']))
    this.applyPreferences()
  }

  // --- Domain alias methods ---

  getAllSkills() { return this.getAll() }
  getEnabledSkills() { return this.getEnabled() }
  getSkill(name: string) { return this.get(name) }

  /** Register a user-installed skill with auto-enable. */
  registerSkill(definition: SkillDefinition): boolean {
    return this.register(definition, true)
  }

  // --- Initialization ---

  applyPreferences(prefs?: SkillPreferences): void {
    if (prefs) this.prefs = prefs
    // Ensure all built-in skills are always in the enabled list
    for (const skill of BUILT_IN_SKILLS) {
      if (!this.prefs.enabledSkills.includes(skill.name)) {
        this.prefs.enabledSkills.push(skill.name)
      }
    }
    this.registry.applyPreferences(this.prefs.enabledSkills)

    // Ensure built-in skill triggers are always seeded as keywords for auto-activation.
    for (const skill of BUILT_IN_SKILLS) {
      if (skill.triggers && skill.triggers.length > 0) {
        if (!this.prefs.skillKeywords) this.prefs.skillKeywords = {}
        if (!this.prefs.skillKeywords[skill.name]) {
          this.prefs.skillKeywords[skill.name] = [...skill.triggers]
        } else {
          for (const t of skill.triggers) {
            if (!this.prefs.skillKeywords[skill.name].includes(t)) {
              this.prefs.skillKeywords[skill.name].push(t)
            }
          }
        }
      }
    }
  }

  getPreferences(): SkillPreferences {
    const prefs: SkillPreferences = {
      enabledSkills: this.registry.getPreferences()
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
