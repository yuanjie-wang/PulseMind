export interface SkillDefinition {
  name: string
  description: string
  category: string
  triggers?: string[]
  systemPrompt: string
  /**
   * Bundled files seeded next to SKILL.md, keyed by skill-relative path
   * `references/xlsx.md` → contents). Built-ins only: the SKILL.md body
   * carries the routing decision and names these files, so a picked skill can
   * pull one deep rule set on demand instead of shipping every scenario spec in
   * the always-loaded body. Never serialized into SKILL.md frontmatter — the
   * frontmatter has no place to put it, and a user copy on disk can differ.
   */
  resources?: Record<string, string>
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
  /**
   * 旧格式的「启用名单」快照，仅供回读/诊断。权威开关是 `disabledSkills`：
   * 2026-11-04 起技能默认开启（用户裁定「把缺省当作打开」），SkillManager
   * 只按 disabledSkills 计算，这一列不再驱动任何状态。
   */
  enabledSkills: string[]
  /**
   * 显式关掉的技能。缺省/空数组 = 全部开启：全新安装、以及带着旧格式偏好
   * 升级上来的机器都是这个缺省值（他们从未在新格式里关过任何技能）。此后
   * 新出现的技能（升级带来的模板技能、zip 导入）同样默认开启。
   */
  disabledSkills?: string[]
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
  /** Replace the explicitly-disabled list; keywords and processed ids are kept. */
  replaceDisabledSkills?: string[]
  /** Drop one skill's entries (enabled snapshot, disabled list) and its keywords. */
  removeSkill?: string
}
