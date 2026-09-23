// ── Deck spec (PLAN-deck-layouts) ── the structured input behind export_document
//  format=pptx's `deck` parameter. The model picks a LAYOUT per slide and fills
//  its slots; geometry, colour and chart drawing belong to the engine
//  (office-export/deck-to-pptx.ts). Pure types + a hand-rolled validator — the
//  renderer validates early for a fast readable error, the main process
//  validates again at the trust boundary, and both must speak the same dialect,
//  which is why this lives in shared/.

/** Slide layouts the engine can render. One source of truth for the validator,
 *  the tool schema text and the skill reference. */
export const DECK_LAYOUTS = ['cover', 'section', 'bullets', 'two-col', 'kpi', 'chart', 'table', 'quote', 'image'] as const
export type DeckLayout = (typeof DECK_LAYOUTS)[number]

export const DECK_CHART_TYPES = ['column', 'bar', 'line', 'pie'] as const
export type DeckChartType = (typeof DECK_CHART_TYPES)[number]

/** Deck cap — same ceiling the markdown path paginates at. */
export const DECK_MAX_SLIDES = 200

/** Workspace image extensions deck-to-pptx can embed (pptxgenjs supported set). */
export const DECK_IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif'] as const

export interface DeckBullet {
  text: string
  /** Sub-points rendered one indent level deeper, muted. */
  sub?: string[]
}

export interface DeckColumn {
  heading?: string
  bullets?: string[]
}

export interface DeckKpiItem {
  /** The big number/short phrase ("98.2%", "3 天"). */
  value: string
  /** What it measures. */
  label: string
}

export interface DeckChartSeries {
  name: string
  values: number[]
}

export interface DeckChart {
  type: DeckChartType
  categories: string[]
  series: DeckChartSeries[]
}

/** One slide. `layout` decides which fields are read; per-layout requirements
 *  are enforced by parseDeckSpec, not by the renderer. */
export interface DeckSlide {
  layout: DeckLayout
  title?: string
  subtitle?: string
  /** bullets: 1–10 items; image: optional side text (image left, text right). */
  bullets?: Array<string | DeckBullet>
  /** two-col: exactly two. */
  columns?: DeckColumn[]
  /** kpi: 2–4. */
  items?: DeckKpiItem[]
  /** chart. */
  chart?: DeckChart
  /** table. */
  header?: string[]
  /** table body rows — each row's length must equal header's. */
  rows?: string[][]
  /** quote body. */
  quote?: string
  /** quote attribution (rendered "— author"). */
  author?: string
  /** image: workspace-relative path (.png/.jpg/.jpeg/.gif). */
  image?: string
  /** image caption under the picture. */
  caption?: string
  /** Bottom source/footnote line (any layout). */
  note?: string
}

export interface DeckTheme {
  /** Accent colour, 6-hex RRGGBB without '#'. Default 2F54EB. */
  accent?: string
}

export interface DeckSpec {
  title: string
  theme?: DeckTheme
  slides: DeckSlide[]
}

export type ParsedDeck = { ok: true; spec: DeckSpec } | { ok: false; error: string }

const HEX6 = /^[0-9A-Fa-f]{6}$/

// ── tiny typed readers (unknown → readable refusal, never a throw) ──

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

/** Optional-string-array reader (columns[].bullets, image bullets…). */
function optStrArray(v: unknown, what: string, max: number, errs: string[]): v is string[] | undefined {
  if (v === undefined) return true
  return strArray(v, what, max, errs)
}

// ── per-layout validation ──

function validateSlide(s: Record<string, unknown>, i: number, errs: string[]): void {
  const at = `slides[${i}]`
  const layout = s.layout
  if (!isStr(layout) || !(DECK_LAYOUTS as readonly string[]).includes(layout)) {
    errs.push(`${at}：layout 必须是 ${DECK_LAYOUTS.join(' / ')} 之一，收到「${String(layout)}」`)
    return
  }
  const title = s.title
  switch (layout) {
    case 'cover':
    case 'section':
      if (!isStr(title) || title.trim() === '') errs.push(`${at}（${layout}）：title 必填`)
      if (s.subtitle !== undefined && !isStr(s.subtitle)) errs.push(`${at}（${layout}）：subtitle 得是字符串`)
      break
    case 'bullets': {
      if (!isStr(title) || title.trim() === '') errs.push(`${at}（bullets）：title 必填`)
      if (!Array.isArray(s.bullets) || s.bullets.length === 0) errs.push(`${at}（bullets）：bullets 必填，1–10 条`)
      else if (s.bullets.length > 10) errs.push(`${at}（bullets）：最多 10 条，收到 ${s.bullets.length} 条——要点多了拆页，别压缩`)
      else
        s.bullets.forEach((b, j) => {
          if (isStr(b)) {
            if (b.trim() === '') errs.push(`${at}（bullets）：第 ${j + 1} 条是空字符串`)
            return
          }
          if (!isObj(b) || !isStr(b.text) || b.text.trim() === '') {
            errs.push(`${at}（bullets）：第 ${j + 1} 条得是字符串或 { text, sub? }`)
            return
          }
          if (b.sub !== undefined && !strArray(b.sub, `${at}（bullets）第 ${j + 1} 条的 sub`, 6, errs)) return
        })
      break
    }
    case 'two-col': {
      if (!isStr(title) || title.trim() === '') errs.push(`${at}（two-col）：title 必填`)
      const cols = s.columns
      if (!Array.isArray(cols) || cols.length !== 2) {
        errs.push(`${at}（two-col）：columns 必须恰好两栏，收到 ${Array.isArray(cols) ? cols.length : '非数组'}`)
        break
      }
      cols.forEach((c, j) => {
        if (!isObj(c)) {
          errs.push(`${at}（two-col）：columns[${j}] 得是 { heading?, bullets? }`)
          return
        }
        if (c.heading !== undefined && !isStr(c.heading)) errs.push(`${at}（two-col）：columns[${j}].heading 得是字符串`)
        if (!optStrArray(c.bullets, `${at}（two-col）columns[${j}].bullets`, 8, errs)) return
      })
      break
    }
    case 'kpi': {
      if (!isStr(title) || title.trim() === '') errs.push(`${at}（kpi）：title 必填`)
      const items = s.items
      if (!Array.isArray(items) || items.length < 2 || items.length > 4) {
        errs.push(`${at}（kpi）：items 需要 2–4 个，收到 ${Array.isArray(items) ? items.length : '非数组'}`)
        break
      }
      items.forEach((it, j) => {
        if (!isObj(it) || !isStr(it.value) || it.value.trim() === '' || !isStr(it.label) || it.label.trim() === '') {
          errs.push(`${at}（kpi）：items[${j}] 得是 { value: "98.2%", label: "环比提升" } 形状`)
        }
      })
      break
    }
    case 'chart': {
      if (!isStr(title) || title.trim() === '') errs.push(`${at}（chart）：title 必填`)
      const c = s.chart
      if (!isObj(c)) {
        errs.push(`${at}（chart）：chart 必填，形如 { type: "column", categories: ["一月", …], series: [{ name: "营收", values: [12, …] }] }`)
        break
      }
      if (!isStr(c.type) || !(DECK_CHART_TYPES as readonly string[]).includes(c.type)) {
        errs.push(`${at}（chart）：chart.type 必须是 ${DECK_CHART_TYPES.join(' / ')} 之一，收到「${String(c.type)}」`)
        break
      }
      if (!strArray(c.categories, `${at}（chart）categories`, 12, errs)) break
      const cats = c.categories as unknown[]
      if (!Array.isArray(c.series) || c.series.length === 0 || c.series.length > 4) {
        errs.push(`${at}（chart）：series 需要 1–4 组，收到 ${Array.isArray(c.series) ? c.series.length : '非数组'}`)
        break
      }
      if (c.type === 'pie' && c.series.length > 1) {
        errs.push(`${at}（chart pie）：pie 只吃一组 series（多组对比请用 column / bar / line）`)
        break
      }
      if (c.type === 'pie' && Array.isArray(c.series) && c.series.some((sr) => isObj(sr) && Array.isArray(sr.values) && sr.values.some((v) => isNum(v) && v < 0))) {
        errs.push(`${at}（chart pie）：pie 的 values 不能有负数（占比没有负值；带正负的对比用 bar）`)
        break
      }
      c.series.forEach((sr, j) => {
        if (!isObj(sr) || !isStr(sr.name) || sr.name.trim() === '') {
          errs.push(`${at}（chart）：series[${j}] 得是 { name, values }`)
          return
        }
        if (!Array.isArray(sr.values) || sr.values.length !== cats.length) {
          errs.push(`${at}（chart）：series[${j}].values 长度（${Array.isArray(sr.values) ? sr.values.length : '非数组'}）必须等于 categories 长度（${cats.length}）`)
          return
        }
        if (!sr.values.every(isNum)) errs.push(`${at}（chart）：series[${j}].values 里混进了非数字`)
      })
      break
    }
    case 'table': {
      if (!isStr(title) || title.trim() === '') errs.push(`${at}（table）：title 必填`)
      if (!strArray(s.header, `${at}（table）header`, 8, errs)) break
      const cols = (s.header as unknown[]).length
      const rows = s.rows
      if (rows === undefined) break // rows 可选——只有表头也成立
      if (!Array.isArray(rows)) {
        errs.push(`${at}（table）：rows 得是二维数组`)
        break
      }
      if (rows.length > 12) {
        errs.push(`${at}（table）：rows 最多 12 行，收到 ${rows.length} 行——多了拆成两页`)
        break
      }
      rows.forEach((r, j) => {
        if (!Array.isArray(r) || r.length !== cols) {
          errs.push(`${at}（table）：rows[${j}] 列数（${Array.isArray(r) ? r.length : '非数组'}）与 header（${cols}）不一致`)
        } else if (!r.every((cell) => isStr(cell))) {
          errs.push(`${at}（table）：rows[${j}] 里有非字符串单元格（数字请先转成字符串）`)
        }
      })
      break
    }
    case 'quote':
      if (!isStr(s.quote) || s.quote.trim() === '') errs.push(`${at}（quote）：quote 必填`)
      if (s.author !== undefined && !isStr(s.author)) errs.push(`${at}（quote）：author 得是字符串`)
      break
    case 'image':
      if (!isStr(s.image) || s.image.trim() === '') errs.push(`${at}（image）：image 必填，工作区图片路径（png / jpg / gif）`)
      if (s.caption !== undefined && !isStr(s.caption)) errs.push(`${at}（image）：caption 得是字符串`)
      if (!optStrArray(s.bullets, `${at}（image）bullets`, 6, errs)) return
      break
  }
  if (s.note !== undefined && !isStr(s.note)) errs.push(`${at}：note 得是字符串`)
}

/** Validate + normalize a deck spec handed over the tool boundary. All
 *  refusals are one readable string — the model is expected to fix and retry,
 *  so the message names the slide and the field. */
export function parseDeckSpec(raw: unknown): ParsedDeck {
  if (!isObj(raw)) return { ok: false, error: 'deck 得是一个对象：{ title, slides: [...] }' }
  if (!isStr(raw.title) || raw.title.trim() === '') return { ok: false, error: 'deck.title 必填（写入文档元数据的标题）' }
  const slides = raw.slides
  if (!Array.isArray(slides) || slides.length === 0) return { ok: false, error: 'deck.slides 必填，至少一页' }
  if (slides.length > DECK_MAX_SLIDES) return { ok: false, error: `deck.slides 超过上限（${slides.length} 页 > ${DECK_MAX_SLIDES} 页）` }
  const accentRaw = isObj(raw.theme) ? raw.theme.accent : undefined
  if (accentRaw !== undefined && (!isStr(accentRaw) || !HEX6.test(accentRaw.trim()))) {
    return { ok: false, error: `deck.theme.accent 得是 6 位 RRGGBB（不带 #），收到「${String(accentRaw)}」` }
  }
  const errs: string[] = []
  slides.forEach((s, i) => {
    if (!isObj(s)) {
      errs.push(`slides[${i}]：得是对象`)
      return
    }
    validateSlide(s, i, errs)
  })
  if (errs.length > 0) return { ok: false, error: errs.slice(0, 5).join('；') + (errs.length > 5 ? `（共 ${errs.length} 处）` : '') }
  return {
    ok: true,
    spec: {
      title: raw.title.trim(),
      theme: { accent: isStr(accentRaw) ? accentRaw.trim().toUpperCase() : undefined },
      slides: slides as DeckSlide[],
    },
  }
}

/** Every image a spec references, with its slide index so the service's
 *  refusals can name the exact slide (deck.slides[N].image). */
export function deckImagePaths(spec: DeckSpec): Array<{ slide: number; path: string }> {
  const out: Array<{ slide: number; path: string }> = []
  spec.slides.forEach((s, i) => {
    if (s.layout === 'image' && s.image && s.image.trim() !== '') out.push({ slide: i, path: s.image })
  })
  return out
}
