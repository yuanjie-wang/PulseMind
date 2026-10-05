// ── Chart spec (PLAN-deck-layouts → PLAN-pptx-html-route) ── the structured
//  chart dialect shared by `data-chart` annotations in the html design route's
//  deck.html. Pure types + a hand-rolled validator. (The deck GENERATION route
//  — export_document's structured `deck` parameter — was removed 2026-10-05 by
//  user ruling: every from-scratch PPT goes through the design route; what
//  survives here is the chart vocabulary that route annotates with, plus the
//  workspace image extension whitelist the office generators share.)

/** Chart types the engine can draw (chart-draw.ts). */
export const DECK_CHART_TYPES = ['column', 'bar', 'line', 'pie'] as const
export type DeckChartType = (typeof DECK_CHART_TYPES)[number]

/** Workspace image extensions the office generators can embed (pptxgenjs supported set). */
export const DECK_IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif'] as const

export interface DeckChartSeries {
  name: string
  /** Same length as categories; pie takes exactly one series of non-negatives. */
  values: number[]
}

export interface DeckChart {
  type: DeckChartType
  /** 2–12 category labels. */
  categories: string[]
  /** 1–4 series, each as long as categories. */
  series: DeckChartSeries[]
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function strArray(v: unknown, what: string, max: number, errs: string[]): v is string[] {
  if (!Array.isArray(v) || v.length === 0) {
    errs.push(`${what}：需要非空字符串数组`)
    return false
  }
  if (v.length > max) {
    errs.push(`${what}：最多 ${max} 项，收到 ${v.length} 项${max >= 8 ? '——内容多了请拆页' : ''}`)
    return false
  }
  return v.every((x) => isStr(x) && x.trim() !== '') || (errs.push(`${what}：每一项都得是非空字符串`), false)
}

/** Chart-object validation shared by BOTH consumers of the chart spec: the
 *  html design route's `data-chart` annotations (tag 「data-chart」) and any
 *  future structured caller — one dialect, one source. `at` is the location
 *  prefix the messages read from ("第 2 页"). */
export function validateDeckChart(c: unknown, at: string, errs: string[], tag = 'chart'): void {
  if (!isObj(c)) {
    errs.push(`${at}（${tag}）：chart 必填，形如 { type: "column", categories: ["一月", …], series: [{ name: "营收", values: [12, …] }] }`)
    return
  }
  if (!isStr(c.type) || !(DECK_CHART_TYPES as readonly string[]).includes(c.type)) {
    errs.push(`${at}（${tag}）：chart.type 必须是 ${DECK_CHART_TYPES.join(' / ')} 之一，收到「${String(c.type)}」`)
    return
  }
  if (!strArray(c.categories, `${at}（${tag}）categories`, 12, errs)) return
  const cats = c.categories as unknown[]
  if (!Array.isArray(c.series) || c.series.length === 0 || c.series.length > 4) {
    errs.push(`${at}（${tag}）：series 需要 1–4 组，收到 ${Array.isArray(c.series) ? c.series.length : '非数组'}`)
    return
  }
  if (c.type === 'pie' && c.series.length > 1) {
    errs.push(`${at}（${tag} pie）：pie 只吃一组 series（多组对比请用 column / bar / line）`)
    return
  }
  if (c.type === 'pie' && Array.isArray(c.series) && c.series.some((sr) => isObj(sr) && Array.isArray(sr.values) && sr.values.some((v) => isNum(v) && v < 0))) {
    errs.push(`${at}（${tag} pie）：pie 的 values 不能有负数（占比没有负值；带正负的对比用 bar）`)
    return
  }
  c.series.forEach((sr, j) => {
    if (!isObj(sr) || !isStr(sr.name) || sr.name.trim() === '') {
      errs.push(`${at}（${tag}）：series[${j}] 得是 { name, values }`)
      return
    }
    if (!Array.isArray(sr.values) || sr.values.length !== cats.length) {
      errs.push(`${at}（${tag}）：series[${j}].values 长度（${Array.isArray(sr.values) ? sr.values.length : '非数组'}）必须等于 categories 长度（${cats.length}）`)
      return
    }
    if (!sr.values.every(isNum)) errs.push(`${at}（${tag}）：series[${j}].values 里混进了非数字`)
  })
}
