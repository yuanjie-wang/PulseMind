// ── L2 operation compiler (PLAN-office-editing §3.3, T5) ──
// Ops compile to span replacements against the ORIGINAL string; every op
// re-parses (documents are small — correctness first). Text edits replace the
// inner span of the covered `w:t` (partial run coverage keeps its untouched
// head/tail); format edits that cover only part of a run SPLIT the run so the
// covered part carries new `rPr` without re-styling the rest. Any failed op
// throws → the whole batch refuses to write (L5).

import { parseXml, splice, escapeXmlText, type SpliceReplacement, type XmlElementNode } from './xml-splice'
import { buildDocumentModel, outlineOf, GAP_CHAR, type RunInfo } from './model'

export type DocxOp =
  | { op: 'outline' }
  | { op: 'replace_text'; find: string; replace: string; expected_count?: number; paragraph?: number }
  | { op: 'insert_paragraph'; paragraph: number; position: 'before' | 'after'; text: string; style?: string }
  | { op: 'delete_paragraph'; paragraph: number }
  | { op: 'set_paragraph_style'; paragraph: number; style: string }
  | { op: 'format_text'; find: string; paragraph?: number; expected_count?: number; bold?: boolean; italic?: boolean; underline?: boolean; color?: string; font_size?: number }

export interface OpResult {
  index: number
  op: string
  ok: boolean
  detail: string
}

export interface ApplyOutcome {
  xml: string
  results: OpResult[]
  outline: Array<{ index: number; style: string | null; text: string }>
}

const MAX_OPS_CHARS = 120_000

export function validateOpsPayload(ops: unknown): { ok: true; ops: DocxOp[] } | { ok: false; reason: string } {
  if (!Array.isArray(ops)) return { ok: false, reason: 'ops must be an array' }
  if (ops.length === 0) return { ok: false, reason: 'ops is empty' }
  if (JSON.stringify(ops).length > MAX_OPS_CHARS) {
    return { ok: false, reason: `ops payload too large (limit ${MAX_OPS_CHARS} chars)` }
  }
  for (const op of ops as DocxOp[]) {
    if (typeof op !== 'object' || op === null || typeof (op as { op?: unknown }).op !== 'string') {
      return { ok: false, reason: 'each entry needs an op field' }
    }
  }
  return { ok: true, ops: ops as DocxOp[] }
}

// ── matching over the concatenated paragraph text ──

interface Segment { run: RunInfo; from: number; to: number }

function segmentsFor(paragraph: { runs: RunInfo[]; charMap: Array<{ run: number; offset: number }> }, start: number, end: number): Segment[] {
  const map = new Map<number, Segment>()
  for (let i = start; i < end; i++) {
    const loc = paragraph.charMap[i]
    if (loc.run < 0 || loc.offset < 0) continue // gap char — never matchable
    const run = paragraph.runs[loc.run]
    const existing = map.get(loc.run)
    if (existing) existing.to = loc.offset + 1
    else map.set(loc.run, { run, from: loc.offset, to: loc.offset + 1 })
  }
  // Align segment ends to entity boundaries: consecutive decoded characters
  // of one entity share the same raw offset — a cut between them would
  // duplicate the entity.
  const segments = [...map.values()]
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

function findMatches(model: ReturnType<typeof buildDocumentModel>, find: string, paragraphIndex?: number) {
  const matches: Array<{ paragraph: ReturnType<typeof buildDocumentModel>['paragraphs'][number]; start: number; end: number }> = []
  const paragraphs = paragraphIndex !== undefined ? [model.paragraphs[paragraphIndex]].filter(Boolean) : model.paragraphs
  for (const paragraph of paragraphs) {
    let from = 0
    for (;;) {
      const at = paragraph.text.indexOf(find, from)
      if (at < 0) break
      matches.push({ paragraph, start: at, end: at + find.length })
      from = at + find.length
    }
  }
  return matches
}

function requireParagraph(model: ReturnType<typeof buildDocumentModel>, index: number) {
  const paragraph = model.paragraphs[index]
  if (!paragraph) throw new Error(`段落 ${index} 不存在（文档共 ${model.paragraphs.length} 段）`)
  return paragraph
}

// ── rPr surgery (format_text) ──

const RPR_ORDER = ['w:rStyle', 'w:b', 'w:bCs', 'w:i', 'w:iCs', 'w:color', 'w:sz', 'w:szCs', 'w:u']

interface RprWant { name: string; xml: string }

/** Build a new `<w:rPr>` from the original inner markup: keep every existing
 *  child except the ones being written, then slot the new elements in at
 *  their canonical positions. Deactivation writes w:val="0"/"none" — never
 *  deletes an existing element (the schema keeps literal forms valid). */
function buildRpr(originalInnerRaw: string | null, wanted: RprWant[]): string {
  const kept: Array<{ order: number; raw: string }> = []
  if (originalInnerRaw) {
    const fragment = parseXml(`<w:rPr>${originalInnerRaw}</w:rPr>`)
    // The fragment's root is #document wrapping the w:rPr — descend into it;
    // its children are the rPr's property elements.
    const rPrNode = fragment.root.children.find((c) => c.kind === 'element' && c.name === 'w:rPr') as XmlElementNode | undefined
    for (const child of (rPrNode ?? fragment.root).children) {
      if (child.kind !== 'element') { kept.push({ order: -1, raw: (child as { raw: string }).raw }); continue }
      if (wanted.some((w) => w.name === child.name)) continue
      const raw = originalInnerRaw.slice(child.start - '<w:rPr>'.length, child.end - '<w:rPr>'.length)
      kept.push({ order: RPR_ORDER.indexOf(child.name) < 0 ? 999 : RPR_ORDER.indexOf(child.name), raw })
    }
  }
  for (const w of wanted) {
    const order = RPR_ORDER.indexOf(w.name)
    let inserted = false
    for (let i = 0; i < kept.length; i++) {
      if (kept[i].order > order) { kept.splice(i, 0, { order, raw: w.xml }); inserted = true; break }
    }
    if (!inserted) kept.push({ order, raw: w.xml })
  }
  return `<w:rPr>${kept.map((k) => k.raw).join('')}</w:rPr>`
}

function rprWants(op: Extract<DocxOp, { op: 'format_text' }>): RprWant[] {
  const wanted: RprWant[] = []
  if (op.bold !== undefined) wanted.push({ name: 'w:b', xml: op.bold ? '<w:b/>' : '<w:b w:val="0"/>' })
  if (op.italic !== undefined) wanted.push({ name: 'w:i', xml: op.italic ? '<w:i/>' : '<w:i w:val="0"/>' })
  if (op.color !== undefined) wanted.push({ name: 'w:color', xml: `<w:color w:val="${escapeXmlText(op.color)}"/>` })
  if (op.font_size !== undefined) wanted.push({ name: 'w:sz', xml: `<w:sz w:val="${Math.round(op.font_size * 2)}"/>` })
  if (op.underline !== undefined) wanted.push({ name: 'w:u', xml: op.underline ? '<w:u w:val="single"/>' : '<w:u w:val="none"/>' })
  return wanted
}

// ── the batch ──

export function applyOps(xml: string, ops: DocxOp[]): ApplyOutcome {
  let current = xml
  const results: OpResult[] = []
  for (let index = 0; index < ops.length; index++) {
    const op = ops[index]
    try {
      const detail = applyOne(current, op)
      current = detail.xml
      results.push({ index, op: op.op, ok: true, detail: detail.message })
    } catch (err) {
      results.push({ index, op: op.op, ok: false, detail: err instanceof Error ? err.message : String(err) })
      // L5: a failed op refuses the whole batch — partial application is how
      // the rejected external design corrupted documents silently.
      return { xml, results, outline: [] }
    }
  }
  return { xml: current, results, outline: outlineOf(buildDocumentModel(current)) }
}

function applyOne(xml: string, op: DocxOp): { xml: string; message: string } {
  const model = buildDocumentModel(xml)
  const replacements: SpliceReplacement[] = []
  let message = ''

  switch (op.op) {
    case 'outline': {
      message = `${model.paragraphs.length} 段`
      break
    }
    case 'replace_text': {
      if (!op.find) throw new Error('replace_text: find 不能为空')
      const matches = findMatches(model, op.find, op.paragraph)
      const expected = op.expected_count ?? 1
      if (matches.length !== expected) {
        throw new Error(`replace_text: 「${op.find.slice(0, 40)}」命中 ${matches.length} 处（expected_count=${expected}）— 用 paragraph 或 expected_count 明确范围`)
      }
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
      message = `替换 ${matches.length} 处`
      break
    }
    case 'insert_paragraph': {
      const anchor = requireParagraph(model, op.paragraph)
      const anchorRaw = xml.slice(anchor.element.start, anchor.element.end)
      const pPr = anchor.element.children.find((c) => c.kind === 'element' && c.name === 'w:pPr') as XmlElementNode | undefined
      let pPrXml = ''
      if (op.style) {
        pPrXml = `<w:pPr><w:pStyle w:val="${escapeXmlText(op.style)}"/></w:pPr>`
      } else if (pPr) {
        pPrXml = xml.slice(pPr.start, pPr.end)
      }
      const space = op.text !== op.text.trim() ? ' xml:space="preserve"' : ''
      const paragraphXml = `<w:p>${pPrXml}<w:r><w:t${space}>${escapeXmlText(op.text)}</w:t></w:r></w:p>`
      const at = op.position === 'before' ? anchor.element.start : anchor.element.end
      replacements.push({ start: at, end: at, text: paragraphXml })
      message = `在段落 ${op.paragraph} ${op.position === 'before' ? '前' : '后'}插入`
      break
    }
    case 'delete_paragraph': {
      const paragraph = requireParagraph(model, op.paragraph)
      if (paragraph.hasSectPr) {
        throw new Error('delete_paragraph: 该段落的 pPr 含分节符（w:sectPr），删除会破坏文档分节——请改用 set_paragraph_style 或手工处理')
      }
      replacements.push({ start: paragraph.element.start, end: paragraph.element.end, text: '' })
      message = `删除段落 ${op.paragraph}`
      break
    }
    case 'set_paragraph_style': {
      const paragraph = requireParagraph(model, op.paragraph)
      const pPr = paragraph.element.children.find((c) => c.kind === 'element' && c.name === 'w:pPr') as XmlElementNode | undefined
      const escaped = escapeXmlText(op.style)
      if (pPr) {
        const pStyle = pPr.children.find((c) => c.kind === 'element' && c.name === 'w:pStyle') as XmlElementNode | undefined
        if (pStyle) {
          const val = pStyle.attrs.get('w:val')
          if (val) {
            replacements.push({ start: val.valueStart, end: val.valueEnd, text: escaped })
          } else {
            const selfClosed = xml.slice(pStyle.start, pStyle.startTagEnd).endsWith('/>')
            const insertAt = selfClosed ? pStyle.startTagEnd - 2 : pStyle.startTagEnd - 2
            replacements.push({ start: insertAt, end: insertAt, text: ` w:val="${escaped}"` })
          }
        } else {
          replacements.push({ start: pPr.startTagEnd, end: pPr.startTagEnd, text: `<w:pStyle w:val="${escaped}"/>` })
        }
      } else {
        replacements.push({ start: paragraph.element.startTagEnd, end: paragraph.element.startTagEnd, text: `<w:pPr><w:pStyle w:val="${escaped}"/></w:pPr>` })
      }
      message = `段落 ${op.paragraph} 样式 → ${op.style}`
      break
    }
    case 'format_text': {
      const wants = rprWants(op)
      if (wants.length === 0) throw new Error('format_text: 没有给出任何格式属性')
      const matches = findMatches(model, op.find, op.paragraph)
      const expected = op.expected_count ?? 1
      if (matches.length !== expected) {
        throw new Error(`format_text: 「${op.find.slice(0, 40)}」命中 ${matches.length} 处（expected_count=${expected}）`)
      }
      for (const match of matches) {
        const segments = segmentsFor(match.paragraph, match.start, match.end)
        for (const seg of segments) {
          const inner = innerSpanOf(seg.run)
          const coversAll = seg.from === 0 && seg.to >= seg.run.text.length
          if (coversAll) {
            // Whole run covered — rewrite its rPr in place.
            const rPr = seg.run.element.children.find((c) => c.kind === 'element' && c.name === 'w:rPr') as XmlElementNode | undefined
            if (rPr && rPr.endTag) {
              replacements.push({ start: rPr.startTagEnd, end: rPr.endTag.start, text: buildRpr(xml.slice(rPr.startTagEnd, rPr.endTag.start), wants) })
            } else if (!rPr) {
              replacements.push({ start: seg.run.element.startTagEnd, end: seg.run.element.startTagEnd, text: buildRpr(null, wants) })
            }
          } else {
            // Partial coverage — SPLIT the run: pre(original rPr) + covered(new rPr) + post(original rPr).
            const rawStart = seg.run.charMap[seg.from]
            const rawEnd = seg.to < seg.run.text.length ? seg.run.charMap[seg.to] : inner.end
            const rPrEl = seg.run.element.children.find((c) => c.kind === 'element' && c.name === 'w:rPr') as XmlElementNode | undefined
            const rPrInner = rPrEl && rPrEl.endTag ? xml.slice(rPrEl.startTagEnd, rPrEl.endTag.start) : null
            // The open tag is ONLY `<w:r …>` — any rPr child is rebuilt below
            // (rPrOriginal / rPrModified); including it here would double it.
            const openTag = xml.slice(seg.run.element.startTagStart, seg.run.element.startTagEnd)
            const closeTag = '</w:r>'
            const rPrOriginal = rPrInner !== null ? `<w:rPr>${rPrInner}</w:rPr>` : ''
            const rPrModified = buildRpr(rPrInner, wants)
            const pre = inner.raw.slice(0, rawStart - inner.start)
            const covered = inner.raw.slice(rawStart - inner.start, rawEnd - inner.start)
            const post = inner.raw.slice(rawEnd - inner.start)
            const split =
              (pre ? `${openTag}${rPrOriginal}<w:t xml:space="preserve">${pre}</w:t></w:r>` : '') +
              `${openTag}${rPrModified}<w:t xml:space="preserve">${covered}</w:t></w:r>` +
              (post ? `${openTag}${rPrOriginal}<w:t xml:space="preserve">${post}</w:t></w:r>` : '')
            replacements.push({ start: seg.run.element.start, end: seg.run.element.end, text: split })
          }
        }
      }
      message = `格式化 ${matches.length} 处`
      break
    }
    default:
      throw new Error(`未知 op: ${(op as { op: string }).op}`)
  }
  return { xml: replacements.length > 0 ? splice(xml, replacements) : xml, message }
}

export { GAP_CHAR }
