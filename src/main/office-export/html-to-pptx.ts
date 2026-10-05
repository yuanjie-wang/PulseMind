// ── HTML design route: layout facts → .pptx (PLAN-pptx-html-route) ── the
//  emitter half of the design pipeline. html-measure hands over Chromium-
//  measured layout facts (slide-relative px); this module owns the mapping to
//  pptx primitives:
//    px → inch  = v / 96   (960×540 canvas ≡ 10×5.625in ≡ LAYOUT_16x9)
//    px → point = v × 0.75 (fonts)
//  Charts are NOT read from the html — a data-chart annotation carries the
//  chart spec (shared/deck/spec) and drawDeckChart draws native editable
//  shapes in the measured box (chart-draw.ts, box-parameterized). Tables
//  map to native tables with per-cell measured styles. The only post-pass is
//  the a:latin/a:ea split: pptxgenjs writes both typefaces from one fontFace,
//  so --pm-font-latin lands via a slide-XML rewrite (adm-zip), matching the
//  format_text double-write convention (main/pptx/ops.ts).
//
//  Fidelity: the collector already refused what can't be honored
//  (transparency, gradients, transforms, overflow); this module re-validates
//  the chart specs defensively and reports what it rendered plus what it
//  degraded (never silently — SKILL 铁律 5).

import AdmZip from 'adm-zip'
import PptxGenJS from 'pptxgenjs'
import { extname } from 'node:path'
import { validateDeckChart, type DeckChart } from '../../shared/deck/spec'
import { SLIDE_H, SLIDE_W } from './html-route-types'
import { drawDeckChart } from './chart-draw'
import type { ChartBlock, ImageBlock, LayoutFacts, LayoutRun, TableBlock, TextBlock, BoxBlock } from './html-route-types'

const IN = 1 / 96 // px → inch on the 96dpi canvas
const PT = 0.75 // px → point

export interface HtmlDeckInput {
  facts: LayoutFacts
  /** Keyed by the RAW src attribute the facts carry — the service resolved
   *  and read every referenced workspace image before Chromium ran. */
  images: Map<string, Buffer>
  /** Resolved token theme (defaults applied by the caller). */
  accent: string
  fontZh: string
  fontLatin: string
  fontMono: string
  title: string
  /** Advisory lines from the measurement pass — merged into the report. */
  degradations?: string[]
}

export interface HtmlDeckResult {
  buffer: Buffer
  /** Per-slide census + degradation list — surfaced in the tool result so
   *  the model can tell the user what the pptx really is. */
  report: string
}

function imageMime(src: string): string {
  const e = extname(src.split('?')[0].toLowerCase())
  if (e === '.png') return 'image/png'
  if (e === '.gif') return 'image/gif'
  return 'image/jpeg'
}

/** pptxgenjs writes a:latin AND a:ea from the same fontFace — split them so
 *  ASCII rides --pm-font-latin while CJK keeps --pm-font-zh (the same double
 *  write format_text does). Only the latin typeface value is rewritten; the
 *  ea entry already carries fontZh. */
function splitLatinEa(buffer: Buffer, latinFace: string, eaFace: string, monoFace: string): Buffer {
  if (latinFace === eaFace && monoFace === eaFace) return buffer
  const zip = new AdmZip(buffer)
  for (const entry of zip.getEntries()) {
    if (!/^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName)) continue
    let xml = zip.readAsText(entry)
    if (latinFace !== eaFace) xml = xml.split(`<a:latin typeface="${eaFace}"`).join(`<a:latin typeface="${latinFace}"`)
    // a mono run carried fontFace=mono (latin AND ea both written mono) —
    // CJK inside it reads on the sans face; digits keep the mono latin
    if (monoFace !== eaFace) xml = xml.split(`<a:ea typeface="${monoFace}"`).join(`<a:ea typeface="${eaFace}"`)
    if (xml !== zip.readAsText(entry)) zip.updateFile(entry, Buffer.from(xml, 'utf8'))
  }
  return zip.toBuffer()
}

const box = (b: { x: number; y: number; w: number; h: number }) => ({ x: b.x * IN, y: b.y * IN, w: b.w * IN, h: b.h * IN })

/**
 * Text-box safety pad. PowerPoint text boxes carry default insets (~0.1" per
 * side) that would eat a shrink-wrapped html box (a page number is a few px
 * wide) into a wrapped line — `margin: 0` removes the insets, and PAD_X adds
 * room on the side(s) the alignment does NOT anchor, so a font substituted
 * slightly wider on the opening machine still fits on one line without moving
 * the visual anchor (left-aligned grows right, right-aligned grows left,
 * centered grows both). PAD_B gives the vertical metric difference slack
 * before fit:'shrink' has to step in. All clamped to the canvas.
 */
const PAD_X = 8
const PAD_B = 4

function textBox(b: TextBlock): { x: number; y: number; w: number; h: number } {
  let { x, y, w } = b
  const h = b.h + PAD_B
  if (b.align === 'right') {
    x -= PAD_X
    w += PAD_X
  } else if (b.align === 'center' || b.align === 'justify') {
    x -= PAD_X / 2
    w += PAD_X
  } else {
    w += PAD_X
  }
  if (x < 0) {
    w += x
    x = 0
  }
  if (y < 0) y = 0
  if (x + w > SLIDE_W) w = SLIDE_W - x
  if (y + h > SLIDE_H) return { x, y, w, h: SLIDE_H - y }
  return { x, y, w, h }
}

/** Run text may carry '\n' (from <br>) — pptxgenjs turns breakLine into
 *  paragraph breaks, so each segment becomes its own run. Mono runs carry
 *  their own fontFace; the box-level default stays the sans pair. */
function textRuns(runs: LayoutRun[], fontMono: string): Array<{ text: string; options: Record<string, unknown> }> {
  const out: Array<{ text: string; options: Record<string, unknown> }> = []
  runs.forEach((run, i) => {
    const segments = run.text.split('\n')
    segments.forEach((seg, j) => {
      if (j > 0 && out.length > 0) out[out.length - 1].options.breakLine = true
      if (!seg) return
      out.push({
        text: seg,
        options: {
          fontSize: Math.round(run.fontSizePx * PT * 10) / 10,
          bold: run.bold || undefined,
          italic: run.italic || undefined,
          underline: run.underline ? { style: 'sng' } : undefined,
          strike: run.strike ? true : undefined,
          color: run.color,
          ...(run.mono ? { fontFace: fontMono } : {}),
        },
      })
    })
    if (i === runs.length - 1 && out.length > 0) delete out[out.length - 1].options.breakLine
  })
  return out
}

function emitText(slide: ReturnType<PptxGenJS['addSlide']>, b: TextBlock, fontZh: string, fontMono: string): void {
  const options: Record<string, unknown> = {
    ...box(textBox(b)),
    margin: 0,
    fontSize: 14,
    fontFace: fontZh,
    align: b.align,
    valign: 'top',
    fit: 'shrink',
    ...(b.lineHeightMultiple ? { lineSpacingMultiple: b.lineHeightMultiple } : {}),
    ...(b.bullet
      ? {
          bullet: b.bullet.ordered ? { type: 'number' as const, indent: 18 } : { characterCode: '2022', indent: 18 },
          // the collector counts the list itself as level 1 — a top-level
          // bullet must carry NO extra indent in the pptx
          indentLevel: Math.max(0, Math.min(b.bullet.level - 1, 4)),
        }
      : {}),
  }
  slide.addText(textRuns(b.runs, fontMono) as never, options as never)
}

function emitBox(slide: ReturnType<PptxGenJS['addSlide']>, b: BoxBlock): void {
  const rounded = (b.radiusPx ?? 0) > 0.5
  slide.addShape(rounded ? 'roundRect' : 'rect', {
    ...box(b),
    ...(b.fill ? { fill: { color: b.fill } } : {}),
    ...(b.border ? { line: { color: b.border.color, width: Math.max(0.75, Math.round(b.border.widthPx * PT * 10) / 10) } } : {}),
    ...(rounded ? { rectRadius: (b.radiusPx ?? 0) * IN } : {}),
  } as never)
}

function emitImage(slide: ReturnType<PptxGenJS['addSlide']>, b: ImageBlock, images: Map<string, Buffer>): void {
  const data = images.get(b.src)
  if (!data) throw new Error(`图片没有解析到字节：${b.src}——这是内部状态不一致（服务已在测量前解析全部图片），请重试导出`)
  slide.addImage({ data: `data:${imageMime(b.src)};base64,${data.toString('base64')}`, ...box(b), sizing: { type: 'contain', w: b.w * IN, h: b.h * IN } })
}

function emitTable(slide: ReturnType<PptxGenJS['addSlide']>, b: TableBlock, fontZh: string): void {
  const rows = b.cells.map((row) =>
    row.map((cell) => ({
      text: cell.text,
      options: {
        bold: cell.bold || undefined,
        color: cell.color,
        fontSize: Math.round(cell.fontSizePx * PT * 10) / 10,
        align: cell.align,
        valign: 'middle' as const,
        ...(cell.fill ? { fill: { color: cell.fill } } : {}),
      },
    }))
  )
  slide.addTable(rows as never, {
    ...box(b),
    colW: b.colWidthsPx.map((v) => Math.max(v * IN, 0.1)),
    rowH: b.rowHeightsPx.map((v) => Math.max(v * IN, 0.12)),
    fontFace: fontZh,
    border: { type: 'solid', color: 'E1E4E8', pt: 0.75 },
    margin: 0.04,
    valign: 'middle',
  } as never)
}

function emitChart(slide: ReturnType<PptxGenJS['addSlide']>, b: ChartBlock, accent: string, page: number): void {
  let spec: unknown
  try {
    spec = JSON.parse(b.raw)
  } catch {
    throw new Error(`第 ${page} 页的 data-chart 不是合法 JSON——属性值应为图表 JSON（形如 {"type":"column","categories":[…],"series":[…]}）`)
  }
  const errs: string[] = []
  validateDeckChart(spec, `第 ${page} 页`, errs, 'data-chart')
  if (errs.length > 0) throw new Error(errs.join('；'))
  drawDeckChart(slide, spec as DeckChart, accent, box(b))
}

export async function htmlDeckToPptxBuffer(input: HtmlDeckInput): Promise<HtmlDeckResult> {
  const { facts, images, accent, fontZh, fontLatin, fontMono, title } = input
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_16x9'
  pptx.title = title
  pptx.author = 'PulseMind'

  const census = { text: 0, box: 0, image: 0, table: 0, chart: 0 }
  facts.slides.forEach((sf, si) => {
    const page = si + 1
    const slide = pptx.addSlide()
    if (sf.background) slide.background = { color: sf.background }
    // browser paint order: in-flow first, positioned above (stable partition)
    const ordered = [...sf.blocks.filter((b) => !b.positioned), ...sf.blocks.filter((b) => b.positioned)]
    ordered.forEach((b) => {
      switch (b.kind) {
        case 'text': emitText(slide, b, fontZh, fontMono); census.text++; break
        case 'box': emitBox(slide, b); census.box++; break
        case 'image': emitImage(slide, b, images); census.image++; break
        case 'table': emitTable(slide, b, fontZh); census.table++; break
        case 'chart': emitChart(slide, b, accent, page); census.chart++; break
      }
    })
  })

  const out = (await pptx.write({ outputType: 'nodebuffer' })) as unknown as Buffer
  const buffer = splitLatinEa(Buffer.from(out), fontLatin, fontZh, fontMono)

  const lines = [
    `【设计路线 · 保真报告】${facts.slides.length} 页：文本块 ${census.text}、色块 ${census.box}、图片 ${census.image}、表格 ${census.table}、图表 ${census.chart}（原生可编辑形状）`,
  ]
  const degradations = [...(input.degradations ?? [])]
  if (degradations.length > 0) lines.push(`降级（如实告知用户）：${degradations.join('；')}`)
  lines.push('HTML 源（deck.html + tokens.css）已保留在会话里——改版式/改主题改它们后重新导出；交付后的小改也可以用 office_edit 直接改 pptx。')
  return { buffer, report: lines.join('\n') }
}
