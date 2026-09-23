// ── Deck spec → .pptx (PLAN-deck-layouts) ── the layout engine behind
//  export_document format=pptx's `deck` parameter. Division of labour: the
//  model picks a LAYOUT per slide and fills its slots; THIS module owns every
//  coordinate, colour and glyph — the model never sees a number that positions
//  anything, so a weak model cannot produce an overlapping page. Everything is
//  drawn with native vector shapes (rect / roundRect / ellipse / line / pie):
//  editable in PowerPoint, and the preview pane renders all of them (pie via
//  its conic-slice branch), so nothing degrades to a placeholder box.
//
//  Charts are shape-drawn on purpose — native OOXML chart parts would render
//  as a labelled box in the preview (its honesty contract). Re-charting means
//  re-generating the deck, which is the export path's own contract anyway.
//
//  Fidelity: parseDeckSpec (shared/deck/spec) has already refused malformed
//  specs, so every field read here with `!` is present by construction. Image
//  bytes arrive resolved by the service; a missing entry is a programming
//  error and throws before any bytes reach disk (the export is in-memory).

import PptxGenJS from 'pptxgenjs'
import { extname } from 'node:path'
import type { DeckChart, DeckSlide, DeckSpec } from '../../shared/deck/spec'

// ── canvas: 16:9 (10in × 5.625in), the same grid the markdown path uses ──

const PAGE_H = 5.625
const MX = 0.6
const MW = 8.8
const TITLE_Y = 0.34
const TITLE_H = 0.62
const BODY_Y = 1.3
const FOOT_Y = 5.28
const FOOT_H = 0.26

const INK = '262626'
const MUTED = '8C8C8C'
const PANEL = 'F7F8FA'
const AXIS = 'D9D9D9'
const ZERO_LINE = 'BFBFBF'

export const DEFAULT_DECK_ACCENT = '2F54EB'
/** Series colours: the accent rides first, then fixed companions (≤4 series). */
const SERIES_FRIENDS = ['13C2C2', 'FAAD14', 'F5222D', '52C41A', '722ED1']
/** Pie needs more slices than a 4-series chart — a 6-hue categorical set. */
const PIE_PALETTE = ['13C2C2', 'FAAD14', 'F5222D', '52C41A', '722ED1']

type Slide = ReturnType<PptxGenJS['addSlide']>

/** The accent rides first so a custom theme recolors the primary series. */
function seriesColor(accent: string, i: number): string {
  return i === 0 ? accent : SERIES_FRIENDS[(i - 1) % SERIES_FRIENDS.length]
}

/** accent mixed toward white by `ratio` (0 = raw, 1 = white) — tints for
 *  panels/cards/section backgrounds, derived so a custom accent re-themes
 *  the whole deck. */
function tint(hex: string, ratio: number): string {
  const n = parseInt(hex, 16)
  const ch = (v: number): number => Math.round(v + (255 - v) * ratio)
  return [ch((n >> 16) & 255), ch((n >> 8) & 255), ch(n & 255)]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
}

/** Round a chart max up to 1/2/2.5/5×10^k so axis-less bars still read true. */
function niceMax(v: number): number {
  if (v <= 0) return 1
  const exp = Math.pow(10, Math.floor(Math.log10(v)))
  for (const m of [1, 2, 2.5, 5, 10]) if (m * exp >= v) return m * exp
  return 10 * exp
}

const fmtNum = (v: number): string => (Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100))

// ── shared chrome ──

function addTitleChrome(slide: Slide, title: string, accent: string): void {
  slide.addShape('rect', { x: MX, y: 0.42, w: 0.075, h: 0.46, fill: { color: accent } })
  slide.addText(title, { x: 0.82, y: TITLE_Y, w: 8.55, h: TITLE_H, fontSize: 23, bold: true, color: INK, valign: 'middle', fit: 'shrink' })
}

function addFooter(slide: Slide, pageNo: number | null, note?: string): void {
  if (note) slide.addText(note, { x: MX, y: FOOT_Y, w: 8.0, h: FOOT_H, fontSize: 9, color: MUTED })
  if (pageNo !== null) slide.addText(String(pageNo), { x: 9.2, y: FOOT_Y, w: 0.4, h: FOOT_H, fontSize: 9, color: MUTED, align: 'right' })
}

// ── layouts ──

function renderCover(slide: Slide, s: DeckSlide, accent: string): void {
  slide.addShape('rect', { x: 0, y: 0, w: 0.22, h: PAGE_H, fill: { color: accent } })
  slide.addShape('rect', { x: 0.95, y: 1.72, w: 1.1, h: 0.055, fill: { color: accent } })
  slide.addText(s.title ?? '', { x: 0.92, y: 1.98, w: 8.2, h: 1.25, fontSize: 38, bold: true, color: INK, valign: 'top', fit: 'shrink' })
  if (s.subtitle) slide.addText(s.subtitle, { x: 0.94, y: 3.3, w: 7.6, h: 0.6, fontSize: 15, color: MUTED, fit: 'shrink' })
}

function renderSection(slide: Slide, s: DeckSlide, accent: string): void {
  slide.background = { color: tint(accent, 0.92) }
  slide.addShape('rect', { x: 4.4, y: 2.02, w: 1.2, h: 0.06, fill: { color: accent } })
  slide.addText(s.title ?? '', { x: 0.8, y: 2.28, w: 8.4, h: 0.95, fontSize: 30, bold: true, color: INK, align: 'center', fit: 'shrink' })
  if (s.subtitle) slide.addText(s.subtitle, { x: 1.5, y: 3.32, w: 7.0, h: 0.5, fontSize: 14, color: MUTED, align: 'center', fit: 'shrink' })
}

/** bullets (string | {text, sub}) → rich runs; sub rides one level deeper, muted. */
function bulletRuns(items: Array<string | { text: string; sub?: string[] }>, mainSize: number, subSize: number): Array<{ text: string; options: Record<string, unknown> }> {
  const runs: Array<{ text: string; options: Record<string, unknown> }> = []
  items.forEach((raw, i) => {
    const item = typeof raw === 'string' ? { text: raw } : raw
    const subs = item.sub ?? []
    runs.push({
      text: item.text,
      options: { fontSize: mainSize, color: INK, breakLine: subs.length === 0 || i < items.length - 1, paraSpaceAfter: 8, bullet: { characterCode: '2022', indent: 18 } },
    })
    subs.forEach((sub, j) => {
      runs.push({
        text: sub,
        options: {
          fontSize: subSize, color: MUTED, breakLine: !(i === items.length - 1 && j === subs.length - 1),
          paraSpaceAfter: 6, bullet: { characterCode: '2013', indent: 18 }, indentLevel: 1,
        },
      })
    })
  })
  return runs
}

function renderBullets(slide: Slide, s: DeckSlide): void {
  slide.addText(bulletRuns(s.bullets ?? [], 17, 13.5), {
    x: 0.75, y: BODY_Y, w: 8.45, h: 3.75, fontSize: 17, color: INK, valign: 'top', fit: 'shrink',
  })
}

function renderTwoCol(slide: Slide, s: DeckSlide, accent: string): void {
  const cols = s.columns ?? []
  const xs = [MX, 5.1]
  cols.forEach((col, i) => {
    const x = xs[i]
    slide.addShape('roundRect', { x, y: BODY_Y, w: 4.3, h: 3.75, fill: { color: PANEL }, rectRadius: 0.08 })
    const heading = (col.heading ?? '').trim()
    let textY = BODY_Y + 0.28
    let textH = 3.2
    if (heading) {
      slide.addText(heading, { x: x + 0.3, y: BODY_Y + 0.22, w: 3.7, h: 0.42, fontSize: 15, bold: true, color: accent, valign: 'middle', fit: 'shrink' })
      textY = BODY_Y + 0.75
      textH = 2.75
    }
    if ((col.bullets?.length ?? 0) > 0) {
      slide.addText(bulletRuns(col.bullets ?? [], 13.5, 12), {
        x: x + 0.3, y: textY, w: 3.7, h: textH, fontSize: 13.5, color: INK, valign: 'top', fit: 'shrink',
      })
    }
  })
}

function renderKpi(slide: Slide, s: DeckSlide, accent: string): void {
  const items = s.items ?? []
  const n = items.length
  const gap = 0.25
  const cardW = (MW - (n - 1) * gap) / n
  items.forEach((it, i) => {
    const x = MX + i * (cardW + gap)
    slide.addShape('roundRect', { x, y: 1.55, w: cardW, h: 2.15, fill: { color: tint(accent, 0.93) }, rectRadius: 0.09 })
    slide.addText(it.value, { x, y: 1.95, w: cardW, h: 0.85, fontSize: 33, bold: true, color: accent, align: 'center', fit: 'shrink' })
    slide.addText(it.label, { x: x + 0.15, y: 2.85, w: cardW - 0.3, h: 0.6, fontSize: 12.5, color: INK, align: 'center', fit: 'shrink' })
  })
}

function addLegend(slide: Slide, x: number, y: number, names: string[], colors: string[]): void {
  let cursor = x
  names.forEach((name, i) => {
    slide.addShape('rect', { x: cursor, y: y + 0.05, w: 0.13, h: 0.13, fill: { color: colors[i] } })
    const w = 0.3 + name.length * 0.16
    slide.addText(name, { x: cursor + 0.2, y, w, h: 0.24, fontSize: 10, color: INK, valign: 'middle' })
    cursor += w + 0.35
  })
}

function renderChart(slide: Slide, s: DeckSlide, accent: string): void {
  const c = s.chart as DeckChart
  let chartTop = 1.42
  let chartH = 3.15
  const chartX = 0.7
  const chartW = 8.6
  const colors = c.series.map((_, i) => seriesColor(accent, i))

  if (c.type === 'pie') {
    renderPie(slide, c, accent, chartTop, chartH, chartX)
    return
  }

  if (c.series.length > 1) {
    addLegend(slide, chartX, chartTop, c.series.map((sr) => sr.name), colors)
    chartTop += 0.38
    chartH -= 0.38
  }

  const all = c.series.flatMap((sr) => sr.values)
  const maxV = niceMax(Math.max(0, ...all))
  const minV = all.some((v) => v < 0) ? -niceMax(Math.max(0, ...all.map((v) => -v))) : 0
  const span = maxV - minV
  const baseline = chartTop + chartH
  const zeroY = baseline - (Math.abs(minV) / span) * chartH
  const scale = chartH / span

  // axes: the bottom edge always; a darker zero line when negatives exist
  slide.addShape('line', { x: chartX, y: baseline, w: chartW, h: 0, line: { color: AXIS, width: 1 } })
  if (minV < 0) slide.addShape('line', { x: chartX, y: zeroY, w: chartW, h: 0, line: { color: ZERO_LINE, width: 1.25 } })

  const catW = chartW / c.categories.length
  const catFont = c.categories.length > 8 ? 9 : 10.5

  if (c.type === 'column' || c.type === 'line') {
    c.categories.forEach((cat, i) => {
      slide.addText(cat, { x: chartX + i * catW, y: baseline + 0.05, w: catW, h: 0.3, fontSize: catFont, color: MUTED, align: 'center' })
    })
  }

  if (c.type === 'column') {
    const groupW = Math.min(catW * 0.66, 0.95)
    const barW = groupW / c.series.length
    const showValues = c.series.length * c.categories.length <= 24
    c.series.forEach((sr, j) => {
      sr.values.forEach((v, i) => {
        const h = Math.max(Math.abs(v) * scale, 0.02)
        const y = v >= 0 ? zeroY - h : zeroY
        const x = chartX + i * catW + (catW - groupW) / 2 + j * barW
        slide.addShape('rect', { x, y, w: barW * 0.82, h, fill: { color: colors[j] } })
        if (showValues) {
          slide.addText(fmtNum(v), {
            x: x - 0.2, y: v >= 0 ? y - 0.24 : y + h + 0.02, w: barW * 0.82 + 0.4, h: 0.22, fontSize: 8.5, color: MUTED, align: 'center',
          })
        }
      })
    })
  }

  if (c.type === 'bar') {
    const labelW = 1.45
    const barX = chartX + labelW + 0.15
    const barMaxW = chartX + chartW - barX - 0.55
    const catH = chartH / c.categories.length
    const barH = Math.min(0.34, catH * 0.55)
    const zeroX = barX + (Math.abs(minV) / span) * barMaxW
    if (minV < 0) slide.addShape('line', { x: zeroX, y: chartTop, w: 0, h: chartH, line: { color: ZERO_LINE, width: 1.25 } })
    c.series.forEach((sr, j) => {
      sr.values.forEach((v, i) => {
        const w = Math.max(Math.abs(v) * (barMaxW / span), 0.02)
        const y = chartTop + i * catH + (catH - barH) / 2
        const x = v >= 0 ? zeroX : zeroX - w
        slide.addShape('rect', { x, y, w, h: barH, fill: { color: colors[j] } })
        slide.addText(fmtNum(v), {
          x: v >= 0 ? x + w + 0.05 : x - 0.6, y: y + barH / 2 - 0.11, w: 0.55, h: 0.22, fontSize: 8.5, color: MUTED, align: 'left',
        })
      })
    })
    c.categories.forEach((cat, i) => {
      slide.addText(cat, { x: chartX, y: chartTop + i * catH, w: labelW, h: catH, fontSize: catFont, color: MUTED, align: 'right', valign: 'middle', fit: 'shrink' })
    })
  }

  if (c.type === 'line') {
    const ptX = (i: number): number => chartX + (i + 0.5) * catW
    c.series.forEach((sr, j) => {
      const pts = sr.values.map((v, i) => ({ x: ptX(i), y: zeroY - v * scale }))
      pts.slice(0, -1).forEach((p, i) => {
        const q = pts[i + 1]
        // a `line` shape draws TL→BR of its own box; flipV turns it BL→TR
        slide.addShape('line', {
          x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), w: Math.abs(q.x - p.x), h: Math.abs(q.y - p.y),
          flipV: q.y < p.y, line: { color: colors[j], width: 2 },
        })
      })
      pts.forEach((p) => {
        slide.addShape('ellipse', { x: p.x - 0.045, y: p.y - 0.045, w: 0.09, h: 0.09, fill: { color: colors[j] } })
      })
      if (c.series.length === 1 && c.categories.length <= 10) {
        sr.values.forEach((v, i) => {
          slide.addText(fmtNum(v), { x: pts[i].x - 0.45, y: pts[i].y - 0.32, w: 0.9, h: 0.22, fontSize: 9, color: MUTED, align: 'center' })
        })
      }
    })
  }
}

/** Pie: native `pie` shapes with angleRange — PowerPoint perfect, and the
 *  preview renders each slice as a conic-gradient wedge. 12 o'clock start,
 *  clockwise, like every chart tool's default. */
function renderPie(slide: Slide, c: DeckChart, accent: string, chartTop: number, chartH: number, chartX: number): void {
  const values = c.series[0].values.map((v) => Math.max(v, 0))
  const total = values.reduce((a, b) => a + b, 0)
  const r = Math.min(chartH / 2, 1.5)
  const cy = chartTop + chartH / 2
  const cx = chartX + 2.1
  const colors = values.map((_, i) => (i === 0 ? accent : PIE_PALETTE[(i - 1) % PIE_PALETTE.length]))
  if (total > 0) {
    let angle = 270 // OOXML geometry: degrees clockwise from 3 o'clock
    values.forEach((v, i) => {
      const sweep = (v / total) * 360
      if (sweep >= 359.5) {
        slide.addShape('ellipse', { x: cx - r, y: cy - r, w: 2 * r, h: 2 * r, fill: { color: colors[i] } })
      } else if (sweep > 0.05) {
        slide.addShape('pie', {
          x: cx - r, y: cy - r, w: 2 * r, h: 2 * r, fill: { color: colors[i] },
          angleRange: [angle % 360, (angle + sweep) % 360] as [number, number], line: { color: 'FFFFFF', width: 1 },
        })
      }
      angle += sweep
    })
  }
  // legend: name · value (pct) — the numbers a legend owes the reader
  const lx = chartX + 4.7
  const rowH = 0.34
  const startY = cy - (values.length * rowH) / 2
  values.forEach((v, i) => {
    const y = startY + i * rowH
    slide.addShape('rect', { x: lx, y: y + 0.06, w: 0.14, h: 0.14, fill: { color: colors[i] } })
    const pct = total > 0 ? (v / total) * 100 : 0
    const pctStr = Number.isInteger(pct) ? String(pct) : pct.toFixed(1)
    slide.addText(`${c.categories[i]} · ${fmtNum(v)}（${pctStr}%）`, {
      x: lx + 0.24, y, w: 3.6, h: rowH, fontSize: 11, color: INK, valign: 'middle', fit: 'shrink',
    })
  })
}

function renderTable(slide: Slide, s: DeckSlide, accent: string): void {
  const header = (s.header ?? []).map((t) => ({
    text: t,
    options: { bold: true, color: 'FFFFFF', fill: { color: accent }, fontSize: 11.5, valign: 'middle' as const },
  }))
  const body = (s.rows ?? []).map((row, ri) =>
    row.map((cell) => ({
      text: cell,
      options: { fontSize: 11, color: INK, fill: { color: ri % 2 === 0 ? 'FFFFFF' : PANEL }, valign: 'middle' as const },
    }))
  )
  slide.addTable([header, ...body] as PptxGenJS.TableRow[], {
    x: MX, y: BODY_Y, w: MW, rowH: 0.3, fontSize: 11,
    border: { type: 'solid', color: 'E1E4E8', pt: 0.5 }, margin: 0.06, valign: 'middle',
  })
}

function renderQuote(slide: Slide, s: DeckSlide, accent: string): void {
  slide.addText('“', { x: 0.72, y: 0.92, w: 1.6, h: 1.15, fontSize: 66, bold: true, color: accent, fontFace: 'Georgia' })
  slide.addText(s.quote ?? '', { x: 1.0, y: 2.0, w: 8.0, h: 2.2, fontSize: 21, color: INK, valign: 'top', fit: 'shrink', lineSpacingMultiple: 1.25 })
  if (s.author) slide.addText(`— ${s.author}`, { x: 1.0, y: 4.4, w: 8.0, h: 0.4, fontSize: 13, color: MUTED, align: 'right' })
}

function imageMime(p: string): string {
  const e = extname(p).toLowerCase()
  if (e === '.png') return 'image/png'
  if (e === '.gif') return 'image/gif'
  return 'image/jpeg'
}

function renderImage(slide: Slide, s: DeckSlide, images: Map<string, Buffer>): void {
  const buf = images.get(s.image ?? '')
  if (!buf) throw new Error(`deck.slides 里引用的图片没有解析到字节：${s.image}`)
  const data = `${imageMime(s.image ?? '')};base64,${buf.toString('base64')}`
  const hasSide = (s.bullets?.length ?? 0) > 0
  const box = hasSide
    ? { x: MX, y: BODY_Y, w: 4.9, h: 3.55 }
    : { x: 1.3, y: s.title ? BODY_Y : 0.95, w: 7.4, h: s.title ? 3.5 : 3.85 }
  slide.addImage({ data, x: box.x, y: box.y, w: box.w, h: box.h, sizing: { type: 'contain', w: box.w, h: box.h } })
  if (s.caption) {
    slide.addText(s.caption, { x: box.x, y: box.y + box.h + 0.06, w: box.w, h: 0.26, fontSize: 9.5, color: MUTED, align: 'center', fit: 'shrink' })
  }
  if (hasSide) {
    slide.addText(bulletRuns(s.bullets ?? [], 14, 12), {
      x: 5.75, y: 1.6, w: 3.65, h: 3.2, fontSize: 14, color: INK, valign: 'top', fit: 'shrink',
    })
  }
}

function renderSlide(pptx: PptxGenJS, s: DeckSlide, index: number, accent: string, images: Map<string, Buffer>): void {
  const slide = pptx.addSlide()
  switch (s.layout) {
    case 'cover':
      renderCover(slide, s, accent)
      break
    case 'section':
      renderSection(slide, s, accent)
      break
    case 'bullets':
      addTitleChrome(slide, s.title ?? '', accent)
      renderBullets(slide, s)
      addFooter(slide, index + 1, s.note)
      break
    case 'two-col':
      addTitleChrome(slide, s.title ?? '', accent)
      renderTwoCol(slide, s, accent)
      addFooter(slide, index + 1, s.note)
      break
    case 'kpi':
      addTitleChrome(slide, s.title ?? '', accent)
      renderKpi(slide, s, accent)
      addFooter(slide, index + 1, s.note)
      break
    case 'chart':
      addTitleChrome(slide, s.title ?? '', accent)
      renderChart(slide, s, accent)
      addFooter(slide, index + 1, s.note)
      break
    case 'table':
      addTitleChrome(slide, s.title ?? '', accent)
      renderTable(slide, s, accent)
      addFooter(slide, index + 1, s.note)
      break
    case 'quote':
      if (s.title && s.title.trim() !== '') addTitleChrome(slide, s.title, accent)
      renderQuote(slide, s, accent)
      addFooter(slide, index + 1, s.note)
      break
    case 'image':
      if (s.title && s.title.trim() !== '') addTitleChrome(slide, s.title, accent)
      renderImage(slide, s, images)
      addFooter(slide, index + 1, s.note)
      break
  }
}

/** deck spec → a real .pptx buffer. `images` maps the spec's own path strings
 *  to file bytes (resolved + guarded by the service). Throws only on internal
 *  inconsistency (an image path that never got resolved) — everything the
 *  model could get wrong was refused by parseDeckSpec before we got here. */
export async function deckToPptxBuffer(spec: DeckSpec, images: Map<string, Buffer>): Promise<Buffer> {
  const accent = (spec.theme?.accent || DEFAULT_DECK_ACCENT).toUpperCase()
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_16x9'
  pptx.title = spec.title
  pptx.author = 'PulseMind'
  spec.slides.forEach((s, i) => renderSlide(pptx, s, i, accent, images))
  const out = (await pptx.write({ outputType: 'nodebuffer' })) as unknown as Buffer
  return Buffer.from(out)
}
