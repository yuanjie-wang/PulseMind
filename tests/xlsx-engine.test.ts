// PLAN-office-editing T14 — the xlsx engine over a synthetic workbook:
// set_cell (value / formula / number format) with read-back, find_replace
// touching values but never formulas by default, sheet inventory invariance,
// and the scan refusals (charts, legacy OLE). exceljs is pure JS so this runs
// in plain vitest.

import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { editXlsx, scanXlsx, xlsxOutline } from '../src/main/xlsx/engine'

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
