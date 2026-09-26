// PLAN-office-editing T14 — the xlsx engine over a synthetic workbook:
// set_cell (value / formula / number format) with read-back, find_replace
// touching values but never formulas by default, sheet inventory invariance,
// and the scan refusals (charts, legacy OLE). exceljs is pure JS so this runs
// in plain vitest.

import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import AdmZip from 'adm-zip'
import { editXlsx, scanXlsx, xlsxOutline } from '../src/main/xlsx/engine'
import { needsOOXMLPath, editXlsxOOXML } from '../src/main/xlsx/ooxml-edit'

async function buildWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Data')
  ws.getCell('A1').value = 'name'
  ws.getCell('B1').value = 10
  ws.getCell('B2').value = { formula: 'B1*3' }
  const cfg = wb.addWorksheet('Config')
  cfg.getCell('A1').value = 'alpha=1'
  return Buffer.from(await wb.xlsx.writeBuffer())
}

describe('scanXlsx (L6 precheck)', () => {
  it('accepts a plain workbook', async () => {
    expect(scanXlsx(await buildWorkbook()).ok).toBe(true)
  })

  it('refuses an OLE blob (.xls / encrypted) with the save-as hint', () => {
    const result = scanXlsx(Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), Buffer.alloc(32)]))
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('另存为')
  })

  it('refuses a workbook carrying charts (exceljs would drop them)', () => {
    const zip = new (require('adm-zip') as typeof import('adm-zip'))()
    zip.addFile('xl/workbook.xml', Buffer.from('<workbook/>'))
    zip.addFile('xl/charts/chart1.xml', Buffer.from('<chart/>'))
    const result = scanXlsx(zip.toBuffer())
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('图表')
  })

  // review 2026-09-26 中7: conditionalFormatting is an element INSIDE the
  // sheet XML, never a zip entry name — the rule used to sit in the
  // entry-name scan where it could never fire, and a dxf-carrying workbook
  // sailed past the friendly refusal into the measured exceljs crash.
  it('refuses a workbook whose sheet XML carries conditional formatting', () => {
    const zip = new (require('adm-zip') as typeof import('adm-zip'))()
    zip.addFile('xl/workbook.xml', Buffer.from('<workbook/>'))
    zip.addFile('xl/worksheets/sheet1.xml', Buffer.from(
      '<worksheet><conditionalFormatting sqref="A1:A2"><cfRule type="cellIs" dxfId="0" priority="1"/></conditionalFormatting></worksheet>'
    ))
    const result = scanXlsx(zip.toBuffer())
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('条件格式')
  })
})

describe('editXlsx', () => {
  it('set_cell writes value and number format, verified by read-back', async () => {
    const outcome = await editXlsx(await buildWorkbook(), [
      { op: 'set_cell', sheet: 'Data', cell: 'B1', value: 99, number_format: '0.00' },
    ])
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(outcome.buffer as unknown as ArrayBuffer)
    const cell = wb.getWorksheet('Data').getCell('B1')
    expect(cell.value).toBe(99)
    expect(cell.numFmt).toBe('0.00')
  })

  it('set_cell with a formula reads back the formula string', async () => {
    const outcome = await editXlsx(await buildWorkbook(), [
      { op: 'set_cell', sheet: 'Data', cell: 'C1', formula: 'SUM(B1:B2)' },
    ])
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(outcome.buffer as unknown as ArrayBuffer)
    expect(wb.getWorksheet('Data').getCell('C1').formula).toBe('SUM(B1:B2)')
  })

  it('find_replace rewrites values and leaves formulas alone by default (L7)', async () => {
    const outcome = await editXlsx(await buildWorkbook(), [
      { op: 'find_replace', sheet: 'Config', find: 'alpha', replace: 'beta' },
    ])
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(outcome.buffer as unknown as ArrayBuffer)
    expect(wb.getWorksheet('Config').getCell('A1').value).toBe('beta=1')
    expect(wb.getWorksheet('Data').getCell('B2').formula).toBe('B1*3')
  })

  it('the sheet inventory is invariant (gate)', async () => {
    const outcome = await editXlsx(await buildWorkbook(), [{ op: 'inspect' }])
    expect(outcome.outline.map((o) => o.sheet)).toEqual(['Data', 'Config'])
    expect(xlsxOutline).toBeInstanceOf(Function)
  })

  it('a failed op aborts the batch (all-or-nothing)', async () => {
    const before = await buildWorkbook()
    await expect(
      editXlsx(before, [
        { op: 'set_cell', sheet: 'Data', cell: 'B1', value: 5 },
        { op: 'set_cell', sheet: 'Nope', cell: 'A1', value: 1 },
      ]),
    ).rejects.toThrow(/整批未应用/)
  })
})

// ── OOXML direct-edit path (P2.4) ──

/** Build a workbook with a chart entry to trigger OOXML path. */
async function buildWorkbookWithChart(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Sales')
  ws.getCell('A1').value = 'Product'
  ws.getCell('B1').value = 'Revenue'
  ws.getCell('A2').value = 'Widget'
  ws.getCell('B2').value = 100
  ws.getCell('A3').value = 'Gadget'
  ws.getCell('B3').value = 200
  const base = Buffer.from(await wb.xlsx.writeBuffer())
  // Inject a chart entry to make scanXlsx refuse but needsOOXMLPath detect
  const zip = new AdmZip(base)
  zip.addFile('xl/charts/chart1.xml', Buffer.from('<?xml version="1.0"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart/></c:chartSpace>'))
  return zip.toBuffer()
}

describe('needsOOXLPath', () => {
  it('returns true for workbook with charts', async () => {
    expect(needsOOXMLPath(await buildWorkbookWithChart())).toBe(true)
  })

  it('returns false for plain workbook', async () => {
    expect(needsOOXMLPath(await buildWorkbook())).toBe(false)
  })

  it('returns false for non-ZIP buffer', () => {
    expect(needsOOXMLPath(Buffer.from('not a zip'))).toBe(false)
  })
})

describe('editXlsxOOXML', () => {
  it('set_cell modifies cell value in chart-containing workbook', async () => {
    const buffer = await buildWorkbookWithChart()
    const outcome = await editXlsxOOXML(buffer, [
      { op: 'set_cell', sheet: 'Sales', cell: 'B2', value: 999 },
    ])
    expect(outcome.results).toHaveLength(1)
    expect(outcome.results[0].ok).toBe(true)
    // Verify via ExcelJS (reading, not writing — safe for charts)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(outcome.buffer as unknown as ArrayBuffer)
    expect(wb.getWorksheet('Sales').getCell('B2').value).toBe(999)
  })

  it('set_cell with formula sets formula in OOXML path', async () => {
    const buffer = await buildWorkbookWithChart()
    const outcome = await editXlsxOOXML(buffer, [
      { op: 'set_cell', sheet: 'Sales', cell: 'C2', formula: 'B2*2' },
    ])
    expect(outcome.results[0].ok).toBe(true)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(outcome.buffer as unknown as ArrayBuffer)
    expect(wb.getWorksheet('Sales').getCell('C2').formula).toBe('B2*2')
  })

  it('inspect returns sheet inventory in OOXML path', async () => {
    const buffer = await buildWorkbookWithChart()
    const outcome = await editXlsxOOXML(buffer, [{ op: 'inspect' }])
    expect(outcome.results).toHaveLength(1)
    expect(outcome.results[0].ok).toBe(true)
    expect(outcome.results[0].detail).toContain('OOXML 直改模式')
  })

  it('unknown op throws in OOXML path', async () => {
    const buffer = await buildWorkbookWithChart()
    await expect(
      editXlsxOOXML(buffer, [{ op: 'add_row', after_row: 1, values: ['x'] }]),
    ).rejects.toThrow(/不支持/)
  })

  it('invalid cell address throws', async () => {
    const buffer = await buildWorkbookWithChart()
    await expect(
      editXlsxOOXML(buffer, [{ op: 'set_cell', cell: '123', value: 1 }]),
    ).rejects.toThrow(/非法/)
  })
})
