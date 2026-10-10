// ── pptx op compiler (PLAN-pptx-editing, L2's slide twin) ── Ops compile to
//  span replacements against the ORIGINAL slide string; every op re-parses
//  (slides are small — correctness first). replace_text works over the
//  concatenated paragraph text and may span runs (real files split text
//  arbitrarily); only the FIRST matched segment carries the replacement.
//  set_shape_text rebuilds the shape's paragraph sequence in place. Any
//  failed op throws → the whole batch refuses to write (D5).

import { splice, escapeXmlText, type SpliceReplacement, type XmlElementNode } from '../docx/xml-splice'
import { buildSlideModel, findElement, GAP_CHAR, type SlideModel, type ParagraphInfo, type RunInfo } from './model'

export type PptxOp =
  | { op: 'outline' }
  | { op: 'replace_text'; find: string; replace: string; expected_count?: number; slide?: number }
  | { op: 'set_shape_text'; slide: number; shape_id: string; text: string }
  | { op: 'format_text'; find: string; slide?: number; shape_id?: string; expected_count?: number; bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; color?: string; font_size?: number; font?: string }
  | { op: 'set_shape_fill'; slide: number; shape_id: string; color: string; line_color?: string }
  | { op: 'set_slide_background'; slide: number; color: string }
  | { op: 'set_shape_geometry'; slide: number; shape_id: string; x?: number; y?: number; w?: number; h?: number }

export type PptxSlideOp = Exclude<PptxOp, { op: 'outline' }>

export interface OpResult {
  index: number
  op: string
  ok: boolean
  detail: string
}

const MAX_OPS_CHARS = 120_000

export function validateOpsPayload(ops: unknown): { ok: true; ops: PptxOp[] } | { ok: false; reason: string } {
  if (!Array.isArray(ops)) return { ok: false, reason: 'ops must be an array' }
  if (ops.length === 0) return { ok: false, reason: 'ops is empty' }
  if (JSON.stringify(ops).length > MAX_OPS_CHARS) {
    return { ok: false, reason: `ops payload too large (limit ${MAX_OPS_CHARS} chars)` }
  }
  for (const op of ops as PptxOp[]) {
    if (typeof op !== 'object' || op === null || typeof (op as { op?: unknown }).op !== 'string') {
      return { ok: false, reason: 'each entry needs an op field' }
    }
  }
  return { ok: true, ops: ops as PptxOp[] }
}

// ── matching over the concatenated paragraph text (docx twin) ──

interface Segment { run: RunInfo; from: number; to: number }

function segmentsFor(paragraph: ParagraphInfo, start: number, end: number): Segment[] {
  const map = new Map<number, Segment>()
  for (let i = start; i < end; i++) {
    const loc = paragraph.charMap[i]
    if (loc.run < 0 || loc.offset < 0) continue // gap char — never matchable
    const existing = map.get(loc.run)
    if (existing) existing.to = loc.offset + 1
    else map.set(loc.run, { run: paragraph.runs[loc.run], from: loc.offset, to: loc.offset + 1 })
  }
  const segments = [...map.values()]
  // Cut on entity boundaries, never through one (docx twin's rule).
  for (const seg of segments) {
    while (seg.to < seg.run.text.length && seg.run.charMap[seg.to] === seg.run.charMap[seg.to - 1]) seg.to += 1
    while (seg.from > 0 && seg.run.charMap[seg.from] === seg.run.charMap[seg.from - 1]) seg.from -= 1
  }
  return segments.sort((a, b) => a.run.charMap[0] - b.run.charMap[0])
}

function innerSpanOf(run: RunInfo): { start: number; end: number; raw: string } {
  const textNode = run.textElement.children.find((c) => c.kind !== 'element')
  if (!textNode) return { start: run.textElement.startTagEnd, end: run.textElement.startTagEnd, raw: '' }
  return { start: textNode.start, end: textNode.end, raw: textNode.raw }
}

function findMatchesInModel(model: SlideModel, find: string) {
  const matches: Array<{ paragraph: ParagraphInfo; start: number; end: number }> = []
  for (const shape of model.shapes) {
    for (const paragraph of shape.paragraphs) {
      let from = 0
      for (;;) {
        const at = paragraph.text.indexOf(find, from)
        if (at < 0) break
        matches.push({ paragraph, start: at, end: at + find.length })
        from = at + find.length
      }
    }
  }
  return matches
}

/** replace_text over one slide: cross-run spans rebuild from the original
 *  spans (the first segment keeps the replacement, the rest empty out). */
function applyReplaceText(xml: string, model: SlideModel, op: Extract<PptxOp, { op: 'replace_text' }>): { xml: string; message: string; replaced: number } {
  if (!op.find) throw new Error('replace_text: find 不能为空')
  const matches = findMatchesInModel(model, op.find)
  const expected = op.expected_count ?? 1
  if (matches.length !== expected) {
    throw new Error(`replace_text: 「${op.find.slice(0, 40)}」命中 ${matches.length} 处（expected_count=${expected}）— 用 slide 或 expected_count 明确范围`)
  }
  const replacements: SpliceReplacement[] = []
  for (const match of matches) {
    const segments = segmentsFor(match.paragraph, match.start, match.end)
    segments.forEach((seg, segIndex) => {
      const inner = innerSpanOf(seg.run)
      const rawStart = seg.from < seg.run.text.length ? seg.run.charMap[seg.from] : inner.end
      let rawEnd = seg.to < seg.run.text.length ? seg.run.charMap[seg.to] : inner.end
      if (rawEnd < rawStart) rawEnd = rawStart
      // 范围 [rawStart, rawEnd) 只覆盖匹配区，周边原文原地保留——拼接
      // pre/post 会把它们复制一份（「Hello world」换 Hello 出
      // 「X world world」，full_20261011 M11-P0-1；docx 非修订孪生同批修）。
      // 实体边界扩张后范围已含整个实体，替换掉整个实体即语义正确。
      const middle = segIndex === 0 ? escapeXmlText(op.replace) : ''
      replacements.push({ start: rawStart, end: rawEnd, text: middle })
    })
  }
  return { xml: splice(xml, replacements), message: `替换 ${matches.length} 处`, replaced: matches.length }
}

/** set_shape_text: replace the WHOLE paragraph sequence of one shape's txBody.
 *  The new paragraphs are single-run a:p elements; the txBody's bodyPr and
 *  lstStyle (everything outside the a:p span) stay untouched, so autofit,
 *  insets and list styles survive. The shape is addressed by `p:cNvPr@id`;
 *  synthetic table cells use their `cell:r:c` ids. */
function applySetShapeText(xml: string, model: SlideModel, op: Extract<PptxOp, { op: 'set_shape_text' }>): { xml: string; message: string } {
  const shape = model.shapes.find((s) => s.id === op.shape_id)
  if (!shape) {
    const ids = model.shapes.map((s) => s.id).join('、')
    throw new Error(`set_shape_text: 形状 id「${op.shape_id}」不存在（本页可用: ${ids || '无'}）— 先 outline`)
  }
  // Ordinary shapes carry p:txBody; synthetic table-cell shapes wrap an
  // a:tc whose text body is a:txBody — both must resolve, or every manual-
  // guided set_shape_text on a cell dies with 「没有文本框」 (review0920-H3;
  // replace_text on the same cell works, which makes the refusal look
  // arbitrary to the model).
  const txBody = shape.element.children.find((c) => isEl(c, 'p:txBody') || isEl(c, 'a:txBody'))
  if (!txBody) throw new Error(`set_shape_text: 形状「${op.shape_id}」没有文本框`)
  const paragraphs = txBody.children.filter((c) => isEl(c, 'a:p'))
  if (paragraphs.length === 0) throw new Error(`set_shape_text: 形状「${op.shape_id}」的 txBody 没有 a:p 段落——模板占位符形状异常，拒绝编辑`)
  const start = paragraphs[0].start
  const end = paragraphs[paragraphs.length - 1].end
  // One a:p per line of the new text (single run each) — paragraph styling
  // comes from lstStyle/inheritance, which is what a template wants.
  const newXml = op.text
    .split('\n')
    .map((line) => {
      const space = line !== line.trim() ? ' xml:space="preserve"' : ''
      return `<a:p><a:r><a:t${space}>${escapeXmlText(line)}</a:t></a:r></a:p>`
    })
    .join('')
  return { xml: splice(xml, [{ start, end, text: newXml }]), message: `形状 ${op.shape_id} 文本已替换（${op.text.split('\n').length} 段）` }
}

const isEl = (n: { kind: string; name?: string }, name: string): n is XmlElementNode => n.kind === 'element' && n.name === name

function requireHex(color: string, what: string): string {
  if (!/^[0-9A-Fa-f]{6}$/.test(color)) throw new Error(`${what}: 颜色必须是 6 位十六进制 RRGGBB（收到「${color}」）`)
  return color.toUpperCase()
}

// ── a:rPr surgery (format_text) ──

/** a:rPr child order per the DrawingML schema — fill inserts before the first
 *  of these, latin/ea before the first of the script faces. */
const AFTER_FILL = ['a:effectLst', 'a:effectDag', 'a:highlight', 'a:uLnTx', 'a:uLn', 'a:uFillTx', 'a:uFill', 'a:latin', 'a:ea', 'a:cs', 'a:sym', 'a:hlinkClick', 'a:hlinkMouseOver', 'a:rtl', 'a:extLst']
const AFTER_LATIN = ['a:ea', 'a:cs', 'a:sym', 'a:hlinkClick', 'a:hlinkMouseOver', 'a:rtl', 'a:extLst']
const FILL_TAGS = ['a:noFill', 'a:solidFill', 'a:gradFill', 'a:blipFill', 'a:pattFill', 'a:grpFill']

interface RprWant {
  attrs: Record<string, string>
  /** 'none' → noFill; else solidFill with the hex */
  fill?: string
  latin?: string
}

function rprWantsOf(op: Extract<PptxOp, { op: 'format_text' }>): RprWant {
  const attrs: Record<string, string> = {}
  if (op.bold !== undefined) attrs['b'] = op.bold ? '1' : '0'
  if (op.italic !== undefined) attrs['i'] = op.italic ? '1' : '0'
  if (op.underline !== undefined) attrs['u'] = op.underline ? 'sng' : 'none'
  if (op.strike !== undefined) attrs['strike'] = op.strike ? 'sngStrike' : 'noStrike'
  if (op.font_size !== undefined) {
    if (!(op.font_size >= 1 && op.font_size <= 4000)) throw new Error('format_text: font_size 需在 1–4000pt 之间')
    attrs['sz'] = String(Math.round(op.font_size * 100))
  }
  return {
    attrs,
    fill: op.color !== undefined ? (op.color === 'none' ? 'none' : requireHex(op.color, 'format_text')) : undefined,
    latin: op.font,
  }
}

/** Rebuild ONE a:rPr from its original span: original attrs kept then
 *  overridden, original children kept except the fill/latin being rewritten.
 *  Insertion positions follow the schema order above. */
function rebuildRpr(rPr: XmlElementNode | undefined, xml: string, want: RprWant): string {
  const attrs: string[] = []
  const seen = new Set<string>()
  if (rPr) {
    for (const [name, attr] of rPr.attrs) {
      const v = want.attrs[name] ?? attr.rawValue
      attrs.push(` ${name}="${escapeXmlText(v)}"`)
      seen.add(name)
    }
  }
  for (const [name, v] of Object.entries(want.attrs)) {
    if (!seen.has(name)) attrs.push(` ${name}="${escapeXmlText(v)}"`)
  }
  // children: keep everything except what we are rewriting
  const kids: string[] = []
  if (rPr) {
    for (const child of rPr.children) {
      if (child.kind !== 'element') { kids.push(xml.slice(child.start, child.end)); continue }
      if (want.fill !== undefined && FILL_TAGS.includes(child.name)) continue
      if (want.latin !== undefined && (child.name === 'a:latin' || child.name === 'a:ea')) continue
      kids.push(xml.slice(child.start, child.end))
    }
  }
  // Insert fill / latin relative to the ORIGINAL child order: the first
  // original child whose tag is in the AFTER list marks the slot.
  const orig = rPr?.children.filter((c) => c.kind === 'element') as XmlElementNode[] | undefined
  const insertAt = (tags: string[]): number => {
    if (!orig) return kids.length
    for (let i = 0; i < orig.length; i++) {
      if (tags.includes(orig[i].name)) {
        // map to the kept-kids index: same position counts skipped kids —
        // kept kids were built in order, so the insertion index is the count
        // of kept kids that came from original children at index >= i … simpler:
        return Math.min(kids.length, kidsIndexFor(orig, i))
      }
    }
    return kids.length
  }
  const kidsIndexFor = (list: XmlElementNode[], target: number): number => {
    // number of kept kids originating from original children BEFORE target
    let n = 0
    for (let i = 0; i < target && i < list.length; i++) {
      const c = list[i]
      const skipped = (want.fill !== undefined && FILL_TAGS.includes(c.name)) || (want.latin !== undefined && (c.name === 'a:latin' || c.name === 'a:ea'))
      if (!skipped) n++
    }
    return n
  }
  const children = [...kids]
  const fillXml = want.fill === 'none' ? '<a:noFill/>' : `<a:solidFill><a:srgbClr val="${want.fill}"/></a:solidFill>`
  if (want.fill !== undefined) children.splice(insertAt(AFTER_FILL), 0, fillXml)
  if (want.latin !== undefined) {
    const face = escapeXmlText(want.latin)
    children.splice(insertAt(AFTER_LATIN), 0, `<a:latin typeface="${face}"/><a:ea typeface="${face}"/>`)
  }
  const inner = children.join('')
  return inner === '' ? `<a:rPr${attrs.join('')}/>` : `<a:rPr${attrs.join('')}>${inner}</a:rPr>`
}

/** format_text: style the runs covered by `find` — whole runs restyle in
 *  place, partial coverage SPLITs the run so only the matched slice carries
 *  the new rPr (docx H7's twin: rebuilt runs keep their original spans). */
function applyFormatText(xml: string, model: SlideModel, op: Extract<PptxOp, { op: 'format_text' }>): { xml: string; message: string } {
  // An empty find makes `indexOf(find, from)` return `from` forever — the
  // loop below never advances and the matches array grows until the MAIN
  // process OOMs (review0920-H1, measured at 4.9GB in ~20s). Guarded here
  // and in applyReplaceText; validateOpsPayload doesn't reach into per-op
  // fields, so the entry guards are the only line of defence.
  if (!op.find) throw new Error('format_text: find 不能为空')
  const want = rprWantsOf(op)
  if (Object.keys(want.attrs).length === 0 && want.fill === undefined && want.latin === undefined) {
    throw new Error('format_text: 没有给出任何样式属性（bold/italic/underline/strike/color/font_size/font）')
  }
  const shapes = op.shape_id !== undefined ? model.shapes.filter((s) => s.id === op.shape_id) : model.shapes
  if (op.shape_id !== undefined && shapes.length === 0) {
    throw new Error(`format_text: 形状 id「${op.shape_id}」不存在 — 先 outline`)
  }
  const matches: Array<{ paragraph: ParagraphInfo; start: number; end: number }> = []
  for (const shape of shapes) {
    for (const paragraph of shape.paragraphs) {
      let from = 0
      for (;;) {
        const at = paragraph.text.indexOf(op.find, from)
        if (at < 0) break
        matches.push({ paragraph, start: at, end: at + op.find.length })
        from = at + op.find.length
      }
    }
  }
  const expected = op.expected_count ?? 1
  if (matches.length !== expected) {
    throw new Error(`format_text: 「${op.find.slice(0, 40)}」命中 ${matches.length} 处（expected_count=${expected}）— 用 shape_id/slide 或 expected_count 明确范围`)
  }
  const replacements: SpliceReplacement[] = []
  for (const match of matches) {
    const segments = segmentsFor(match.paragraph, match.start, match.end)
    for (const seg of segments) {
      const runEl = seg.run.element
      const rPr = runEl.children.find((c) => c.kind === 'element' && c.name === 'a:rPr') as XmlElementNode | undefined
      const inner = innerSpanOf(seg.run)
      const openTag = xml.slice(runEl.startTagStart, runEl.startTagEnd)
      const rPrOriginal = rPr ? xml.slice(rPr.start, rPr.end) : ''
      const coversAll = seg.from === 0 && seg.to >= seg.run.text.length
      if (coversAll) {
        const rebuilt = rebuildRpr(rPr, xml, want)
        if (rPr) replacements.push({ start: rPr.start, end: rPr.end, text: rebuilt })
        else replacements.push({ start: runEl.startTagEnd, end: runEl.startTagEnd, text: rebuilt })
        continue
      }
      // split: pre(orig rPr) + covered(new rPr) + post(orig rPr)
      const rawStart = seg.run.charMap[seg.from]
      const rawEnd = seg.to < seg.run.text.length ? seg.run.charMap[seg.to] : inner.end
      const pre = inner.raw.slice(0, rawStart - inner.start)
      const covered = inner.raw.slice(rawStart - inner.start, rawEnd - inner.start)
      const post = inner.raw.slice(rawEnd - inner.start)
      const parts: string[] = []
      if (pre) parts.push(`${openTag}${rPrOriginal}<a:t xml:space="preserve">${pre}</a:t></a:r>`)
      parts.push(`${openTag}${rebuildRpr(rPr, xml, want)}<a:t xml:space="preserve">${covered}</a:t></a:r>`)
      if (post) parts.push(`${openTag}${rPrOriginal}<a:t xml:space="preserve">${post}</a:t></a:r>`)
      replacements.push({ start: runEl.start, end: runEl.end, text: parts.join('') })
    }
  }
  return { xml: splice(xml, replacements), message: `样式化 ${matches.length} 处` }
}

/** set_shape_fill: replace/insert the shape's spPr fill (and optionally the
 *  line colour). spPr child order: xfrm, geometry, fill, ln, … */
function applySetShapeFill(xml: string, model: SlideModel, op: Extract<PptxOp, { op: 'set_shape_fill' }>): { xml: string; message: string } {
  const shape = requireShape(model, op.shape_id)
  const spPr = shape.element.children.find((c) => isEl(c, 'p:spPr'))
  if (!spPr) throw new Error(`set_shape_fill: 形状「${op.shape_id}」没有 spPr`)
  const color = op.color === 'none' ? 'none' : requireHex(op.color, 'set_shape_fill')
  const fillXml = color === 'none' ? '<a:noFill/>' : `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>`
  const replacements: SpliceReplacement[] = []
  const fillEl = spPr.children.find((c) => c.kind === 'element' && FILL_TAGS.includes(c.name))
  if (fillEl) {
    replacements.push({ start: fillEl.start, end: fillEl.end, text: fillXml })
  } else {
    const geom = spPr.children.find((c) => c.kind === 'element' && (c.name === 'a:prstGeom' || c.name === 'a:custGeom'))
    const xfrm = spPr.children.find((c) => c.kind === 'element' && c.name === 'a:xfrm')
    const at = geom ? geom.end : xfrm ? xfrm.end : spPr.startTagEnd
    replacements.push({ start: at, end: at, text: fillXml })
  }
  if (op.line_color !== undefined) {
    const lineColor = requireHex(op.line_color, 'set_shape_fill.line_color')
    const ln = spPr.children.find((c) => isEl(c, 'a:ln'))
    const lnFill = `<a:solidFill><a:srgbClr val="${lineColor}"/></a:solidFill>`
    if (ln) {
      const lnFillEl = ln.children.find((c) => c.kind === 'element' && FILL_TAGS.includes(c.name))
      if (lnFillEl) replacements.push({ start: lnFillEl.start, end: lnFillEl.end, text: lnFill })
      else replacements.push({ start: ln.startTagEnd, end: ln.startTagEnd, text: lnFill })
    } else {
      // insert a full a:ln right after the (possibly just-spliced) fill —
      // against the ORIGINAL string the position is the same anchor logic.
      const geom = spPr.children.find((c) => c.kind === 'element' && (c.name === 'a:prstGeom' || c.name === 'a:custGeom'))
      const xfrm = spPr.children.find((c) => c.kind === 'element' && c.name === 'a:xfrm')
      const at = geom ? geom.end : xfrm ? xfrm.end : spPr.startTagEnd
      replacements.push({ start: at, end: at, text: `<a:ln>${lnFill}</a:ln>` })
    }
  }
  return { xml: splice(xml, replacements), message: `形状 ${op.shape_id} 填充 → ${op.color}` }
}

/** set_slide_background: p:bg is the FIRST child of p:cSld (before spTree). */
function applySetSlideBackground(xml: string, model: SlideModel, op: Extract<PptxOp, { op: 'set_slide_background' }>): { xml: string; message: string } {
  const color = requireHex(op.color, 'set_slide_background')
  const cSld = findElement(model.parsed.root, 'p:cSld')
  if (!cSld) throw new Error('set_slide_background: 找不到 p:cSld — 不是有效的幻灯片部件')
  const bgXml = `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`
  const bg = cSld.children.find((c) => isEl(c, 'p:bg'))
  if (bg) {
    return { xml: splice(xml, [{ start: bg.start, end: bg.end, text: bgXml }]), message: `页面 ${op.slide} 背景 → ${color}` }
  }
  return { xml: splice(xml, [{ start: cSld.startTagEnd, end: cSld.startTagEnd, text: bgXml }]), message: `页面 ${op.slide} 背景 → ${color}` }
}

const EMU = (inches: number): number => Math.round(inches * 914400)

/** set_shape_geometry: inches in, EMU in the XML. xfrm sits FIRST in spPr;
 *  off/ext attribute values splice in place. */
function applySetShapeGeometry(xml: string, model: SlideModel, op: Extract<PptxOp, { op: 'set_shape_geometry' }>): { xml: string; message: string } {
  const shape = requireShape(model, op.shape_id)
  const spPr = shape.element.children.find((c) => isEl(c, 'p:spPr'))
  if (!spPr) throw new Error(`set_shape_geometry: 形状「${op.shape_id}」没有 spPr`)
  const xfrm = spPr.children.find((c) => isEl(c, 'a:xfrm'))
  const setAttr = (el: XmlElementNode, name: string, value: string): SpliceReplacement | null => {
    const attr = el.attrs.get(name)
    if (attr) return { start: attr.valueStart, end: attr.valueEnd, text: value }
    // insert before the tag close ('/>' or '>')
    const at = el.startTagEnd - (xml.slice(el.startTagStart, el.startTagEnd).endsWith('/>') ? 2 : 1)
    return { start: at, end: at, text: ` ${name}="${value}"` }
  }
  if (!xfrm) {
    const off = `<a:off x="${EMU(op.x ?? 0)}" y="${EMU(op.y ?? 0)}"/>`
    const ext = `<a:ext cx="${EMU(op.w ?? 0)}" cy="${EMU(op.h ?? 0)}"/>`
    return { xml: splice(xml, [{ start: spPr.startTagEnd, end: spPr.startTagEnd, text: `<a:xfrm>${off}${ext}</a:xfrm>` }]), message: `形状 ${op.shape_id} 已定位` }
  }
  const replacements: SpliceReplacement[] = []
  const off = xfrm.children.find((c) => isEl(c, 'a:off'))
  const ext = xfrm.children.find((c) => isEl(c, 'a:ext'))
  const parts: Array<[XmlElementNode | undefined, string, number | undefined]> = [
    [off, 'x', op.x], [off, 'y', op.y], [ext, 'cx', op.w], [ext, 'cy', op.h],
  ]
  let changed = 0
  for (const [el, name, value] of parts) {
    if (value === undefined) continue
    if (!el) continue
    const rep = setAttr(el, name, String(EMU(value)))
    if (rep) { replacements.push(rep); changed++ }
  }
  if (changed === 0) return { xml, message: `形状 ${op.shape_id} 未指定任何几何变更` }
  return { xml: splice(xml, replacements), message: `形状 ${op.shape_id} 几何已更新` }
}

function requireShape(model: SlideModel, shapeId: string) {
  const shape = model.shapes.find((s) => s.id === shapeId)
  if (!shape) throw new Error(`形状 id「${shapeId}」不存在（本页可用: ${model.shapes.map((s) => s.id).join('、') || '无'}）— 先 outline`)
  return shape
}

/** Apply a batch of slide-scoped ops to ONE slide part. Every op re-parses
 *  the current string; a failed op marks the batch failed and stops. */
export function applySlideOps(xml: string, ops: PptxSlideOp[]): { xml: string; results: OpResult[] } {
  let current = xml
  const results: OpResult[] = []
  for (let index = 0; index < ops.length; index++) {
    const op = ops[index]
    try {
      const model = buildSlideModel(current)
      const detail =
        op.op === 'replace_text' ? applyReplaceText(current, model, op)
        : op.op === 'set_shape_text' ? applySetShapeText(current, model, op)
        : op.op === 'format_text' ? applyFormatText(current, model, op)
        : op.op === 'set_shape_fill' ? applySetShapeFill(current, model, op)
        : op.op === 'set_slide_background' ? applySetSlideBackground(current, model, op)
        : applySetShapeGeometry(current, model, op)
      current = detail.xml
      results.push({ index, op: op.op, ok: true, detail: detail.message })
    } catch (err) {
      results.push({ index, op: op.op, ok: false, detail: err instanceof Error ? err.message : String(err) })
      return { xml, results }
    }
  }
  return { xml: current, results }
}

export { GAP_CHAR }
