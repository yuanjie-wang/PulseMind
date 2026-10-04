// ── office_read — paged, structure-faithful reads (PLAN-office-read) ──
// The read the edit tools consume: docx paragraphs in FULL match-space text
// (the outline's 80-char slice was why models probed *_edit for real info),
// xlsx cell values by sheet/range, pptx shapes with shape ids and full text.
// Coordinates are the edit tools' own (paragraph index / cell address /
// shape id; pptx slides in sldIdLst order — the same order the edit tool's slide
// so what a read shows is what an edit addresses. Read-only: no backup, no
// write — but behind the same read guard as every other read mouth (M2).

import AdmZip from 'adm-zip'
import { guardFsTarget } from '../sandbox/guard'
import { buildDocumentModel, GAP_CHAR } from '../docx/model'
import { decodedText, type XmlElementNode } from '../docx/xml-splice'
import { buildSlideModel, slidePartNames } from '../pptx/model'
import { xlsxCellText } from './office-inspect'
import type { OfficeReadInput, OfficeReadResult } from '../../shared/office/ops'

/** Page defaults and hard caps — the LLM's numbers never exceed these, the
 *  formatter's char budget is the second net. */
const DOCX_DEFAULT_LIMIT = 40
const DOCX_MAX_LIMIT = 200
const XLSX_DEFAULT_ROWS = 50
const XLSX_MAX_ROWS = 500
const XLSX_MAX_COLS = 60
/** Per-cell text cap in tables mode: a 50×30 grid must stay a tool result. */
const MAX_CELL_CHARS = 120

const isElement = (n: { kind?: string }): n is XmlElementNode => n.kind === 'element'
const renderGaps = (text: string): string => text.replace(new RegExp(GAP_CHAR, 'g'), ' ')

/** Full visible text of one table cell: its `w:p` paragraphs' `w:t` runs
 *  (w:del subtree excluded — deleted-revision text is not what the user
 *  sees), paragraphs joined with a space. The same value space replace_text
 *  matches against, just per-cell instead of per-flat-paragraph. */
function docxCellText(tc: XmlElementNode): string {
  const paragraphs: string[] = []
  const walk = (node: XmlElementNode, current: string): string => {
    let text = current
    for (const child of node.children) {
      if (!isElement(child)) continue
      if (child.name === 'w:del' || child.name === 'mc:Fallback') continue
      if (child.name === 'w:p') {
        paragraphs.push(walk(child, '').trim())
        continue
      }
      if (child.name === 'w:tab' || child.name === 'w:br') {
        text += ' '
        continue
      }
      if (child.name === 'w:r') {
        const textEl = child.children.find((c) => isElement(c) && c.name === 'w:t') as XmlElementNode | undefined
        if (textEl) text += decodedText(textEl).text
        continue
      }
      if (child.children.length > 0) text = walk(child, text)
    }
    return text
  }
  walk(tc, '')
  return paragraphs
    .filter((p) => p.length > 0)
    .join(' ')
    .slice(0, MAX_CELL_CHARS)
}

/** "A1:J50" or "B3" → 1-based [startCol, startRow, endCol, endRow]; null when
 *  the string is not an address. */
function parseRange(range: string): [number, number, number, number] | null {
  const m = /^([A-Za-z]{1,3})(\d{1,7})(?::([A-Za-z]{1,3})(\d{1,7}))?$/.exec(range.trim())
  if (!m) return null
  const colOf = (letters: string): number => {
    let n = 0
    for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
    return n
  }
  const c1 = colOf(m[1])
  const r1 = parseInt(m[2], 10)
  const c2 = m[3] ? colOf(m[3]) : c1
  const r2 = m[4] ? parseInt(m[4], 10) : r1
  return [Math.min(c1, c2), Math.min(r1, r2), Math.max(c1, c2), Math.max(r1, r2)]
}

/** One rendered cell for a read window: formula cells show BOTH the
 *  expression and the cached result — the expression is what set_cell
 *  rewrites, the result is what the reader sees. */
function xlsxReadCellText(cell: { value: unknown; formula?: string }): string {
  if (cell.formula) {
    const result = xlsxCellText(cell)
    return result ? `=${cell.formula} → ${result}` : `=${cell.formula}`
  }
  return xlsxCellText(cell)
}

export async function svcReadOffice(input: OfficeReadInput): Promise<OfficeReadResult> {
  const { filePath } = input
  if (!filePath) return { success: false, format: 'unknown', summary: 'file_path is required', details: {}, error: 'file_path is required' }

  const guard = await guardFsTarget(filePath, 'read')
  if (!guard.ok) {
    return { success: false, format: 'unknown', summary: guard.reason ?? '路径被拒绝', details: {}, error: guard.reason }
  }

  const { readFile } = await import('fs/promises')
  let buffer: Buffer
  try {
    buffer = await readFile(guard.resolved)
  } catch (err: any) {
    return { success: false, format: 'unknown', summary: `无法读取文件: ${err.message}`, details: {}, error: err.message }
  }
  const isZip = buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b
  if (!isZip) {
    return { success: false, format: 'unknown', summary: '不是 OOXML 文件', details: {}, error: '该文件不是 OOXML 格式（.docx/.xlsx/.pptx）' }
  }

  let zip: AdmZip
  try {
    zip = new AdmZip(buffer)
  } catch {
    return { success: false, format: 'unknown', summary: '无法解析 ZIP 包', details: {}, error: '无法读取文件包结构' }
  }
  const names = zip.getEntries().map((e) => e.entryName)

  // ── docx ──
  if (names.includes('word/document.xml')) {
    try {
      const xml = (zip.readFile('word/document.xml') as Buffer).toString('utf8')
      const model = buildDocumentModel(xml)
      const total = model.paragraphs.length
      if (total === 0) {
        return { success: true, format: 'docx', summary: 'Word 文档: 空文档（0 段）', details: { paragraphCount: 0 } }
      }
      const offset = Math.min(Math.max(Math.floor(input.offset ?? 1), 1), total)
      const limit = Math.min(Math.max(Math.floor(input.limit ?? DOCX_DEFAULT_LIMIT), 1), DOCX_MAX_LIMIT)
      const end = Math.min(offset + limit - 1, total)
      const paragraphs = model.paragraphs.slice(offset - 1, end).map((p) => ({
        index: p.index,
        style: p.style,
        text: renderGaps(p.text),
      }))
      const details: OfficeReadResult['details'] = {
        paragraphs,
        paragraphCount: total,
        ...(end < total ? { nextOffset: end + 1 } : {}),
      }
      let tablesNote = ''
      if (input.tables === true && model.tables.length > 0) {
        details.tables = model.tables.map((t) => ({
          index: t.index,
          rows: t.rows.length,
          cols: t.rows[0]?.cells.length ?? 0,
          cells: t.rows.map((r) => r.cells.map(docxCellText)),
        }))
        tablesNote = `, ${model.tables.length} 个表格`
      }
      return {
        success: true,
        format: 'docx',
        summary: `Word 文档: 第 ${offset}–${end} 段 / 共 ${total} 段${tablesNote}`,
        details,
      }
    } catch (err: any) {
      return { success: false, format: 'docx', summary: `解析失败: ${err.message}`, details: {}, error: err.message }
    }
  }

  // ── xlsx ──
  if (names.includes('xl/workbook.xml')) {
    try {
      const ExcelJS = (await import('exceljs')).default
      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.load(buffer as unknown as ArrayBuffer)

      // No sheet named → the sheet inventory IS the answer; naming a sheet
      // from it is the next call. Guessing the first sheet would read the
      // wrong grid one roundtrip away from the same inventory.
      if (!input.sheet) {
        const sheets = workbook.worksheets.map((ws) => ({
          name: ws.name,
          rowCount: ws.rowCount,
          columnCount: ws.columnCount,
        }))
        return {
          success: true,
          format: 'xlsx',
          summary: `Excel 工作簿: ${sheets.map((s) => `${s.name}(${s.rowCount}行×${s.columnCount}列)`).join(', ')}`,
          details: { sheets },
        }
      }

      const ws =
        workbook.worksheets.find((w) => w.name === input.sheet) ??
        workbook.worksheets.find((w) => w.name.toLowerCase() === input.sheet!.toLowerCase())
      if (!ws) {
        return {
          success: false,
          format: 'xlsx',
          summary: `工作表「${input.sheet}」不存在`,
          details: {},
          error: `工作表「${input.sheet}」不存在。可用: ${workbook.worksheets.map((w) => w.name).join(', ')}`,
        }
      }

      const totalRows = ws.rowCount
      const totalCols = ws.columnCount
      let startCol = 1
      let endCol = Math.min(totalCols, XLSX_MAX_COLS)
      let startRow: number
      let endRow: number
      if (input.range) {
        const parsed = parseRange(input.range)
        if (!parsed) {
          return {
            success: false,
            format: 'xlsx',
            summary: `range「${input.range}」不是合法地址`,
            details: {},
            error: `range「${input.range}」不是合法地址（形如 A1:J50 或 B3）`,
          }
        }
        ;[startCol, startRow, endCol, endRow] = parsed
        endCol = Math.min(endCol, startCol + XLSX_MAX_COLS - 1)
        endRow = Math.min(endRow, startRow + XLSX_MAX_ROWS - 1)
      } else {
        startRow = Math.min(Math.max(Math.floor(input.offset ?? 1), 1), Math.max(totalRows, 1))
        endRow = Math.min(startRow + Math.min(Math.max(Math.floor(input.limit ?? XLSX_DEFAULT_ROWS), 1), XLSX_MAX_ROWS) - 1, totalRows)
      }
      const cells: string[][] = []
      for (let r = startRow; r <= endRow; r++) {
        const row = ws.getRow(r)
        const values: string[] = []
        for (let c = startCol; c <= endCol; c++) values.push(xlsxReadCellText(row.getCell(c)))
        cells.push(values)
      }
      const details: OfficeReadResult['details'] = {
        sheet: ws.name,
        startRow,
        cells,
        columnCount: endCol - startCol + 1,
        ...(endRow < totalRows ? { nextOffset: endRow + 1 } : {}),
      }
      return {
        success: true,
        format: 'xlsx',
        summary:
          totalRows === 0
            ? `工作表「${ws.name}」: 空工作表（0 行 × ${totalCols} 列）`
            : `工作表「${ws.name}」: 第 ${startRow}–${endRow} 行 / 共 ${totalRows} 行 × ${totalCols} 列`,
        details,
      }
    } catch (err: any) {
      return { success: false, format: 'xlsx', summary: `解析失败: ${err.message}`, details: {}, error: err.message }
    }
  }

  // ── pptx ──
  if (names.includes('ppt/presentation.xml')) {
    try {
      // sldIdLst order — the order office_edit's `slide` counts (D3: never guess
      // slide identity from filenames). A deck whose rels cannot resolve is
      // refused, not silently reordered: coordinates that would not survive
      // an edit are not coordinates.
      const presXml = (zip.readFile('ppt/presentation.xml') as Buffer).toString('utf8')
      const relsEntry = zip.getEntry('ppt/_rels/presentation.xml.rels')
      const relsXml = relsEntry ? (relsEntry.getData() as Buffer).toString('utf8') : ''
      const slideNames = slidePartNames(presXml, relsXml)
      if (slideNames.length === 0) {
        return {
          success: false,
          format: 'pptx',
          summary: '无法解析幻灯片顺序',
          details: {},
          error: '无法从 presentation.xml 的 sldIdLst 解析出任何幻灯片（rels 缺失或损坏）——拒绝给出与编辑工具错位的页码',
        }
      }
      const wanted = input.slide != null ? Math.floor(input.slide) : null
      if (wanted !== null && (wanted < 1 || wanted > slideNames.length)) {
        return {
          success: false,
          format: 'pptx',
          summary: `第 ${wanted} 页不存在`,
          details: {},
          error: `第 ${wanted} 页不存在（共 ${slideNames.length} 页）`,
        }
      }
      const slides: OfficeReadResult['details']['slides'] = []
      for (let i = 0; i < slideNames.length; i++) {
        const index = i + 1
        if (wanted !== null && index !== wanted) continue
        const xml = (zip.readFile(slideNames[i]) as Buffer).toString('utf8')
        const model = buildSlideModel(xml)
        slides.push({
          index,
          shapes: model.shapes.map((s) => ({
            shapeId: s.id,
            name: s.name,
            ...(s.phType ? { phType: s.phType } : {}),
            text: s.paragraphs.map((p) => renderGaps(p.text)).join('\n'),
          })),
        })
      }
      const shapeTotal = slides.reduce((n, s) => n + s.shapes.length, 0)
      const summary =
        wanted !== null
          ? `PowerPoint: 第 ${wanted} 页（${slides[0]?.shapes.length ?? 0} 形状）`
          : `PowerPoint: 全部 ${slideNames.length} 页（${shapeTotal} 形状）`
      return { success: true, format: 'pptx', summary, details: { slides } }
    } catch (err: any) {
      return { success: false, format: 'pptx', summary: `解析失败: ${err.message}`, details: {}, error: err.message }
    }
  }

  return { success: false, format: 'unknown', summary: '无法识别的 Office 格式', details: {}, error: 'ZIP 包内未找到 word/document.xml、xl/workbook.xml 或 ppt/presentation.xml' }
}
