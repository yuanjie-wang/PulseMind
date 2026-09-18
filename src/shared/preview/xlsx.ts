// ── XLSX preview model (PLAN-xlsx-preview) ── The pure half of the sheet
// preview: everything exceljs's parsed workbook hands us gets turned into a
// renderable grid here, with no exceljs import — the component adapts the
// workbook to the plain structures below, so vitest covers the formatting,
// merge arithmetic and capping without the 2.8MB browser bundle.
//
// Honesty contract (same posture as xlsx_edit's L6): this is a READ-ONLY
// view of the common formats. Number formats outside the recognised families
// fall back to the raw value rather than a guess, and formulas are shown from
// their cached result — a formula the file never computed renders as the
// formula text itself, because we do not recalculate.

/** Render cap. The pane is a few hundred px wide; a sheet beyond this is
 *  capped with a note, exactly like the CSV renderer's row cap. */
export const XLSX_PREVIEW_ROW_LIMIT = 500
export const XLSX_PREVIEW_COL_LIMIT = 40

/** Excel's default column width is 8.43 characters ≈ 64px; the default row
 *  height is 15pt ≈ 20px. Used where the file does not say. */
export const XLSX_DEFAULT_COL_WIDTH_PX = 64
export const XLSX_DEFAULT_ROW_HEIGHT_PX = 20

// ── Coordinates ──

/** 1-based column index → letters: 1→A, 26→Z, 27→AA, 702→ZZ. */
export function columnLetter(col: number): string {
  let n = col
  let out = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

/** 'BC23' → { row: 23, col: 55 }; returns null for anything else. */
export function parseCellRef(ref: string): { row: number; col: number } | null {
  const m = /^([A-Z]+)([0-9]+)$/.exec(ref)
  if (!m) return null
  let col = 0
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64)
  return { row: Number(m[2]), col }
}

/** 'A1:C1' → { top, left, bottom, right } (1-based, inclusive); a single ref
 *  collapses to itself. Unparseable → null. */
export function parseRange(range: string): { top: number; left: number; bottom: number; right: number } | null {
  const [from, to] = range.split(':')
  const a = parseCellRef(from ?? '')
  if (!a) return null
  if (to === undefined) return { top: a.row, left: a.col, bottom: a.row, right: a.col }
  const b = parseCellRef(to)
  if (!b) return null
  return {
    top: Math.min(a.row, b.row),
    left: Math.min(a.col, b.col),
    bottom: Math.max(a.row, b.row),
    right: Math.max(a.col, b.col),
  }
}

// ── Geometry ──

/** exceljs column width is in "characters of the default font"; the classic
 *  Calibri-11 conversion is px = round(w × 7) + 5. Unspecified → default. */
export function colWidthPx(width: number | undefined): number {
  if (width === undefined || !Number.isFinite(width)) return XLSX_DEFAULT_COL_WIDTH_PX
  return Math.max(8, Math.round(width * 7) + 5)
}

/** exceljs row height is in points; 1pt = 96/72px. Unspecified → default. */
export function rowHeightPx(height: number | undefined): number {
  if (height === undefined || !Number.isFinite(height)) return XLSX_DEFAULT_ROW_HEIGHT_PX
  return Math.max(8, Math.round((height * 96) / 72))
}

// ── Colours ──

/** exceljs ARGB ('FF4472C4', sometimes 6-digit) → CSS. A fully opaque alpha
 *  drops; anything else rides rgba so a theme tint survives. Indexted/theme
 *  colours (exceljs gives `{ theme }` / `{ indexed }` objects instead of
 *  argb) never reach this — the caller only passes `argb` strings through. */
export function argbToCss(argb: string | undefined): string | null {
  if (!argb) return null
  let hex = argb.replace(/^#/, '')
  if (hex.length === 6) return `#${hex}`
  if (hex.length !== 8) return null
  const alpha = parseInt(hex.slice(0, 2), 16) / 255
  hex = hex.slice(2)
  if (!Number.isFinite(alpha)) return null
  if (alpha >= 0.999) return `#${hex}`
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${Math.round(alpha * 100) / 100})`
}

// ── Values ──

/** The structural union of what exceljs puts in `cell.value`. Kept here
 *  (rather than importing exceljs types) so this module stays dep-free. */
export type XlsxCellValue =
  | null
  | undefined
  | number
  | string
  | boolean
  | Date
  | { formula: string; result?: number | string | boolean | Date | null }
  | { sharedFormula: string; formula?: string; result?: number | string | boolean | Date | null }
  | { richText: Array<{ text: string }> }
  | { text: string; hyperlink: string }
  | { error: string }

export interface FormattedCell {
  text: string
  /** `formula` = no cached result, text is the formula itself; `link` renders
   *  link-styled with the URL as tooltip; `error` renders in red. */
  kind: 'empty' | 'value' | 'formula' | 'link' | 'error'
  link?: string
}

/** Format a cell for display. Dates format through the cell's own numFmt when
 *  it is a recognisable date pattern, else ISO date(-time). */
export function formatCellValue(value: XlsxCellValue, numFmt?: string): FormattedCell {
  if (value === null || value === undefined || value === '') return { text: '', kind: 'empty' }
  if (typeof value === 'boolean') return { text: value ? 'TRUE' : 'FALSE', kind: 'value' }
  if (value instanceof Date) return { text: formatDateValue(value, numFmt), kind: 'value' }
  if (typeof value === 'number') return { text: formatNumberValue(value, numFmt), kind: 'value' }
  if (typeof value === 'string') return { text: value, kind: 'value' }
  if ('richText' in value) {
    return { text: value.richText.map((run) => run.text).join(''), kind: 'value' }
  }
  if ('hyperlink' in value) {
    return { text: value.text || value.hyperlink, kind: 'link', link: value.hyperlink }
  }
  if ('error' in value) return { text: value.error, kind: 'error' }
  if ('sharedFormula' in value) {
    return formulaCell(value.formula ?? '', value.result)
  }
  if ('formula' in value) return formulaCell(value.formula, value.result)
  return { text: String(value), kind: 'value' }
}

function formulaCell(formula: string, result: number | string | boolean | Date | null | undefined): FormattedCell {
  if (result === null || result === undefined) {
    // The file never cached a result (generator-written, or calculation
    // disabled). Show the formula itself rather than inventing a value.
    return { text: `=${formula}`, kind: 'formula' }
  }
  if (typeof result === 'number') return { text: formatNumberValue(result, undefined), kind: 'value' }
  if (result instanceof Date) return { text: formatDateValue(result, undefined), kind: 'value' }
  if (typeof result === 'boolean') return { text: result ? 'TRUE' : 'FALSE', kind: 'value' }
  return { text: String(result), kind: 'value' }
}

/** Strip quoted literals and bracketed prefixes ([Red], [$$-409]…) so token
 *  detection sees the format's skeleton. */
function numFmtSkeleton(fmt: string): string {
  return fmt.replace(/\[[^\]]*\]/g, '').replace(/"[^"]*"/g, '')
}

function hasDateTokens(skeleton: string): boolean {
  return /[yY]/.test(skeleton) || /[dD]/.test(skeleton) || /[hH]/.test(skeleton) || /[sS]/.test(skeleton) || /A[MP]\/?P?M/i.test(skeleton)
}

function formatDateValue(date: Date, numFmt?: string): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const fmt = numFmt ?? ''
  const skeleton = fmt ? numFmtSkeleton(fmt) : ''
  if (!skeleton || !hasDateTokens(skeleton)) {
    // No usable pattern: ISO, date-only unless the file carries a time.
    const dateOnly = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    if (date.getHours() === 0 && date.getMinutes() === 0 && date.getSeconds() === 0) return dateOnly
    return `${dateOnly} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  }
  // Tokenise the RAW format so quoted literals pass through verbatim
  // (yyyy"年"m"月"d"日"). Excel's rule for m/mm: minutes when the token
  // neighbours an hour or second token, else month — decided per token, not
  // globally, because 'yyyy-mm-dd hh:mm' mixes both.
  const use12 = /A[MP]\/?P?M/i.test(skeleton)
  const h24 = date.getHours()
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  type Tok = { kind: 'lit'; text: string } | { kind: 'tok'; name: string }
  const toks: Tok[] = []
  let i = 0
  while (i < fmt.length) {
    const ch = fmt[i]
    if (ch === '"') {
      const end = fmt.indexOf('"', i + 1)
      const stop = end === -1 ? fmt.length : end + 1
      toks.push({ kind: 'lit', text: fmt.slice(i, stop).replace(/"/g, '') })
      i = stop
      continue
    }
    const rest = fmt.slice(i)
    const m = /^(yyyy|yy|y|mm|m|dd|d|hh|h|ss|s|AM\/PM|A)(?![a-zA-Z])/.exec(rest)
    if (m && !/^\[[^\]]*\]/.test(rest)) {
      toks.push({ kind: 'tok', name: m[1].toLowerCase() })
      i += m[1].length
      continue
    }
    const lit = /^("[^"]*"|\[[^\]]*\]|.)/.exec(rest)![1]
    toks.push({ kind: 'lit', text: lit.replace(/[[\]]/g, (b, off) => (off === 0 ? '' : b)) })
    i += lit.length
  }
  let out = ''
  for (let k = 0; k < toks.length; k++) {
    const tok = toks[k]
    if (tok.kind === 'lit') {
      out += tok.text
      continue
    }
    switch (tok.name) {
      case 'yyyy': out += String(date.getFullYear()); break
      case 'yy': out += pad(date.getFullYear() % 100); break
      case 'y': out += String(date.getFullYear()); break
      case 'dd': out += pad(date.getDate()); break
      case 'd': out += String(date.getDate()); break
      case 'hh': out += pad(use12 ? h12 : h24); break
      case 'h': out += String(use12 ? h12 : h24); break
      case 'ss': out += pad(date.getSeconds()); break
      case 's': out += String(date.getSeconds()); break
      case 'am/pm': out += h24 < 12 ? 'AM' : 'PM'; break
      case 'a': out += h24 < 12 ? 'AM' : 'PM'; break
      case 'mm': case 'm': {
        // Excel's rule: minutes when the token neighbours an hour or second
        // FORMAT token, else month — literals (space, ':', '-') never break
        // the adjacency, so 'h:mm' is minutes while 'yyyy-mm-dd' is months.
        // The token's own width pads either reading.
        const near = (dir: number): boolean => {
          for (let j = k + dir; j >= 0 && j < toks.length; j += dir) {
            const t = toks[j]
            if (t.kind === 'tok') return t.name.startsWith('h') || t.name.startsWith('s')
          }
          return false
        }
        const minute = near(-1) || near(1)
        const n = minute ? date.getMinutes() : date.getMonth() + 1
        out += tok.name === 'mm' ? pad(n) : String(n)
        break
      }
      default: out += tok.name
    }
  }
  return out
}

/** The common numeric families: thousands grouping, fixed decimals, percent,
 *  currency-prefixed numbers. Anything else → the raw number, honestly. */
export function formatNumberValue(value: number, numFmt?: string): string {
  if (numFmt === undefined || numFmt === '' || numFmt === 'General') return String(value)
  const skeleton = numFmtSkeleton(numFmt)
  if (skeleton === '@') return String(value)
  if (!/[0#]/.test(skeleton)) return String(value)

  // Percent first — the value scales, the rest formats like a plain number.
  const isPercent = skeleton.includes('%')
  const scaled = isPercent ? value * 100 : value

  // Decimals = the 0s and trailing #s after the decimal point in the FIRST
  // section (negatives reuse it). '#,##0.00' → 2; '0' → 0; '#,##0.###' → up
  // to 3, trimmed.
  const section = skeleton.split(';')[0]
  const dot = section.indexOf('.')
  let decimals = 0
  let trimZeros = false
  if (dot >= 0) {
    const frac = section.slice(dot + 1).replace(/[^0#]/g, '')
    decimals = frac.length
    trimZeros = frac.endsWith('#') && !frac.endsWith('0')
  }
  const useGrouping = section.includes(',')
  const fixed = scaled.toFixed(decimals)
  const [intPart, fracPart] = fixed.split('.')
  const grouped = useGrouping ? intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : intPart
  let digits = fracPart ?? ''
  if (trimZeros) digits = digits.replace(/0+$/, '')
  let body = digits ? `${grouped}.${digits}` : grouped

  // Currency/literal decoration: characters around the numeric skeleton that
  // survived quote-stripping are usually a currency symbol (¥#,##0.00). Any
  // surviving ASCII letter means a family we do not format (scientific E+,
  // text tokens) — the raw number wins, honestly.
  const symbol = section.replace(/[0#.,%\s]/g, '')
  if (/[A-Za-z]/.test(symbol)) return String(value)
  if (isPercent) body = `${body}%`
  if (symbol) {
    // Excel renders the symbol before (most locales) the number; '-' of a
    // negative number stays inside.
    if (scaled < 0) body = `-${symbol}${body.slice(1)}`
    else body = `${symbol}${body}`
  }
  return body
}

// ── Grid assembly ──

/** What the component extracts from one exceljs cell — exactly the fields the
 *  grid needs, nothing else. */
export interface XlsxCellInput {
  value?: XlsxCellValue
  numFmt?: string
  font?: {
    name?: string
    size?: number
    bold?: boolean
    italic?: boolean
    underline?: boolean
    strike?: boolean
    color?: { argb?: string }
  }
  fill?: { pattern?: string; fgColor?: { argb?: string } }
  alignment?: {
    horizontal?: string
    vertical?: string
    wrapText?: boolean
    indent?: number
  }
  border?: {
    top?: { style?: string; color?: { argb?: string } }
    bottom?: { style?: string; color?: { argb?: string } }
    left?: { style?: string; color?: { argb?: string } }
    right?: { style?: string; color?: { argb?: string } }
  }
}

export interface XlsxGridCellVM {
  text: string
  kind: 'empty' | 'value' | 'formula' | 'link' | 'error'
  link?: string
  color?: string
  bg?: string
  fontFamily?: string
  fontSizePt?: number
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  hAlign?: string
  vAlign?: string
  wrap?: boolean
  indent?: number
  borders?: {
    top?: string
    bottom?: string
    left?: string
    right?: string
  }
  /** Present on a merge master only; covered cells become null in the grid. */
  rowSpan?: number
  colSpan?: number
}

export interface XlsxSheetVM {
  name: string
  cells: Array<Array<XlsxGridCellVM | null>>
  colWidths: number[]
  rowHeights: number[]
  truncatedRows: boolean
  truncatedCols: boolean
  totalRows: number
  totalCols: number
}

export interface XlsxSheetInput {
  name: string
  rowCount: number
  columnCount: number
  merges?: string[]
  colWidths?: Array<number | undefined>
  rowHeights?: Array<number | undefined>
  /** getCell is 1-based, exceljs-style; return undefined for an empty cell. */
  getCell(row: number, col: number): XlsxCellInput | undefined
}

/** Build the capped, merge-resolved grid for one sheet. Cells outside the cap
 *  never materialise; merges that START inside the cap clip at its edge. */
export function buildSheetGrid(input: XlsxSheetInput): XlsxSheetVM {
  const totalRows = Math.max(0, input.rowCount)
  const totalCols = Math.max(0, input.columnCount)
  const rows = Math.min(totalRows, XLSX_PREVIEW_ROW_LIMIT)
  const cols = Math.min(totalCols, XLSX_PREVIEW_COL_LIMIT)

  // Merge masters within the cap; every covered coordinate lands in `covered`
  // as "r,c" — even one clipped at the boundary, which then simply covers
  // nothing the grid still renders.
  const spans = new Map<string, { rowSpan: number; colSpan: number }>()
  const covered = new Set<string>()
  for (const range of input.merges ?? []) {
    const box = parseRange(range)
    if (!box) continue
    if (box.top > rows || box.left > cols) continue
    const rowSpan = Math.min(box.bottom, rows) - box.top + 1
    const colSpan = Math.min(box.right, cols) - box.left + 1
    spans.set(`${box.top},${box.left}`, { rowSpan, colSpan })
    for (let r = box.top; r <= box.top + rowSpan - 1; r++) {
      for (let c = box.left; c <= box.left + colSpan - 1; c++) {
        if (r === box.top && c === box.left) continue
        covered.add(`${r},${c}`)
      }
    }
  }

  const cells: Array<Array<XlsxGridCellVM | null>> = []
  for (let r = 1; r <= rows; r++) {
    const row: Array<XlsxGridCellVM | null> = []
    for (let c = 1; c <= cols; c++) {
      if (covered.has(`${r},${c}`)) {
        row.push(null)
        continue
      }
      const raw = input.getCell(r, c)
      const fmt = formatCellValue(raw?.value ?? null, raw?.numFmt)
      const vm: XlsxGridCellVM = { text: fmt.text, kind: fmt.kind }
      if (fmt.link) vm.link = fmt.link
      if (raw) {
        const font = raw.font
        if (font) {
          const color = argbToCss(font.color?.argb)
          if (color) vm.color = color
          if (font.name) vm.fontFamily = font.name
          if (font.size !== undefined) vm.fontSizePt = font.size
          if (font.bold) vm.bold = true
          if (font.italic) vm.italic = true
          if (font.underline) vm.underline = true
          if (font.strike) vm.strike = true
        }
        const fill = raw.fill
        if (fill?.pattern === 'solid') {
          const bg = argbToCss(fill.fgColor?.argb)
          if (bg) vm.bg = bg
        }
        const align = raw.alignment
        if (align) {
          if (align.horizontal) vm.hAlign = align.horizontal
          if (align.vertical) vm.vAlign = align.vertical
          if (align.wrapText) vm.wrap = true
          if (align.indent) vm.indent = align.indent
        }
        const border = raw.border
        if (border) {
          const sides: Array<'top' | 'bottom' | 'left' | 'right'> = ['top', 'bottom', 'left', 'right']
          for (const side of sides) {
            const b = border[side]
            // Excel's hairline/thin families all read as 1px here; 'none'
            // (and falsy) means no line. Colour rides the border colour.
            if (b && b.style && b.style !== 'none') {
              const color = argbToCss(b.color?.argb) ?? '#000'
              vm.borders = vm.borders ?? {}
              vm.borders[side] = `1px solid ${color}`
            }
          }
        }
      }
      // Merge spans ride the VM last so a master is one object.
      const span = spans.get(`${r},${c}`)
      if (span) {
        vm.rowSpan = span.rowSpan
        vm.colSpan = span.colSpan
      }
      row.push(vm)
    }
    cells.push(row)
  }

  const colWidths: number[] = []
  for (let c = 1; c <= cols; c++) colWidths.push(colWidthPx(input.colWidths?.[c - 1]))
  const rowHeights: number[] = []
  for (let r = 1; r <= rows; r++) rowHeights.push(rowHeightPx(input.rowHeights?.[r - 1]))

  return {
    name: input.name,
    cells,
    colWidths,
    rowHeights,
    truncatedRows: totalRows > rows,
    truncatedCols: totalCols > cols,
    totalRows,
    totalCols,
  }
}
