// ── Markdown → sheet model (PLAN-office-export, D4) ──
// Each H2 heading opens a sheet named by the heading; tables feed the current
// sheet's grid. Sheet names are sanitized to exceljs's constraints (≤31
// chars, no []:*?/\ ) and deduped with the D6 -2 suffix — the same convention
// the file-name side uses, one dimension down.

import { marked } from 'marked'
import ExcelJS from 'exceljs'
import { typedRows } from './cell-type'

export interface SheetModel {
  name: string
  rows: string[][]
}

/** Sheet models → a real .xlsx buffer, fully in memory (any failure here =
 *  zero bytes on disk — the service's read-back gate then never sees one). */
export async function sheetsToXlsxBuffer(sheets: SheetModel[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  // 名字自检（full_20261011 M11-P1-2）：exceljs 对 >31 字符静默截断、对重名
  // 表抛错——两个行为叠加就是「截断撞名整单失败，报错还不可诊断」。入口先
  // 断言，把违例变成一句可读的话。
  const seen = new Set<string>()
  for (const sheet of sheets) {
    if (sheet.name.length > EXCEL_SHEET_MAX) {
      throw new Error(`工作表名超过 ${EXCEL_SHEET_MAX} 字符：${sheet.name.slice(0, 40)}`)
    }
    const key = sheet.name.toLowerCase()
    if (seen.has(key)) throw new Error(`工作表重名：${sheet.name}`)
    seen.add(key)
    const ws = wb.addWorksheet(sheet.name)
    for (const row of typedRows(sheet.rows)) ws.addRow(row)
    // M5 rider (PLAN-office-expressiveness §2.5): the generated artifact stops
    // being a bare value grid — first row bold (headers) and every column
    // sized to its longest cell (+2, capped 50). Excel's own unit math makes
    // the exact width cosmetic; the point is readable-on-open.
    if (sheet.rows.length > 0) {
      const header = ws.getRow(1)
      if (header) header.font = { ...header.font, bold: true }
      const colCount = ws.columnCount
      for (let c = 1; c <= colCount; c++) {
        let max = 0
        ws.eachRow((row) => {
          const v = row.getCell(c).value
          const len = v === null || v === undefined ? 0 : String(typeof v === 'object' && v !== null && 'formula' in (v as object) ? (v as { result?: unknown }).result ?? '' : v).length
          if (len > max) max = len
        })
        ws.getColumn(c).width = Math.min(max + 2, 50)
      }
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer())
}

const EXCEL_SHEET_MAX = 31
const EXCEL_SHEET_FORBIDDEN = /[\\[\]:*?/]/g
const DEFAULT_SHEET = 'Sheet1'

/** Sanitize one sheet name: forbidden chars out, 31-char cap, empty →
 *  default. (Apostrophe edge cases Excel also forbids — leading/trailing ' —
 *  are stripped by the same pass.) */
export function sanitizeSheetName(raw: string): string {
  let name = raw.replace(EXCEL_SHEET_FORBIDDEN, '').replace(/^'+|'+$/g, '').trim()
  if (name.length > EXCEL_SHEET_MAX) name = name.slice(0, EXCEL_SHEET_MAX)
  return name === '' ? DEFAULT_SHEET : name
}

/** Assign final names: dedupe case-insensitively (Excel's rule) with `-2`,
 *  `-3`… — D6 at sheet granularity. The suffix counts against the 31-char
 *  budget (full_20261011 M11-P1-2): appending to an already-31-char name used
 *  to push it over, exceljs silently truncated back to 31 and the NEXT
 *  addWorksheet hit a duplicate-name throw — the whole export died. */
export function dedupeSheetNames(names: string[]): string[] {
  const used = new Set<string>()
  const out: string[] = []
  for (const original of names) {
    if (!used.has(original.toLowerCase())) {
      used.add(original.toLowerCase())
      out.push(original)
      continue
    }
    let n = 2
    for (;;) {
      const suffix = `-${n}`
      const candidate = original.slice(0, EXCEL_SHEET_MAX - suffix.length) + suffix
      if (!used.has(candidate.toLowerCase())) {
        used.add(candidate.toLowerCase())
        out.push(candidate)
        break
      }
      n++
    }
  }
  return out
}

/** Markdown string → sheet models. `## 标题` opens a sheet; a table before
 *  any heading lands in the default sheet. Cells come out as plain strings
 *  (inline markup flattened) — typing is cell-type.ts's job. */
export function markdownToSheets(md: string): SheetModel[] {
  const tokens = marked.lexer(md) as unknown as MarkedToken[]
  const raw: SheetModel[] = []
  let current: SheetModel | null = null

  const sheetFor = (): SheetModel => {
    if (!current) {
      current = { name: DEFAULT_SHEET, rows: [] }
      raw.push(current)
    }
    return current
  }

  for (const token of tokens) {
    if (token.type === 'heading' && token.depth === 2) {
      current = { name: sanitizeSheetName(token.text.trim()), rows: [] }
      raw.push(current)
      continue
    }
    if (token.type === 'table') {
      const sheet = sheetFor()
      const header = token.header ?? []
      const body = token.rows ?? []
      sheet.rows.push(header.map((cell) => flattenInline(cell.tokens)))
      for (const row of body) sheet.rows.push(row.map((cell) => flattenInline(cell.tokens)))
    }
  }

  const names = dedupeSheetNames(raw.map((s) => s.name))
  return raw.map((s, i) => ({ ...s, name: names[i] }))
}

/** flattenInline mirrors marked's cell flattening for the docx module too. */
type MarkedToken = {
  type: string
  depth?: number
  text: string
  header?: MarkedCell[]
  rows?: MarkedCell[][]
  ordered?: boolean
  items?: Array<{ tokens?: MarkedToken[] }>
  tokens?: MarkedToken[]
  lang?: string
}
type MarkedCell = { text: string; tokens?: MarkedToken[] }

/** The plain text of an inline token tree — outermost token's markup dropped,
 *  inner text kept (v1: no style recursion in cells). */
export function flattenInline(tokens?: MarkedToken[]): string {
  if (!tokens) return ''
  return tokens
    .map((t) => (t.tokens && t.tokens.length > 0 ? flattenInline(t.tokens) : t.text ?? ''))
    .join('')
}
