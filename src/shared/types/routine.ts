// ── Routine domain types (PLAN-0.4.0 M4) ──
// A routine is a parameterized prompt task the user can run on demand or on a
// cron schedule (D3: separate from skills — skills are prompt-injection
// capabilities the model picks; routines are tasks the USER triggers).

import type { SandboxApprovalMode } from '../sandbox/policy'

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

/** Batch mode (PLAN-routine-batch): a CSV whose headers match the routine's
 *  param keys; one run per row, each row an independent conversation. Present
 *  csvPath = configured. `applyToSchedule` defaults false — configuring a CSV
 *  does not silently change what a cron fire does. */
export interface RoutineBatchConfig {
  csvPath: string
  /** Rows executed at once, 1–5; absent = the default (3). */
  concurrency?: number
  /** Per-row hard ceiling in minutes, 1–120; absent = the default (15). */
  timeoutMinutes?: number
  /** Cron fires run the batch too, not just manual starts. */
  applyToSchedule?: boolean
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
  /** Run working directory; absent = a session folder under the global
   *  workspace, minted per run exactly like a normal conversation. */
  workspaceDir?: string
  /** Approval level for the unattended run; absent = the unattended default
   *  ('outside-ask') — needs-approval calls are auto-skipped either way. */
  approvalMode?: SandboxApprovalMode
  /** LLM profile to run with; absent = the active profile at run time. A
   *  deleted profile falls back to the active one when the run fires. */
  profileId?: string
  /** Where this routine came from ("extract from conversation"). */
  sourceConversationId?: string
  /** Batch mode over a CSV; absent = single-run routine. */
  batch?: RoutineBatchConfig
  /** Event triggers (PLAN-routine-triggers M1): local sources that start the
   *  routine outside the cron schedule. Absent = cron/manual only. Triggers
   *  are LIVE-ONLY — events while the app is closed are not replayed. */
  triggers?: RoutineTrigger[]
  /** Persisted by the scheduler for catch-up decisions across restarts. */
  nextRunAt?: string
  createdAt: string
  updatedAt: string
}

/** Watch declared paths (files or directories) for changes; a debounced
 *  change fires the routine. */
export interface RoutineFileTrigger {
  type: 'file'
  paths: string[]
  /** Trailing-debounce window in ms, clamped 1_000-60_000; absent = 5_000. */
  debounceMs?: number
}

/** A loopback HTTP POST (with the token) fires the routine. The token is
 *  minted main-side at save — the UI never invents secrets. */
export interface RoutineWebhookTrigger {
  type: 'webhook'
  token: string
}

export type RoutineTrigger = RoutineFileTrigger | RoutineWebhookTrigger

export type RoutineRunStatus = 'running' | 'success' | 'failed' | 'skipped' | 'partial'
export type RoutineRunTrigger = 'manual' | 'schedule' | 'file' | 'webhook'

/** Progress of a batch parent run, derived from its child rows at read time
 *  (never stored — a stored copy would always be stale). */
export interface RoutineBatchProgress {
  total: number
  success: number
  failed: number
  skipped: number
  running: number
}

/** What a batch PARENT row records about the run (batch_json column). */
export interface RoutineBatchMeta {
  csvName: string
  totalRows: number
  concurrency: number
  /** What each row's ceiling was at start (undefined on parents recorded
   *  before the field existed — they ran the default). */
  timeoutMinutes?: number
}

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
  // ── Batch mode (PLAN-routine-batch) ──
  /** Set on CHILD rows: the parent batch run they belong to. Parent rows and
   *  single runs leave it unset; the flat run history filters children out. */
  parentRunId?: string
  /** Child rows: 0-based CSV data row this run executed. */
  rowIndex?: number
  /** Child rows: the provided values this row ran with — the retry path uses
   *  the snapshot, not the CSV, because the file may have changed since. */
  paramsSnapshot?: Record<string, string>
  /** Child rows, computed at read: how many attempts this CSV row has (a
   *  resumed batch re-runs unfinished rows, appending new attempt rows). */
  attempts?: number
  /** Parent rows only: what the batch was launched with. */
  batch?: RoutineBatchMeta
  /** Parent rows only, computed at read: live progress over the child rows. */
  batchProgress?: RoutineBatchProgress
}
