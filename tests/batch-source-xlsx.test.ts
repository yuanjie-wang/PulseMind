/** The xlsx data source (PLAN-batch-resume): a real workbook through the
 *  real parser, plus the format/size gates around it. The contract the whole
 *  batch depends on: xlsx flattens to the SAME { headers, rows } table the CSV
 *  parser produces, so mapping, rowParamsAt and the row cap need no xlsx-aware
 *  branch anywhere downstream.
 *
 *  exceljs is pure JS, so this runs under plain Node (same as
 *  tests/xlsx-engine.test.ts) — no Electron, no database.
 *
 *  Non-vacuity: removing the `.xlsx` dispatch makes the workbook tests read a
 *  zip as CSV (headers garbage → these fail); dropping `includeEmpty` shifts
 *  the hole-row columns (the alignment assertion fails); removing the
 *  blank-row filter fails totalRows; the .xls / size / row-cap gates each have
 *  their own refusal literal. */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { loadBatchSource, previewCsv, decodeCsvBytes } from '../src/main/routine/batch-source'
import { MAX_BATCH_FILE_BYTES, MAX_BATCH_ROWS } from '../src/shared/routine/batch'
import type { Routine, RoutineParam } from '../src/shared/types/routine'

const PARAMS: RoutineParam[] = [
  { key: 'name', label: '名称', required: true },
  { key: 'score', label: '分值' },
]

let dir: string
let workbookPath: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pm-batch-xlsx-'))
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('data')

  // Header with spreadsheet whitespace — the trim is the header contract.
  ws.getCell('A1').value = ' name '
  ws.getCell('B1').value = ' score '
  ws.getCell('C1').value = ' note '

  // Row 1: plain string + number.
  ws.getCell('A2').value = ' Alice '
  ws.getCell('B2').value = 1.5

  // Row 2: a HOLE in column B — includeEmpty must keep column C at index 2.
  ws.getCell('A3').value = 'Bob'
  ws.getCell('C3').value = 'after-hole'

  // Row 3: a fully-blank row — dropped like the CSV parser drops blank lines.
  ws.getRow(4).values = [null, '', '', '']

  // Row 4: boolean + number.
  ws.getCell('A5').value = 'Carol'
  ws.getCell('B5').value = true

  workbookPath = join(dir, 'data.xlsx')
  await wb.xlsx.writeFile(workbookPath)
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function routine(batchPath: string, params = PARAMS): Routine {
  return {
    id: 'routine_x', name: 't', description: '', prompt: '检查 {{name}}',
    params, enabled: true, createdAt: '', updatedAt: '',
    batch: { csvPath: batchPath },
  }
}

describe('xlsx → table', () => {
  it('reads headers trimmed and drops the fully-blank row', async () => {
    const preview = await previewCsv(workbookPath, PARAMS)
    expect(preview.headers).toEqual(['name', 'score', 'note'])
    // 4 sheet rows, 1 blank → 3 data rows; csvName is the file's basename.
    expect(preview.totalRows).toBe(3)
    expect(preview.csvName).toBe('data.xlsx')
    expect(preview.overRowLimit).toBe(false)
  })

  it('flattens cells to display text and keeps a hole in its column', async () => {
    const preview = await previewCsv(workbookPath, PARAMS)
    // Cells are NOT trimmed here (only headers are) — rowParamsAt trims at
    // lookup, which the next test asserts.
    expect(preview.previewRows[0]).toEqual([' Alice ', '1.5'])
    // The hole's neighbours stay put: name in 0, empty in 1, value in 2.
    expect(preview.previewRows[1]).toEqual(['Bob', '', 'after-hole'])
    // boolean → String(), lowercase (honest to the cell type, not the locale).
    expect(preview.previewRows[2]).toEqual(['Carol', 'true'])
  })

  it('flattens every typed cell: date, richText, formula±result, hyperlink, error', async () => {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('data')
    ws.getCell('A1').value = 'name'
    ws.getCell('B1').value = 'payload'
    // Dates: numFmt is what makes exceljs read the serial back as a Date (real
    // spreadsheets always carry one). Midnight drops the time part; a timed
    // date keeps it — both as local wall clock, the value Excel shows.
    ws.getCell('A2').value = 'dated'
    ws.getCell('B2').value = new Date(2026, 8, 23, 0, 0, 0)
    ws.getCell('B2').numFmt = 'yyyy-mm-dd'
    ws.getCell('A3').value = 'timed'
    ws.getCell('B3').value = new Date(2026, 8, 23, 9, 5, 0)
    ws.getCell('B3').numFmt = 'yyyy-mm-dd hh:mm:ss'
    // The rest of xlsxValueText's branches, one cell each.
    ws.getCell('A4').value = 'rich'
    ws.getCell('B4').value = { richText: [{ text: 'Ab' }, { text: 'Cd' }] }
    ws.getCell('A5').value = 'formula'
    ws.getCell('B5').value = { formula: 'CONCATENATE(X1,Y1)', result: 'cached' }
    ws.getCell('A6').value = 'no-result'
    ws.getCell('B6').value = { formula: 'SUM(Z1:Z9)' }
    ws.getCell('A7').value = 'link'
    ws.getCell('B7').value = { text: 'click', hyperlink: 'https://example.test' }
    ws.getCell('A8').value = 'err'
    ws.getCell('B8').value = { error: '#DIV/0!' }
    const p = join(dir, 'typed.xlsx')
    await wb.xlsx.writeFile(p)

    const preview = await previewCsv(p, PARAMS)
    const payload = (i: number): unknown => preview.previewRows[i][1]
    expect(payload(0)).toBe('2026-09-23') // midnight-only date drops the time
    expect(payload(1)).toBe('2026-09-23 09:05:00')
    expect(payload(2)).toBe('AbCd')
    expect(payload(3)).toBe('cached') // a formula's cached result is the display value
    expect(payload(4)).toBe('') // result-less formula has no display value yet
    expect(payload(5)).toBe('click') // the visible text, never the URL
    expect(payload(6)).toBe('#DIV/0!')
  })

  it('rowParamsAt consumes the xlsx table exactly like a CSV one', async () => {
    const { rowParamsAt } = await import('../src/shared/routine/batch')
    const preview = await previewCsv(workbookPath, PARAMS)
    expect(rowParamsAt(preview.headers, preview.previewRows, PARAMS, 0)).toEqual({ name: 'Alice', score: '1.5' })
    // Cell trim happens at lookup — the sheet's own whitespace is accidental.
    expect(rowParamsAt(preview.headers, preview.previewRows, PARAMS, 1).name).toBe('Bob')
  })

  it('refuses a required column the workbook does not have', async () => {
    await expect(loadBatchSource(routine(workbookPath, [{ key: 'owner', label: '负责人', required: true }])))
      .rejects.toThrow(/批量数据缺少必填参数的列：owner/)
  })

  it('a header-only workbook refuses as having no data rows', async () => {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('data')
    ws.getCell('A1').value = 'name'
    const p = join(dir, 'header-only.xlsx')
    await wb.xlsx.writeFile(p)
    await expect(loadBatchSource(routine(p))).rejects.toThrow(/没有数据行/)
  })

  it(`refuses more than ${MAX_BATCH_ROWS} rows`, async () => {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('data')
    ws.getRow(1).values = ['name', 'score']
    for (let i = 0; i < MAX_BATCH_ROWS + 1; i++) ws.addRow([`row-${i}`, 1])
    const p = join(dir, 'too-many.xlsx')
    await wb.xlsx.writeFile(p)
    await expect(loadBatchSource(routine(p))).rejects.toThrow(/超过单批 200 行/)
  })
})

describe('format and size gates', () => {
  it('refuses legacy .xls with a save-as hint (before any parse attempt)', async () => {
    const p = join(dir, 'legacy.xls')
    writeFileSync(p, Buffer.from('not really an ole file'))
    await expect(previewCsv(p, PARAMS)).rejects.toThrow(/暂不支持 \.xls 老格式.*另存为 \.xlsx/s)
  })

  it('refuses a file over the size cap before parsing', async () => {
    const p = join(dir, 'huge.csv')
    writeFileSync(p, Buffer.alloc(MAX_BATCH_FILE_BYTES + 1, 0x20))
    await expect(previewCsv(p, PARAMS)).rejects.toThrow(/超过 2MB 上限/)
  })

  it('reports a missing file with the path, and a blank path up front', async () => {
    await expect(previewCsv(join(dir, 'nope.csv'), PARAMS)).rejects.toThrow(/不存在或不可读/)
    await expect(previewCsv('   ', PARAMS)).rejects.toThrow(/未选择批量数据文件/)
  })

  it('unknown extensions keep parsing as CSV (older configs point at .csv/.txt)', async () => {
    const p = join(dir, 'data.tbl')
    writeFileSync(p, 'name,score\nZoe,7\n')
    const preview = await previewCsv(p, PARAMS)
    expect(preview.headers).toEqual(['name', 'score'])
    expect(preview.previewRows).toEqual([['Zoe', '7']])
  })

  it('a UTF-8 CSV still round-trips (regression: async dispatch changed the CSV path)', async () => {
    const p = join(dir, 'utf8.csv')
    writeFileSync(p, 'name,score\n中文任务,3\n')
    const preview = await previewCsv(p, PARAMS)
    expect(preview.previewRows).toEqual([['中文任务', '3']])
  })

  it('decodeCsvBytes: UTF-8 BOM stripped, GBK fallback, then a refusal', () => {
    expect(decodeCsvBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('name', 'utf8')]))).toBe('name')
    // 任务 in GBK is C8 CE CE F1 — the Chinese-Excel export reality.
    expect(decodeCsvBytes(Buffer.from([0xc8, 0xce, 0xce, 0xf1]))).toBe('任务')
    // Neither strict decoder accepts a 0xFF lead (invalid UTF-8, out of GBK's
    // 0x81–0xFE lead range) — the refusal, not mojibake, is the answer.
    expect(() => decodeCsvBytes(Buffer.from([0xff, 0xfe, 0x80, 0x81]))).toThrow(/无法识别批量数据文件的编码/)
  })
})
