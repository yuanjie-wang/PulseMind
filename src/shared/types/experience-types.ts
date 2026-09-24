export interface ExperienceRecord {
  id: string
  name: string
  title: string
  description: string
  category: string
  sourceConversationId?: string
  createdAt: string
  lastUsedAt?: string | null
  useCount: number
  /** Trigger keywords matched against the latest user message to surface this experience. */
  triggers?: string[]
  /** Companion scripts (PLAN-experience-scripts): relative paths inside the
   *  experience dir, e.g. `scripts/aggregate.mjs`. Mirrored from files_json. */
  files?: string[]
  /** Read-only computed address of the experience directory (main fills it in
   *  list(); never stored). The pick_skill envelope and the panel both read it. */
  dir?: string
}

/** A script file that ships with an experience. `path` is relative to the
 *  experience dir and MUST start with `scripts/`. */
export interface ExperienceDraftFile {
  path: string
  content: string
}

export interface ExperienceDraft {
  title: string
  description: string
  content: string
  category: string
  sourceConversationId?: string
  triggers?: string[]
  /** Files written alongside SKILL.md. Absent = keep whatever is on disk and
   *  in files_json (the ensureTriggers rewrite must not wash the list). */
  files?: ExperienceDraftFile[]
}

export const MAX_EXPERIENCES = 20

export const EXPERIENCE_CATEGORIES = ['code', 'architecture', 'user_pref', 'decision', 'general'] as const
