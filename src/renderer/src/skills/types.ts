import type { SkillDefinition, SkillPreferences } from '../../../shared/types/skill-types'

export type { SkillDefinition, SkillPreferences }

/** Runtime state: definition + user toggle */
export interface SkillState {
  definition: SkillDefinition
  enabled: boolean
}
