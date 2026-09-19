// ── pptx text-graph model (PLAN-pptx-editing, L4's slide twin) ── Walks one
//  slide part's parsed XML into SHAPES and PARAGRAPHS. The matchable text of
//  a paragraph is the concatenated DECODED text of its `a:t` runs only:
//  `a:br` becomes a GAP_CHAR (find never spans a line break by accident),
//  `a:fld` (slide-number/date fields) is EXCLUDED — its a:t is a cache
//  PowerPoint recomputes, so editing it is meaningless — and table-cell
//  txBody paragraphs are ordinary paragraphs (replace works there for free).
//  `mc:Fallback` is skipped so AlternateContent never double-matches.

import { parseXml, decodedText, type XmlElementNode, type ParsedXml } from '../docx/xml-splice'

/** Same private-use joiner the docx model uses. */
export const GAP_CHAR = '\uE000'

const isElement = (n: { kind?: string }): n is XmlElementNode => n.kind === 'element'

export interface RunInfo {
  element: XmlElementNode
  /** The `a:t` inside the run. */
  textElement: XmlElementNode
  text: string
  /** decoded char i → raw document offset. */
  charMap: number[]
}

export interface ParagraphInfo {
  element: XmlElementNode
  runs: RunInfo[]
  text: string
  /** concat char i → { run, offset } (offset < 0 for gap chars). */
  charMap: Array<{ run: number; offset: number }>
}

export interface ShapeInfo {
  /** `p:cNvPr@id` — the stable handle set_shape_text addresses. */
  id: string
  /** `p:cNvPr@name` — often "Title 1" / "文本框 4". */
  name: string
  /** placeholder type when the shape is one (title/ctrTitle/body/…). */
  phType?: string
  element: XmlElementNode
  paragraphs: ParagraphInfo[]
}

export interface SlideModel {
  parsed: ParsedXml
  shapes: ShapeInfo[]
}

/** The txBody-bearing shape kinds; a `p:pic` can carry text too (its txBody)
 *  but pictures with text are rare — sp and cxnSp cover the real graph. */
function isShapeElement(el: XmlElementNode): boolean {
  return el.name === 'p:sp' || el.name === 'p:cxnSp'
}

function phTypeOf(shape: XmlElementNode): string | undefined {
  const nv = shape.children.find((c) => isElement(c) && (c.name === 'p:nvSpPr' || c.name === 'p:nvCxnSpPr')) as XmlElementNode | undefined
  const ph = nv?.children.find((c) => isElement(c) && c.name === 'p:nvPr') as XmlElementNode | undefined
  const phEl = ph?.children.find((c) => isElement(c) && c.name === 'p:ph') as XmlElementNode | undefined
  return phEl?.attrs.get('type')?.rawValue
}

function cNvPrOf(shape: XmlElementNode): XmlElementNode | undefined {
  const nv = shape.children.find((c) => isElement(c) && (c.name === 'p:nvSpPr' || c.name === 'p:nvCxnSpPr')) as XmlElementNode | undefined
  return nv?.children.find((c) => isElement(c) && c.name === 'p:cNvPr') as XmlElementNode | undefined
}

function buildParagraph(paragraph: XmlElementNode): ParagraphInfo {
  const runs: RunInfo[] = []
  let text = ''
  const charMap: Array<{ run: number; offset: number }> = []
  const walk = (node: XmlElementNode): void => {
    for (const child of node.children) {
      if (!isElement(child)) continue
      if (child.name === 'mc:Fallback') continue
      if (child.name === 'a:br') {
        text += GAP_CHAR
        charMap.push({ run: -1, offset: -1 })
        continue
      }
      if (child.name === 'a:fld') continue // field cache — not matchable (D2)
      if (child.name === 'a:r') {
        const textEl = child.children.find((c) => isElement(c) && c.name === 'a:t') as XmlElementNode | undefined
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
      // a:hyperlink and unknown wrappers recurse (deep a:t stays visible text)
      if (child.children.length > 0) walk(child)
    }
  }
  walk(paragraph)
  return { element: paragraph, runs, text, charMap }
}

/** Collect paragraphs of one txBody, in document order. */
function txBodyParagraphs(txBody: XmlElementNode): ParagraphInfo[] {
  return txBody.children.filter((c): c is XmlElementNode => isElement(c) && c.name === 'a:p').map(buildParagraph)
}

/** Walk the shape tree: p:sp/p:cxnSp are shapes; p:grpSp recurses; a graphic-
 *  frame TABLE's cells contribute shapes-less paragraphs via synthetic shapes
 *  (one per cell) so replace_text reaches table text with the same machinery. */
function collectShapes(container: XmlElementNode, into: ShapeInfo[], syntheticIdBase: { n: number }): void {
  for (const child of container.children) {
    if (!isElement(child)) continue
    if (isShapeElement(child)) {
      const cNvPr = cNvPrOf(child)
      const txBody = child.children.find((c) => isElement(c) && c.name === 'p:txBody') as XmlElementNode | undefined
      if (!txBody) continue
      into.push({
        id: cNvPr?.attrs.get('id')?.rawValue ?? '',
        name: cNvPr?.attrs.get('name')?.rawValue ?? '',
        phType: phTypeOf(child),
        element: child,
        paragraphs: txBodyParagraphs(txBody),
      })
      continue
    }
    if (child.name === 'p:grpSp') {
      collectShapes(child, into, syntheticIdBase)
      continue
    }
    if (child.name === 'p:graphicFrame') {
      // Table cells: each a:tc's txBody becomes a synthetic shape whose id is
      // "cell:<r>:<c>" — set_shape_text can address it, replace_text just works.
      const tbl = findElement(child, 'a:tbl')
      if (!tbl) continue
      const rows = tbl.children.filter((c) => isElement(c) && c.name === 'a:tr') as XmlElementNode[]
      rows.forEach((tr, r) => {
        const cells = tr.children.filter((c) => isElement(c) && c.name === 'a:tc') as XmlElementNode[]
        cells.forEach((tc, c) => {
          const txBody = tc.children.find((x) => isElement(x) && x.name === 'a:txBody') as XmlElementNode | undefined
          if (!txBody) return
          into.push({
            id: `cell:${r + 1}:${c + 1}`,
            name: `表格单元格 R${r + 1}C${c + 1}`,
            element: tc,
            paragraphs: txBodyParagraphs(txBody),
          })
        })
      })
    }
  }
}

/** First descendant element with the local (prefixed) tag name. */
export function findElement(node: XmlElementNode, name: string): XmlElementNode | undefined {
  for (const child of node.children) {
    if (!isElement(child)) continue
    if (child.name === name) return child
    const hit = findElement(child, name)
    if (hit) return hit
  }
  return undefined
}

/** Parse one slide part into the editable text graph. */
export function buildSlideModel(xml: string): SlideModel {
  const parsed = parseXml(xml)
  const shapes: ShapeInfo[] = []
  const syntheticIdBase = { n: 0 }
  const spTree = findElement(parsed.root, 'p:cSld')
  const tree = spTree ? findElement(spTree, 'p:spTree') : undefined
  if (tree) collectShapes(tree, shapes, syntheticIdBase)
  return { parsed, shapes }
}

// ── Slide ordering (D3): sldIdLst order through the presentation rels ──

/** The slide part names in presentation order: ['ppt/slides/slide1.xml', …].
 *  Falls back to name-sorted scan when the rels are missing/dangling. */
export function slidePartNames(presentationXml: string, presentationRelsXml: string): string[] {
  const pres = parseXml(presentationXml)
  const rels = parseXml(presentationRelsXml)
  // parseXml's root is the #document wrapper — descend into the real elements.
  const presRoot = firstElement(pres.root)
  const relsRoot = firstElement(rels.root)
  const byId = new Map<string, string>()
  for (const rel of relsRoot?.children ?? []) {
    if (!isElement(rel) || rel.name !== 'Relationship') continue
    const id = rel.attrs.get('Id')?.rawValue
    const target = rel.attrs.get('Target')?.rawValue
    const mode = rel.attrs.get('TargetMode')?.rawValue
    if (!id || !target || mode === 'External') continue
    // Targets are relative to ppt/ (the presentation's directory)
    const stack: string[] = []
    for (const seg of `ppt/${target}`.split('/')) {
      if (seg === '' || seg === '.') continue
      if (seg === '..') stack.pop()
      else stack.push(seg)
    }
    byId.set(id, stack.join('/'))
  }
  const out: string[] = []
  const sldIdLst = presRoot?.children.find((c) => isElement(c) && c.name === 'p:sldIdLst') as XmlElementNode | undefined
  if (sldIdLst) {
    for (const sldId of sldIdLst.children) {
      if (!isElement(sldId) || sldId.name !== 'p:sldId') continue
      let rid = ''
      for (const [name] of sldId.attrs) if (name === 'r:id' || name.endsWith(':id')) rid = sldId.attrs.get(name)?.rawValue ?? ''
      const target = rid ? byId.get(rid) : undefined
      if (target) out.push(target)
    }
  }
  if (out.length === 0) {
    // Dangling rels: nothing resolvable — the caller refuses (fail-closed)
    // rather than guessing slide identity from filenames.
    return []
  }
  return out
}

function firstElement(node: XmlElementNode): XmlElementNode | undefined {
  return node.children.find((c): c is XmlElementNode => isElement(c))
}

// ── outline (the tool's navigation payload) ──

export interface SlideOutline {
  slide: number
  shapes: Array<{ shapeId: string; name: string; phType?: string; text: string }>
}

export function outlineOf(model: SlideModel, slide: number, cap = 200): SlideOutline {
  const shapes = model.shapes.map((s) => {
    const text = s.paragraphs.map((p) => p.text.replace(new RegExp(GAP_CHAR, 'g'), ' ').trim()).filter(Boolean).join(' ⏎ ').slice(0, 80)
    return { shapeId: s.id, name: s.name, phType: s.phType, text }
  })
  return { slide, shapes: shapes.length <= cap ? shapes : shapes.slice(0, cap) }
}
