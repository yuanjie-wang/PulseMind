// ── Chart-drawing vocabulary (PLAN-pptx-html-route; extracted from the retired
//  deck route's deck-to-pptx.ts) ── the ONE chart painter: native vector shapes
//  (rect/roundRect/ellipse/line/pie) that PowerPoint can recolor and retext,
//  and the preview pane renders honestly (pie via its conic-slice branch).
//
//  The deck GENERATION route was removed 2026-10-05 (user ruling: every
//  from-scratch PPT goes through the html design route) — what survives here is
//  what the design route needs: `data-chart` annotations in deck.html carry the
//  chart spec (shared/deck/spec), validated by validateDeckChart, and are drawn
//  by drawDeckChart into the measured box.

import type PptxGenJS from 'pptxgenjs'
import type { DeckChart } from '../../shared/deck/spec'

export interface ChartBox {
  x: number
  y: number
  w: number
  h: number
}

const INK = '262626'
const MUTED = '8C8C8C'
const AXIS = 'D9D9D9'
const ZERO_LINE = 'BFBFBF'

// ── Series colours derive FROM the accent (2026-10-07) ── the old fixed antd
//  five broke theme unity the moment a deck's accent wasn't red-family: a teal
//  deck's second series still came out antd-cyan. Companions now walk the
//  golden angle (137.5° — the classic uniform-hue spread) off the accent's own
//  hue, with S/L clamped to chart-legible mid bands; the accent itself rides
//  first VERBATIM (the recolor-the-primary-series contract). Near-neutral
//  accents (S < 0.08) have no hue to rotate — they walk a lightness ladder
//  instead, because monochrome themes read series by shade.
const GOLDEN_ANGLE = 137.5

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const r = parseInt(hex.slice(0, 2), 16) / 255
  const g = parseInt(hex.slice(2, 4), 16) / 255
  const b = parseInt(hex.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l }
  const s = d / (1 - Math.abs(2 * l - 1))
  let h: number
  if (max === r) h = 60 * (((g - b) / d) % 6)
  else if (max === g) h = 60 * ((b - r) / d + 2)
  else h = 60 * ((r - g) / d + 4)
  return { h: (h + 360) % 360, s, l }
}

function hslToHex({ h, s, l }: { h: number; s: number; l: number }): string {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hp = (h % 360) / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  const m = l - c / 2
  const [r0, g0, b0] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x]
  const byte = (v: number): string => Math.round((v + m) * 255).toString(16).padStart(2, '0').toUpperCase()
  return byte(r0) + byte(g0) + byte(b0)
}

/** [accent verbatim, then derived companions] — the palette every painter
 *  (column/bar/line/pie) reads. `count` = series or slice count. */
export function seriesPalette(accent: string, count: number): string[] {
  const first = accent.replace('#', '').toUpperCase()
  const out = [first]
  if (count <= 1) return out
  const { h, s, l } = hexToHsl(first)
  const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
  if (s < 0.08) {
    const steps = [0.24, -0.24, 0.42, -0.42, 0.58, -0.58, 0.72, -0.72, 0.84, -0.84, 0.92]
    for (let i = 1; i < count; i++) {
      const li = clamp(l + steps[(i - 1) % steps.length], 0.06, 0.94)
      out.push(hslToHex({ h, s, l: li }))
    }
  } else {
    const cs = clamp(s, 0.5, 0.78)
    const cl = clamp(l, 0.42, 0.56)
    for (let i = 1; i < count; i++) out.push(hslToHex({ h: (h + i * GOLDEN_ANGLE) % 360, s: cs, l: cl }))
  }
  return out
}

type Slide = ReturnType<PptxGenJS['addSlide']>

/** The accent rides first so a custom theme recolors the primary series;
 *  companions derive from it via seriesPalette. */
function seriesColor(palette: string[], i: number): string {
  return palette[i % palette.length]
}

/** Round a chart max up to 1/2/2.5/5×10^k so axis-less bars still read true. */
export function niceMax(v: number): number {
  if (v <= 0) return 1
  const exp = Math.pow(10, Math.floor(Math.log10(v)))
  for (const m of [1, 2, 2.5, 5, 10]) if (m * exp >= v) return m * exp
  return 10 * exp
}

const fmtNum = (v: number): string => (Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100))

function addLegend(slide: Slide, x: number, y: number, names: string[], colors: string[]): void {
  let cursor = x
  names.forEach((name, i) => {
    slide.addShape('rect', { x: cursor, y: y + 0.05, w: 0.13, h: 0.13, fill: { color: colors[i] } })
    const w = 0.3 + name.length * 0.16
    slide.addText(name, { x: cursor + 0.2, y, w, h: 0.24, fontSize: 10, color: INK, valign: 'middle' })
    cursor += w + 0.35
  })
}

/** Draw a chart into an arbitrary box — the html design route passes the
 *  measured rect of a `data-chart` element. Pie geometry is box-relative
 *  (center at 25% width, radius capped at h/2 and w/4) so a measured box of
 *  any size reads right. */
export function drawDeckChart(slide: Slide, c: DeckChart, accent: string, box: ChartBox): void {
  let chartTop = box.y
  let chartH = box.h
  const chartX = box.x
  const chartW = box.w
  const palette = seriesPalette(accent, c.series.length)
  const colors = c.series.map((_, i) => seriesColor(palette, i))

  if (c.type === 'pie') {
    renderPie(slide, c, accent, chartTop, chartH, chartX, chartW)
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
 *  clockwise, like every chart tool's default. Geometry is box-relative:
 *  center at 25% of the box width, radius the smaller of h/2 and w/4. */
function renderPie(slide: Slide, c: DeckChart, accent: string, chartTop: number, chartH: number, chartX: number, chartW: number): void {
  const values = c.series[0].values.map((v) => Math.max(v, 0))
  const total = values.reduce((a, b) => a + b, 0)
  const r = Math.min(chartH / 2, chartW / 4)
  const cy = chartTop + chartH / 2
  const cx = chartX + chartW * 0.25
  // up to 12 slices from one accent — the golden angle spreads them all
  const colors = seriesPalette(accent, values.length)
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
  const lx = chartX + chartW * 0.55
  const rowH = 0.34
  const startY = cy - (values.length * rowH) / 2
  values.forEach((v, i) => {
    const y = startY + i * rowH
    slide.addShape('rect', { x: lx, y: y + 0.06, w: 0.14, h: 0.14, fill: { color: colors[i] } })
    const pct = total > 0 ? (v / total) * 100 : 0
    const pctStr = Number.isInteger(pct) ? String(pct) : pct.toFixed(1)
    slide.addText(`${c.categories[i]} · ${fmtNum(v)}（${pctStr}%）`, {
      x: lx + 0.24, y, w: chartW * 0.42, h: rowH, fontSize: 11, color: INK, valign: 'middle', fit: 'shrink',
    })
  })
}
