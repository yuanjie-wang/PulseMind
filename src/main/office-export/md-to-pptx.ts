// ── Markdown → .pptx generation (PLAN-pptx-export) ── marked.lexer locates
//  structure; pptxgenjs writes the bytes. Fully in memory (pptx.write with
//  outputType 'nodebuffer' serializes the zip in RAM), so any failure here
//  means zero bytes on disk.
//
//  Fidelity contract (v1): headings PAGINATE (D2) — the first h1 is the cover,
//  every later h1/h2 starts a slide, deeper headings are bold body lines.
//  Inline styling takes the OUTERMOST token only, like md-to-docx; anything
//  the deck cannot express (images, inline HTML, a second table on one page,
//  slides past the cap) degrades to text PLUS a closing 备注 page naming the
//  loss — never silent.

import { marked } from 'marked'
import PptxGenJS from 'pptxgenjs'

/** Deck cap, aligned with the preview's PPTX_PREVIEW_SLIDE_LIMIT (local copy:
 *  the exporter must not couple to the preview model's parser). */
export const PPTX_EXPORT_SLIDE_LIMIT = 200

const CODE_FONT = 'Consolas'
const BODY_INK = '262626'
const MUTED_INK = '8C8C8C'
/** Body region of a 16:9 slide (10in × 5.625in): below the title band. */
const BODY_X = 0.6
const BODY_Y = 1.35
const BODY_W = 8.8
const BODY_BOTTOM = 5.35

// ── Spec shapes (the pure, testable half) ──

export interface PptxTextRunSpec {
  text: string
  bold?: boolean
  italic?: boolean
  strike?: boolean
  code?: boolean
  link?: string
}

export interface PptxParagraphSpec {
  kind: 'para' | 'bullet' | 'quote' | 'heading'
  runs: PptxTextRunSpec[]
  /** bullets only; 0-based, capped at 2 */
  level?: number
  ordered?: boolean
}

export interface PptxTableSpec {
  kind: 'table'
  header: string[]
  rows: string[][]
}

export type PptxBlockSpec =
  | ({ kind: 'para' | 'bullet' | 'quote' | 'heading' } & PptxParagraphSpec)
  | PptxTableSpec
  | { kind: 'code'; text: string }

export interface SlideSpec {
  kind: 'cover' | 'content'
  title: string
  subtitle?: string
  blocks: PptxBlockSpec[]
}

export interface PptxSpecs {
  slides: SlideSpec[]
  /** Every degradation, for the closing 备注 page. */
  degradations: string[]
}

// ── Marked token shape (same loose type md-to-docx uses) ──

type MarkedToken = {
  type: string
  depth?: number
  raw?: string
  text?: string
  tokens?: MarkedToken[]
  ordered?: boolean
  items?: Array<{ tokens?: MarkedToken[] }>
  header?: MarkedCell[]
  rows?: MarkedCell[][]
}
type MarkedCell = { text: string; tokens?: MarkedToken[] }

/** Flatten an inline token tree to plain text (styles dropped). */
function plainText(tokens?: MarkedToken[]): string {
  if (!tokens) return ''
  return tokens.map((t) => (t.tokens && t.tokens.length > 0 ? plainText(t.tokens) : t.text ?? '')).join('')
}

function inlineRuns(tokens: MarkedToken[] | undefined, degrade: (kind: string) => void): PptxTextRunSpec[] {
  if (!tokens) return []
  const out: PptxTextRunSpec[] = []
  for (const token of tokens) {
    switch (token.type) {
      case 'text':
        if (token.tokens && token.tokens.length > 0) out.push(...inlineRuns(token.tokens, degrade))
        else out.push({ text: token.text ?? '' })
        break
      case 'escape':
        out.push({ text: token.text ?? '' })
        break
      case 'br':
        out.push({ text: '\n' })
        break
      case 'strong':
        out.push({ text: plainText(token.tokens), bold: true })
        break
      case 'em':
        out.push({ text: plainText(token.tokens), italic: true })
        break
      case 'del':
        out.push({ text: plainText(token.tokens), strike: true })
        break
      case 'codespan':
        out.push({ text: token.text ?? '', code: true })
        break
      case 'link': {
        let href = String(token.raw ?? '').match(/\]\(\s*([^)\s]+)/)?.[1] ?? ''
        try { href = decodeURI(href) } catch { /* keep raw */ }
        out.push({ text: plainText(token.tokens), link: href })
        break
      }
      case 'image': {
        degrade('图片')
        const alt = token.text || plainText(token.tokens) || '图片'
        out.push({ text: `[图片:${alt}]` })
        break
      }
      case 'html':
        degrade('HTML 片段')
        out.push({ text: token.raw ?? token.text ?? '' })
        break
      default:
        out.push({ text: token.text ?? token.raw ?? '' })
    }
  }
  return out
}

/** markdown → slide specs. Pure: no pptxgenjs, no IO — vitest drives this
 *  directly, and the buffer builder consumes it below. */
export function markdownToSlideSpecs(md: string): PptxSpecs {
  const tokens = marked.lexer(md) as unknown as MarkedToken[]
  const degradations = new Set<string>()
  const degrade = (kind: string) => degradations.add(kind)
  const slides: SlideSpec[] = []

  const newSlide = (kind: SlideSpec['kind'], title: string): SlideSpec => {
    const slide: SlideSpec = { kind, title, blocks: [] }
    slides.push(slide)
    return slide
  }
  // A deck with no leading heading still renders — everything rides one page.
  let current = newSlide('content', '')

  for (const token of tokens) {
    switch (token.type) {
      case 'heading': {
        const depth = token.depth ?? 1
        if (depth <= 2) {
          const isCover = depth === 1 && slides.length === 1 && current.kind === 'content' && current.title === '' && current.blocks.length === 0
          current = newSlide(isCover ? 'cover' : 'content', plainText(token.tokens).trim())
        } else {
          current.blocks.push({ kind: 'heading', runs: inlineRuns(token.tokens, degrade) })
        }
        break
      }
      case 'paragraph': {
        // The paragraph right after the cover title becomes its subtitle —
        // UNLESS it carries tokens whose loss plainText would swallow (an
        // image degrades through inlineRuns, so it must stay a body block).
        const hasLossyInline = (tokens: MarkedToken[] | undefined): boolean =>
          (tokens ?? []).some((t) => t.type === 'image' || t.type === 'html' || hasLossyInline(t.tokens))
        if (current.kind === 'cover' && current.subtitle === undefined && current.blocks.length === 0 && !hasLossyInline(token.tokens)) {
          current.subtitle = plainText(token.tokens).trim()
          break
        }
        current.blocks.push({ kind: 'para', runs: inlineRuns(token.tokens, degrade) })
        break
      }
      case 'blockquote': {
        for (const child of token.tokens ?? []) {
          if (child.type === 'table') {
            pushTable(current, child)
            continue
          }
          current.blocks.push({ kind: 'quote', runs: inlineRuns(child.tokens ?? [child], degrade) })
        }
        break
      }
      case 'code': {
        const lines = String(token.text ?? '').split('\n')
        if (lines[lines.length - 1] === '') lines.pop()
        current.blocks.push({ kind: 'code', text: lines.join('\n') })
        break
      }
      case 'list': {
        pushList(current, token, 0, degrade)
        break
      }
      case 'table': {
        pushTable(current, token)
        break
      }
      case 'space':
      case 'hr':
        break
      default:
        degrade('数学/脚注等元素')
        current.blocks.push({ kind: 'para', runs: [{ text: token.raw ?? token.text ?? '' }] })
    }
  }

  let capped = slides
  // The seed page exists to catch heading-less documents; if a real heading
  // opened a page, the untouched seed drops off.
  if (capped.length > 1 && capped[0].kind === 'content' && capped[0].title === '' && capped[0].blocks.length === 0 && capped[0].subtitle === undefined) {
    capped = capped.slice(1)
  }
  if (capped.length > PPTX_EXPORT_SLIDE_LIMIT) {
    degradations.add(`页数超限（共 ${capped.length} 页，仅导出前 ${PPTX_EXPORT_SLIDE_LIMIT} 页）`)
    capped = capped.slice(0, PPTX_EXPORT_SLIDE_LIMIT)
  }
  // A wholly empty document exports nothing (the service refuses it).
  if (capped.length === 1 && capped[0].title === '' && capped[0].blocks.length === 0 && capped[0].subtitle === undefined) {
    return { slides: [], degradations: [...degradations] }
  }
  return { slides: capped, degradations: [...degradations] }
}

function pushList(slide: SlideSpec, token: MarkedToken, level: number, degrade: (kind: string) => void): void {
  const capped = Math.min(level, 2)
  for (const item of token.items ?? []) {
    const runs: PptxTextRunSpec[] = []
    const nested: MarkedToken[] = []
    for (const child of item.tokens ?? []) {
      if (child.type === 'list') nested.push(child)
      else runs.push(...inlineRuns([child], degrade))
    }
    // The parent's own bullet lands BEFORE its children's — marked hands the
    // nested list over as a sibling token, and recursing inline used to flip
    // the order.
    slide.blocks.push({ kind: 'bullet', runs, level: capped, ordered: token.ordered })
    for (const child of nested) pushList(slide, child, level + 1, degrade)
  }
}

function pushTable(slide: SlideSpec, token: MarkedToken): void {
  const cellText = (cell: MarkedCell): string => plainText(cell.tokens)
  slide.blocks.push({
    kind: 'table',
    header: (token.header ?? []).map(cellText),
    rows: (token.rows ?? []).map((row) => row.map(cellText)),
  })
}

// ── Buffer assembly (pptxgenjs) ──

interface ParagraphStyle {
  fontSize: number
  bold?: boolean
  italic?: boolean
  color?: string
  indent?: number
  bullet?: boolean | { type: 'number' }
  fontFace?: string
  paraSpaceBefore?: number
}

function pushParagraph(runs: Array<{ text: string; options: Record<string, unknown> }>, spec: PptxParagraphSpec, style: ParagraphStyle): void {
  const paraOpts: Record<string, unknown> = { breakLine: true, ...style }
  if (spec.kind === 'bullet') {
    paraOpts.bullet = spec.ordered ? { type: 'number' } : true
    paraOpts.indentLevel = spec.level ?? 0
  }
  if (spec.runs.length === 0) {
    runs.push({ text: ' ', options: { ...paraOpts } })
    return
  }
  spec.runs.forEach((run, i) => {
    const opts: Record<string, unknown> = { ...style }
    if (i === spec.runs.length - 1) Object.assign(opts, paraOpts)
    if (run.bold) opts.bold = true
    if (run.italic) opts.italic = true
    if (run.strike) opts.strike = true
    if (run.code) opts.fontFace = CODE_FONT
    if (run.link) opts.hyperlink = { url: run.link }
    runs.push({ text: run.text, options: opts })
  })
}

function textRunsOf(blocks: PptxBlockSpec[], bodyStyle: ParagraphStyle): Array<{ text: string; options: Record<string, unknown> }> {
  const runs: Array<{ text: string; options: Record<string, unknown> }> = []
  for (const block of blocks) {
    if (block.kind === 'table') continue
    if (block.kind === 'code') {
      const lines = block.text.split('\n')
      lines.forEach((line, i) => {
        runs.push({
          text: line === '' ? ' ' : line,
          options: {
            fontFace: CODE_FONT,
            fontSize: 10,
            color: BODY_INK,
            breakLine: i === lines.length - 1,
            fill: { color: 'F5F5F5' },
          },
        })
      })
      continue
    }
    const style: ParagraphStyle =
      block.kind === 'heading'
        ? { fontSize: 15, bold: true, color: BODY_INK, paraSpaceBefore: 8 }
        : block.kind === 'quote'
          ? { fontSize: 13, italic: true, color: MUTED_INK, indent: 12 }
          : bodyStyle
    pushParagraph(runs, block, style)
  }
  return runs
}

function addSlideChrome(pptx: PptxGenJS, spec: SlideSpec): string[] {
  const slide = pptx.addSlide()
  if (spec.kind === 'cover') {
    slide.addText(spec.title, {
      x: 0.8, y: 1.9, w: 8.4, h: 1.2, fontSize: 32, bold: true, color: BODY_INK, align: 'left',
    })
    if (spec.subtitle) {
      slide.addText(spec.subtitle, { x: 0.8, y: 3.15, w: 8.4, h: 0.9, fontSize: 15, color: MUTED_INK, fit: 'shrink' })
    }
    if (spec.blocks.length === 0) return []
    // A cover renders its body as one styled text box, and textRunsOf skips
    // tables — which silently dropped the table on 「# 季度汇报」+ 汇总表, the
    // most common LLM markdown shape (review0920-H4). Each cover table takes
    // renderBody's degradation shape: a named placeholder line on the slide
    // plus a loss the closing 备注 page carries.
    const losses: string[] = []
    const blocks: PptxBlockSpec[] = spec.blocks.map((block) => {
      if (block.kind !== 'table') return block
      losses.push('表格')
      return { kind: 'para', runs: [{ text: `[表格: ${block.header.join(' / ')}…]` }] }
    })
    slide.addText(textRunsOf(blocks, { fontSize: 14, color: BODY_INK }), {
      x: BODY_X, y: 4.1, w: BODY_W, h: BODY_BOTTOM - 4.1, fontSize: 14, color: BODY_INK, valign: 'top', fit: 'shrink',
    })
    return losses
  }
  slide.addText(spec.title, {
    x: BODY_X, y: 0.38, w: BODY_W, h: 0.85, fontSize: 22, bold: true, color: BODY_INK, align: 'left', fit: 'shrink',
  })
  return renderBody(slide, spec.blocks)
}

/** Cursor-flow body layout: text buffers flush when a table arrives; every
 *  table renders at the cursor while room remains. Whatever a 10×5.625 page
 *  cannot hold degrades with a named note — nothing disappears silently. */
function renderBody(slide: ReturnType<PptxGenJS['addSlide']>, blocks: PptxBlockSpec[]): string[] {
  const degradations: string[] = []
  let cursor = BODY_Y
  let textBuffer: PptxBlockSpec[] = []
  let overflowed = false

  const flushText = (): void => {
    if (textBuffer.length === 0) return
    const height = BODY_BOTTOM - cursor
    if (height < 0.3) {
      overflowed = true
    } else {
      slide.addText(textRunsOf(textBuffer, { fontSize: 14, color: BODY_INK }), {
        x: BODY_X, y: cursor, w: BODY_W, h: height, fontSize: 14, color: BODY_INK, valign: 'top', fit: 'shrink',
      })
      cursor += height * 0.5 + 0.1 // the box keeps the rest for shrink headroom
    }
    textBuffer = []
  }

  for (const block of blocks) {
    if (block.kind !== 'table') {
      textBuffer.push(block)
      continue
    }
    flushText()
    const rows = [
      block.header.map((t) => ({ text: t, options: { bold: true, fill: { color: 'F2F3F5' } } })),
      ...block.rows.map((row) => row.map((t) => ({ text: t }))),
    ]
    const estH = rows.length * 0.32 + 0.1
    if (cursor + estH > BODY_BOTTOM + 0.2) {
      degradations.push('表格')
      textBuffer.push({ kind: 'para', runs: [{ text: `[表格: ${block.header.join(' / ')}…]` }] })
      continue
    }
    slide.addTable(rows as PptxGenJS.TableRow[], {
      x: BODY_X, y: cursor, w: BODY_W, fontSize: 11, border: { type: 'solid', color: 'D9D9D9', pt: 0.5 }, valign: 'middle',
    })
    cursor += estH + 0.15
  }
  flushText()
  if (overflowed) degradations.push('单页放不下的内容（正文字号已尽量收缩）')
  return degradations
}

/** markdown → a real .pptx buffer. Throws when nothing exportable — the
 *  service turns that into a readable refusal. */
export async function markdownToPptxBuffer(md: string): Promise<Buffer> {
  const { slides, degradations } = markdownToSlideSpecs(md)
  if (slides.length === 0) throw new Error('没有可导出的内容（markdown 需要至少一个标题或段落）')
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_16x9'
  pptx.author = 'PulseMind'
  const layoutLosses: string[] = []
  for (const spec of slides) layoutLosses.push(...addSlideChrome(pptx, spec))
  if (layoutLosses.length > 0) degradations.push(...new Set(layoutLosses))
  if (degradations.length > 0) {
    const notes = pptx.addSlide()
    notes.addText('导出说明', { x: BODY_X, y: 0.38, w: BODY_W, h: 0.7, fontSize: 18, bold: true, color: MUTED_INK })
    notes.addText(
      degradations.map((d, i) => ({ text: d, options: { breakLine: i === degradations.length - 1, bullet: true } })),
      { x: BODY_X, y: 1.35, w: BODY_W, h: 3.6, fontSize: 11, color: MUTED_INK, valign: 'top' }
    )
  }
  const out = (await pptx.write({ outputType: 'nodebuffer' })) as unknown as Buffer
  return Buffer.from(out)
}
