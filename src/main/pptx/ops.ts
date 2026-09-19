// ── pptx op compiler (PLAN-pptx-editing, L2's slide twin) ── Ops compile to
//  span replacements against the ORIGINAL slide string; every op re-parses
//  (slides are small — correctness first). replace_text works over the
//  concatenated paragraph text and may span runs (real files split text
//  arbitrarily); only the FIRST matched segment carries the replacement.
//  set_shape_text rebuilds the shape's paragraph sequence in place. Any
//  failed op throws → the whole batch refuses to write (D5).

import { splice, escapeXmlText, type SpliceReplacement, type XmlElementNode } from '../docx/xml-splice'
import { buildSlideModel, GAP_CHAR, type SlideModel, type ParagraphInfo, type RunInfo } from './model'

export type PptxOp =
  | { op: 'outline' }
  | { op: 'replace_text'; find: string; replace: string; expected_count?: number; slide?: number }
  | { op: 'set_shape_text'; slide: number; shape_id: string; text: string }

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
      const pre = inner.raw.slice(0, rawStart - inner.start)
      const post = inner.raw.slice(rawEnd - inner.start)
      const middle = segIndex === 0 ? escapeXmlText(op.replace) : ''
      replacements.push({ start: rawStart, end: rawEnd, text: pre + middle + post })
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
  const txBody = shape.element.children.find((c) => isEl(c, 'p:txBody'))
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

/** Apply a batch of slide-scoped ops to ONE slide part. Every op re-parses
 *  the current string; a failed op marks the batch failed and stops. */
export function applySlideOps(xml: string, ops: PptxSlideOp[]): { xml: string; results: OpResult[] } {
  let current = xml
  const results: OpResult[] = []
  for (let index = 0; index < ops.length; index++) {
    const op = ops[index]
    try {
      const model = buildSlideModel(current)
      const detail = op.op === 'replace_text' ? applyReplaceText(current, model, op) : applySetShapeText(current, model, op)
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
