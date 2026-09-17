// ── xlsx precheck + engine (PLAN-office-editing §3.5, L6/L7, T13) ──
// xlsx gets NO byte-faithful engine: exceljs rewrites the whole workbook.
// That tradeoff (L1 ruling) is fenced by a PRECHECK that refuses the
// feature classes exceljs destroys (charts, pivot tables, VBA, legacy
// .xls, encryption) and a per-op READ-BACK that refuses silent divergence.
// This is NOT the docx contract and no text may blur the two.

import AdmZip from 'adm-zip'

export interface XlsxScanResult {
  ok: boolean
  reason?: string
}

/** Refuse what exceljs would silently destroy. Direct zip-part look — the
 *  cheapest honest read of what the workbook carries. */
export function scanXlsx(buffer: Buffer): XlsxScanResult {
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    // OLE magic = .doc/.xls legacy or an encrypted OOXML package.
    const ole = buffer.length > 4 && buffer[0] === 0xd0 && buffer[1] === 0xcf
    return { ok: false, reason: ole
      ? '这是 OLE 复合文档（.xls 旧格式或加密工作簿）——请先在 Excel/WPS 中另存为 .xlsx'
      : '这不是 .xlsx（OOXML）文件' }
  }
  let zip: AdmZip
  try {
    zip = new AdmZip(buffer)
  } catch {
    return { ok: false, reason: '无法读取工作簿包' }
  }
  const names = zip.getEntries().map((e) => e.entryName)
  if (!names.some((n) => n === 'xl/workbook.xml')) {
    return { ok: false, reason: '包内缺少 xl/workbook.xml — 不是有效的 Excel 工作簿' }
  }
  const forbidden: Array<[RegExp, string]> = [
    [/^xl\/charts\//, '图表（exceljs 往返会丢失图表）'],
    [/^xl\/pivotTables\//, '数据透视表（exceljs 往返会丢失透视表）'],
    [/vbaProject\.bin$/, 'VBA 宏（exceljs 不保留宏）'],
    [/^xl\/drawings\//, '绘图/图形对象（exceljs 往返可能丢失）'],
    [/^xl\/themes\//, '主题部件（exceljs 往返可能改写主题）'],
  ]
  for (const [pattern, why] of forbidden) {
    if (names.some((n) => pattern.test(n))) {
      return { ok: false, reason: `工作簿包含${why}——拒绝编辑以避免静默损坏` }
    }
  }
  return { ok: true }
}

// The engine imports exceljs lazily so the pure scan stays importable in tests.
type Workbook = import('exceljs').Workbook

export interface XlsxCellSnapshot {
  address: string
  value: string | number | boolean | null
  formula: string | null
  type: string
}

import type { XlsxEditOutcome } from '../../shared/office/ops'

const MAX_CELL_TEXT = 32_000

function cellSnapshot(cell: import('exceljs').Cell): XlsxCellSnapshot {
  const value = cell.value
  const readable = value === undefined || value === null ? null
    : typeof value === 'object' && value !== null && 'richText' in value
      ? (value as { richText: Array<{ text: string }> }).richText.map((r) => r.text).join('')
      : typeof value === 'object' && value !== null && 'formula' in value
        ? (value as { result?: unknown }).result ?? null
        : (value as string | number | boolean | null)
  return {
    address: cell.address,
    value: readable as string | number | boolean | null,
    formula: cell.formula ?? null,
    type: String(cell.type),
  }
}

function sameValue(a: string | number | boolean | null, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined || b === ''
  return String(a) === String(b)
}

export async function editXlsx(buffer: Buffer, ops: Array<Record<string, unknown>>): Promise<XlsxEditOutcome> {
  const scan = scanXlsx(buffer)
  if (!scan.ok) throw new Error(scan.reason)

  const ExcelJS = (await import('exceljs')).default
  const workbook: Workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer)

  const sheetNames = workbook.worksheets.map((ws) => ws.name)
  const resolveSheet = (name?: string): Workbook['worksheets'][number] => {
    const ws = name ? workbook.getWorksheet(name) : workbook.worksheets[0]
    if (!ws) throw new Error(`找不到工作表「${name ?? '(默认第一个)'}」；现有: ${sheetNames.join(', ')}`)
    return ws
  }

  const beforeSheets = workbook.worksheets.map((ws) => ws.name)
  const results: XlsxEditOutcome['results'] = []
  const warnings: string[] = []
  const readBacks: Array<() => void> = []

  for (let index = 0; index < ops.length; index++) {
    const op = ops[index] as Record<string, unknown>
    const kind = String(op.op ?? '')
    try {
      if (kind === 'inspect') {
        const ws = resolveSheet(op.sheet as string | undefined)
        results.push({ index, op: kind, ok: true, detail: `工作表「${ws.name}」共 ${ws.rowCount} 行 × ${ws.columnCount} 列` })
        continue
      }
      if (kind === 'set_cell') {
        const ws = resolveSheet(op.sheet as string | undefined)
        const address = String(op.cell ?? '')
        if (!/^[A-Za-z]{1,3}[1-9]\d*$/.test(address)) throw new Error(`set_cell: 非法单元格地址「${address}」`)
        const cell = ws.getCell(address)
        const beforeText = String(cell.text ?? '').slice(0, MAX_CELL_TEXT)
        if (typeof op.formula === 'string' && op.formula) {
          cell.value = { formula: op.formula.startsWith('=') ? op.formula.slice(1) : op.formula }
        } else if ('value' in op) {
          const value = op.value as string | number | boolean | null
          if (typeof value === 'string' && value.length > MAX_CELL_TEXT) throw new Error('set_cell: 单元格文本过长')
          cell.value = value as never
        }
        if (typeof op.number_format === 'string') cell.numFmt = op.number_format
        const after = cellSnapshot(cell)
        // Read-back gate (L6): value/formula must read back as intended.
        readBacks.push(() => {
          const check = ws.getCell(address)
          if (typeof op.formula === 'string' && op.formula) {
            if (check.formula !== (op.formula.startsWith('=') ? op.formula.slice(1) : op.formula)) {
              throw new Error(`set_cell ${address}: 公式读回不一致`)
            }
          } else if (!sameValue(after.value, check.value ?? null)) {
            throw new Error(`set_cell ${address}: 值读回不一致`)
          }
          if (typeof op.number_format === 'string' && check.numFmt !== op.number_format) {
            throw new Error(`set_cell ${address}: 数字格式读回不一致`)
          }
        })
        results.push({ index, op: kind, ok: true, detail: `${address} ← ${op.formula ? '=' + String(op.formula) : JSON.stringify(op.value ?? null)}（原: ${beforeText.slice(0, 40) || '空'}）` })
        continue
      }
      if (kind === 'find_replace') {
        const ws = resolveSheet(op.sheet as string | undefined)
        const find = String(op.find ?? '')
        if (!find) throw new Error('find_replace: find 不能为空')
        const replace = String(op.replace ?? '')
        const includeFormulas = op.include_formulas === true
        let count = 0
        ws.eachRow((row) => {
          row.eachCell({ includeEmpty: false }, (cell) => {
            const isFormula = typeof cell.formula === 'string' && cell.formula.length > 0
            if (isFormula && !includeFormulas) return // L7: formulas untouched by default
            const text = typeof cell.value === 'string' ? cell.value : cell.text
            if (typeof text === 'string' && text.includes(find)) {
              const next = (typeof cell.value === 'string' ? cell.value : text).split(find).join(replace)
              cell.value = next
              count++
            }
          })
        })
        const expected = (op.expected_count as number | undefined) ?? count
        if (count !== expected) {
          throw new Error(`find_replace: 替换了 ${count} 个单元格（expected_count=${expected}）`)
        }
        results.push({ index, op: kind, ok: true, detail: `替换 ${count} 个单元格${includeFormulas ? '（含公式）' : ''}` })
        continue
      }
      throw new Error(`未知 op: ${kind}`)
    } catch (err) {
      results.push({ index, op: kind, ok: false, detail: err instanceof Error ? err.message : String(err) })
      // All-or-nothing (L5): one failed op aborts the batch.
      throw new XlsxBatchError(results)
    }
  }

  // Sheet inventory must be unchanged.
  const afterSheets = workbook.worksheets.map((ws) => ws.name)
  if (afterSheets.join('|') !== beforeSheets.join('|')) {
    throw new Error('门禁未通过：工作表清单发生了变化')
  }
  for (const verify of readBacks) verify()

  const outBuffer = Buffer.from(await workbook.xlsx.writeBuffer() as ArrayBuffer)
  const reloaded = new ExcelJS.Workbook()
  await reloaded.xlsx.load(outBuffer as unknown as ArrayBuffer)
  const outline = reloaded.worksheets.map((ws) => ({ sheet: ws.name, usedRange: `${ws.rowCount} 行 × ${ws.columnCount} 列` }))
  return { buffer: outBuffer, results, outline, warnings }
}

export class XlsxBatchError extends Error {
  readonly results: XlsxEditOutcome['results']
  constructor(results: XlsxEditOutcome['results']) {
    const failed = results.filter((r) => !r.ok)
    super(`第 ${failed.map((f) => f.index + 1).join('、')} 个 op 失败，整批未应用: ${failed.map((f) => f.detail).join('；')}`)
    this.results = results
  }
}

/** The outline the tool returns even without edits (L9 xlsx half). */
export async function xlsxOutline(buffer: Buffer): Promise<Array<{ sheet: string; usedRange: string }>> {
  const ExcelJS = (await import('exceljs')).default
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer)
  return workbook.worksheets.map((ws) => ({ sheet: ws.name, usedRange: `${ws.rowCount} 行 × ${ws.columnCount} 列` }))
}
