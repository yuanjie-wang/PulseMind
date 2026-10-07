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
//  Fidelity: the collector refuses what still can't be honored (gradients,
//  transforms, overflow, translucent TEXT color) and maps what now can
//  (fill/line alpha → pptxgenjs transparency, single outer box-shadow →
//  outerShdw, object-fit:cover → a real srcRect); this module re-validates
//  the chart specs defensively and reports what it rendered plus what it
//  degraded (never silently — SKILL 铁律 5).

import AdmZip from 'adm-zip'
import PptxGenJS from 'pptxgenjs'
import { extname } from 'node:path'
import { validateDeckChart, type DeckChart } from '../../shared/deck/spec'
import { SLIDE_H, SLIDE_W } from './html-route-types'
import { drawDeckChart } from './chart-draw'
import type { BoxShadowFacts, ChartBlock, ImageBlock, LayoutFacts, LayoutRun, TableBlock, TextBlock, BoxBlock } from './html-route-types'

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
 * CSS box-shadow → pptxgenjs outer shadow. OOXML's outerShdw is polar
 * (dist + dir clockwise from 3 o'clock); CSS gives dx/dy, so dist = |offset|,
 * dir = atan2(dy, dx) in degrees. The falsy-default guard is load-bearing:
 * pptxgenjs fills `angle || 270` / `offset || 4` / `blur || 8`, so a legit
 * 0° angle must ship as 360°, and zero offsets/blurs as an epsilon —
 * otherwise every glow (`0 0 12px …`) secretly gains a 4pt offset.
 */
function shadowProps(s: BoxShadowFacts): Record<string, unknown> {
  const dist = Math.hypot(s.offsetX, s.offsetY) * PT
  const angleDeg = ((Math.atan2(s.offsetY, s.offsetX) * 180) / Math.PI + 360) % 360
  return {
    type: 'outer',
    angle: Math.round(angleDeg) === 0 ? 360 : Math.round(angleDeg),
    blur: Math.max(Math.round(s.blur * PT * 100) / 100, 0.01),
    offset: Math.max(Math.round(dist * 100) / 100, 0.01),
    color: s.color,
    opacity: Math.round(s.alpha * 100) / 100,
  }
}

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
          // letter-spacing px → pt; pptxgenjs emits spc (1/100 pt) and only
          // for truthy values, so untracked runs omit it (0 = no tracking)
          ...(run.charSpacingPx ? { charSpacing: Math.round(run.charSpacingPx * PT * 100) / 100 } : {}),
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
    ...(b.fill ? { fill: { color: b.fill, ...(b.fillTransparency !== undefined ? { transparency: b.fillTransparency } : {}) } } : {}),
    ...(b.border
      ? { line: { color: b.border.color, width: Math.max(0.75, Math.round(b.border.widthPx * PT * 10) / 10), ...(b.border.transparency !== undefined ? { transparency: b.border.transparency } : {}), ...(b.border.dash ? { dashType: b.border.dash } : {}) } }
      : {}),
    ...(rounded ? { rectRadius: (b.radiusPx ?? 0) * IN } : {}),
    ...(b.shadow ? { shadow: shadowProps(b.shadow) } : {}),
  } as never)
}

function emitImage(
  slide: ReturnType<PptxGenJS['addSlide']>,
  b: ImageBlock,
  images: Map<string, Buffer>,
  crops?: string[],
  degradations?: string[],
  page?: number
): void {
  const data = images.get(b.src)
  if (!data) throw new Error(`图片没有解析到字节：${b.src}——这是内部状态不一致（服务已在测量前解析全部图片），请重试导出`)
  const add = (sizing?: { type: 'cover'; w: number; h: number }) =>
    slide.addImage({
      data: `data:${imageMime(b.src)};base64,${data.toString('base64')}`,
      ...box(b),
      ...(sizing ? { sizing } : {}),
    })
  // object-fit:cover → pptxgenjs sizing is a no-op (it sizes against the
  // element frame, not the natural image), so the crop rides the post-pass:
  // sizing 'cover' emits the zero-srcRect MARKER — the only source of that
  // string — and applyCoverCrops swaps markers for real crops in pic order.
  if (b.objectFit === 'cover' && b.coverCrop && crops) {
    add({ type: 'cover', w: b.w * IN, h: b.h * IN })
    crops.push(coverSrcRect(b.coverCrop))
    return
  }
  if (b.objectFit === 'cover' && !b.coverCrop && degradations) {
    degradations.push(`第 ${page} 页：object-fit:cover 读不到图片原始尺寸，按拉伸处理`)
  }
  add()
}

/** pptxgenjs's own `sizing: 'cover'` output — zero crop, the marker string. */
const SRCRECT_MARKER = '<a:srcRect l="0" r="0" t="0" b="0"/><a:stretch/>'

function coverSrcRect(crop: { l: number; r: number; t: number; b: number }): string {
  const pct = (v: number): number => Math.round(v * 100000)
  return `<a:srcRect l="${pct(crop.l)}" r="${pct(crop.r)}" t="${pct(crop.t)}" b="${pct(crop.b)}"/><a:stretch/>`
}

/** Swap each cover pic's zero srcRect for its computed crop. The k-th marker
 *  in a slide's XML is the k-th cover image in that slide's emission order —
 *  the same order the crops were collected in. */
function applyCoverCrops(buffer: Buffer, cropsBySlide: string[][]): Buffer {
  if (!cropsBySlide.some((c) => c.length > 0)) return buffer
  const zip = new AdmZip(buffer)
  for (const entry of zip.getEntries()) {
    const m = entry.entryName.match(/^ppt\/slides\/slide(\d+)\.xml$/)
    if (!m) continue
    const crops = cropsBySlide[Number(m[1]) - 1]
    if (!crops || crops.length === 0) continue
    let i = 0
    // replaceAll, never replace: a slide with TWO+ cover images emits two
    // markers, and string-mode replace swaps only the first — the rest land
    // as zero srcRects, i.e. stretch instead of crop, silently
    // (review_20261008 高1).
    const xml = zip.readAsText(entry).replaceAll(SRCRECT_MARKER, () => (i < crops.length ? crops[i++] : SRCRECT_MARKER))
    zip.updateFile(entry, Buffer.from(xml, 'utf8'))
  }
  return zip.toBuffer()
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
        ...(cell.fill ? { fill: { color: cell.fill, ...(cell.fillTransparency !== undefined ? { transparency: cell.fillTransparency } : {}) } } : {}),
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
  const coverCropsBySlide: string[][] = []
  const emitDegradations: string[] = []
  facts.slides.forEach((sf, si) => {
    const page = si + 1
    const slide = pptx.addSlide()
    if (sf.background) slide.background = { color: sf.background, ...(sf.backgroundTransparency !== undefined ? { transparency: sf.backgroundTransparency } : {}) } as never
    // browser paint order: in-flow first, positioned above (stable partition)
    const ordered = [...sf.blocks.filter((b) => !b.positioned), ...sf.blocks.filter((b) => b.positioned)]
    const crops: string[] = []
    coverCropsBySlide[si] = crops
    ordered.forEach((b) => {
      switch (b.kind) {
        case 'text': emitText(slide, b, fontZh, fontMono); census.text++; break
        case 'box': emitBox(slide, b); census.box++; break
        case 'image': emitImage(slide, b, images, crops, emitDegradations, page); census.image++; break
        case 'table': emitTable(slide, b, fontZh); census.table++; break
        case 'chart': emitChart(slide, b, accent, page); census.chart++; break
      }
    })
  })

  const out = (await pptx.write({ outputType: 'nodebuffer' })) as unknown as Buffer
  const buffer = applyCoverCrops(splitLatinEa(Buffer.from(out), fontLatin, fontZh, fontMono), coverCropsBySlide)

  const lines = [
    `【设计路线 · 保真报告】${facts.slides.length} 页：文本块 ${census.text}、色块 ${census.box}、图片 ${census.image}、表格 ${census.table}、图表 ${census.chart}（原生可编辑形状）`,
  ]
  const degradations = [...(input.degradations ?? []), ...emitDegradations]
  if (degradations.length > 0) lines.push(`降级（如实告知用户）：${degradations.join('；')}`)
  lines.push('HTML 源（deck.html + tokens.css）已保留在会话里——改版式/改主题改它们后重新导出；交付后的小改也可以用 office_edit 直接改 pptx。')
  return { buffer, report: lines.join('\n') }
}
