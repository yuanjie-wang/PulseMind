// ── CSV output and input (PLAN-office-export) ──
// Output: RFC-4180 quoting, UTF-8 **with BOM** — the BOM is what keeps WPS and
// Excel from reading a Chinese column as mojibake on double-click-open.
// Input: exceljs's CSV reader (the same pipeline xlsx writes through), so a
// CSV sourcePath and an xlsx export share one parse.

import { Readable } from 'node:stream'
import ExcelJS from 'exceljs'
import type { SheetModel } from './md-tables'

const BOM = '\uFEFF'

function csvEscape(field: string): string {
  if (/[",\r\n]/.test(field)) return `"${field.replace(/"/g, '""')}"`
  return field
}

/** The first sheet → a BOM-prefixed CSV string. CSV has exactly one grid; a
 *  multi-sheet workbook exported as CSV delivers its first sheet. */
export function csvFromSheet(sheet: SheetModel): string {
  const lines = sheet.rows.map((row) => row.map((cell) => csvEscape(cell ?? '')).join(','))
  return BOM + lines.join('\r\n') + '\r\n'
}

/** A CSV string → sheet model (named, typed at build time like any source). */
export async function csvToSheet(csv: string, name = 'Sheet1'): Promise<SheetModel> {
  const wb = new ExcelJS.Workbook()
  // Strip the BOM a previous export wrote — exceljs treats it as cell text.
  const body = csv.charCodeAt(0) === 0xfeff ? csv.slice(1) : csv
  await wb.csv.read(Readable.from(body, { encoding: 'utf8' }))
  const ws = wb.worksheets[0]
  if (!ws) return { name, rows: [] }
  const rows: string[][] = []
  ws.eachRow({ includeEmpty: false }, (row) => {
    const values: string[] = []
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      values[colNumber - 1] = cellText(cell.value)
    })
    for (let i = 0; i < values.length; i++) if (values[i] === undefined) values[i] = ''
    rows.push(values)
  })
  return { name, rows }
}

/** ExcelJS cell value → the string the sheet model carries (formulas via
 *  their cached result; rich text flattened; null → ''). */
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return ''
  const asRecord = value as unknown as Record<string, unknown>
  if (typeof value === 'object' && 'result' in asRecord) {
    return String(asRecord.result ?? '')
  }
  if (typeof value === 'object' && 'richText' in asRecord) {
    return ((asRecord.richText as Array<{ text: string }>) ?? []).map((r) => r.text).join('')
  }
  return String(value)
}
