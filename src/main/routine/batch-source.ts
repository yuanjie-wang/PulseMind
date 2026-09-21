// ── Batch CSV source (PLAN-routine-batch M3) ──
// Reads + validates the CSV a batch run executes against. The FILE is the only
// source of truth: it is re-read at every batch start (a scheduled nightly
// batch picks up the rows the user edited that day), so a moved/deleted file
// fails the run up front with the path in the error — never a silent stale
// snapshot.
//
// Encoding reality: CSVs exported by Chinese Windows Excel are GBK. The read
// therefore tries strict UTF-8 first and falls back to strict GBK (Electron's
// main process ships full ICU, so TextDecoder needs no dependency), and only
// then asks the user to re-save — instead of showing them mojibake params.

import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { parseCsv } from '../../shared/routine/csv'
import { analyzeCsvBatch, MAX_BATCH_FILE_BYTES, MAX_BATCH_ROWS, type CsvPreview } from '../../shared/routine/batch'
import type { CsvBatchAnalysis } from '../../shared/routine/batch'
import type { Routine, RoutineParam } from '../../shared/types/routine'

export interface BatchSource {
  headers: string[]
  rows: string[][]
  analysis: CsvBatchAnalysis
  csvName: string
}

export const PREVIEW_ROW_COUNT = 10

export function previewCsv(filePath: string, params: RoutineParam[] | undefined): CsvPreview {
  const csvPath = filePath?.trim()
  if (!csvPath) throw new Error('未选择批量数据文件')
  let size: number
  try {
    size = statSync(csvPath).size
  } catch {
    throw new Error(`批量数据文件不存在或不可读：${csvPath}`)
  }
  if (size > MAX_BATCH_FILE_BYTES) {
    throw new Error(`批量数据文件超过 ${Math.floor(MAX_BATCH_FILE_BYTES / 1024 / 1024)}MB 上限，请拆分后重试`)
  }
  const table = parseCsv(decodeCsvBytes(readFileSync(csvPath)))
  if (table.headers.length === 0) throw new Error('批量数据文件为空或缺少表头行')
  return {
    csvName: basename(csvPath),
    headers: table.headers,
    previewRows: table.rows.slice(0, PREVIEW_ROW_COUNT),
    totalRows: table.rows.length,
    analysis: analyzeCsvBatch(table.headers, table.rows, params),
    overRowLimit: table.rows.length > MAX_BATCH_ROWS,
  }
}

/** UTF-8 strict → GBK strict → a refusal the user can act on. */
export function decodeCsvBytes(buf: Buffer): string {
  const clean = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(clean)
  } catch { /* not valid UTF-8 — try the spreadsheet-legacy encoding */ }
  try {
    return new TextDecoder('gbk', { fatal: true }).decode(clean)
  } catch { /* neither — say so instead of showing mojibake params */ }
  throw new Error('无法识别批量数据文件的编码，请将 CSV 另存为 UTF-8 编码后重试')
}

export function loadBatchSource(routine: Routine): BatchSource {
  const csvPath = routine.batch?.csvPath?.trim()
  if (!csvPath) throw new Error('未配置批量数据文件')
  let size: number
  try {
    size = statSync(csvPath).size
  } catch {
    throw new Error(`批量数据文件不存在或不可读：${csvPath}`)
  }
  if (size > MAX_BATCH_FILE_BYTES) {
    throw new Error(`批量数据文件超过 ${Math.floor(MAX_BATCH_FILE_BYTES / 1024 / 1024)}MB 上限，请拆分后重试`)
  }
  const table = parseCsv(decodeCsvBytes(readFileSync(csvPath)))
  if (table.headers.length === 0) throw new Error('批量数据文件为空或缺少表头行')
  const analysis = analyzeCsvBatch(table.headers, table.rows, routine.params)
  if (analysis.missingRequiredHeaders.length > 0) {
    throw new Error(`批量数据缺少必填参数的列：${analysis.missingRequiredHeaders.join('、')}`)
  }
  if (table.rows.length === 0) throw new Error('批量数据文件没有数据行')
  if (table.rows.length > MAX_BATCH_ROWS) {
    throw new Error(`批量数据共 ${table.rows.length} 行，超过单批 ${MAX_BATCH_ROWS} 行的上限，请拆分文件后重试`)
  }
  return { headers: table.headers, rows: table.rows, analysis, csvName: basename(csvPath) }
}
