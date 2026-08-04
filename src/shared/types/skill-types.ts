export interface SkillDefinition {
  name: string
  description: string
  category: string
  triggers?: string[]
  systemPrompt: string
  worksWellWith?: string[]
  builtIn?: boolean
  sourceConversationId?: string
  createdAt?: string
}

export interface SkillPreferences {
  enabledSkills: string[]
  skillKeywords?: Record<string, string[]>
  /** IDs of conversations already processed for experience extraction. */
  processedConversations?: string[]
}
