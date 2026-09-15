// ── Routine domain types (PLAN-0.4.0 M4) ──
// A routine is a parameterized prompt task the user can run on demand or on a
// cron schedule (D3: separate from skills — skills are prompt-injection
// capabilities the model picks; routines are tasks the USER triggers).

export interface RoutineParam {
  key: string
  label: string
  required?: boolean
  default?: string
}

export interface RoutineSchedule {
  /** 5-field cron expression (cron-parser, standard local time). */
  cron: string
  timezone?: string
  /** When a fire was missed (app closed): run once on startup, or skip ahead. */
  catchUp?: 'once' | 'skip'
}

export interface Routine {
  id: string
  name: string
  description: string
  prompt: string
  params?: RoutineParam[]
  icon?: string
  schedule?: RoutineSchedule
  enabled: boolean
  /** Bound skills are injected at run time (without touching the skill
   *  manager's global enabled state — M4.8). */
  skills?: string[]
  /** Where this routine came from ("extract from conversation"). */
  sourceConversationId?: string
  /** Persisted by the scheduler for catch-up decisions across restarts. */
  nextRunAt?: string
  createdAt: string
  updatedAt: string
}

export type RoutineRunStatus = 'running' | 'success' | 'failed' | 'skipped'
export type RoutineRunTrigger = 'manual' | 'schedule'

export interface RoutineRun {
  id: string
  routineId: string
  /** The produced conversation — inspectable output. */
  conversationId?: string
  status: RoutineRunStatus
  trigger: RoutineRunTrigger
  startedAt: string
  finishedAt?: string
  error?: string
}
