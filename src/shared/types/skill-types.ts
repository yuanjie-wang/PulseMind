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
  /** Agent Skills spec (agentskills.io) optional fields — preserved on import. */
  license?: string
  compatibility?: string
  metadata?: Record<string, unknown>
  /** Experimental spec field: space-separated pre-approved tools. */
  allowedTools?: string
  /** Unknown frontmatter fields, preserved verbatim (e.g. OpenClaw extensions). */
  extra?: Record<string, unknown>
}

export interface SkillPreferences {
  enabledSkills: string[]
  skillKeywords?: Record<string, string[]>
  /** IDs of conversations already processed for experience extraction. */
  processedConversations?: string[]
}
