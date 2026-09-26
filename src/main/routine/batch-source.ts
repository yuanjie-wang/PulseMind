// ── Batch data source (PLAN-routine-batch M3; xlsx per PLAN-batch-resume) ──
// Reads + validates the data file a batch run executes against. The FILE is the
// only source of truth: it is re-read at every batch start (a scheduled nightly
// batch picks up the rows the user edited that day), so a moved/deleted file
// fails the run up front with the path in the error — never a silent stale
// snapshot.
//
// Two formats, one table shape ({ headers, rows }):
//   - .xlsx: the FIRST worksheet through exceljs (lazily imported, the same
//     pattern as xlsx/engine.ts), every cell flattened to the display text the
//     user would see — so a header→param cell means the same thing as in a CSV
//     export. Legacy .xls (pre-2007, not a zip — exceljs cannot read it) is
//     refused with a save-as hint instead of failing obscurely mid-parse.
//   - anything else (.csv, .txt, no extension, .tsv…): the hand-rolled RFC 4180
//     parser. Encoding reality: CSVs exported by Chinese Windows Excel are
//     GBK, so the read tries strict UTF-8 first and falls back to strict GBK
//     (Electron's main process ships full ICU, so TextDecoder needs no
//     dependency), and only then asks the user to re-save — instead of showing
//     them mojibake params. The fallback path is also what older configs point
//     at, which is why unknown extensions keep parsing as CSV.
//
// The read is async from here on (exceljs has no sync load), so start/resume/
// preview all return promises. Refusal messages stay byte-identical.

import { readFileSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { parseCsv, type CsvTable } from '../../shared/routine/csv'
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

/** Open-stat + format dispatch, shared by preview and load: exists, size cap,
 *  then the right parser. Returns the trimmed path alongside the table so the
 *  caller can name the file. */
async function openTable(filePath: string): Promise<{ path: string; table: CsvTable }> {
  const path = filePath.trim()
  let size: number
  try {
    size = statSync(path).size
  } catch {
    throw new Error(`批量数据文件不存在或不可读：${path}`)
  }
  if (size > MAX_BATCH_FILE_BYTES) {
    throw new Error(`批量数据文件超过 ${Math.floor(MAX_BATCH_FILE_BYTES / 1024 / 1024)}MB 上限，请拆分后重试`)
  }
  const ext = extname(path).toLowerCase()
  if (ext === '.xls') {
    throw new Error(`暂不支持 .xls 老格式，请用 Excel 另存为 .xlsx 或 UTF-8 编码的 CSV 后重试：${path}`)
  }
  const table = ext === '.xlsx'
    ? await parseXlsx(readFileSync(path))
    : parseCsv(decodeCsvBytes(readFileSync(path)))
  if (table.headers.length === 0) throw new Error('批量数据文件为空或缺少表头行')
  return { path, table }
}

export async function previewCsv(filePath: string, params: RoutineParam[] | undefined): Promise<CsvPreview> {
  if (!filePath?.trim()) throw new Error('未选择批量数据文件')
  const { path, table } = await openTable(filePath)
  return {
    csvName: basename(path),
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

export async function loadBatchSource(routine: Routine): Promise<BatchSource> {
  const csvPath = routine.batch?.csvPath?.trim()
  if (!csvPath) throw new Error('未配置批量数据文件')
  const { path, table } = await openTable(csvPath)
  const analysis = analyzeCsvBatch(table.headers, table.rows, routine.params)
  if (analysis.missingRequiredHeaders.length > 0) {
    throw new Error(`批量数据缺少必填参数的列：${analysis.missingRequiredHeaders.join('、')}`)
  }
  if (table.rows.length === 0) throw new Error('批量数据文件没有数据行')
  if (table.rows.length > MAX_BATCH_ROWS) {
    throw new Error(`批量数据共 ${table.rows.length} 行，超过单批 ${MAX_BATCH_ROWS} 行的上限，请拆分文件后重试`)
  }
  return { headers: table.headers, rows: table.rows, analysis, csvName: basename(path) }
}

// ── xlsx cell flattening ──

async function parseXlsx(buf: Buffer): Promise<CsvTable> {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf as unknown as ArrayBuffer)
  const ws = wb.worksheets[0]
  if (!ws) return { headers: [], rows: [] }
  const grid: string[][] = []
  ws.eachRow((row) => {
    const cells: string[] = []
    // includeEmpty is load-bearing: cells are keyed by real column anyway, so
    // the point is density — a hole must materialize as '' like the CSV parser
    // yields, not stay a sparse cell (undefined) that only some consumers
    // happen to coalesce. Both formats must produce the SAME table shape.
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      cells[colNumber - 1] = xlsxValueText(cell.value)
    })
    grid.push(cells)
  })
  // Mirror parseCsv's two contracts exactly: fully-blank rows are dropped
  // (the header row is simply the first survivor), and headers are trimmed —
  // cells themselves are NOT (rowParamsAt trims at lookup).
  const kept = grid.filter((r) => !r.every((c) => c === ''))
  const header = kept[0] ?? []
  return { headers: header.map((h) => h.trim()), rows: kept.slice(1) }
}

/** Flatten one exceljs cell value to display text. */
function xlsxValueText(value: import('exceljs').CellValue): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  // Numbers and booleans: String() — 1.5 → '1.5', true → 'true' (a CSV export
  // writes TRUE, but the prompt consumes either; lowercase keeps the value
  // honest to the file's cell type rather than to Excel's export locale).
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  // Dates show as local wall-clock — the same value Excel shows on this
  // machine; a midnight-only date drops the time part (a date column should
  // not read 2026-09-23 00:00:00).
  if (value instanceof Date) return dateText(value)
  if (typeof value === 'object') {
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text ?? '').join('')
    }
    if ('error' in value) return String(value.error) // '#DIV/0!' etc.
    if ('result' in value) return xlsxValueText(value.result as import('exceljs').CellValue) // formula / sharedFormula
    if ('text' in value) {
      const text = (value as { text: unknown }).text
      return typeof text === 'string' ? text : text != null && typeof text === 'object' ? xlsxValueText(text as import('exceljs').CellValue) : ''
    }
    if ('formula' in value || 'sharedFormula' in value) return '' // result-less formula
  }
  return String(value)
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

function dateText(d: Date): string {
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
  return d.getHours() || d.getMinutes() || d.getSeconds()
    ? `${date} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
    : date
}
