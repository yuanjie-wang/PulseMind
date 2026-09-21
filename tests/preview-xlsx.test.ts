// ── XLSX preview pure model (PLAN-xlsx-preview) ── covers the shared grid
// builder in src/shared/preview/xlsx.ts: coordinate letters/refs, dimension
// conversion, ARGB colours, the number/date format families, and the capped,
// merge-resolved grid — plus the PreviewContent wiring that routes .xlsx to
// the renderer (source scan; vitest here is node-env, no DOM).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  argbToCss,
  buildSheetGrid,
  colWidthPx,
  columnLetter,
  formatCellValue,
  parseCellRef,
  parseRange,
  rowHeightPx,
  XLSX_DEFAULT_COL_WIDTH_PX,
  XLSX_DEFAULT_ROW_HEIGHT_PX,
  XLSX_PREVIEW_COL_LIMIT,
  XLSX_PREVIEW_ROW_LIMIT,
  type XlsxSheetInput,
} from '../src/shared/preview/xlsx'

describe('coordinates', () => {
  it('columnLetter walks the bijective base-26 alphabet', () => {
    expect(columnLetter(1)).toBe('A')
    expect(columnLetter(26)).toBe('Z')
    expect(columnLetter(27)).toBe('AA')
    expect(columnLetter(52)).toBe('AZ')
    expect(columnLetter(53)).toBe('BA')
    expect(columnLetter(702)).toBe('ZZ')
    expect(columnLetter(703)).toBe('AAA')
  })

  it('parseCellRef / parseRange read A1-notation', () => {
    expect(parseCellRef('A1')).toEqual({ row: 1, col: 1 })
    expect(parseCellRef('BC23')).toEqual({ row: 23, col: 26 * 2 + 3 })
    expect(parseCellRef('1A')).toBeNull()
    expect(parseCellRef('')).toBeNull()
    expect(parseRange('A1:C1')).toEqual({ top: 1, left: 1, bottom: 1, right: 3 })
    expect(parseRange('B2')).toEqual({ top: 2, left: 2, bottom: 2, right: 2 })
    expect(parseRange('nope')).toBeNull()
  })
})

describe('geometry', () => {
  it('colWidthPx converts characters→px with the classic formula, defaulting when absent', () => {
    expect(colWidthPx(undefined)).toBe(XLSX_DEFAULT_COL_WIDTH_PX)
    expect(colWidthPx(8.43)).toBe(Math.round(8.43 * 7) + 5)
    expect(colWidthPx(0)).toBe(8) // floor keeps a zero-width column reachable
  })

  it('rowHeightPx converts points→px at 96dpi, defaulting when absent', () => {
    expect(rowHeightPx(undefined)).toBe(XLSX_DEFAULT_ROW_HEIGHT_PX)
    expect(rowHeightPx(15)).toBe(20)
    expect(rowHeightPx(0)).toBe(8)
  })
})

describe('colours', () => {
  it('argbToCss maps exceljs ARGB to CSS', () => {
    expect(argbToCss('FF4472C4')).toBe('#4472C4')
    expect(argbToCss('4472C4')).toBe('#4472C4')
    expect(argbToCss('804472C4')).toBe('rgba(68, 114, 196, 0.5)')
    expect(argbToCss(undefined)).toBeNull()
    expect(argbToCss('nope')).toBeNull()
  })
})

describe('formatCellValue', () => {
  it('empties, booleans and plain strings', () => {
    expect(formatCellValue(null)).toEqual({ text: '', kind: 'empty' })
    expect(formatCellValue('')).toEqual({ text: '', kind: 'empty' })
    expect(formatCellValue(true)).toMatchObject({ text: 'TRUE', kind: 'value' })
    expect(formatCellValue(false)).toMatchObject({ text: 'FALSE', kind: 'value' })
    expect(formatCellValue('文本')).toMatchObject({ text: '文本', kind: 'value' })
  })

  it('numbers through the common numFmt families', () => {
    expect(formatCellValue(1234.5, 'General')).toMatchObject({ text: '1234.5' })
    expect(formatCellValue(1234.5, '#,##0.00')).toMatchObject({ text: '1,234.50' })
    expect(formatCellValue(1234.5, '0.00')).toMatchObject({ text: '1234.50' })
    expect(formatCellValue(0.25, '0%')).toMatchObject({ text: '25%' })
    expect(formatCellValue(-0.25, '0.00%')).toMatchObject({ text: '-25.00%' })
    expect(formatCellValue(1234.5, '¥#,##0.00')).toMatchObject({ text: '¥1,234.50' })
    expect(formatCellValue(-1234.5, '¥#,##0.00')).toMatchObject({ text: '-¥1,234.50' })
    // A format outside the recognised families degrades to the raw number,
    // never a guess.
    expect(formatCellValue(1234.5, '0.00E+00')).toMatchObject({ text: '1234.5' })
    // Trailing-# fractions trim their zeros.
    expect(formatCellValue(1.5, '0.###')).toMatchObject({ text: '1.5' })
    expect(formatCellValue(1, '0.###')).toMatchObject({ text: '1' })
  })

  it('dates ride the cell pattern; undated numbers do not invent one', () => {
    const d = new Date(2026, 8, 18, 14, 30, 9)
    expect(formatCellValue(d, 'yyyy-mm-dd')).toMatchObject({ text: '2026-09-18' })
    expect(formatCellValue(d, 'yyyy/mm/dd hh:mm:ss')).toMatchObject({ text: '2026/09/18 14:30:09' })
    expect(formatCellValue(d, 'yyyy"年"m"月"d"日"')).toMatchObject({ text: '2026年9月18日' })
    expect(formatCellValue(d, 'h:mm AM/PM')).toMatchObject({ text: '2:30 PM' })
    // No usable pattern → ISO, time dropped when midnight.
    expect(formatCellValue(new Date(2026, 8, 18), undefined)).toMatchObject({ text: '2026-09-18' })
    expect(formatCellValue(d, undefined)).toMatchObject({ text: '2026-09-18 14:30:09' })
  })

  it('formulas show the cached result, else the formula itself', () => {
    expect(formatCellValue({ formula: 'B2*2', result: 10 })).toMatchObject({ text: '10', kind: 'value' })
    const noCache = formatCellValue({ formula: 'SUM(A1:A9)' })
    expect(noCache).toMatchObject({ text: '=SUM(A1:A9)', kind: 'formula' })
    expect(formatCellValue({ sharedFormula: 'B3', formula: 'B2*2', result: 4 })).toMatchObject({ text: '4' })
  })

  it('rich text joins runs; links carry their URL; errors surface in kind', () => {
    expect(formatCellValue({ richText: [{ text: '甲' }, { text: '乙' }] })).toMatchObject({ text: '甲乙', kind: 'value' })
    const link = formatCellValue({ text: '站点', hyperlink: 'https://example.com' })
    expect(link).toMatchObject({ text: '站点', kind: 'link', link: 'https://example.com' })
    expect(formatCellValue({ error: '#N/A' })).toMatchObject({ text: '#N/A', kind: 'error' })
  })
})

function gridInput(over: Partial<XlsxSheetInput>): XlsxSheetInput {
  return {
    name: 'S',
    rowCount: 0,
    columnCount: 0,
    getCell: () => undefined,
    ...over,
  }
}

describe('buildSheetGrid', () => {
  it('caps the window and reports what it dropped', () => {
    const grid = buildSheetGrid(
      gridInput({
        rowCount: XLSX_PREVIEW_ROW_LIMIT + 7,
        columnCount: XLSX_PREVIEW_COL_LIMIT + 3,
      })
    )
    expect(grid.cells).toHaveLength(XLSX_PREVIEW_ROW_LIMIT)
    expect(grid.cells[0]).toHaveLength(XLSX_PREVIEW_COL_LIMIT)
    expect(grid.truncatedRows).toBe(true)
    expect(grid.truncatedCols).toBe(true)
    expect(grid.totalRows).toBe(XLSX_PREVIEW_ROW_LIMIT + 7)
    expect(grid.totalCols).toBe(XLSX_PREVIEW_COL_LIMIT + 3)
    const inside = buildSheetGrid(gridInput({ rowCount: 5, columnCount: 4 }))
    expect(inside.truncatedRows).toBe(false)
    expect(inside.truncatedCols).toBe(false)
  })

  it('renders merges as a spanned master plus covered nulls, clipping at the cap', () => {
    const grid = buildSheetGrid(
      gridInput({
        rowCount: 4,
        columnCount: 4,
        merges: ['A1:C1', 'B3:D5'], // second one runs off the cap's edge
        getCell: (r, c) => (r === 1 && c === 1 ? { value: '标题' } : undefined),
      })
    )
    const master = grid.cells[0][0]
    expect(master).toMatchObject({ text: '标题', colSpan: 3, rowSpan: 1 })
    expect(grid.cells[0][1]).toBeNull()
    expect(grid.cells[0][2]).toBeNull()
    expect(grid.cells[0][3]).toMatchObject({ text: '' }) // outside the merge
    // B3:D5 clips to the 4×4 window: master keeps rowSpan 2, colSpan 3.
    expect(grid.cells[2][1]).toMatchObject({ rowSpan: 2, colSpan: 3 })
    expect(grid.cells[3][3]).toBeNull() // D5 is inside the clipped box
    // A merge starting beyond the cap materialises nothing.
    const big = buildSheetGrid(
      gridInput({ rowCount: 2, columnCount: 2, merges: ['A10:B12'], getCell: () => undefined })
    )
    expect(big.cells.flat().every((c) => c !== null)).toBe(true)
  })

  it('maps fonts, solid fills, alignment and real borders onto the VM', () => {
    const grid = buildSheetGrid(
      gridInput({
        rowCount: 2,
        columnCount: 2,
        getCell: (r, c) => {
          if (r === 1 && c === 1) {
            return {
              value: '样式',
              font: { name: '宋体', size: 14, bold: true, italic: true, color: { argb: 'FF333333' } },
              fill: { pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } },
              alignment: { horizontal: 'center', vertical: 'middle', wrapText: true, indent: 1 },
              border: {
                top: { style: 'thin', color: { argb: 'FF000000' } },
                left: { style: 'hair' },
                bottom: { style: 'none' },
              },
            }
          }
          return undefined
        },
      })
    )
    expect(grid.cells[0][0]).toMatchObject({
      text: '样式',
      fontFamily: '宋体',
      fontSizePt: 14,
      bold: true,
      italic: true,
      color: '#333333',
      bg: '#FFF2CC',
      hAlign: 'center',
      vAlign: 'middle',
      wrap: true,
      indent: 1,
      borders: { top: '1px solid #000000', left: '1px solid #000' },
    })
    // 'none' borders stay unset, so the grid line shows through.
    expect(grid.cells[0][0]?.borders?.bottom).toBeUndefined()
    // An untouched cell keeps the defaults only.
    expect(grid.cells[0][1]).toMatchObject({ text: '', kind: 'empty' })
    expect(grid.cells[0][1]?.bg).toBeUndefined()
  })

  it('carries per-column widths and per-row heights in pixel space', () => {
    const grid = buildSheetGrid(
      gridInput({
        rowCount: 2,
        columnCount: 3,
        colWidths: [20, undefined, 0],
        rowHeights: [30, undefined],
        getCell: () => undefined,
      })
    )
    expect(grid.colWidths).toEqual([colWidthPx(20), colWidthPx(undefined), colWidthPx(0)])
    expect(grid.rowHeights).toEqual([rowHeightPx(30), rowHeightPx(undefined)])
  })
})

describe('wiring', () => {
  const previewContent = readFileSync(
    join(__dirname, '../src/renderer/src/components/preview/PreviewContent.tsx'),
    'utf8'
  )
  it('PreviewContent routes .xlsx to XlsxPreview (doc/xls/ppt keep markitdown; pdf has its own renderer)', () => {
    expect(previewContent).toContain("import { XlsxPreview } from './XlsxPreview'")
    expect(previewContent).toContain("if (ext === 'xlsx') return <XlsxPreview")
    // DocxPreview is reached through React.lazy — the engine (docx-preview) is a
    // static import in that module and PreviewPane sits in the always-mounted
    // shell, so a static import here puts it in the entry chunk. Asserted as
    // lazy (both halves) so the revert cannot pass.
    expect(previewContent).toContain("(await import('./DocxPreview')).DocxPreview")
    expect(previewContent).toContain("if (ext === 'docx') {")
    expect(previewContent).toContain('<LazyDocxPreview path={path}')
    expect(previewContent).not.toContain("import { DocxPreview } from './DocxPreview'")
    expect(previewContent).toContain("if (ext === 'pdf') return <PdfPreview")
    expect(previewContent).toContain('OfficePreview path={path}')
  })
})
