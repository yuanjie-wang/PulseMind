// ── Routine batch: constants + CSV↔param mapping (PLAN-routine-batch) ──
// Pure logic shared by the main-process batch runner and the renderer's
// preview. The contract (L2): a header matches a param key exactly after
// trimming the HEADER (param keys are authored, not typed into a spreadsheet);
// columns without a param are ignored but surfaced; required params without a
// column refuse the whole batch; a row whose required cell resolves blank is
// that row's failure, not the batch's.

import type { RoutineParam } from '../types/routine'

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
