// ── office_search — coordinate-anchored content search (2026-10-12) ──
// Find WHERE content lives (paragraph index / cell address / shape id)
// WITHOUT reading the file — the read-side counterpart of office_edit's
// find_replace, and the large-file tool: search first, then office_read only
// the hit neighborhoods. Coordinates are the same spaces office_read pages
// and office_edit edits against, so a hit is meant to be paged into, not
// trusted blind. Read-only: behind the same read guard as every read mouth.

import AdmZip from 'adm-zip'
import { guardFsTarget } from '../sandbox/guard'
import { buildDocumentModel, GAP_CHAR } from '../docx/model'
import { buildSlideModel, slidePartNames } from '../pptx/model'
import { xlsxReadCellText } from './office-read'
import type { OfficeSearchInput, OfficeSearchResult } from '../../shared/office/ops'

const MAX_HITS = 50
/** Snippet = the match ± this many chars. */
const SNIPPET_CONTEXT = 40
const MAX_SNIPPET_CHARS = 120
/** xlsx hit rows carry their first non-empty cells as column context. */
const ROW_PREVIEW_CELLS = 6
const PREVIEW_CELL_CHARS = 40
/** Scan bound for pathological sheets — the workbook is already in memory,
 *  this bounds only the walk. */
const XLSX_MAX_SCAN_CELLS = 2_000_000
/** Total match-time budget per file (ms), checked every MATCH_TIME_CHECK_EVERY
 *  items. Matching runs on the MAIN process — a catastrophic-backtracking
 *  regex (the query is model-generated) pins the event loop with no abort
 *  channel, freezing window + IPC + every session. The walk bails into
 *  scanNote with the partial result; one slow test() call still runs to
 *  completion (V8 has no preemption), so the budget bounds the aggregate.
 *  `now`/`checkEvery` are test seams — production uses wall time. */
const MATCH_TIME_BUDGET_MS = 2_000
const MATCH_TIME_CHECK_EVERY = 256

interface MatchBudget {
  /** True when the budget is spent; call once per walked item. */
  spent: () => boolean
  note: () => string
}

function makeMatchBudget(budgetMs: number, checkEvery: number, now: () => number): MatchBudget {
  const deadline = now() + budgetMs
  let tick = 0
  return {
    spent: () => tick++ % checkEvery === 0 && now() > deadline,
    note: () => `匹配在 ${budgetMs}ms 时长预算处中止——以下为部分结果，收窄 query（或关闭 regex）后重试可扫完剩余`,
  }
}

const renderGaps = (text: string): string => text.replace(new RegExp(GAP_CHAR, 'g'), ' ')

/** The matcher + the first-match locator share one compiled form so a regex
 *  is parsed exactly once. */
interface Matcher {
  matches: (s: string) => boolean
  firstIndex: (s: string) => number
  needleLength: (s: string) => number
}

/** The one error-message idiom for this file's catch arms — `no-explicit-any`
 *  is not the price of reading `err.message` (review_20261013 低3). */
const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

function buildMatcher(input: OfficeSearchInput): { matcher: Matcher } | { error: string } {
  if (input.regex === true) {
    let re: RegExp
    try {
      re = new RegExp(input.query, input.caseSensitive ? '' : 'i')
    } catch (err) {
      return { error: `query 不是合法正则: ${errMessage(err)}` }
    }
    return {
      matcher: {
        matches: (s) => re.test(s),
        firstIndex: (s) => s.search(re),
        needleLength: (s) => {
          const m = re.exec(s)
          return m && m[0].length > 0 ? m[0].length : 0
        },
      },
    }
  }
  const needle = input.caseSensitive ? input.query : input.query.toLowerCase()
  return {
    matcher: {
      matches: (s) => (input.caseSensitive ? s : s.toLowerCase()).includes(needle),
      firstIndex: (s) => (input.caseSensitive ? s : s.toLowerCase()).indexOf(needle),
      needleLength: () => input.query.length,
    },
  }
}

/** The match ± context, ellipsized — the anchor, not the whole line. A long
 *  match (regex `[\s\S]*`, a fat xlsx cell) makes the naive window unbounded,
 *  so the body re-windows on the MATCH's own midpoint: the hit itself stays
 *  centered inside MAX_SNIPPET_CHARS instead of one giant hit eating the
 *  list. The ellipses track the FINAL window, so a re-windowed snippet still
 *  honestly marks the omitted tail/head. (review_20261013 低1) */
function snippetOf(text: string, matcher: Matcher): string {
  const idx = matcher.firstIndex(text)
  if (idx < 0) return text.slice(0, MAX_SNIPPET_CHARS)
  const len = matcher.needleLength(text) || 1
  const start = Math.max(0, idx - SNIPPET_CONTEXT)
  const end = Math.min(text.length, idx + len + SNIPPET_CONTEXT)
  let bodyStart = start
  let bodyEnd = end
  if (end - start > MAX_SNIPPET_CHARS) {
    const mid = idx - start + len / 2
    bodyStart = start + Math.max(0, Math.floor(mid - MAX_SNIPPET_CHARS / 2))
    bodyEnd = start + Math.min(end - start, Math.ceil(mid + MAX_SNIPPET_CHARS / 2))
  }
  const body = text.slice(bodyStart, bodyEnd)
  return `${bodyStart > 0 ? '…' : ''}${body}${bodyEnd < text.length ? '…' : ''}`
}

export interface OfficeSearchBudgetOpts {
  /** Total match-time budget in ms (default MATCH_TIME_BUDGET_MS). */
  budgetMs?: number
  /** Clock granularity: check the deadline every N walked items (default MATCH_TIME_CHECK_EVERY). */
  checkEvery?: number
  /** Wall clock seam (tests). */
  now?: () => number
}

export async function svcSearchOffice(input: OfficeSearchInput, opts?: OfficeSearchBudgetOpts): Promise<OfficeSearchResult> {
  const { filePath, query } = input
  if (!filePath) return { success: false, format: 'unknown', summary: 'file_path is required', details: {}, error: 'file_path is required' }
  if (!query) return { success: false, format: 'unknown', summary: 'query is required', details: {}, error: 'query is required' }

  const budget = makeMatchBudget(opts?.budgetMs ?? MATCH_TIME_BUDGET_MS, opts?.checkEvery ?? MATCH_TIME_CHECK_EVERY, opts?.now ?? Date.now)

  const built = buildMatcher(input)
  if ('error' in built) {
    return { success: false, format: 'unknown', summary: built.error, details: {}, error: built.error }
  }
  const matcher = built.matcher

  const guard = await guardFsTarget(filePath, 'read')
  if (!guard.ok) {
    return { success: false, format: 'unknown', summary: guard.reason ?? '路径被拒绝', details: {}, error: guard.reason }
  }

  const { readFile } = await import('fs/promises')
  let buffer: Buffer
  try {
    buffer = await readFile(guard.resolved)
  } catch (err) {
    const msg = errMessage(err)
    return { success: false, format: 'unknown', summary: `无法读取文件: ${msg}`, details: {}, error: msg }
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

  const envelope = (
    format: OfficeSearchResult['format'],
    label: string,
    hits: OfficeSearchResult['details']['hits'],
    totalMatches: number,
    scanNote?: string,
  ): OfficeSearchResult => ({
    success: true,
    format,
    summary:
      totalMatches === 0
        ? `${label}检索「${query}」: 无命中`
        : `${label}检索「${query}」: ${totalMatches} 处命中${totalMatches > MAX_HITS ? `（显示前 ${MAX_HITS}）` : ''}`,
    details: { hits, totalMatches, ...(scanNote ? { scanNote } : {}) },
  })

  // ── docx: flat paragraph space (office_read pages it, office_edit edits it) ──
  if (names.includes('word/document.xml')) {
    try {
      const xml = (zip.readFile('word/document.xml') as Buffer).toString('utf8')
      const model = buildDocumentModel(xml)
      const hits: NonNullable<OfficeSearchResult['details']['hits']> = []
      let totalMatches = 0
      let timeNote: string | undefined
      for (const p of model.paragraphs) {
        if (budget.spent()) {
          timeNote = budget.note()
          break
        }
        const text = renderGaps(p.text)
        if (!matcher.matches(text)) continue
        totalMatches++
        if (hits.length < MAX_HITS) {
          hits.push({ index: p.index, style: p.style, snippet: snippetOf(text.trim(), matcher) })
        }
      }
      return envelope('docx', 'Word', hits, totalMatches, timeNote)
    } catch (err) {
      const msg = errMessage(err)
      return { success: false, format: 'docx', summary: `解析失败: ${msg}`, details: {}, error: msg }
    }
  }

  // ── xlsx: cell addresses + row context ──
  if (names.includes('xl/workbook.xml')) {
    try {
      const ExcelJS = (await import('exceljs')).default
      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.load(buffer as unknown as ArrayBuffer)

      const sheets = input.sheet
        ? workbook.worksheets.filter((w) => w.name === input.sheet).length > 0
          ? workbook.worksheets.filter((w) => w.name === input.sheet)
          : workbook.worksheets.filter((w) => w.name.toLowerCase() === input.sheet!.toLowerCase())
        : workbook.worksheets
      if (input.sheet && sheets.length === 0) {
        return {
          success: false,
          format: 'xlsx',
          summary: `工作表「${input.sheet}」不存在`,
          details: {},
          error: `工作表「${input.sheet}」不存在。可用: ${workbook.worksheets.map((w) => w.name).join(', ')}`,
        }
      }

      const hits: NonNullable<OfficeSearchResult['details']['hits']> = []
      let totalMatches = 0
      let scanned = 0
      let scanNote: string | undefined
      outer: for (const ws of sheets) {
        for (let r = 1; r <= ws.rowCount; r++) {
          const row = ws.getRow(r)
          let preview: string[] | undefined
          for (let c = 1; c <= ws.columnCount; c++) {
            if (budget.spent()) {
              scanNote = budget.note()
              break outer
            }
            const cell = row.getCell(c)
            const text = xlsxReadCellText(cell)
            if (!text) continue
            if (++scanned > XLSX_MAX_SCAN_CELLS) {
              scanNote = `扫描在 ${XLSX_MAX_SCAN_CELLS} 格处停止——已覆盖的部分如下，收窄 sheet 或 query 可扫完剩余`
              break outer
            }
            if (!matcher.matches(text)) continue
            totalMatches++
            if (hits.length >= MAX_HITS) continue
            if (!preview) {
              preview = []
              for (let pc = 1; pc <= ws.columnCount && preview.length < ROW_PREVIEW_CELLS; pc++) {
                const t = xlsxReadCellText(row.getCell(pc))
                if (t) preview.push(t.slice(0, PREVIEW_CELL_CHARS))
              }
            }
            hits.push({ sheet: ws.name, address: cell.address, rowPreview: preview, snippet: snippetOf(text, matcher) })
          }
        }
      }
      return envelope('xlsx', 'Excel', hits, totalMatches, scanNote)
    } catch (err) {
      const msg = errMessage(err)
      return { success: false, format: 'xlsx', summary: `解析失败: ${msg}`, details: {}, error: msg }
    }
  }

  // ── pptx: slide + shape id (sldIdLst order — the coordinate `slide` counts) ──
  if (names.includes('ppt/presentation.xml')) {
    try {
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
          error: '无法从 presentation.xml 的 sldIdLst 解析出任何幻灯片（rels 缺失或损坏）',
        }
      }
      const wanted = input.slide != null ? Math.floor(input.slide) : null
      if (wanted !== null && (wanted < 1 || wanted > slideNames.length)) {
        return { success: false, format: 'pptx', summary: `第 ${wanted} 页不存在`, details: {}, error: `第 ${wanted} 页不存在（共 ${slideNames.length} 页）` }
      }
      const hits: NonNullable<OfficeSearchResult['details']['hits']> = []
      let totalMatches = 0
      let timeNote: string | undefined
      outer: for (let i = 0; i < slideNames.length; i++) {
        const index = i + 1
        if (wanted !== null && index !== wanted) continue
        const xml = (zip.readFile(slideNames[i]) as Buffer).toString('utf8')
        const model = buildSlideModel(xml)
        for (const shape of model.shapes) {
          if (budget.spent()) {
            timeNote = budget.note()
            break outer
          }
          const text = shape.paragraphs.map((p) => renderGaps(p.text)).join('\n')
          if (!matcher.matches(text)) continue
          totalMatches++
          if (hits.length < MAX_HITS) {
            hits.push({ slide: index, shapeId: shape.id, name: shape.name, snippet: snippetOf(renderGaps(text), matcher) })
          }
        }
      }
      return envelope('pptx', 'PowerPoint', hits, totalMatches, timeNote)
    } catch (err) {
      const msg = errMessage(err)
      return { success: false, format: 'pptx', summary: `解析失败: ${msg}`, details: {}, error: msg }
    }
  }

  return {
    success: false,
    format: 'unknown',
    summary: '无法识别的 Office 格式',
    details: {},
    error: 'ZIP 包内未找到 word/document.xml、xl/workbook.xml 或 ppt/presentation.xml',
  }
}
