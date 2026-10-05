// ── HTML design route types (PLAN-pptx-html-route) ── the dialect between the
//  route's two halves: html-measure (Chromium walks the DOM, produces facts)
//  and html-to-pptx (facts → positioned shapes). The profile constants —
//  canvas size, token whitelist, font whitelist — live here too so the
//  measurement script, the validators and the reference documentation can
//  never drift apart on the numbers.

/** The one canvas: 960×540px @96dpi ≡ 10×5.625in ≡ LAYOUT_16x9 — the same
 *  grid the office generators draw on (10×5.625in, LAYOUT_16x9). Every coordinate
 *  in the facts is slide-relative px on this canvas. */
export const SLIDE_W = 960
export const SLIDE_H = 540

/** The design route's page ceiling. */
export const HTML_SLIDE_CAP = 200

/** deck.html source cap — a slide deck's HTML beyond this is a pathological
 *  page, refuse before paying for Chromium. */
export const HTML_SOURCE_LIMIT = 200 * 1024

/** tokens.css's entire schema — a fixed shape, not a freeform stylesheet:
 *  seven colors (theme + accent wash + hairline), three font faces (sans pair
 *  + mono for numerals/labels), and a four-step type scale, nothing else.
 *  Unknown custom properties are refused (a token the converter doesn't know
 *  is a lie waiting to happen), and so are non-custom declarations. The type
 *  scale is html-side only — sizes are measured off the browser, so a restyle
 *  of the scale needs no converter involvement. */
export const TOKEN_KEYS = [
  '--pm-accent', '--pm-accent-soft', '--pm-ink', '--pm-muted', '--pm-panel', '--pm-bg', '--pm-line',
  '--pm-font-zh', '--pm-font-latin', '--pm-font-mono',
  '--pm-fs-cover', '--pm-fs-title', '--pm-fs-body', '--pm-fs-note',
] as const
export type TokenKey = (typeof TOKEN_KEYS)[number]

const COLOR_KEYS: readonly string[] = ['--pm-accent', '--pm-accent-soft', '--pm-ink', '--pm-muted', '--pm-panel', '--pm-bg', '--pm-line']
const FONT_KEYS: readonly string[] = ['--pm-font-zh', '--pm-font-latin', '--pm-font-mono']
/** Type-scale keys: `NNpx` integers, html-side indirection only. */
export const FS_KEYS: readonly string[] = ['--pm-fs-cover', '--pm-fs-title', '--pm-fs-body', '--pm-fs-note']

/** FS token bounds in px — cover-display sizes down to footnotes. */
export const FS_MIN_PX = 8
export const FS_MAX_PX = 200

/** Faces the converter is willing to WRITE into the pptx. The browser measures
 *  with whatever it resolves; the deck carries the token name, so the name
 *  must be a real face the opening machine can substitute sanely — generics
 *  (sans-serif) and web fonts are not. The preview must not promise a font
 *  the pptx cannot keep. The mono block exists for numerals/page
 *  numbers/labels (the Swiss-grid move): digits ride a:latin, CJK in a mono
 *  run falls back to --pm-font-zh via the emitter's post-pass. */
export const FONT_WHITELIST = [
  '微软雅黑', 'Microsoft YaHei', 'PingFang SC', '苹方-简', '黑体', 'SimHei', '宋体', 'SimSun',
  '等线', 'DengXian', '楷体', 'KaiTi', '仿宋', 'FangSong',
  'Arial', 'Helvetica', 'Calibri', 'Segoe UI', 'Georgia', 'Times New Roman', 'Verdana', 'Tahoma',
  'Trebuchet MS', 'Courier New', 'Consolas',
  'Menlo', 'Monaco', 'SF Mono', 'JetBrains Mono', 'Source Code Pro', 'Roboto Mono',
] as const

/** Injected into the page when deck.html ships no tokens.css (or before its
 *  own link — the link wins the cascade) so the route has sane defaults and
 *  the html can reference var(--pm-*) unconditionally. chart-draw's palette
 *  constants, verbatim. */
export const DEFAULT_TOKENS: Record<TokenKey, string> = {
  '--pm-accent': '#2F54EB',
  '--pm-accent-soft': '#EAEFFB',
  '--pm-ink': '#262626',
  '--pm-muted': '#8C8C8C',
  '--pm-panel': '#F7F8FA',
  '--pm-bg': '#FFFFFF',
  '--pm-line': '#D9D9D9',
  '--pm-font-zh': '微软雅黑',
  '--pm-font-latin': 'Arial',
  '--pm-font-mono': 'Courier New',
  '--pm-fs-cover': '44px',
  '--pm-fs-title': '26px',
  '--pm-fs-body': '18px',
  '--pm-fs-note': '12px',
}

// ── layout facts (what the page reports; all px, slide-relative) ──

export interface LayoutRun {
  text: string
  fontSizePx: number
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  /** Opaque RRGGBB — the profile refuses translucent color everywhere. */
  color: string
  /** The run's computed font-family is the --pm-font-mono face: the emitter
   *  writes the mono face into a:latin (digits/labels) and the post-pass
   *  keeps CJK in this run on --pm-font-zh. */
  mono?: boolean
}

export interface LayoutBorder {
  color: string
  widthPx: number
}

interface BlockBox {
  x: number
  y: number
  w: number
  h: number
  /** Paint layer: positioned blocks paint above in-flow ones (the browser's
   *  own rule, CSS2.1 Appendix E) — the emitter stable-partitions on this
   *  because pptx stacking is purely add-order. */
  positioned?: boolean
}

export interface TextBlock extends BlockBox {
  kind: 'text'
  runs: LayoutRun[]
  align: 'left' | 'center' | 'right' | 'justify'
  /** Present only when CSS set a line-height (not `normal`). */
  lineHeightMultiple?: number
  /** <li> blocks: nesting depth among the slide's lists + which kind. A styled
   *  leaf (button-like) arrives as TWO blocks — its box, then this text on the
   *  content box — paint order keeps them stacked. */
  bullet?: { level: number; ordered: boolean }
}

export interface BoxBlock extends BlockBox {
  kind: 'box'
  fill?: string
  border?: LayoutBorder
  radiusPx?: number
}

export interface ImageBlock extends BlockBox {
  kind: 'image'
  /** The raw src attribute — the service resolves + reads bytes against the
   *  workspace and keys the image map by exactly this string. */
  src: string
}

export interface TableCellFacts {
  text: string
  header: boolean
  bold: boolean
  color: string
  fontSizePx: number
  align: 'left' | 'center' | 'right'
  fill?: string
}

export interface TableBlock extends BlockBox {
  kind: 'table'
  colWidthsPx: number[]
  rowHeightsPx: number[]
  cells: TableCellFacts[][]
}

export interface ChartBlock extends BlockBox {
  kind: 'chart'
  /** The raw data-chart attribute — JSON per the deck chart spec; parsed +
   *  validated by validateDeckChart in the service (and defensively again in
   *  the emitter). Charts are NEVER svg in the html — the engine draws them
   *  as native editable shapes. */
  raw: string
}

export type LayoutBlock = TextBlock | BoxBlock | ImageBlock | TableBlock | ChartBlock

export interface SlideFacts {
  /** Opaque RRGGBB, present only when the .slide painted a background. */
  background?: string
  blocks: LayoutBlock[]
}

/** The emitter's input: the slides the page reported (refusals already
 *  filtered out by measureLayout). */
export interface LayoutFacts {
  slides: SlideFacts[]
}

/** A profile violation or layout impossibility found in the page — named by
 *  page number and element so the model can fix the html, not guess. */
export interface MeasureError {
  page: number
  message: string
}

/** What collectDeckLayout (in-page) returns. */
export interface CollectResult extends LayoutFacts {
  /** Advisory only — unmappable decoration (box-shadow) the route skips.
   *  Refusals go in `errors`; these ride the fidelity report. */
  degradations: string[]
  errors: MeasureError[]
}
