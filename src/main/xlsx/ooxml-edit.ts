// ── xlsx OOXML direct-edit engine (PLAN-office-editing §P2.4) ──
// For workbooks with charts/drawings/themes that exceljs would destroy:
// bypass exceljs entirely, edit sheet XML directly through adm-zip.
// Supports: inspect, set_cell, find_replace (add_row not supported —
// requires row insertion which is complex in raw XML).
//
// Design: parse XML to LOCATE elements (with byte offsets), then modify the
// original XML string via targeted replacements. Never re-serialize from tree
// (that loses namespace declarations and breaks ExcelJS read-back).

import AdmZip from 'adm-zip'
import type { XlsxEditOutcome } from '../../shared/office/ops'
import { XlsxBatchError } from './engine'

// ── Detection ──

const OOXML_REQUIRED_PATTERNS: Array<[RegExp, string]> = [
  [/^xl\/charts\//, 'charts'],
  [/^xl\/drawings\//, 'drawings'],
  [/^xl\/themes\//, 'themes'],
]

export function needsOOXMLPath(buffer: Buffer): boolean {
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) return false
  try {
    const zip = new AdmZip(buffer)
    const names = zip.getEntries().map((e) => e.entryName)
    return OOXML_REQUIRED_PATTERNS.some(([pattern]) => names.some((n) => pattern.test(n)))
  } catch {
    return false
  }
}

// ── XML tokenizer with byte offsets ──
// Modified from docx/xml-splice.ts approach: single-pass, locate-only,
// produces offset-tracked nodes for targeted string replacement.

interface XmlNode {
  kind: 'element' | 'text' | 'pi' | 'comment'
  name?: string
  attrs?: Map<string, string>
  children?: XmlNode[]
  text?: string
  // Byte offsets in original XML string (UTF-16 code units after decode)
  start?: number   // '<' for elements, first char for text
  end?: number     // '>' exclusive for elements, end for text
  tagStart?: number   // start of opening tag including '<'
  tagEnd?: number     // end of opening tag (after '>')
  closeStart?: number // position of '<' in '</tag>' (for insertion before closing tag)
}

function parseXML(xml: string): XmlNode {
  const root: XmlNode = { kind: 'element', name: '?root', attrs: new Map(), children: [], start: 0, end: xml.length }
  const stack: XmlNode[] = [root]
  let i = 0
  const push = (n: XmlNode) => { stack[stack.length - 1].children!.push(n) }

  while (i < xml.length) {
    if (xml[i] !== '<') {
      let end = xml.indexOf('<', i)
      if (end < 0) end = xml.length
      push({ kind: 'text', text: xml.slice(i, end), start: i, end })
      i = end
      continue
    }
    if (xml.startsWith('<!--', i)) {
      const close = xml.indexOf('-->', i + 4)
      const end = close >= 0 ? close + 3 : xml.length
      push({ kind: 'comment', text: xml.slice(i, end), start: i, end })
      i = end
      continue
    }
    if (xml.startsWith('<?', i)) {
      const close = xml.indexOf('?>', i + 2)
      const end = close >= 0 ? close + 2 : xml.length
      push({ kind: 'pi', text: xml.slice(i, end), start: i, end })
      i = end
      continue
    }
    if (xml.startsWith('<![CDATA[', i)) {
      const close = xml.indexOf(']]>', i + 9)
      const end = close >= 0 ? close + 3 : xml.length
      push({ kind: 'text', text: xml.slice(i + 9, close >= 0 ? close : xml.length), start: i, end })
      i = end
      continue
    }

    if (xml[i + 1] === '/') {
      // closing tag
      const closeEnd = xml.indexOf('>', i + 2)
      const end = closeEnd >= 0 ? closeEnd + 1 : xml.length
      if (stack.length > 1) {
        const popped = stack[stack.length - 1]
        popped.end = end
        popped.closeStart = i  // position of '<' in '</tag>'
        stack.pop()
      }
      i = end
      continue
    }

    // opening or self-closing tag
    const tagStart = i
    const tagEnd = xml.indexOf('>', i + 1)
    if (tagEnd < 0) break
    const tagContent = xml.slice(i + 1, xml[tagEnd - 1] === '/' ? tagEnd - 1 : tagEnd)
    const spaceIdx = tagContent.search(/\s/)
    const name = spaceIdx > 0 ? tagContent.slice(0, spaceIdx) : tagContent
    const attrs = new Map<string, string>()
    if (spaceIdx > 0) {
      const attrStr = tagContent.slice(spaceIdx + 1).replace(/\/$/, '').trim()
      const re = /([\w:.-]+)(?:="([^"]*?)")/g
      let m: RegExpExecArray | null
      while ((m = re.exec(attrStr))) attrs.set(m[1], m[2])
    }
    const selfClose = tagContent.endsWith('/') || xml[tagEnd - 1] === '/'
    const nodeEnd = selfClose ? tagEnd + 1 : tagEnd + 1
    const node: XmlNode = {
      kind: 'element', name, attrs, children: [],
      start: tagStart, end: nodeEnd, tagStart, tagEnd: tagEnd + 1,
    }
    push(node)
    if (!selfClose) stack.push(node)
    i = nodeEnd
  }
  return root
}

function findElement(node: XmlNode, name: string): XmlNode | undefined {
  if (node.kind === 'element' && node.name === name) return node
  if (!node.children) return undefined
  for (const child of node.children) {
    const found = findElement(child, name)
    if (found) return found
  }
  return undefined
}

function findElements(node: XmlNode, name: string): XmlNode[] {
  const results: XmlNode[] = []
  const walk = (n: XmlNode) => {
    if (n.kind === 'element' && n.name === name) results.push(n)
    if (n.children) n.children.forEach(walk)
  }
  walk(node)
  return results
}

function getText(node: XmlNode): string {
  if (node.kind === 'text') return node.text ?? ''
  if (!node.children) return ''
  return node.children.map(getText).join('')
}

function getAttr(node: XmlNode, name: string): string | undefined { return node.attrs?.get(name) }

// ── Cell reference parsing ──

function colToIndex(col: string): number {
  let n = 0
  for (const ch of col.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

function parseCellRef(ref: string): { col: string; row: number; colIdx: number } | null {
  const m = ref.match(/^([A-Za-z]{1,3})([1-9]\d*)$/)
  if (!m) return null
  return { col: m[1].toUpperCase(), row: parseInt(m[2], 10), colIdx: colToIndex(m[1]) }
}

// ── String replacement helper ──

function escapeXmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ── post-edit structural gate ──

/** Throw unless every tag in `xml` is balanced. Offset-splice edits must
 *  leave the sheet well-formed; this is the check a bad splice cannot pass
 *  (duplicated document bodies, unclosed rows). */
function assertWellFormedXml(xml: string, label: string): void {
  const stack: Array<{ name: string }> = []
  let i = 0
  while (i < xml.length) {
    if (xml[i] !== '<') {
      const next = xml.indexOf('<', i)
      i = next < 0 ? xml.length : next
      continue
    }
    if (xml.startsWith('<!--', i)) { const c = xml.indexOf('-->', i + 4); i = c >= 0 ? c + 3 : xml.length; continue }
    if (xml.startsWith('<?', i)) { const c = xml.indexOf('?>', i + 2); i = c >= 0 ? c + 2 : xml.length; continue }
    if (xml.startsWith('<![CDATA[', i)) { const c = xml.indexOf(']]>', i + 9); i = c >= 0 ? c + 3 : xml.length; continue }
    if (xml[i + 1] === '/') {
      const closeEnd = xml.indexOf('>', i + 2)
      if (closeEnd < 0) throw new Error(`OOXML 直改产物结构校验失败（${label}）：存在残缺的闭合标签`)
      const name = xml.slice(i + 2, closeEnd).trim()
      const top = stack.pop()
      if (!top || top.name !== name) {
        throw new Error(`OOXML 直改产物结构校验失败（${label}）：</${name}> 与 <${top?.name ?? '（空）'}> 不匹配，拒绝写盘`)
      }
      i = closeEnd + 1
      continue
    }
    const tagEnd = xml.indexOf('>', i + 1)
    if (tagEnd < 0) throw new Error(`OOXML 直改产物结构校验失败（${label}）：存在未闭合的标签，拒绝写盘`)
    const tagContent = xml.slice(i + 1, xml[tagEnd - 1] === '/' ? tagEnd - 1 : tagEnd)
    const spaceIdx = tagContent.search(/\s/)
    const name = spaceIdx > 0 ? tagContent.slice(0, spaceIdx) : tagContent
    const selfClose = tagContent.endsWith('/') || xml[tagEnd - 1] === '/'
    if (!selfClose) stack.push({ name })
    i = tagEnd + 1
  }
  if (stack.length > 0) {
    throw new Error(`OOXML 直改产物结构校验失败（${label}）：${stack.length} 个标签未闭合（如 <${stack[stack.length - 1].name}>），拒绝写盘`)
  }
}

// ── OOXML edit engine ──

const MAX_CELL_TEXT = 32_000

interface OOXMLSheetState {
  name: string
  fileName: string
  xml: string
  /** XML as loaded from the ZIP — the change detector for the write gate
   *  (replacements can be drained mid-batch by the re-parse flow, so their
   *  count is not a dirty flag). */
  originalXml: string
  tree: XmlNode
  rows: Map<number, XmlNode>
  /** Accumulated string replacements (applied at the end, right-to-left by offset). */
  replacements: Array<{ start: number; end: number; text: string }>
}

export async function editXlsxOOXML(buffer: Buffer, ops: Array<Record<string, unknown>>): Promise<XlsxEditOutcome> {
  const zip = new AdmZip(buffer)
  const rawEntries = zip.getEntries()
  const entries = rawEntries.map((e) => e.entryName)

  if (!entries.some((n) => n === 'xl/workbook.xml')) {
    throw new Error('包内缺少 xl/workbook.xml — 不是有效的 Excel 工作簿')
  }

  // Load shared strings (read-only)
  const sharedStrings: string[] = []
  if (entries.includes('xl/sharedStrings.xml')) {
    const ssXml = zip.readFile('xl/sharedStrings.xml')!.toString('utf8')
    const ssTree = parseXML(ssXml)
    const sst = findElement(ssTree, 'sst') ?? ssTree
    for (const si of sst.children ?? []) {
      if (si.kind !== 'element' || si.name !== 'si') continue
      const t = findElement(si, 't')
      if (t) { sharedStrings.push(getText(t)); continue }
      const parts: string[] = []
      for (const r of si.children ?? []) {
        if (r.kind === 'element' && r.name === 'r') {
          const rt = findElement(r, 't')
          if (rt) parts.push(getText(rt))
        }
      }
      sharedStrings.push(parts.join(''))
    }
  }

  // Resolve sheet files from workbook.xml + rels
  const sheetFileMap = new Map<string, string>()
  const wbXml = zip.readFile('xl/workbook.xml')!.toString('utf8')
  const wbTree = parseXML(wbXml)
  const sheetsEl = findElement(wbTree, 'sheets')
  if (!sheetsEl) throw new Error('工作簿缺少 <sheets> 元素')
  const relsPath = 'xl/_rels/workbook.xml.rels'
  const hasRels = entries.includes(relsPath)
  let relsXml = ''
  let relsTree: XmlNode | null = null
  if (hasRels) {
    relsXml = zip.readFile(relsPath)!.toString('utf8')
    relsTree = parseXML(relsXml)
  }
  for (const sheetEl of sheetsEl.children ?? []) {
    if (sheetEl.kind !== 'element' || sheetEl.name !== 'sheet') continue
    const name = getAttr(sheetEl, 'name') ?? ''
    const rId = getAttr(sheetEl, 'r:id') ?? ''
    if (!rId || !relsTree) continue
    const relsRoot = findElement(relsTree, 'Relationships') ?? relsTree
    for (const rel of relsRoot.children ?? []) {
      if (rel.kind !== 'element' || rel.name !== 'Relationship') continue
      if (getAttr(rel, 'Id') === rId) {
        const target = getAttr(rel, 'Target') ?? ''
        const fileName = target.startsWith('/') ? target.slice(1) : `xl/${target}`
        sheetFileMap.set(name, fileName)
        break
      }
    }
  }

  // Load sheet states (with offset tracking)
  const sheetStates = new Map<string, OOXMLSheetState>()
  for (const [name, fileName] of sheetFileMap) {
    if (!entries.includes(fileName)) continue
    const xml = zip.readFile(fileName)!.toString('utf8')
    const tree = parseXML(xml)
    const rows = new Map<number, XmlNode>()
    const ws = findElement(tree, 'worksheet') ?? tree
    const sheetData = findElement(ws, 'sheetData')
    if (sheetData) {
      for (const row of sheetData.children ?? []) {
        if (row.kind === 'element' && row.name === 'row') {
          const r = parseInt(getAttr(row, 'r') ?? '0', 10)
          if (r > 0) rows.set(r, row)
        }
      }
    }
    sheetStates.set(name, { name, fileName, xml, originalXml: xml, tree, rows, replacements: [] })
  }

  const resolveSheetState = (name?: string): OOXMLSheetState => {
    if (name) {
      const s = sheetStates.get(name)
      if (!s) throw new Error(`找不到工作表「${name}」；现有: ${[...sheetStates.keys()].join(', ')}`)
      return s
    }
    const first = sheetStates.values().next().value
    if (!first) throw new Error('工作簿中没有工作表')
    return first
  }

  /** Queue a replacement on the sheet's XML string. */
  const queueReplacement = (state: OOXMLSheetState, start: number, end: number, text: string) => {
    state.replacements.push({ start, end, text })
  }

  /** Queue content to be appended just inside `el`'s closing tag. A
   *  self-closing element (Excel writes `<row/>` for empty rows carrying a
   *  row height) has no closing tag, so its whole tag is replaced by the
   *  opened form — splicing at its undefined closeStart would replicate the
   *  entire sheet XML (the H4 corruption). */
  const appendInsideElement = (state: OOXMLSheetState, el: XmlNode, innerXml: string) => {
    if (el.closeStart !== undefined && el.closeStart >= (el.tagEnd ?? 0)) {
      queueReplacement(state, el.closeStart, el.closeStart, innerXml)
      return
    }
    const tagXml = state.xml.slice(el.start!, el.end!)
    const opened = tagXml.replace(/\/>$/, '>')
    if (opened === tagXml) throw new Error(`无法在自闭合元素 <${el.name}/> 内插入内容（标签形态异常）`)
    queueReplacement(state, el.start!, el.end!, `${opened}${innerXml}</${el.name}>`)
  }

  /** Build the final XML for a sheet by applying all queued replacements (right-to-left). */
  const buildSheetXml = (state: OOXMLSheetState): string => {
    if (state.replacements.length === 0) return state.xml
    const sorted = [...state.replacements].sort((a, b) => b.start - a.start) // right-to-left
    let result = state.xml
    for (const r of sorted) {
      result = result.slice(0, r.start) + r.text + result.slice(r.end)
    }
    return result
  }

  const results: XlsxEditOutcome['results'] = []
  const warnings: string[] = []

  for (let index = 0; index < ops.length; index++) {
    const op = ops[index] as Record<string, unknown>
    const kind = String(op.op ?? '')
    try {
      if (kind === 'inspect') {
        const state = resolveSheetState(op.sheet as string | undefined)
        let maxRow = 0, maxCol = 0
        for (const [, rowEl] of state.rows) {
          for (const c of rowEl.children ?? []) {
            if (c.kind !== 'element' || c.name !== 'c') continue
            const ref = parseCellRef(getAttr(c, 'r') ?? '')
            if (ref) { maxRow = Math.max(maxRow, ref.row); maxCol = Math.max(maxCol, ref.colIdx + 1) }
          }
        }
        results.push({ index, op: kind, ok: true, detail: `工作表「${state.name}」共 ${maxRow} 行 × ${maxCol} 列（OOXML 直改模式）` })
        continue
      }

      if (kind === 'set_cell') {
        const state = resolveSheetState(op.sheet as string | undefined)
        const address = String(op.cell ?? '')
        if (!/^[A-Za-z]{1,3}[1-9]\d*$/.test(address)) throw new Error(`set_cell: 非法单元格地址「${address}」`)
        const ref = parseCellRef(address)!
        let rowEl = state.rows.get(ref.row)

        if (!rowEl) {
          // Insert new <row> element — we need to splice it into the XML
          // Find sheetData and insert in row order
          const ws = findElement(state.tree, 'worksheet') ?? state.tree
          let sheetData = findElement(ws, 'sheetData')
          if (!sheetData) {
            // sheetData doesn't exist — add it before </worksheet>
            appendInsideElement(state, ws, `\n    <sheetData>\n      <row r="${ref.row}">\n        <c r="${address}"/>\n      </row>\n    </sheetData>`)
            // Re-parse to update tree for subsequent ops
            const updatedXml = buildSheetXml(state)
            state.xml = updatedXml
            state.tree = parseXML(updatedXml)
            state.replacements = []
            // Rebuild rows map
            state.rows.clear()
            const newWs = findElement(state.tree, 'worksheet') ?? state.tree
            const newSd = findElement(newWs, 'sheetData')
            if (newSd) {
              for (const row of newSd.children ?? []) {
                if (row.kind === 'element' && row.name === 'row') {
                  const r = parseInt(getAttr(row, 'r') ?? '0', 10)
                  if (r > 0) state.rows.set(r, row)
                }
              }
            }
            rowEl = state.rows.get(ref.row)!
          } else {
            // Insert new row in order within sheetData
            const rowXml = `\n      <row r="${ref.row}">\n        <c r="${address}"/>\n      </row>`
            let inserted = false
            const children = sheetData.children ?? []
            for (let i = 0; i < children.length; i++) {
              const existing = children[i]
              if (existing.kind === 'element' && existing.name === 'row') {
                const existR = parseInt(getAttr(existing, 'r') ?? '0', 10)
                if (existR > ref.row) {
                  queueReplacement(state, existing.start!, existing.start!, rowXml)
                  inserted = true
                  break
                }
              }
            }
            if (!inserted) {
              appendInsideElement(state, sheetData, rowXml)
            }
            // Re-parse
            const updatedXml = buildSheetXml(state)
            state.xml = updatedXml
            state.tree = parseXML(updatedXml)
            state.replacements = []
            state.rows.clear()
            const newWs = findElement(state.tree, 'worksheet') ?? state.tree
            const newSd = findElement(newWs, 'sheetData')
            if (newSd) {
              for (const row of newSd.children ?? []) {
                if (row.kind === 'element' && row.name === 'row') {
                  const r = parseInt(getAttr(row, 'r') ?? '0', 10)
                  if (r > 0) state.rows.set(r, row)
                }
              }
            }
            rowEl = state.rows.get(ref.row)!
          }
        }

        // Find existing cell
        let cellEl: XmlNode | undefined
        for (const c of rowEl.children ?? []) {
          if (c.kind === 'element' && c.name === 'c' && getAttr(c, 'r') === address) {
            cellEl = c; break
          }
        }

        // Read before value
        let beforeText = ''
        if (cellEl) {
          const vEl = findElement(cellEl, 'v')
          if (vEl) {
            const tAttr = getAttr(cellEl, 't')
            if (tAttr === 's') {
              const idx = parseInt(getText(vEl), 10)
              beforeText = sharedStrings[idx] ?? ''
            } else {
              beforeText = getText(vEl)
            }
          }
        }

        if (typeof op.formula === 'string' && op.formula) {
          // Formula cell — replace entire cell content
          const formula = op.formula.startsWith('=') ? op.formula.slice(1) : op.formula
          const newCellXml = `<c r="${address}"><f>${escapeXmlText(formula)}</f><v>0</v></c>`
          if (cellEl) {
            queueReplacement(state, cellEl.start!, cellEl.end!, newCellXml)
          } else {
            // New cell — append to row
            appendInsideElement(state, rowEl, `\n        ${newCellXml}`)
          }
        } else if ('value' in op) {
          const value = op.value as string | number | boolean | null
          if (typeof value === 'string' && value.length > MAX_CELL_TEXT) throw new Error('set_cell: 单元格文本过长')

          if (!cellEl) {
            // New cell — append to row
            let newCellXml: string
            if (value === null || value === undefined || value === '') {
              newCellXml = `<c r="${address}"/>`
            } else if (typeof value === 'number') {
              newCellXml = `<c r="${address}"><v>${value}</v></c>`
            } else if (typeof value === 'boolean') {
              newCellXml = `<c r="${address}" t="b"><v>${value ? '1' : '0'}</v></c>`
            } else {
              newCellXml = `<c r="${address}" t="inlineStr"><is><t>${escapeXmlText(String(value))}</t></is></c>`
            }
            appendInsideElement(state, rowEl, `\n        ${newCellXml}`)
          } else {
            // Existing cell — replace entire cell
            let newCellXml: string
            if (value === null || value === undefined || value === '') {
              newCellXml = `<c r="${address}"/>`
            } else if (typeof value === 'number') {
              newCellXml = `<c r="${address}"><v>${value}</v></c>`
            } else if (typeof value === 'boolean') {
              newCellXml = `<c r="${address}" t="b"><v>${value ? '1' : '0'}</v></c>`
            } else {
              newCellXml = `<c r="${address}" t="inlineStr"><is><t>${escapeXmlText(String(value))}</t></is></c>`
            }
            queueReplacement(state, cellEl.start!, cellEl.end!, newCellXml)
          }
        }

        results.push({ index, op: kind, ok: true, detail: `${address} ← ${op.formula ? '=' + String(op.formula) : JSON.stringify(op.value ?? null)}（原: ${beforeText.slice(0, 40) || '空'}）` })
        continue
      }

      if (kind === 'find_replace') {
        const state = resolveSheetState(op.sheet as string | undefined)
        const find = String(op.find ?? '')
        if (!find) throw new Error('find_replace: find 不能为空')
        const replace = String(op.replace ?? '')
        let count = 0
        let sharedHits = 0

        // Shared strings are READ-ONLY here (the table is workbook-global;
        // rewriting it would touch every cell that references it). Counting
        // hits into the replaced total reported "replaced N cells" while the
        // bytes never moved — real Excel/WPS files keep almost all strings
        // there, so that lie fired on nearly every real file (H5).
        for (let i = 0; i < sharedStrings.length; i++) {
          if (sharedStrings[i].includes(find)) sharedHits++
        }

        // Scan sheet cells for inline strings — modify via offset replacement
        for (const [, rowEl] of state.rows) {
          for (const c of rowEl.children ?? []) {
            if (c.kind !== 'element' || c.name !== 'c') continue
            const tAttr = getAttr(c, 't')
            if (tAttr === 'inlineStr') {
              const isEl = findElement(c, 'is')
              const tEl = isEl ? findElement(isEl, 't') : undefined
              if (tEl) {
                const text = getText(tEl)
                if (text.includes(find)) {
                  const newText = text.split(find).join(replace)
                  // Replace the text node content within <t>...</t>
                  const textNode = tEl.children?.find((ch) => ch.kind === 'text')
                  if (textNode && textNode.start !== undefined && textNode.end !== undefined) {
                    queueReplacement(state, textNode.start, textNode.end, escapeXmlText(newText))
                  }
                  count++
                }
              }
            }
          }
        }

        if (sharedHits > 0) {
          warnings.push(`find_replace「${find.slice(0, 40)}」：另有 ${sharedHits} 处命中共享字符串表（本模式只读该表、未替换）——如需替换请先用 read 导出内容评估或人工处理`)
        }

        const expected = (op.expected_count as number | undefined) ?? count
        if (count !== expected) {
          throw new Error(`find_replace: 替换了 ${count} 个单元格（expected_count=${expected}）${sharedHits > 0 ? `；另有 ${sharedHits} 处在共享字符串表中，本模式不替换` : '；OOXML 直改模式仅修改内联字符串单元格'}`)
        }
        results.push({ index, op: kind, ok: true, detail: `替换 ${count} 个单元格（OOXML 直改模式）${sharedHits > 0 ? `，${sharedHits} 处共享字符串命中未替换` : ''}` })
        continue
      }

      throw new Error(`未知 op: ${kind}（OOXML 直改模式不支持此操作）`)
    } catch (err) {
      results.push({ index, op: kind, ok: false, detail: err instanceof Error ? err.message : String(err) })
      throw new XlsxBatchError(results)
    }
  }

  // Structural gate before any byte reaches the ZIP (mirrors the docx
  // re-tokenize gate): the offset-splice edits must leave every touched
  // sheet balanced. A bad splice (e.g. the self-closing-row duplication)
  // fails HERE — refusing the write — instead of corrupting the file and
  // reporting success.
  for (const [name, state] of sheetStates) {
    const fileName = sheetFileMap.get(name)
    if (!fileName) continue
    const finalXml = buildSheetXml(state)
    if (finalXml === state.originalXml) continue
    assertWellFormedXml(finalXml, `工作表「${name}」`)
    zip.updateFile(fileName, Buffer.from(finalXml, 'utf8'))
  }

  const outBuffer = zip.toBuffer()

  // Outline: compute from modified state
  const outline: XlsxEditOutcome['outline'] = []
  for (const [name, state] of sheetStates) {
    let maxRow = 0, maxCol = 0
    for (const [, rowEl] of state.rows) {
      for (const c of rowEl.children ?? []) {
        if (c.kind !== 'element' || c.name !== 'c') continue
        const ref = parseCellRef(getAttr(c, 'r') ?? '')
        if (ref) { maxRow = Math.max(maxRow, ref.row); maxCol = Math.max(maxCol, ref.colIdx + 1) }
      }
    }
    outline.push({ sheet: name, usedRange: `${maxRow} 行 × ${maxCol} 列` })
  }

  return { buffer: outBuffer, results, outline, warnings }
}
