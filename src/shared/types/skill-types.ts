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

/**
 * Patch-shaped, merge-on-arrival preferences update (PLAN-parallel-experts
 * T10): callers used to read the whole block over one IPC call, patch it
 * client-side and ship a full replacement over another — two concurrent
 * writers (two experts installing skills in one round) each replaced the
 * whole block and the later silently clobbered the earlier's keyword
 * backfill. The main process applies every branch of this patch between one
 * read and one write with no await in between, which on its single
 * synchronous SQLite connection is atomic.
 */
export interface SkillPreferencesPatch {
  /** Keyword backfill: entries are added only when the skill has none yet. */
  setKeywordIfAbsent?: Record<string, string[]>
  /** Replace the enabled-skills list; keywords and processed ids are kept. */
  replaceEnabledSkills?: string[]
  /** Drop one skill's enabled entry and its keywords. */
  removeSkill?: string
}
