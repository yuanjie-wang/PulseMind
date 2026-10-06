/** Outcome counters fed by real executions (PLAN-experience-outcome M1): the
 *  static matcher on the exec settlement records a script run's exit verdict —
 *  never an LLM's self-assessment. DB column: outcome_json. */
export interface ExperienceOutcome {
  ok: number
  fail: number
  lastOutcomeAt?: string | null
}

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
  /** Set when this record has been iterated on (PLAN-experience-iteration):
   *  the last time a save overwrote its content with a different hash.
   *  Absent/null = created only, never revised. */
  updatedAt?: string | null
  /** Real-execution outcome counters (PLAN-experience-outcome M1). Absent =
   *  never matched by the exec script matcher; advisory data for the envelope
   *  tail, the panel and (later) the pool's self-iteration input — NOT an
   *  eviction weight (the 20-LRU discipline stays). */
  outcome?: ExperienceOutcome
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
  /** The pool record this save ITERATES on (PLAN-experience-iteration): an
   *  existing record `name` to upsert into instead of the slugified title.
   *  Absent = create/replace by title slug (the pre-iteration behaviour). */
  targetName?: string
}

export const MAX_EXPERIENCES = 20

export const EXPERIENCE_CATEGORIES = ['code', 'architecture', 'user_pref', 'decision', 'general'] as const
