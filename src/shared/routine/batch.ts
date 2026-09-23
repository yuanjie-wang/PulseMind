// ── Routine batch: constants + CSV↔param mapping (PLAN-routine-batch) ──
// Pure logic shared by the main-process batch runner and the renderer's
// preview. The contract (L2): a header matches a param key exactly after
// trimming the HEADER (param keys are authored, not typed into a spreadsheet);
// columns without a param are ignored but surfaced; required params without a
// column refuse the whole batch; a row whose required cell resolves blank is
// that row's failure, not the batch's.

import type { RoutineBatchProgress, RoutineParam, RoutineRun } from '../types/routine'

/** Hard ceiling on rows per batch run — a 50k-row CSV must not silently
 *  enqueue 50k conversations (LLM cost). Refused with a split-the-file hint. */
export const MAX_BATCH_ROWS = 200

/** CSV source size cap; 2MB of CSV is already ~10x the row cap. */
export const MAX_BATCH_FILE_BYTES = 2 * 1024 * 1024

/** Rows executed at once. LLM concurrency is the scarce resource — same
 *  reasoning as MAX_PARALLEL_SUBAGENTS=5; each row is an ordinary session, so
 *  the session manager's FIFO queue keeps guarding underneath. */
export const MAX_BATCH_CONCURRENCY = 5
export const DEFAULT_BATCH_CONCURRENCY = 3

/** Per-row hard ceiling, in minutes (user 2026-09-23: a batch row must be
 *  stoppable at a configured bound, not only at the built-in 15). The default
 *  IS routine-runner's RUN_TIMEOUT_MS — that constant is derived from this one,
 *  so the single-run ceiling and the batch default cannot drift apart. */
export const DEFAULT_BATCH_TIMEOUT_MINUTES = 15
export const MAX_BATCH_TIMEOUT_MINUTES = 120

/** The editor / start-dialog pick list — integers within [1, MAX] that
 *  normalizeBatchTimeoutMinutes accepts, fixed so both surfaces offer the
 *  same choices (a 1..120 derived list would be unusable). */
export const BATCH_TIMEOUT_MINUTE_OPTIONS = [5, 10, 15, 20, 30, 45, 60, 90, 120]

export interface CsvBatchAnalysis {
  /** Param keys (in declaration order) that have a matching column. */
  matchedParams: string[]
  /** Columns with no declared param — ignored at run time, shown in preview. */
  unmatchedHeaders: string[]
  /** Required params with no column — the batch refuses to start. */
  missingRequiredHeaders: string[]
  /** Data rows after the parser dropped blank ones. */
  totalRows: number
}

/** First occurrence of a header wins (duplicates are the file's problem). */
function columnOfKey(headers: string[], key: string): number {
  return headers.indexOf(key)
}

export function analyzeCsvBatch(headers: string[], rows: string[][], params: RoutineParam[] | undefined): CsvBatchAnalysis {
  const declared = params ?? []
  const matchedParams: string[] = []
  const missingRequiredHeaders: string[] = []
  for (const p of declared) {
    if (columnOfKey(headers, p.key) >= 0) matchedParams.push(p.key)
    else if (p.required) missingRequiredHeaders.push(p.key)
  }
  const unmatchedHeaders = headers.filter((h) => !declared.some((p) => p.key === h))
  return { matchedParams, unmatchedHeaders, missingRequiredHeaders, totalRows: rows.length }
}

/** One row's provided values: only columns that map to declared params —
 *  cells for everything else are none of resolveParamValues' business, so
 *  blank optional cells keep falling back to the stored default. Cells are
 *  trimmed (spreadsheet whitespace is accidental, never intentional data). */
export function rowParamsAt(headers: string[], rows: string[][], params: RoutineParam[] | undefined, rowIndex: number): Record<string, string> {
  const row = rows[rowIndex] ?? []
  const out: Record<string, string> = {}
  for (const p of params ?? []) {
    const col = columnOfKey(headers, p.key)
    if (col >= 0) out[p.key] = (row[col] ?? '').trim()
  }
  return out
}

/** What the editor / start-dialog preview needs: the mapping verdict plus a
 *  bounded slice of the actual rows. Over-limit rows are REPORTED here (the
 *  UI shows why start would refuse), not thrown — the preview's job is to let
 *  the user see the problem before the run does. Lives in shared because the
 *  renderer consumes it over the routine:csv-preview bridge. */
export interface CsvPreview {
  csvName: string
  headers: string[]
  previewRows: string[][]
  totalRows: number
  analysis: CsvBatchAnalysis
  overRowLimit: boolean
}

export interface CsvPreviewResult {
  ok: boolean
  preview?: CsvPreview
  error?: string
}

/** Absent/blank → undefined (caller applies the default); present but not an
 *  integer within [1, MAX] throws — a hand-crafted JSON payload must not
 *  silently widen to "run everything at once". */
export function normalizeBatchConcurrency(value: unknown): number | undefined {
  if (value == null || value === '') return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_BATCH_CONCURRENCY) {
    throw new Error(`无效的批量并发数：${String(value)}（1–${MAX_BATCH_CONCURRENCY} 的整数）`)
  }
  return value
}

/** Same contract as normalizeBatchConcurrency, for the per-row timeout in
 *  minutes: absent → undefined (the default applies), invalid → throw. */
export function normalizeBatchTimeoutMinutes(value: unknown): number | undefined {
  if (value == null || value === '') return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_BATCH_TIMEOUT_MINUTES) {
    throw new Error(`无效的单次超时：${String(value)}（1–${MAX_BATCH_TIMEOUT_MINUTES} 的整数分钟）`)
  }
  return value
}

// ── Resume after an interruption (停止 / 应用退出) ──
// A batch's rows may be attempted more than once: continuing a batch appends a
// new WAVE of child rows for the unfinished indices under the SAME parent. A
// row's outcome is therefore its LATEST attempt's status — every read below
// folds the children to one attempt per row_index before counting.

/** Latest attempt per CSV row index. `children` must come ordered by
 *  started_at (then rowid) ascending — the last occurrence of an index wins. */
export function latestAttemptsByIndex(children: RoutineRun[]): Map<number, RoutineRun> {
  const latest = new Map<number, RoutineRun>()
  for (const c of children) {
    if (c.rowIndex == null) continue
    latest.set(c.rowIndex, c)
  }
  return latest
}

/** A row needs (re)running when its latest attempt is missing or did not
 *  succeed — failed rows re-run, skipped rows run for the first time. */
export function planResumeRows(totalRows: number, children: RoutineRun[]): ResumePlan {
  const latest = latestAttemptsByIndex(children)
  const snapshotParams = new Map<number, Record<string, string>>()
  const csvIndices: number[] = []
  const indices: number[] = []
  for (let i = 0; i < totalRows; i++) {
    const last = latest.get(i)
    if (last?.status === 'success') continue
    indices.push(i)
    // The snapshot rule: a row that RAN is frozen to the values it ran with
    // (the CSV may have changed under it) — a failed attempt with a
    // conversation is the one shape that proves the row ran. Everything else
    // pending never reached the engine (never dispatched by the crash, queued
    // at the stop, or killed at the parameter pre-check), so continuing takes
    // its values from the live CSV — the user's fix to the file is exactly
    // what resuming should pick up.
    if (last && last.status === 'failed' && last.conversationId && last.paramsSnapshot) {
      snapshotParams.set(i, last.paramsSnapshot)
    } else {
      csvIndices.push(i)
    }
  }
  return { indices, snapshotParams, csvIndices }
}

export interface ResumePlan {
  /** CSV row indices to execute, ascending. */
  indices: number[]
  /** Per-index values frozen from the row's latest attempt. */
  snapshotParams: Map<number, Record<string, string>>
  /** Indices that read their values from the live CSV at resume time (never
   *  attempted rows, and rows that failed the parameter pre-check without
   *  ever reaching an engine). */
  csvIndices: number[]
}

/** Progress over a batch's children, folded to the latest attempt per row.
 *  `total` is the batch's declared row count — the honest denominator before
 *  every row has been dispatched (children only exist once dispatched), and
 *  the stable one once resumed waves outnumber the rows. */
export function progressFromAttempts(children: RoutineRun[], totalRows: number): RoutineBatchProgress {
  const latest = latestAttemptsByIndex(children)
  const progress: RoutineBatchProgress = { total: totalRows, success: 0, failed: 0, skipped: 0, running: 0 }
  for (const run of latest.values()) {
    if (run.status === 'success') progress.success++
    else if (run.status === 'failed') progress.failed++
    else if (run.status === 'skipped') progress.skipped++
    else if (run.status === 'running') progress.running++
  }
  return progress
}
