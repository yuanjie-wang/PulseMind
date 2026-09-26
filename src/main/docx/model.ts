// ── L1 typed document model (PLAN-office-editing §3.2, T4) ──
// Walks the parsed document.xml into paragraphs and runs. The text graph
// (L4 rules): per-paragraph concatenated DECODED text over `w:t` runs only —
// `w:tab`/`w:br` become unmatchable gap characters, `w:delText` (deleted-
// revision text the user does not see) is NEVER part of the matchable text,
// and table-cell paragraphs are ordinary paragraphs (replace/format work
// there for free).

import { parseXml, decodedText, type XmlElementNode } from './xml-splice'

/** A private-use character: joins runs into readable text but can never be
 *  typed by a user, so a find never spans a tab/break by accident. */
export const GAP_CHAR = '\uE000'

export interface RunInfo {
  element: XmlElementNode
  /** The `w:t` inside the run. */
  textElement: XmlElementNode
  text: string
  /** decoded char i → raw document offset. */
  charMap: number[]
}

export interface ParagraphInfo {
  index: number
  element: XmlElementNode
  style: string | null
  runs: RunInfo[]
  /** Concatenated decoded text (gaps inserted for tab/br). */
  text: string
  /** concat char i → { run, offset } (offset < 0 for gap chars). */
  charMap: Array<{ run: number; offset: number }>
  hasSectPr: boolean
  /** True when this paragraph is the ONLY block-level element of its table
   *  cell — deleting it would leave a schema-illegal empty `<w:tc/>` (M8). */
  soleBlockOfCell?: boolean
}

export interface TableRowsInfo {
  element: XmlElementNode
  /** The row's <w:tc> nodes, full XML elements (start/end/children) — the
   *  row-clone ops read their spans and tcPr children directly. */
  cells: XmlElementNode[]
}

export interface TableInfo {
  index: number
  element: XmlElementNode
  rows: TableRowsInfo[]
}

export interface DocumentModel {
  paragraphs: ParagraphInfo[]
  /** BODY-LEVEL `w:tbl` only (M4): nested tables are deliberately not
   *  addressable — row clones/deletes on a nested grid corrupt vMerge bookkeeping
   *  and are refused, not half-supported. */
  tables: TableInfo[]
}

const isElement = (n: { kind?: string }): n is XmlElementNode => n.kind === 'element'

function pPrOf(paragraph: XmlElementNode): XmlElementNode | null {
  return (paragraph.children.find((c) => isElement(c) && c.name === 'w:pPr') as XmlElementNode | undefined) ?? null
}

function styleOf(paragraph: XmlElementNode): string | null {
  const pPr = pPrOf(paragraph)
  const pStyle = pPr ? (pPr.children.find((c) => isElement(c) && c.name === 'w:pStyle') as XmlElementNode | undefined) : undefined
  return pStyle ? (pStyle.attrs.get('w:val')?.rawValue ?? null) : null
}

function buildParagraph(paragraph: XmlElementNode, index: number): ParagraphInfo {
  const runs: RunInfo[] = []
  let text = ''
  const charMap: Array<{ run: number; offset: number }> = []

  // A paragraph's visible text lives in w:r > w:t; revisions wrap runs in
  // w:ins (still matchable — the user SEES that text) while w:del carries
  // w:delText (invisible — excluded). Walk descendants in document order.
  const walk = (node: XmlElementNode, insideIns: boolean): void => {
    for (const child of node.children) {
      if (!isElement(child)) continue
      if (child.name === 'w:del') continue // deleted content: never matchable
      // mc:AlternateContent repeats the same content in Choice + Fallback —
      // the Fallback copy must not double every match (L4).
      if (child.name === 'mc:Fallback') continue
      if (child.name === 'w:tab' || child.name === 'w:br') {
        text += GAP_CHAR
        charMap.push({ run: -1, offset: -1 })
        continue
      }
      if (child.name === 'w:ins') { walk(child, true); continue }
      if (child.name === 'w:r') {
        const textEl = child.children.find((c) => isElement(c) && c.name === 'w:t') as XmlElementNode | undefined
        if (textEl) {
          const { text: decoded, charMap: map } = decodedText(textEl)
          const runIndex = runs.length
          runs.push({ element: child, textElement: textEl, text: decoded, charMap: map })
          for (let i = 0; i < decoded.length; i++) {
            text += decoded[i]
            charMap.push({ run: runIndex, offset: i })
          }
        }
        continue
      }
      // w:hyperlink and friends wrap runs — recurse.
      if (child.children.length > 0) walk(child, insideIns)
    }
  }
  walk(paragraph, false)

  return {
    index,
    element: paragraph,
    style: styleOf(paragraph),
    runs,
    text,
    charMap,
    hasSectPr: !!pPrOf(paragraph)?.children.find((c) => isElement(c) && c.name === 'w:sectPr'),
  }
}

export function buildDocumentModel(xml: string): DocumentModel {
  const { root } = parseXml(xml)
  const document = root.children.find((c) => isElement(c) && c.name === 'w:document') as XmlElementNode | undefined
  const body = (document ?? root).children.find((c) => isElement(c) && c.name === 'w:body') as XmlElementNode | undefined
  const paragraphs: ParagraphInfo[] = []
  const tables: TableInfo[] = []
  if (!body) return { paragraphs, tables }
  const collect = (container: XmlElementNode): void => {
    for (const child of container.children) {
      if (!isElement(child)) continue
      if (child.name === 'w:p') {
        paragraphs.push(buildParagraph(child, paragraphs.length))
      } else if (child.name === 'w:tbl') {
        const rows: TableRowsInfo[] = []
        for (const tr of child.children) {
          if (!isElement(tr) || tr.name !== 'w:tr') continue
          rows.push({ element: tr, cells: tr.children.filter((c) => isElement(c) && c.name === 'w:tc') as XmlElementNode[] })
        }
        tables.push({ index: tables.length, element: child, rows })
        // Paragraphs inside still join the flat list (replace/format work in
        // cells); nested tables deliberately do NOT join `tables`.
        collect(child as XmlElementNode)
      } else if (child.name === 'w:tr' || child.name === 'w:tc' ||
                 child.name === 'w:sdt' || child.name === 'w:sdtContent' || child.name === 'w:customXml' ||
                 child.name === 'w:hyperlink' || child.name === 'w:body') {
        // Containers recurse until the paragraphs inside (tables nest
        // tbl > tr > tc > p; structured document tags wrap either).
        collect(child as XmlElementNode)
      }
    }
  }
  collect(body as XmlElementNode)
  markSoleCellParagraphs(body as XmlElementNode, paragraphs)
  return { paragraphs, tables }
}

/** OOXML requires every `w:tc` to keep at least one block-level element; a
 *  cell whose single block is one `w:p` must never have that `w:p` deleted. */
function markSoleCellParagraphs(node: XmlElementNode, paragraphs: ParagraphInfo[]): void {
  for (const child of node.children) {
    if (!isElement(child)) continue
    if (child.name === 'w:tc') {
      const blocks = child.children.filter((c) => isElement(c) && (c.name === 'w:p' || c.name === 'w:tbl' || c.name === 'w:sdt')) as XmlElementNode[]
      if (blocks.length === 1 && blocks[0].name === 'w:p') {
        const p = paragraphs.find((pp) => pp.element === blocks[0])
        if (p) p.soleBlockOfCell = true
      }
    }
    if (child.children.length > 0) markSoleCellParagraphs(child, paragraphs)
  }
}

export interface OutlineEntry {
  index: number
  style: string | null
  text: string
}

/** The outline every tool result returns (L9): index + style + a one-line
 *  summary, capped — the model navigates by it before editing. */
export function outlineOf(model: DocumentModel, cap = 200): OutlineEntry[] {
  const entries = model.paragraphs.map((p) => ({
    index: p.index,
    style: p.style,
    text: p.text.replace(new RegExp(GAP_CHAR, 'g'), ' ').trim().slice(0, 80),
  }))
  return entries.length <= cap ? entries : entries.slice(0, cap)
}
