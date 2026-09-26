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
    // The rest of what an exceljs round-trip silently drops (M3):
    [/^xl\/threadedComments\//, '串联批注（exceljs 往返会丢失）'],
    [/^xl\/slicers\//, '切片器（exceljs 往返会丢失）'],
    // NOTE: conditionalFormatting is deliberately NOT in this table — it is
    // an element INSIDE the sheet XML, never a zip entry name, so an
    // entry-name rule could never fire (review 2026-09-26 中7). The measured
    // M0 crash it guards against is caught by the content scan below.
  ]
  for (const [pattern, why] of forbidden) {
    if (names.some((n) => pattern.test(n))) {
      return { ok: false, reason: `工作簿包含${why}——拒绝编辑以避免静默损坏` }
    }
  }
  // Conditional formatting and sparklines live INSIDE the sheet XML (CF as a
  // plain element, sparklines in the x14 extension), not in their own part —
  // the entry-name scan above cannot see either. CF carries the M0 measured
  // crash (a sheet whose conditionalFormatting references a styles dxf makes
  // exceljs CRASH on load — styles-xform.getDxfStyle), so it is refused here
  // where it is actually visible. dataValidation, by contrast, round-trips
  // losslessly and is deliberately NOT forbidden.
  for (const entry of zip.getEntries()) {
    if (!/^xl\/worksheets\/.*\.xml$/.test(entry.entryName)) continue
    const xml = (zip.readFile(entry.entryName) as Buffer).toString('utf8')
    if (xml.includes('conditionalFormatting')) {
      return { ok: false, reason: `工作簿包含条件格式（${entry.entryName}，exceljs 加载含 dxf 引用的规则会直接崩溃）——拒绝编辑以避免静默损坏` }
    }
    if (xml.includes('sparklineGroup')) {
      return { ok: false, reason: `工作簿包含迷你图（${entry.entryName}，exceljs 往返会丢失）——拒绝编辑以避免静默损坏` }
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
  /** Ops whose write must survive the round-trip, verified against the
   *  RELOADED buffer below — the old gate read back from the very workbook
   *  object the write had just set, so it was a tautology (M4). */
  const readBacks: Array<{ sheetName: string; address: string; op: Record<string, unknown>; after: XlsxCellSnapshot }> = []

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
        readBacks.push({ sheetName: ws.name, address, op, after })
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
            // A rich-text or hyperlink cell rewritten as a plain string loses
            // its formatting/link — that silent downgrade used to pass as a
            // successful replacement. Name the cell and refuse the op (the
            // batch refuses with it).
            const v = cell.value
            const isRichText = typeof v === 'object' && v !== null && 'richText' in (v as object)
            const isHyperlink = typeof v === 'object' && v !== null && 'hyperlink' in (v as object)
            if (isRichText || isHyperlink) {
              const flat = typeof cell.text === 'string' ? cell.text : ''
              if (flat.includes(find)) {
                throw new Error(`find_replace: ${cell.address} 是${isRichText ? '富文本' : '超链接'}单元格——整格替换会丢失其格式/链接，本批拒绝。请先用 read 查看该单元格或改用 set_cell 明确重写`)
              }
              return
            }
            const text = typeof v === 'string' ? v : cell.text
            if (typeof text === 'string' && text.includes(find)) {
              const next = (typeof v === 'string' ? v : text).split(find).join(replace)
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
      if (kind === 'add_row') {
        const ws = resolveSheet(op.sheet as string | undefined)
        const afterRow = Number(op.after_row)
        if (!Number.isFinite(afterRow) || afterRow < 0) throw new Error(`add_row: after_row 必须是非负整数（收到 ${op.after_row}）`)
        const values = Array.isArray(op.values) ? op.values : []
        const beforeRowCount = ws.rowCount
        ws.insertRows(afterRow + 1, [values])
        const inserted = ws.rowCount - beforeRowCount
        results.push({ index, op: kind, ok: true, detail: `在第 ${afterRow} 行后插入 ${inserted} 行（共 ${ws.rowCount} 行）` })
        continue
      }
      if (kind === 'set_style') {
        // M5 (PLAN-office-expressiveness): cell styling, exceljs path ONLY —
        // the OOXML path (charts etc.) refuses below in editXlsxOOXML.
        const ws = resolveSheet(op.sheet as string | undefined)
        const range = parseCellRange(String(op.cells ?? ''))
        if (!range) throw new Error(`set_style: 非法范围「${op.cells}」（形如 B3 或 A1:C10）`)
        const total = (range.endRow - range.startRow + 1) * (range.endCol - range.startCol + 1)
        if (total > 50_000) throw new Error(`set_style: 范围展开 ${total} 个单元格，超过 50,000 上限——缩小范围（整表样式请按列/区域分批）`)
        if (!['bold', 'italic', 'font_size', 'color', 'fill', 'font', 'align', 'wrap_text'].some((k) => k in op)) {
          throw new Error('set_style: 没有给出任何样式属性')
        }
        const font: Record<string, unknown> = {}
        if (op.bold !== undefined) font.bold = op.bold === true
        if (op.italic !== undefined) font.italic = op.italic === true
        if (op.font_size !== undefined) font.size = Number(op.font_size)
        if (op.font !== undefined) font.name = String(op.font)
        if (op.color !== undefined) font.color = { argb: 'FF' + argb(String(op.color)) }
        const fillBody = op.fill !== undefined ? { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + argb(String(op.fill)) } } : undefined
        const alignment: Record<string, unknown> = {}
        if (op.align !== undefined) {
          const a = String(op.align)
          if (!['left', 'center', 'right'].includes(a)) throw new Error(`set_style: align 只接受 left/center/right（收到 ${a}）`)
          alignment.horizontal = a
        }
        if (op.wrap_text !== undefined) alignment.wrapText = op.wrap_text === true
        let touched = 0
        const firstAddr = rangeAddr(range.startCol, range.startRow)
        const lastAddr = rangeAddr(range.endCol, range.endRow)
        for (let r = range.startRow; r <= range.endRow; r++) {
          for (let c = range.startCol; c <= range.endCol; c++) {
            const cell = ws.getCell(r, c)
            if (Object.keys(font).length > 0) cell.font = { ...cell.font, ...font } as never
            if (fillBody) cell.fill = fillBody as never
            if (Object.keys(alignment).length > 0) cell.alignment = { ...cell.alignment, ...alignment } as never
            touched++
          }
        }
        // Read-back: first + last cell of the range (spot check, not 50k cells).
        readBacks.push({ sheetName: ws.name, address: firstAddr, op: { set_style: op }, after: { address: firstAddr, value: null, formula: null, type: 'style' } } as never)
        readBacks.push({ sheetName: ws.name, address: lastAddr, op: { set_style: op }, after: { address: lastAddr, value: null, formula: null, type: 'style' } } as never)
        results.push({ index, op: kind, ok: true, detail: `样式已应用到 ${touched} 个单元格（${rangeAddr(range.startCol, range.startRow)}:${rangeAddr(range.endCol, range.endRow)}）` })
        continue
      }
      if (kind === 'set_column_width') {
        const ws = resolveSheet(op.sheet as string | undefined)
        const width = Number(op.width)
        if (!Number.isFinite(width) || width <= 0) throw new Error(`set_column_width: width 必须是正数（收到 ${op.width}）`)
        const spec = String(op.columns ?? '')
        const cols = parseColumnSpec(spec)
        if (!cols) throw new Error(`set_column_width: 非法列「${spec}」（形如 A 或 A:C，逗号可叠多组）`)
        for (const c of cols) ws.getColumn(c).width = width
        readBacks.push({ sheetName: ws.name, address: `${colName(cols[0])}1`, op: { __colWidth: width, __col: cols[0], __cols: cols }, after: { address: '', value: null, formula: null, type: 'style' } })
        results.push({ index, op: kind, ok: true, detail: `列 ${spec} 宽度 → ${width}` })
        continue
      }
      if (kind === 'freeze_panes') {
        const ws = resolveSheet(op.sheet as string | undefined)
        const cell = String(op.cell ?? '')
        const addr = /^([A-Za-z]{1,3})([1-9]\d*)$/.exec(cell)
        if (!addr) throw new Error(`freeze_panes: 非法单元格「${cell}」`)
        // ECMA-376: xSplit/ySplit ARE the frozen column/row counts. exceljs
        // writes only what the model carries — a topLeftCell-only view lands
        // as `<pane state="frozen"/>` with no splits, which freezes NOTHING in
        // Excel/WPS, and the state/topLeftCell round-trip cannot see the gap.
        // Compute the splits from the address; absence (=0) stays omitted.
        const xSplit = colIndexOf(addr[1]) - 1
        const ySplit = Number(addr[2]) - 1
        ws.views = [{ state: 'frozen', xSplit, ySplit, topLeftCell: cell } as never]
        readBacks.push({ sheetName: ws.name, address: cell, op: { __freeze: cell, __xSplit: xSplit, __ySplit: ySplit }, after: { address: cell, value: null, formula: null, type: 'style' } })
        results.push({ index, op: kind, ok: true, detail: `冻结窗格于 ${cell}` })
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

  const outBuffer = Buffer.from(await workbook.xlsx.writeBuffer() as ArrayBuffer)
  const reloaded = new ExcelJS.Workbook()
  await reloaded.xlsx.load(outBuffer as unknown as ArrayBuffer)

  // Read-back gate (L6, M4 + M5 style variants): every written fact is read
  // back from the RE-SERIALIZED buffer.
  for (const rb of readBacks) {
    const op0 = rb.op as Record<string, unknown>
    if ('set_style' in op0) {
      const want = op0.set_style as Record<string, unknown>
      const ws2 = reloaded.getWorksheet(rb.sheetName)
      if (!ws2) throw new Error(`门禁未通过：重载后缺少工作表「${rb.sheetName}」`)
      const cell = ws2.getCell(rb.address)
      const font = cell.font as Record<string, unknown> | undefined
      if (want.bold !== undefined && font?.bold !== (want.bold === true)) throw new Error(`set_style ${rb.address}: 加粗写盘回读不一致`)
      if (want.italic !== undefined && font?.italic !== (want.italic === true)) throw new Error(`set_style ${rb.address}: 斜体写盘回读不一致`)
      if (want.font_size !== undefined && font?.size !== Number(want.font_size)) throw new Error(`set_style ${rb.address}: 字号写盘回读不一致`)
      if (want.color !== undefined) {
        const argb = (font?.color as { argb?: string } | undefined)?.argb ?? ''
        if (!argb.endsWith(String(want.color).toUpperCase())) throw new Error(`set_style ${rb.address}: 字色写盘回读不一致`)
      }
      if (want.fill !== undefined) {
        const fg = (cell.fill as { fgColor?: { argb?: string } } | undefined)?.fgColor?.argb ?? ''
        if (!fg.endsWith(String(want.fill).toUpperCase())) throw new Error(`set_style ${rb.address}: 填充写盘回读不一致`)
      }
      if (want.align !== undefined) {
        const al = cell.alignment as Record<string, unknown> | undefined
        if (al?.horizontal !== String(want.align)) throw new Error(`set_style ${rb.address}: 对齐写盘回读不一致`)
      }
      if (want.wrap_text !== undefined) {
        const al = cell.alignment as Record<string, unknown> | undefined
        if (al?.wrapText !== (want.wrap_text === true)) throw new Error(`set_style ${rb.address}: 换行写盘回读不一致`)
      }
      continue
    }
    if ('__colWidth' in op0) {
      const ws2 = reloaded.getWorksheet(rb.sheetName)
      if (!ws2) throw new Error(`门禁未通过：重载后缺少工作表「${rb.sheetName}」`)
      const actual = ws2.getColumn(op0.__col as number).width
      // exceljs width round-trips with float drift (R3) — tolerance, not equality.
      if (actual === undefined || Math.abs(actual - (op0.__colWidth as number)) > 0.01) {
        throw new Error(`set_column_width: 列宽写盘回读不一致（期望 ${op0.__colWidth}，实际 ${actual}）`)
      }
      continue
    }
    if ('__freeze' in op0) {
      const ws2 = reloaded.getWorksheet(rb.sheetName)
      if (!ws2) throw new Error(`门禁未通过：重载后缺少工作表「${rb.sheetName}」`)
      const view = ws2.views[0] as { state?: string; topLeftCell?: string; xSplit?: number; ySplit?: number } | undefined
      if (view?.state !== 'frozen' || view.topLeftCell !== op0.__freeze) {
        throw new Error(`freeze_panes: 冻结写盘回读不一致`)
      }
      // The splits are the actual freeze — a pane without them freezes nothing
      // (exceljs parses absent attributes back as 0, so compare numerically).
      if ((view.xSplit ?? 0) !== op0.__xSplit || (view.ySplit ?? 0) !== op0.__ySplit) {
        throw new Error(`freeze_panes: 冻结分割数写盘回读不一致（期望 x=${op0.__xSplit}/y=${op0.__ySplit}，实际 x=${view.xSplit ?? 0}/y=${view.ySplit ?? 0}）`)
      }
      continue
    }
  }

  // Read-back gate (L6, M4): every written cell is read back from the
  // re-serialized buffer — the bytes a client will actually open — not from
  // the in-memory workbook the write just mutated.
  for (const rb of readBacks) {
    // Style/width/freeze entries carry markers and were checked above.
    const marker = rb.op as Record<string, unknown>
    if ('set_style' in marker || '__colWidth' in marker || '__freeze' in marker) continue
    const ws2 = reloaded.getWorksheet(rb.sheetName)
    if (!ws2) throw new Error(`门禁未通过：重载后缺少工作表「${rb.sheetName}」`)
    const check = ws2.getCell(rb.address)
    if (typeof rb.op.formula === 'string' && rb.op.formula) {
      if (check.formula !== (rb.op.formula.startsWith('=') ? rb.op.formula.slice(1) : rb.op.formula)) {
        throw new Error(`set_cell ${rb.address}: 公式写盘回读不一致`)
      }
    } else if (!sameValue(rb.after.value, check.value ?? null)) {
      throw new Error(`set_cell ${rb.address}: 值写盘回读不一致`)
    }
    if (typeof rb.op.number_format === 'string' && check.numFmt !== rb.op.number_format) {
      throw new Error(`set_cell ${rb.address}: 数字格式写盘回读不一致`)
    }
  }

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

/** B3 → {col: 55ish} — 1-based column letter math for style ranges. */
function colIndexOf(letters: string): number {
  let n = 0
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n
}
function colName(n: number): string {
  let s = ''
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26) }
  return s
}
function rangeAddr(col: number, row: number): string { return `${colName(col)}${row}` }

/** 'B3' | 'A1:C10' → 1-based inclusive bounds; null on garbage. */
function parseCellRange(spec: string): { startCol: number; startRow: number; endCol: number; endRow: number } | null {
  const m = /^([A-Za-z]{1,3})([1-9]\d*)(?::([A-Za-z]{1,3})([1-9]\d*))?$/.exec(spec.trim())
  if (!m) return null
  const c1 = colIndexOf(m[1]); const r1 = Number(m[2])
  const c2 = m[3] ? colIndexOf(m[3]) : c1
  const r2 = m[4] ? Number(m[4]) : r1
  return { startCol: Math.min(c1, c2), startRow: Math.min(r1, r2), endCol: Math.max(c1, c2), endRow: Math.max(r1, r2) }
}

/** 'A' | 'A:C' | 'A:C,D' (commas stack groups) → 1-based column numbers. */
function parseColumnSpec(spec: string): number[] | null {
  const parts = spec.split(',').map((p) => p.trim()).filter(Boolean)
  if (parts.length === 0) return null
  const out: number[] = []
  for (const part of parts) {
    const m = /^([A-Za-z]{1,3})(?::([A-Za-z]{1,3}))?$/.exec(part)
    if (!m) return null
    const a = colIndexOf(m[1])
    const b = m[2] ? colIndexOf(m[2]) : a
    if (b < a) return null
    for (let c = a; c <= b && c - a < 64; c++) out.push(c) // a runaway group is capped
  }
  return out.length > 0 ? out : null
}

/** RRGGBB (no #) → uppercase; garbage throws (better a loud refuse than a
 *  silent black fill). */
function argb(color: string): string {
  const c = color.replace(/^#/, '').toUpperCase()
  if (!/^[0-9A-F]{6}$/.test(c)) throw new Error(`颜色「${color}」必须是 6 位 RRGGBB（不带 #）`)
  return c
}

/** The outline the tool returns even without edits (L9 xlsx half). */
export async function xlsxOutline(buffer: Buffer): Promise<Array<{ sheet: string; usedRange: string }>> {
  const ExcelJS = (await import('exceljs')).default
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer)
  return workbook.worksheets.map((ws) => ({ sheet: ws.name, usedRange: `${ws.rowCount} 行 × ${ws.columnCount} 列` }))
}
