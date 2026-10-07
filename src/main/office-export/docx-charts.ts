// ── docx 图表栅格化（PLAN-docx-native-styles M9）── markdown 的 ```chart 围
// 栏（data-chart 同一方言，validateDeckChart 校验）→ SVG（复用 chart-draw 的
// 视觉语言：seriesPalette 从 accent 派生系列色、niceMax 轴、图例/数值标注）→
// Chromium 截图 → PNG，经 ImageRun 落进文档。
//
// 职责切分刻意的：`markdownToDocxBuffer` 是纯函数（零 Chromium），只认
// `options.charts` 里按围栏文档序摆好的 PNG；扫描/校验/栅格化都住在服务层
// （office-export.ts）。Chromium 缺席 → 服务层降级（不传 charts），生成器把
// 围栏当普通代码块 + 降级注——图表是增强，不是承重墙。
//
// SVG 是手绘的而不是截 HTML 图：图表几何（轴/柱/点/扇形）就是几个纯函数，
// 直出 SVG 少一层 HTML/CSS 的不确定，截图只付一次位图转换。

import type { DeckChart } from '../../shared/deck/spec'
import { niceMax, seriesPalette } from './chart-draw'
import { marked } from 'marked'

export const CHART_WIDTH = 600
export const CHART_HEIGHT = 360
/** 截图倍率：2x 位图落进 600px 显示框，打印件不发虚。 */
export const CHART_SCALE = 2

const INK = '#262626'
const MUTED = '#8C8C8C'
const AXIS = '#D9D9D9'
const ZERO_LINE = '#BFBFBF'
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const fmtNum = (v: number): string => (Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100))

/** ```chart 围栏的原文（JSON），文档序，只走顶层 token——生成器的围栏计数
 *  同样只发生在顶层 code 分支，两边按 index 对齐严格成立（列表/引用块里的围
 *  栏不是文档化能力，两边都不认）。 */
export function mdChartSpecs(md: string): string[] {
  return (marked.lexer(md) as unknown as Array<{ type: string; lang?: string; text?: string }>)
    .filter((t) => t.type === 'code' && (t.lang ?? '').trim().split(/\s+/)[0]?.toLowerCase() === 'chart')
    .map((t) => String(t.text ?? ''))
}

function legendSvg(names: string[], colors: string[], y: number): { svg: string; height: number } {
  let x = 0
  const parts: string[] = []
  names.forEach((name, i) => {
    parts.push(`<rect x="${x}" y="${y + 4}" width="13" height="13" fill="${colors[i]}"/>`)
    const w = 0.3 * 2 + name.length * 7
    parts.push(`<text x="${x + 20}" y="${y + 15}" font-size="12" fill="${INK}">${esc(name)}</text>`)
    x += w + 30
  })
  return { svg: parts.join(''), height: names.length > 1 ? 26 : 0 }
}

/** 一张图表的 SVG。几何语义对齐 chart-draw.ts：底部轴线、柱组内 0.82 缩宽、
 *  横条的类目标签右对齐在轴左、折线的单系列数值标注、pie 圆心在左 1/4 + 右侧
 *  「名 · 值（占比）」图例。seriesPalette 产的是不带 # 的 hex（pptxgenjs 口
 *  径），SVG 的 fill 要 # 前缀——cssColor 统一补。 */
const cssColor = (hex: string): string => (hex.startsWith('#') ? hex : `#${hex}`)

export function chartToSvg(spec: DeckChart, accent: string, width = CHART_WIDTH, height = CHART_HEIGHT): string {
  const palette = seriesPalette(accent, spec.series.length)
  const colors = spec.series.map((_, i) => cssColor(palette[i % palette.length]))
  const parts: string[] = []
  // pie 不画系列图例——切片图例已带名称（renderPie 同款语义）。
  const hasSeriesLegend = spec.type !== 'pie' && spec.series.length > 1
  const legend = hasSeriesLegend ? legendSvg(spec.series.map((sr) => sr.name), colors, 6) : { svg: '', height: 0 }
  parts.push(legend.svg)
  const top = 6 + legend.height
  const plotH = height - top - 30

  if (spec.type === 'pie') {
    // 切片色按切片数重取（chart-draw renderPie 的同款语义）——series.length=1
    // 的系列色数组覆盖不了 N 个切片，越界的 fill 会是 undefined（SVG 落黑）。
    const sliceColors = seriesPalette(accent, spec.categories.length).map(cssColor)
    const values = spec.series[0].values.map((v) => Math.max(v, 0))
    const total = values.reduce((a, b) => a + b, 0)
    const r = Math.min(plotH / 2, width * 0.25)
    const cx = width * 0.25
    const cy = top + plotH / 2
    if (total > 0) {
      let angle = -90 // SVG 习惯：12 点起、顺时针
      values.forEach((v, i) => {
        const sweep = (v / total) * 360
        if (sweep >= 359.5) {
          parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${sliceColors[i]}"/>`)
        } else if (sweep > 0.05) {
          const a0 = (angle * Math.PI) / 180
          const a1 = ((angle + sweep) * Math.PI) / 180
          const large = sweep > 180 ? 1 : 0
          const x0 = cx + r * Math.cos(a0)
          const y0 = cy + r * Math.sin(a0)
          const x1 = cx + r * Math.cos(a1)
          const y1 = cy + r * Math.sin(a1)
          parts.push(`<path d="M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} Z" fill="${sliceColors[i]}" stroke="#FFFFFF" stroke-width="1"/>`)
        }
        angle += sweep
      })
    }
    const lx = width * 0.55
    const rowH = 26
    const startY = cy - (values.length * rowH) / 2
    values.forEach((v, i) => {
      const y = startY + i * rowH
      parts.push(`<rect x="${lx}" y="${y + 5}" width="13" height="13" fill="${sliceColors[i]}"/>`)
      const pct = total > 0 ? (v / total) * 100 : 0
      parts.push(`<text x="${lx + 22}" y="${y + 16}" font-size="13" fill="${INK}">${esc(spec.categories[i])} · ${fmtNum(v)}（${Number.isInteger(pct) ? pct : pct.toFixed(1)}%）</text>`)
    })
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#FFFFFF"/>${parts.join('')}</svg>`
  }

  const all = spec.series.flatMap((s) => s.values)
  const maxV = niceMax(Math.max(0, ...all))
  const minV = all.some((v) => v < 0) ? -niceMax(Math.max(0, ...all.map((v) => -v))) : 0
  const span = maxV - minV

  if (spec.type === 'bar') {
    const labelW = 145
    const plotX = labelW + 12
    const plotW = width - plotX - 52
    const zeroX = plotX + (Math.abs(minV) / span) * plotW
    const catH = plotH / spec.categories.length
    const barH = Math.min(26, catH * 0.55)
    if (minV < 0) parts.push(`<line x1="${zeroX}" y1="${top}" x2="${zeroX}" y2="${top + plotH}" stroke="${ZERO_LINE}" stroke-width="1.25"/>`)
    spec.series.forEach((sr, j) => {
      sr.values.forEach((v, i) => {
        const w = Math.max(Math.abs(v) * (plotW / span), 1.5)
        const y = top + i * catH + (catH - barH) / 2
        const x = v >= 0 ? zeroX : zeroX - w
        parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${barH}" fill="${colors[j]}"/>`)
        parts.push(`<text x="${v >= 0 ? x + w + 4 : x - 4}" y="${y + barH / 2 + 4}" font-size="11" fill="${MUTED}" text-anchor="${v >= 0 ? 'start' : 'end'}">${fmtNum(v)}</text>`)
      })
    })
    spec.categories.forEach((cat, i) => {
      parts.push(`<text x="${labelW}" y="${top + i * catH + catH / 2 + 4}" font-size="12" fill="${MUTED}" text-anchor="end">${esc(cat)}</text>`)
    })
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#FFFFFF"/>${parts.join('')}</svg>`
  }

  const zeroY = top + plotH - (Math.abs(minV) / span) * plotH
  const scale = plotH / span
  parts.push(`<line x1="36" y1="${top + plotH}" x2="${width - 8}" y2="${top + plotH}" stroke="${AXIS}" stroke-width="1"/>`)
  if (minV < 0) parts.push(`<line x1="36" y1="${zeroY}" x2="${width - 8}" y2="${zeroY}" stroke="${ZERO_LINE}" stroke-width="1.25"/>`)

  const plotW = width - 44
  const catW = plotW / spec.categories.length
  const catFont = spec.categories.length > 8 ? 11 : 12

  if (spec.type === 'column') {
    const groupW = Math.min(catW * 0.66, 76)
    const barW = groupW / spec.series.length
    const showValues = spec.series.length * spec.categories.length <= 24
    spec.series.forEach((sr, j) => {
      sr.values.forEach((v, i) => {
        const h = Math.max(Math.abs(v) * scale, 1.5)
        const y = v >= 0 ? zeroY - h : zeroY
        const x = 36 + i * catW + (catW - groupW) / 2 + j * barW
        parts.push(`<rect x="${x}" y="${y}" width="${barW * 0.82}" height="${h}" fill="${colors[j]}"/>`)
        if (showValues) parts.push(`<text x="${x + (barW * 0.82) / 2}" y="${v >= 0 ? y - 5 : y + h + 12}" font-size="10.5" fill="${MUTED}" text-anchor="middle">${fmtNum(v)}</text>`)
      })
    })
  }

  if (spec.type === 'line') {
    const ptX = (i: number): number => 36 + (i + 0.5) * catW
    spec.series.forEach((sr, j) => {
      const pts = sr.values.map((v, i) => ({ x: ptX(i), y: zeroY - v * scale }))
      if (pts.length > 1) {
        parts.push(`<polyline points="${pts.map((p) => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="${colors[j]}" stroke-width="2"/>`)
      }
      pts.forEach((p) => parts.push(`<circle cx="${p.x}" cy="${p.y}" r="3.5" fill="${colors[j]}"/>`))
      if (spec.series.length === 1 && spec.categories.length <= 10) {
        sr.values.forEach((v, i) => parts.push(`<text x="${pts[i].x}" y="${pts[i].y - 9}" font-size="10.5" fill="${MUTED}" text-anchor="middle">${fmtNum(v)}</text>`))
      }
    })
  }

  spec.categories.forEach((cat, i) => {
    parts.push(`<text x="${36 + i * catW + catW / 2}" y="${top + plotH + 17}" font-size="${catFont}" fill="${MUTED}" text-anchor="middle">${esc(cat)}</text>`)
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#FFFFFF"/>${parts.join('')}</svg>`
}

export interface RenderChartsOptions {
  /** DI seam：测试注入假 launch，不在 vitest 里真开 Chromium。 */
  launch?: (headless: boolean) => Promise<import('playwright-core').Browser>
  /** 截图倍率（CHART_SCALE 的测试覆盖）。 */
  deviceScaleFactor?: number
}

/** 围栏 spec 数组 → PNG buffer 数组（文档序）。每次导出独立 launch/close——
 *  与 measureLayout 同款纪律，不碰 BrowserService 的用户会话实例。 */
export async function renderChartsToPng(specs: DeckChart[], accent: string, opts: RenderChartsOptions = {}): Promise<Buffer[]> {
  if (specs.length === 0) return []
  const { defaultLaunch } = await import('./html-measure')
  const launch = opts.launch ?? defaultLaunch
  const browser = await launch(true)
  try {
    const page = await browser.newPage({ deviceScaleFactor: opts.deviceScaleFactor ?? CHART_SCALE, viewport: { width: CHART_WIDTH + 40, height: CHART_HEIGHT + 40 } })
    const body = specs
      .map((spec, i) => `<div class="chart" data-idx="${i}">${chartToSvg(spec, accent)}</div>`)
      .join('\n')
    await page.setContent(
      `<!doctype html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0}body{background:#fff}.chart{width:${CHART_WIDTH}px;height:${CHART_HEIGHT}px;overflow:hidden}</style></head><body>${body}</body></html>`,
      { waitUntil: 'load' },
    )
    const out: Buffer[] = []
    for (let i = 0; i < specs.length; i++) {
      const el = page.locator(`[data-idx="${i}"]`)
      out.push(await el.screenshot({ type: 'png' }))
    }
    return out
  } finally {
    await browser.close().catch(() => undefined)
  }
}
