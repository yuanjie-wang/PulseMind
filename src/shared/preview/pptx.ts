// ── PPTX preview model (PLAN-pptx-preview) ── The pure half of the slide
//  preview: an unzipped part store goes in, a renderable slide VM comes out.
//  No DOM here and no zip dependency (the XML plumbing lives in pptx-xml.ts;
//  the component adapts fflate's output to `PptxParts`), so vitest feeds
//  literal XML strings straight through `partsOf` in the test file.
//
//  Honesty contract (D5): the fidelity target is the SLIDESHOW appearance —
//  master/layout decoration shapes render (they show on every slide), empty
//  placeholder prompts do not, animations/transitions/notes do not exist.
//  Charts / SmartArt / OLE / media / EMF-WMF images render as labelled
//  placeholder boxes and are counted in `skipped`; nothing is guessed.
//  autofit honours the fontScale the file cached (PowerPoint computed it at
//  save time) and never re-measures text.

import { type XNode, elementsOf, findDescendant, findDescendants, kid, kids, numAttr, parseXml, textOf } from './pptx-xml'

// ── Caps (D6): pathological decks must not explode the DOM. Walking
//  continues (counting is cheap), rendering stops at the cap. ──
export const PPTX_PREVIEW_SLIDE_LIMIT = 200
export const PPTX_PREVIEW_SHAPE_LIMIT = 500

/** EMU → px at 96dpi (OOXML's 914400 EMU/inch over 96 px/inch). */
const emuToPx = (emu: number): number => emu / 9525
/** Run size in hundredths of a point → points. */
const sizeToPt = (sz: number): number => sz / 100
/** OOXML angle in 60000ths of a degree → degrees. */
const angleToDeg = (ang: number): number => ang / 60000

// ── Parts ──

/** What the parser needs from the zip. The component adapts fflate's
 *  `Record<path, Uint8Array>` to this at the boundary; tests build it from
 *  literal XML strings, which is why the model has no zip dependency. */
export interface PptxParts {
  entryText(name: string): string | undefined
  entryBytes(name: string): Uint8Array | undefined
  names(): string[]
}

// ── VM shapes ──

export interface PptxTextRun {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  sizePt?: number
  color?: string
  /** A font-family LIST ("Calibri, 微软雅黑") — browsers pick per glyph, so
   *  a mixed Latin/CJK run resolves each script through its own face. */
  font?: string
  link?: string
  /** Rendered as a <br> (an a:br line break inside the paragraph). */
  br?: boolean
}

export interface PptxBullet {
  kind: 'char' | 'num'
  char: string
  /** For `num`: the ordinal this paragraph shows (startAt-honoured). */
  index?: number
  color?: string
}

export interface PptxParagraph {
  runs: PptxTextRun[]
  align?: 'left' | 'center' | 'right' | 'justify'
  /** Effective left margin (hanging-indent base), px. */
  marLeftPx?: number
  indentPx?: number
  bullet?: PptxBullet
  lineSpacing?: number
  lineSpacingPt?: number
  spaceBeforePt?: number
  spaceAfterPt?: number
}

export interface PptxTextFrame {
  paragraphs: PptxParagraph[]
  anchor: 'top' | 'middle' | 'bottom'
  wrap: boolean
  /** Cached normAutofit fontScale (0..1] — applied, never recomputed. */
  fontScale?: number
  insetsPx: { top: number; right: number; bottom: number; left: number }
}

export interface PptxLineStyle {
  color: string
  widthPx: number
  dash?: 'dash' | 'dot' | 'solid'
}

export interface PptxGeometry {
  /** preset-geometry tag — the renderer keys its extra styling off this */
  prst: string
  /** roundRect only: corner radius as a ratio of min(w,h) (adj/100000). */
  radiusRatio?: number
  clipPath?: string
  /** line/straightConnector1 — an SVG corner-to-corner line */
  isLine?: boolean
  /** pie only: adj1/adj2 in degrees, clockwise from 3 o'clock (OOXML angle
   *  units are 60000ths). The renderer paints the [start, end) wedge with a
   *  conic-gradient inside a round box. */
  startAngleDeg?: number
  endAngleDeg?: number
}

export interface PptxShapeVM {
  kind: 'shape' | 'image' | 'table' | 'placeholder'
  x: number
  y: number
  w: number
  h: number
  rotationDeg?: number
  flipH?: boolean
  flipV?: boolean
  /** CSS background (solid or linear-gradient); undefined = transparent. */
  fill?: string
  line?: PptxLineStyle
  geometry?: PptxGeometry
  text?: PptxTextFrame
  /** image kind: data: URL (the CSP allows data: images — DocxPreview's
   *  useBase64URL precedent). */
  src?: string
  srcRect?: { l: number; t: number; r: number; b: number }
  alt?: string
  /** table kind: position/size from the graphicFrame, grid from a:tbl. */
  table?: PptxTableVM
  /** placeholder kind: chart / smartArt / media / ole / image (undecodable) */
  phLabel?: 'chart' | 'smartArt' | 'media' | 'ole' | 'image'
}

export interface PptxTableCellVM {
  paragraphs: PptxParagraph[]
  fill?: string
  colSpan?: number
  rowSpan?: number
  /** continuation cell (hMerge/vMerge) — covered by its master, not rendered */
  hidden?: boolean
  borders?: { top?: string; right?: string; bottom?: string; left?: string }
}

export interface PptxTableVM {
  x: number
  y: number
  w: number
  h: number
  colWidthsPx: number[]
  rowHeightsPx: number[]
  /** Sparse rows: absent = columns consumed by an earlier cell's colSpan. */
  cells: Array<Array<PptxTableCellVM | undefined>>
}

export interface PptxSlideVM {
  index: number
  name?: string
  background?: string
  shapes: PptxShapeVM[]
  totalShapes: number
  truncatedShapes: boolean
}

export interface PptxSkipped {
  charts: number
  smartArt: number
  media: number
  ole: number
  /** images whose format Chromium cannot decode (EMF/WMF/…) */
  badImages: number
  /** prstGeom values outside the recognised families */
  unknownGeoms: number
  /** slides whose XML failed to parse — skipped, not fatal */
  corruptSlides: number
  /** slides marked show="0" — a slideshow does not show them */
  hiddenSlides: number
}

export interface PptxDeck {
  widthPx: number
  heightPx: number
  slides: PptxSlideVM[]
  totalSlides: number
  truncatedSlides: boolean
  skipped: PptxSkipped
  /** The model's own per-slide cap — the component's banner reads it from
   *  here so the component never value-imports this module (that would pull
   *  the parser into the main chunk and defeat the dynamic import). */
  shapeLimit: number
  /** Every family the deck names (theme included), for the alias @font-face
   *  CSS the component injects (the docx-fonts.ts table). */
  fonts: string[]
  /** The theme's minor Latin face — a run that names no font shows this. */
  defaultFont?: string
}

// ── Rels ──

interface Rel {
  type: string
  target: string
  external: boolean
}

/** `../media/x.png` resolved against the referrer part's directory; a
 *  leading-slash target is package-root-relative. */
function resolveRelTarget(referrerPart: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const dir = referrerPart.slice(0, referrerPart.lastIndexOf('/') + 1)
  const stack: string[] = []
  for (const seg of `${dir}${target}`.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') stack.pop()
    else stack.push(seg)
  }
  return stack.join('/')
}

function relsOf(parts: PptxParts, partName: string): Map<string, Rel> {
  const out = new Map<string, Rel>()
  const dir = partName.slice(0, partName.lastIndexOf('/') + 1)
  const base = partName.slice(dir.length)
  const root = parseXml(parts.entryText(`${dir}_rels/${base}.rels`))[0]
  for (const rel of kids(root, 'Relationship')) {
    out.set(attrLocal(rel, 'Id'), {
      type: rel.attrs.Type ?? '',
      target: rel.attrs.TargetMode === 'External' ? rel.attrs.Target ?? '' : resolveRelTarget(partName, rel.attrs.Target ?? ''),
      external: rel.attrs.TargetMode === 'External',
    })
  }
  return out
}

/** Attribute by local name — relationship attrs ride the `r:` prefix whose
 *  spelling is convention, not contract (same rule as element names). */
function attrLocal(node: XNode, name: string): string {
  if (node.attrs[name] !== undefined) return node.attrs[name]
  const suffixed = Object.keys(node.attrs).find((k) => k.endsWith(`:${name}`))
  return suffixed ? node.attrs[suffixed] : ''
}

/** The RELATIONSHIP id of an element (`r:id` / `r:embed`). The namespaced
 *  form wins over a plain `id` — `p:sldId` carries both, and its plain
 *  `id` is a shape id, never a relationship. */
function relIdOf(node: XNode, name = 'id'): string {
  const suffixed = Object.keys(node.attrs).find((k) => k.endsWith(`:${name}`))
  return suffixed ? node.attrs[suffixed] : node.attrs[name] ?? ''
}

/** First rel of the given type (suffix match — type URLs end with the kind). */
function relOfType(rels: Map<string, Rel>, suffix: string): Rel | undefined {
  for (const rel of rels.values()) {
    if (rel.type.endsWith(suffix) && !rel.external) return rel
  }
  return undefined
}

// ── Theme ──

interface Theme {
  colors: Map<string, string>
  majorLatin?: string
  majorEa?: string
  minorLatin?: string
  minorEa?: string
}

function normalizeHex(hex: string): string | undefined {
  const clean = hex.replace(/^#/, '')
  return /^[0-9a-fA-F]{6}$/.test(clean) ? `#${clean}` : undefined
}

function parseTheme(root: XNode | undefined): Theme {
  const theme: Theme = { colors: new Map() }
  const scheme = findDescendant(root, 'clrScheme')
  if (scheme) {
    for (const entry of scheme.kids) {
      const color = kid(entry, 'srgbClr') ?? kid(entry, 'sysClr')
      const hex =
        color?.tag === 'sysClr' ? color.attrs.lastClr ?? color.attrs.val : color?.attrs.val
      if (hex) {
        const normalized = normalizeHex(hex)
        if (normalized) theme.colors.set(entry.tag, normalized)
      }
    }
  }
  const fontScheme = findDescendant(root, 'fontScheme')
  if (fontScheme) {
    const major = kid(fontScheme, 'majorFont')
    const minor = kid(fontScheme, 'minorFont')
    theme.majorLatin = kid(major, 'latin')?.attrs.typeface
    theme.majorEa = kid(major, 'ea')?.attrs.typeface
    theme.minorLatin = kid(minor, 'latin')?.attrs.typeface
    theme.minorEa = kid(minor, 'ea')?.attrs.typeface
  }
  return theme
}

// ── Colour resolution (schemeClr + transforms) ──

interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

function hexToRgba(hex: string): Rgba {
  const v = parseInt(hex.slice(1), 16)
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255, a: 1 }
}

function rgbaToCss({ r, g, b, a }: Rgba): string {
  const clamp = (n: number) => Math.round(Math.max(0, Math.min(255, n)))
  if (a >= 0.999) {
    const hex = (1 << 24) | (clamp(r) << 16) | (clamp(g) << 8) | clamp(b)
    return `#${hex.toString(16).slice(1)}`
  }
  return `rgba(${clamp(r)}, ${clamp(g)}, ${clamp(b)}, ${Math.round(a * 100) / 100})`
}

function rgbToHsl({ r, g, b }: Rgba): { h: number; s: number; l: number } {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6
  else if (max === gn) h = ((bn - rn) / d + 2) / 6
  else h = ((rn - gn) / d + 4) / 6
  return { h, s, l }
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const channel = (t: number): number => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return { r: channel(h + 1 / 3) * 255, g: channel(h) * 255, b: channel(h - 1 / 3) * 255 }
}

interface ParseCtx {
  theme: Theme
  /** master's clrMap: bg1→lt1, tx1→dk1 … */
  clrMap: Map<string, string>
  /** the colour a fill/line style-reference hands its transforms (phClr) */
  phClr?: string
}

/** schemeClr key → theme hex, through the master's clrMap. */
function schemeColor(key: string, ctx: ParseCtx): string | undefined {
  if (key === 'phClr') return ctx.phClr
  const mapped = ctx.clrMap.get(key) ?? key
  return ctx.theme.colors.get(mapped)
}

/** The colour element (srgbClr / schemeClr / sysClr) with its child
 *  transforms (lumMod/lumOff/tint/shade/alpha/satMod) in document order.
 *  Transform math is the common HSL-luminance approximation every
 *  implementation of ECMA-376 uses. */
function resolveColorNode(node: XNode | undefined, ctx: ParseCtx): string | undefined {
  if (!node) return undefined
  let base: string | undefined
  if (node.tag === 'srgbClr' || node.tag === 'prstClr') base = normalizeHex(node.attrs.val ?? '')
  else if (node.tag === 'sysClr') base = normalizeHex(node.attrs.lastClr ?? node.attrs.val ?? '')
  else if (node.tag === 'schemeClr') base = schemeColor(node.attrs.val ?? '', ctx)
  if (!base) return undefined
  const transforms = node.kids.filter((k) => k.tag !== '#text')
  if (transforms.length === 0) return base
  const rgba = hexToRgba(base)
  const cur = { ...rgbToHsl(rgba), a: rgba.a }
  for (const t of transforms) {
    const val = numAttr(t, 'val', NaN) / 100000
    if (!Number.isFinite(val)) continue
    switch (t.tag) {
      case 'lumMod': cur.l *= val; break
      case 'lumOff': cur.l += val; break
      case 'tint': cur.l = cur.l * val + (1 - val); break
      case 'shade': cur.l *= val; break
      case 'satMod': cur.s *= val; break
      case 'alpha': cur.a *= val; break
      default: break // unknown transform: drop it, keep the base colour
    }
  }
  const rgb = hslToRgb(cur.h, cur.s, Math.max(0, Math.min(1, cur.l)))
  return rgbaToCss({ ...rgb, a: cur.a })
}

/** The one colour child of a fill/line container. */
function colorChildOf(parent: XNode): XNode | undefined {
  return parent.kids.find((k) => k.tag === 'srgbClr' || k.tag === 'schemeClr' || k.tag === 'sysClr' || k.tag === 'prstClr')
}

// ── Text style inheritance ──

interface TextStyle {
  sizePt?: number
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  color?: string
  font?: string
  align?: PptxParagraph['align']
  marLeftPx?: number
  bullet?: PptxBullet | 'none'
}

/** A shape's placeholder kind + idx, for the inheritance chain. */
interface PhRef {
  type?: string
  idx?: string
}

function phRefOf(shape: XNode): PhRef | undefined {
  const ph = findDescendant(kid(shape, 'nvSpPr') ?? kid(shape, 'nvCxnSpPr'), 'ph')
  if (!ph) return undefined
  return { type: ph.attrs.type || undefined, idx: ph.attrs.idx || undefined }
}

/** defRPr / rPr share the attribute grammar; this is their common reader. */
function styleOfRPr(rPr: XNode | undefined, ctx: ParseCtx, fonts?: Set<string>): TextStyle {
  const s: TextStyle = {}
  if (!rPr) return s
  if (rPr.attrs.sz !== undefined) s.sizePt = sizeToPt(numAttr(rPr, 'sz', 1800))
  if (rPr.attrs.b !== undefined) s.bold = rPr.attrs.b === '1' || rPr.attrs.b === 'true'
  if (rPr.attrs.i !== undefined) s.italic = rPr.attrs.i === '1' || rPr.attrs.i === 'true'
  if (rPr.attrs.u !== undefined) s.underline = rPr.attrs.u !== 'none'
  if (rPr.attrs.strike !== undefined) s.strike = rPr.attrs.strike !== 'noStrike'
  const fill = kid(rPr, 'solidFill')
  const color = fill ? resolveColorNode(colorChildOf(fill), ctx) : undefined
  if (color) s.color = color
  // A run names a Latin face and an East-Asian face separately; the CSS
  // font-family list lets the browser resolve each script per glyph.
  const faces = [kid(rPr, 'latin'), kid(rPr, 'ea'), kid(rPr, 'cs')]
    .map((n) => resolvedFontName(n?.attrs.typeface, ctx))
    .filter((f): f is string => !!f)
  if (faces.length > 0) {
    s.font = faces.join(', ')
    if (fonts) for (const f of faces) fonts.add(f)
  }
  return s
}

/** '+mn-lt' style references resolve through the theme; real names pass. */
function resolvedFontName(typeface: string | undefined, ctx: ParseCtx): string | undefined {
  if (!typeface) return undefined
  if (!typeface.startsWith('+')) return typeface
  const major = typeface.startsWith('+mj')
  const ea = typeface.endsWith('-ea')
  const theme = ctx.theme
  return major ? (ea ? theme.majorEa : theme.majorLatin) : ea ? theme.minorEa : theme.minorLatin
}

/** lvl1pPr…lvl9pPr for a 0-based level, under a txStyles/list-style parent. */
function lvlStyleOf(parent: XNode | undefined, level: number, ctx: ParseCtx): TextStyle {
  const pPr = kid(parent, `lvl${Math.min(9, Math.max(1, level + 1))}pPr`)
  if (!pPr) return {}
  return lvlPropsOf(pPr, ctx)
}

/** A paragraph-properties element (lvlNpPr OR a paragraph's own pPr — same
 *  grammar: algn/marL/bullets on the element, defRPr for the characters). */
function lvlPropsOf(pPr: XNode, ctx: ParseCtx): TextStyle {
  const s = styleOfRPr(kid(pPr, 'defRPr'), ctx)
  s.align = alignOf(pPr.attrs.algn)
  if (pPr.attrs.marL !== undefined) s.marLeftPx = emuToPx(numAttr(pPr, 'marL', 0))
  const bullet = bulletOf(pPr, ctx)
  if (bullet === null) s.bullet = 'none'
  else if (bullet) s.bullet = bullet
  return s
}

/** The paragraph's own pPr — its props sit on the element itself. */
function ownParaStyle(pPr: XNode | undefined, ctx: ParseCtx): TextStyle {
  if (!pPr) return {}
  return lvlPropsOf(pPr, ctx)
}

function mergeStyle(...styles: Array<TextStyle | undefined>): TextStyle {
  const out: TextStyle = {}
  for (const s of styles) {
    if (!s) continue
    for (const [k, v] of Object.entries(s)) {
      if (v !== undefined) (out as Record<string, unknown>)[k] = v
    }
  }
  return out
}

/** pptxgenjs writes bullet chars as numeric character references (&#x2022;)
 *  and fast-xml-parser decodes only the named five — left alone, the preview
 *  prints the raw entity as text. Real PowerPoint writes literal glyphs, so
 *  this only ever fires on generated decks. */
function decodeCharRef(s: string): string {
  return s.replace(/&#(?:x([0-9A-Fa-f]+)|(\d+));/g, (_, hex: string | undefined, dec: string | undefined) =>
    String.fromCodePoint(parseInt(hex ?? dec!, hex !== undefined ? 16 : 10)))
}

function bulletOf(pPr: XNode, ctx: ParseCtx): PptxBullet | null | undefined {
  if (kid(pPr, 'buNone')) return null
  const autoNum = kid(pPr, 'buAutoNum')
  if (autoNum) return { kind: 'num', char: autoNum.attrs.type ?? 'arabicPeriod' }
  const buChar = kid(pPr, 'buChar')
  if (buChar) {
    const clr = kid(pPr, 'buClr')
    const color = clr ? resolveColorNode(colorChildOf(clr), ctx) : undefined
    return { kind: 'char', char: decodeCharRef(buChar.attrs.char ?? '•'), color }
  }
  return undefined // nothing said at this level — inherit
}

/** OOXML algn → CSS text-align (the tokens differ: ctr/just vs center/justify). */
function alignOf(algn: string | undefined): PptxParagraph['align'] | undefined {
  if (algn === 'l') return 'left'
  if (algn === 'ctr') return 'center'
  if (algn === 'r') return 'right'
  if (algn === 'just') return 'justify'
  return undefined
}

function lineSpacingOf(pPr: XNode): { lineSpacing?: number; lineSpacingPt?: number } {
  const lnSpc = kid(pPr, 'lnSpc')
  if (!lnSpc) return {}
  const pct = kid(lnSpc, 'spcPct')
  if (pct) return { lineSpacing: numAttr(pct, 'val', 100000) / 100000 }
  const pts = kid(lnSpc, 'spcPts')
  if (pts) return { lineSpacingPt: sizeToPt(numAttr(pts, 'val', 0)) }
  return {}
}

function spcOf(pPr: XNode, tag: 'spcBef' | 'spcAft'): number | undefined {
  const node = kid(pPr, tag)
  const pts = node ? kid(node, 'spcPts') : undefined
  return pts ? sizeToPt(numAttr(pts, 'val', 0)) : undefined
}

/** The master → layout → slide chain for one placeholder's list styles. */
function effectiveLevelStyle(
  own: XNode | undefined,
  layoutLst: XNode | undefined,
  masterStyles: XNode | undefined,
  phType: string | undefined,
  level: number,
  ctx: ParseCtx
): TextStyle {
  const stylesKind =
    phType === 'title' || phType === 'ctrTitle'
      ? 'titleStyle'
      : phType === 'body' || phType === 'subTitle' || phType === 'vertBody'
        ? 'bodyStyle'
        : 'otherStyle'
  return mergeStyle(
    lvlStyleOf(kid(masterStyles, stylesKind), level, ctx),
    lvlStyleOf(layoutLst, level, ctx),
    lvlStyleOf(own, level, ctx)
  )
}

/** Paragraphs of one txBody. Numbering ordinals run across consecutive
 *  buAutoNum paragraphs; an interrupting paragraph restarts the count. */
function parseTextFrame(
  txBody: XNode,
  ctx: ParseCtx,
  chain: {
    own?: XNode | undefined
    layoutLst?: XNode | undefined
    masterStyles?: XNode | undefined
    phType?: string
    /** slide rels, for external hyperlinks (r:id → URL) */
    links?: Map<string, Rel>
  },
  fonts: Set<string>
): PptxTextFrame {
  const bodyPr = kid(txBody, 'bodyPr')
  const autofit = findDescendant(bodyPr, 'normAutofit')
  const fontScaleRaw = numAttr(autofit, 'fontScale', 100000)
  const fontScale = fontScaleRaw !== 100000 ? fontScaleRaw / 100000 : undefined
  const paragraphs: PptxParagraph[] = []
  let numOrdinal = 0
  let prevWasNum = false
  for (const p of kids(txBody, 'p')) {
    const pPr = kid(p, 'pPr')
    const level = Math.min(8, Math.max(0, numAttr(pPr, 'lvl', 0)))
    const inherited = effectiveLevelStyle(
      chain.own,
      chain.layoutLst,
      chain.masterStyles,
      chain.phType,
      level,
      ctx
    )
    const own = ownParaStyle(pPr, ctx)
    const runs: PptxTextRun[] = []
    for (const el of elementsOf(p)) {
      if (el.tag === 'r') {
        const rPr = mergeStyle(inherited, styleOfRPr(kid(pPr, 'defRPr'), ctx, fonts), styleOfRPr(kid(el, 'rPr'), ctx, fonts))
        const run: PptxTextRun = { text: textOf(kid(el, 't')) }
        if (rPr.sizePt !== undefined) run.sizePt = rPr.sizePt
        if (rPr.bold) run.bold = true
        if (rPr.italic) run.italic = true
        if (rPr.underline) run.underline = true
        if (rPr.strike) run.strike = true
        if (rPr.color) run.color = rPr.color
        if (rPr.font) run.font = rPr.font
        const hlink = kid(kid(el, 'rPr'), 'hlinkClick')
        const rel = hlink ? chain.links?.get(relIdOf(hlink)) : undefined
        if (rel?.external) run.link = rel.target
        if (run.text || run.br) runs.push(run)
      } else if (el.tag === 'br') {
        runs.push({ text: '\n', br: true })
      } else if (el.tag === 'fld') {
        const cached = textOf(kid(el, 't'))
        if (cached) runs.push({ text: cached })
      }
    }
    // Bullets: explicit buNone wins; numbering counts while consecutive.
    const decision = own.bullet ?? inherited.bullet
    let bullet: PptxBullet | undefined
    if (decision === 'none') {
      prevWasNum = false
    } else if (decision) {
      if (decision.kind === 'num') {
        const startAt = pPr ? numAttr(kid(pPr, 'buAutoNum'), 'startAt', NaN) : NaN
        numOrdinal = Number.isFinite(startAt) ? startAt : prevWasNum ? numOrdinal + 1 : 1
        bullet = { kind: 'num', char: decision.char, index: numOrdinal }
        prevWasNum = true
      } else {
        bullet = decision
        prevWasNum = false
      }
    } else {
      prevWasNum = false
    }
    const spacing = pPr ? lineSpacingOf(pPr) : {}
    paragraphs.push({
      runs,
      align: own.align ?? inherited.align ?? 'left',
      marLeftPx: own.marLeftPx ?? inherited.marLeftPx ?? (bullet ? emuToPx((level + 1) * 457200) : 0),
      indentPx: pPr && pPr.attrs.indent !== undefined ? emuToPx(numAttr(pPr, 'indent', 0)) : undefined,
      bullet,
      lineSpacing: spacing.lineSpacing,
      lineSpacingPt: spacing.lineSpacingPt,
      spaceBeforePt: pPr ? spcOf(pPr, 'spcBef') : undefined,
      spaceAfterPt: pPr ? spcOf(pPr, 'spcAft') : undefined,
    })
  }
  const insets = {
    left: emuToPx(numAttr(bodyPr, 'lIns', 91440)),
    right: emuToPx(numAttr(bodyPr, 'rIns', 91440)),
    top: emuToPx(numAttr(bodyPr, 'tIns', 45720)),
    bottom: emuToPx(numAttr(bodyPr, 'bIns', 45720)),
  }
  const anchorAttr = bodyPr?.attrs.anchor
  return {
    paragraphs,
    anchor: anchorAttr === 'ctr' ? 'middle' : anchorAttr === 'b' ? 'bottom' : 'top',
    wrap: bodyPr?.attrs.wrap !== 'none',
    fontScale,
    insetsPx: insets,
  }
}

// ── Shape geometry ──

const CLIP_PATHS: Record<string, string> = {
  triangle: 'polygon(50% 0%, 100% 100%, 0% 100%)',
  rtTriangle: 'polygon(0% 0%, 0% 100%, 100% 100%)',
  diamond: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)',
  pentagon: 'polygon(50% 0%, 100% 38%, 82% 100%, 18% 100%, 0% 38%)',
  hexagon: 'polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)',
  heptagon: 'polygon(50% 0%, 90% 20%, 100% 60%, 75% 100%, 25% 100%, 0% 60%, 10% 20%)',
  octagon: 'polygon(30% 0%, 70% 0%, 100% 30%, 100% 70%, 70% 100%, 30% 100%, 0% 70%, 0% 30%)',
  plus: 'polygon(35% 0%, 65% 0%, 65% 35%, 100% 35%, 100% 65%, 65% 65%, 65% 100%, 35% 100%, 35% 65%, 0% 65%, 0% 35%, 35% 35%)',
  rightArrow: 'polygon(0% 25%, 55% 25%, 55% 0%, 100% 50%, 55% 100%, 55% 75%, 0% 75%)',
  leftArrow: 'polygon(100% 25%, 45% 25%, 45% 0%, 0% 50%, 45% 100%, 45% 75%, 100% 75%)',
  upArrow: 'polygon(25% 100%, 25% 45%, 0% 45%, 50% 0%, 100% 45%, 75% 45%, 75% 100%)',
  downArrow: 'polygon(25% 0%, 25% 55%, 0% 55%, 50% 100%, 100% 55%, 75% 55%, 75% 0%)',
  chevron: 'polygon(0% 0%, 70% 0%, 100% 50%, 70% 100%, 0% 100%, 30% 50%)',
  parallelogram: 'polygon(20% 0%, 100% 0%, 80% 100%, 0% 100%)',
  trapezoid: 'polygon(20% 0%, 80% 0%, 100% 100%, 0% 100%)',
}

/** avLst's `gd name="adj" fmla="val N"` — first match; per-shape fallback. */
function adjValue(prstGeom: XNode, name: string, fallback: number): number {
  for (const gd of findDescendants(prstGeom, 'gd')) {
    if (gd.attrs.name === name) {
      const m = /val (-?\d+)/.exec(gd.attrs.fmla ?? '')
      if (m) return Number(m[1])
    }
  }
  return fallback
}

function geometryOf(spPr: XNode | undefined, skipped: PptxSkipped): PptxGeometry {
  const prstGeom = kid(spPr, 'prstGeom')
  const prst = prstGeom?.attrs.prst ?? 'rect'
  if (prst === 'roundRect') {
    const adj = adjValue(prstGeom as XNode, 'adj', 16667) / 100000
    return { prst, radiusRatio: adj }
  }
  if (prst === 'ellipse') return { prst }
  if (prst === 'rect' || prst === 'flowChartProcess' || prst === 'textBox') return { prst: 'rect' }
  if (prst === 'line' || prst === 'straightConnector1') return { prst, isLine: true }
  if (prst === 'pie') {
    // OOXML defaults: 0°→270° (a three-quarter wedge); the chart painter always
    // writes both adj values, so the fallback only guards hand-made files.
    return { prst, startAngleDeg: adjValue(prstGeom as XNode, 'adj1', 0) / 60000, endAngleDeg: adjValue(prstGeom as XNode, 'adj2', 16200000) / 60000 }
  }
  const clip = CLIP_PATHS[prst]
  if (clip) return { prst, clipPath: clip }
  skipped.unknownGeoms++
  return { prst: 'rect' }
}

// ── Fill / line ──

function solidFillOf(parent: XNode | undefined, ctx: ParseCtx): string | undefined {
  const fill = kid(parent, 'solidFill')
  return fill ? resolveColorNode(colorChildOf(fill), ctx) : undefined
}

function fillOf(spPr: XNode | undefined, ctx: ParseCtx): string | undefined {
  if (!spPr) return undefined
  if (kid(spPr, 'noFill')) return undefined
  const grad = kid(spPr, 'gradFill')
  if (grad) {
    const stops = kids(kid(grad, 'gsLst'), 'gs')
    const parts: string[] = []
    for (const gs of stops) {
      const pos = numAttr(gs, 'pos', 0) / 1000
      const color = resolveColorNode(colorChildOf(gs), ctx)
      if (color !== undefined) parts.push(`${color} ${pos}%`)
    }
    if (parts.length >= 2) {
      const lin = kid(grad, 'lin')
      // OOXML angles run clockwise from 3 o'clock; CSS from 12 o'clock.
      const cssDeg = (lin ? angleToDeg(numAttr(lin, 'ang', 0)) : 0) + 90
      return `linear-gradient(${cssDeg}deg, ${parts.join(', ')})`
    }
    if (parts.length === 1) return parts[0].replace(/ \d+(\.\d+)?%$/, '')
    return undefined
  }
  const solid = solidFillOf(spPr, ctx)
  if (solid) return solid
  // blip / patt / grpFill: unsupported → transparent, honestly.
  return undefined
}

function lineOf(spPr: XNode | undefined, ctx: ParseCtx): PptxLineStyle | undefined {
  if (!spPr) return undefined
  const ln = kid(spPr, 'ln')
  if (!ln) return undefined
  if (kid(ln, 'noFill')) return undefined
  const color = solidFillOf(ln, ctx)
  if (!color) return undefined
  const dashPrst = kid(ln, 'prstDash')?.attrs.val
  return {
    color,
    widthPx: Math.max(1, emuToPx(numAttr(ln, 'w', 9525))),
    dash: dashPrst === 'dash' || dashPrst === 'sysDash' ? 'dash' : dashPrst === 'dot' || dashPrst === 'sysDot' ? 'dot' : 'solid',
  }
}

/** p:style fallback: a decorated shape without explicit fill/line takes the
 *  theme reference (the accent1 family) — how "default" shapes look.
 *  fillRef idx="0" means "no fill from the style", which is an answer. */
function styleFillRef(shape: XNode, ctx: ParseCtx): string | undefined {
  const ref = kid(kid(shape, 'style'), 'fillRef')
  if (!ref || ref.attrs.idx === '0') return undefined
  const colorNode = ref.kids.find((k) => k.tag !== '#text')
  return colorNode ? resolveColorNode(colorNode, ctx) : undefined
}

function styleLnRef(shape: XNode, ctx: ParseCtx): PptxLineStyle | undefined {
  const ref = kid(kid(shape, 'style'), 'lnRef')
  if (!ref || ref.attrs.idx === '0') return undefined
  const colorNode = ref.kids.find((k) => k.tag !== '#text')
  if (!colorNode) return undefined
  const resolved = resolveColorNode(colorNode, ctx)
  if (!resolved) return undefined
  return { color: resolved, widthPx: Math.max(1, emuToPx(9525)), dash: 'solid' }
}

// ── Placeholder inheritance ──

function matchingPhInTree(spTree: XNode | undefined, ph: PhRef): XNode | undefined {
  for (const shape of kids(spTree, 'sp')) {
    const candidate = phRefOf(shape)
    if (!candidate) continue
    const idxMatch =
      ph.idx !== undefined && candidate.idx !== undefined && ph.idx === candidate.idx
    const typeMatch = ph.type !== undefined && candidate.type === ph.type
    if ((idxMatch && (ph.type === undefined || candidate.type === undefined || typeMatch)) || typeMatch) {
      return shape
    }
  }
  return undefined
}

/** spPr/a:xfrm for a placeholder: own, else the layout's matching ph, else
 *  the master's — the chain empty placeholders get their geometry from. */
function inheritedXfrm(shape: XNode, ph: PhRef | undefined, src: InheritanceSource): XNode | undefined {
  const own = kid(kid(shape, 'spPr'), 'xfrm')
  if (own || !ph) return own
  const layoutShape = matchingPhInTree(src.layoutSpTree, ph)
  const layoutXfrm = layoutShape ? kid(kid(layoutShape, 'spPr'), 'xfrm') : undefined
  if (layoutXfrm) return layoutXfrm
  const masterShape = matchingPhInTree(src.masterSpTree, ph)
  return masterShape ? kid(kid(masterShape, 'spPr'), 'xfrm') : undefined
}

interface InheritanceSource {
  layoutSpTree: XNode | undefined
  masterSpTree: XNode | undefined
}

function xfrmBox(xfrm: XNode): { x: number; y: number; w: number; h: number } {
  const off = kid(xfrm, 'off')
  const ext = kid(xfrm, 'ext')
  return {
    x: emuToPx(numAttr(off, 'x', 0)),
    y: emuToPx(numAttr(off, 'y', 0)),
    w: emuToPx(numAttr(ext, 'cx', 0)),
    h: emuToPx(numAttr(ext, 'cy', 0)),
  }
}

// ── Media ──

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  svg: 'image/svg+xml',
}

function imageSrcFor(parts: PptxParts, rels: Map<string, Rel>, rid: string): string | 'bad-format' | undefined {
  if (!rid) return undefined
  const rel = rels.get(rid)
  if (!rel || rel.external) return undefined
  const bytes = parts.entryBytes(rel.target)
  if (!bytes) return undefined
  const ext = rel.target.slice(rel.target.lastIndexOf('.') + 1).toLowerCase()
  const mime = IMAGE_MIME[ext]
  if (!mime) return 'bad-format'
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return `data:${mime};base64,${btoa(binary)}`
}

// ── Tables ──

function parseTable(tbl: XNode, ctx: ParseCtx, fonts: Set<string>): PptxTableVM {
  const colWidths = kids(kid(tbl, 'tblGrid'), 'gridCol').map((c) => emuToPx(numAttr(c, 'w', 914400)))
  const rows = kids(tbl, 'tr')
  const cells: Array<Array<PptxTableCellVM | undefined>> = []
  const rowHeights: number[] = []
  rows.forEach((tr, r) => {
    const declared = numAttr(tr, 'h', 0)
    rowHeights[r] = declared > 0 ? emuToPx(declared) : 0
    let cursor = 0
    cells[r] = cells[r] ?? []
    for (const tc of kids(tr, 'tc')) {
      const txBody = kid(tc, 'txBody')
      const cell: PptxTableCellVM = {
        paragraphs: txBody ? parseTextFrame(txBody, ctx, {}, fonts).paragraphs : [],
      }
      const tcPr = kid(tc, 'tcPr')
      const fill = tcPr ? solidFillOf(tcPr, ctx) : undefined
      if (fill) cell.fill = fill
      const gridSpan = numAttr(tc, 'gridSpan', 1)
      if (gridSpan > 1) cell.colSpan = gridSpan
      const rowSpan = numAttr(tc, 'rowSpan', 1)
      if (rowSpan > 1) cell.rowSpan = rowSpan
      if (tc.attrs.hMerge === '1' || tc.attrs.vMerge === '1') cell.hidden = true
      const borders: PptxTableCellVM['borders'] = {}
      for (const side of ['lnL', 'lnR', 'lnT', 'lnB'] as const) {
        const ln = tcPr ? kid(tcPr, side) : undefined
        if (!ln) continue
        const color = solidFillOf(ln, ctx)
        if (color) {
          const css = `${Math.max(1, emuToPx(numAttr(ln, 'w', 9525)))}px solid ${color}`
          if (side === 'lnL') borders.left = css
          if (side === 'lnR') borders.right = css
          if (side === 'lnT') borders.top = css
          if (side === 'lnB') borders.bottom = css
        }
      }
      if (Object.keys(borders).length > 0) cell.borders = borders
      cells[r][cursor] = cell
      cursor += gridSpan
    }
  })
  // Declared h="0" (pptxgenjs emits it) means auto-grow: estimate from the
  // content — max run size drives the line height, insets pad it.
  const insetsV = 2 * emuToPx(45720)
  rowHeights.forEach((h, r) => {
    if (h > 0) return
    let max = 24
    for (const cell of cells[r] ?? []) {
      if (!cell) continue
      let content = 0
      for (const para of cell.paragraphs) {
        const sizePt = para.runs.reduce((m, run) => Math.max(m, run.sizePt ?? 18), 12)
        content += ((sizePt * 96) / 72) * 1.25 + ((para.spaceBeforePt ?? 0) + (para.spaceAfterPt ?? 0)) * (96 / 72)
      }
      max = Math.max(max, content + insetsV)
    }
    rowHeights[r] = max
  })
  const w = colWidths.reduce((a, b) => a + b, 0)
  const h = rowHeights.reduce((a, b) => a + b, 0)
  return { x: 0, y: 0, w, h, colWidthsPx: colWidths, rowHeightsPx: rowHeights, cells }
}

// ── Shared slide-tree facts (masters / layouts / slides are all cSld) ──

function spTreeOf(cSld: XNode | undefined): XNode | undefined {
  return kid(cSld, 'spTree')
}

function bgOf(cSld: XNode | undefined, ctx: ParseCtx): string | undefined {
  const bg = kid(cSld, 'bg')
  if (!bg) return undefined
  const bgPr = kid(bg, 'bgPr')
  if (bgPr) return fillOf(bgPr, ctx)
  const bgRef = kid(bg, 'bgRef')
  if (bgRef) return resolveColorNode(colorChildOf(bgRef), ctx)
  return undefined
}

// ── The spTree walk ──

interface WalkTransform {
  sx: number
  sy: number
  dx: number
  dy: number
}

interface SlideEnv extends InheritanceSource {
  parts: PptxParts
  rels: Map<string, Rel>
  skipped: PptxSkipped
  fonts: Set<string>
  masterStyles: XNode | undefined
  shapeBudget: () => boolean
}

/** Walks one shape tree. `decorationOnly` (master/layout trees) skips
 *  placeholder shapes: empty placeholders are invisible in a slideshow, and
 *  their boxes exist for inheritance, which reads them directly. */
function walkSpTree(
  spTree: XNode,
  ctx: ParseCtx,
  env: SlideEnv,
  into: PptxShapeVM[],
  tf: WalkTransform,
  decorationOnly: boolean
): void {
  for (const el of elementsOf(spTree)) {
    if (el.tag === 'sp' || el.tag === 'cxnSp') {
      if (decorationOnly && phRefOf(el)) continue
      parseShape(el, ctx, env, into, tf)
    } else if (el.tag === 'pic') {
      if (decorationOnly && phRefOf(el)) continue
      parsePic(el, ctx, env, into, tf)
    } else if (el.tag === 'graphicFrame') {
      if (decorationOnly) continue
      parseGraphicFrame(el, ctx, env, into, tf)
    } else if (el.tag === 'grpSp') {
      const xfrm = kid(kid(el, 'grpSpPr'), 'xfrm')
      if (!xfrm) continue
      const kx = numAttr(kid(xfrm, 'chExt'), 'cx', 0) !== 0 ? numAttr(kid(xfrm, 'ext'), 'cx', 0) / numAttr(kid(xfrm, 'chExt'), 'cx', 1) : 1
      const ky = numAttr(kid(xfrm, 'chExt'), 'cy', 0) !== 0 ? numAttr(kid(xfrm, 'ext'), 'cy', 0) / numAttr(kid(xfrm, 'chExt'), 'cy', 1) : 1
      // Compose child→slide with the parent's mapping: x' = sx·(k·u + b) + dx.
      const next: WalkTransform = {
        sx: tf.sx * kx,
        sy: tf.sy * ky,
        dx: tf.dx + tf.sx * (numAttr(kid(xfrm, 'off'), 'x', 0) - numAttr(kid(xfrm, 'chOff'), 'x', 0) * kx),
        dy: tf.dy + tf.sy * (numAttr(kid(xfrm, 'off'), 'y', 0) - numAttr(kid(xfrm, 'chOff'), 'y', 0) * ky),
      }
      walkSpTree(el, ctx, env, into, next, decorationOnly)
    }
    // nvGrpSpPr / grpSpPr / anything else: not shapes.
  }
}

function parseShape(
  shape: XNode,
  ctx: ParseCtx,
  env: SlideEnv,
  into: PptxShapeVM[],
  tf: WalkTransform
): void {
  if (!env.shapeBudget()) return
  const spPr = kid(shape, 'spPr')
  const ph = phRefOf(shape)
  const xfrm = inheritedXfrm(shape, ph, env)
  // A non-placeholder without a frame is invisible — nothing to inherit.
  if (!xfrm) return
  const box = xfrmBox(xfrm)
  const txBody = kid(shape, 'txBody')
  const geometry = geometryOf(spPr, env.skipped)
  let fill = fillOf(spPr, ctx)
  let line = lineOf(spPr, ctx)
  // Placeholder fill/line inherit from the matched master/layout ph shape.
  if (fill === undefined && ph) {
    const layoutPh = matchingPhInTree(env.layoutSpTree, ph)
    const masterPh = matchingPhInTree(env.masterSpTree, ph)
    fill = fillOf(kid(layoutPh, 'spPr'), ctx) ?? fillOf(kid(masterPh, 'spPr'), ctx)
  }
  if (fill === undefined && !txBody) fill = styleFillRef(shape, ctx)
  if (line === undefined && !txBody) line = styleLnRef(shape, ctx)
  const vm: PptxShapeVM = {
    kind: 'shape',
    x: box.x * tf.sx + tf.dx,
    y: box.y * tf.sy + tf.dy,
    w: box.w * tf.sx,
    h: box.h * tf.sy,
  }
  if (xfrm.attrs.rot !== undefined) vm.rotationDeg = angleToDeg(numAttr(xfrm, 'rot', 0))
  if (xfrm.attrs.flipH === '1') vm.flipH = true
  if (xfrm.attrs.flipV === '1') vm.flipV = true
  if (fill !== undefined) vm.fill = fill
  if (line !== undefined) vm.line = line
  if (geometry.prst !== 'rect' || geometry.isLine) vm.geometry = geometry
  if (txBody) {
    const lstStyle = kid(txBody, 'lstStyle')
    const layoutShape = ph ? matchingPhInTree(env.layoutSpTree, ph) : undefined
    vm.text = parseTextFrame(
      txBody,
      ctx,
      {
        own: lstStyle,
        layoutLst: layoutShape ? kid(kid(layoutShape, 'txBody'), 'lstStyle') : undefined,
        masterStyles: env.masterStyles,
        phType: ph?.type,
        links: env.rels,
      },
      env.fonts
    )
  }
  into.push(vm)
}

function parsePic(pic: XNode, ctx: ParseCtx, env: SlideEnv, into: PptxShapeVM[], tf: WalkTransform): void {
  if (!env.shapeBudget()) return
  const xfrm = kid(kid(pic, 'spPr'), 'xfrm')
  if (!xfrm) return
  const box = xfrmBox(xfrm)
  const place = (minW: number, minH: number) => ({
    x: box.x * tf.sx + tf.dx,
    y: box.y * tf.sy + tf.dy,
    w: Math.max(box.w * tf.sx, minW),
    h: Math.max(box.h * tf.sy, minH),
  })
  // Media frames sit on p:pic with a videoFile/audioFile reference.
  const nvPr = findDescendant(kid(pic, 'nvPicPr'), 'nvPr')
  if (nvPr && (kid(nvPr, 'videoFile') || kid(nvPr, 'audioFile'))) {
    into.push({ kind: 'placeholder', ...place(24, 24), phLabel: 'media' })
    env.skipped.media++
    return
  }
  const blipFill = kid(pic, 'blipFill')
  const blip = kid(blipFill, 'blip')
  const src = imageSrcFor(env.parts, env.rels, blip ? attrLocal(blip, 'embed') || attrLocal(blip, 'link') : '')
  if (src === undefined || src === 'bad-format') {
    env.skipped.badImages++
    into.push({ kind: 'placeholder', ...place(24, 24), phLabel: 'image' })
    return
  }
  const vm: PptxShapeVM = {
    kind: 'image',
    ...place(1, 1),
    src,
    alt: findDescendant(kid(pic, 'nvPicPr'), 'cNvPr')?.attrs.descr,
  }
  const srcRect = kid(blipFill, 'srcRect')
  if (srcRect) {
    vm.srcRect = {
      l: numAttr(srcRect, 'l', 0) / 100000,
      t: numAttr(srcRect, 't', 0) / 100000,
      r: numAttr(srcRect, 'r', 0) / 100000,
      b: numAttr(srcRect, 'b', 0) / 100000,
    }
  }
  const geometry = geometryOf(kid(pic, 'spPr'), env.skipped)
  if (geometry.prst !== 'rect') vm.geometry = geometry
  into.push(vm)
}

function parseGraphicFrame(frame: XNode, ctx: ParseCtx, env: SlideEnv, into: PptxShapeVM[], tf: WalkTransform): void {
  if (!env.shapeBudget()) return
  const xfrm = kid(frame, 'xfrm')
  if (!xfrm) return
  const box = xfrmBox(xfrm)
  const place = (minW: number, minH: number) => ({
    x: box.x * tf.sx + tf.dx,
    y: box.y * tf.sy + tf.dy,
    w: Math.max(box.w * tf.sx, minW),
    h: Math.max(box.h * tf.sy, minH),
  })
  const graphicData = kid(kid(frame, 'graphic'), 'graphicData')
  const uri = graphicData?.attrs.uri ?? ''
  if (uri.endsWith('/table')) {
    const tbl = findDescendant(frame, 'tbl')
    if (!tbl) return
    const table = parseTable(tbl, ctx, env.fonts)
    into.push({ kind: 'table', ...place(1, 1), table })
    return
  }
  const label: PptxShapeVM['phLabel'] | undefined = uri.endsWith('/chart')
    ? 'chart'
    : uri.endsWith('/diagram')
      ? 'smartArt'
      : uri.endsWith('/ole')
        ? 'ole'
        : undefined
  if (label) {
    into.push({ kind: 'placeholder', ...place(40, 40), phLabel: label })
    if (label === 'chart') env.skipped.charts++
    else if (label === 'smartArt') env.skipped.smartArt++
    else env.skipped.ole++
  }
}

// ── Deck assembly ──

const DEFAULT_CLR_MAP: Record<string, string> = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' }

/** A deck with no parseable theme at all still gets an (empty) palette. */
const FALLBACK_THEME: Theme = { colors: new Map<string, string>() }

interface MasterInfo {
  root: XNode | undefined
  clrMap: Map<string, string>
  theme: Theme
  txStyles: XNode | undefined
  /** layout part names this master owns */
  layoutNames: Set<string>
  /** the master's OWN rels — its pictures resolve here, not in the slide's */
  rels: Map<string, Rel>
}

function parseMaster(parts: PptxParts, masterName: string): MasterInfo {
  const root = parseXml(parts.entryText(masterName))[0]
  const rels = relsOf(parts, masterName)
  const themeRel = relOfType(rels, '/theme')
  const layoutNames = new Set<string>()
  for (const rel of rels.values()) {
    if (rel.type.endsWith('/slideLayout')) layoutNames.add(rel.target)
  }
  return {
    root,
    clrMap: new Map(Object.entries({ ...DEFAULT_CLR_MAP, ...kid(root, 'clrMap')?.attrs })),
    theme: parseTheme(parseXml(parts.entryText(themeRel?.target ?? ''))[0]),
    txStyles: kid(root, 'txStyles'),
    layoutNames,
    rels,
  }
}

/** Entry: parts → deck. Returns null when the file is not a pptx we can even
 *  locate slides in — the component shows the fallback card. */
export function parsePptxDeck(parts: PptxParts): PptxDeck | null {
  const presRoot = parseXml(parts.entryText('ppt/presentation.xml'))[0]
  if (!presRoot || presRoot.tag !== 'presentation') return null
  const skipped: PptxSkipped = {
    charts: 0,
    smartArt: 0,
    media: 0,
    ole: 0,
    badImages: 0,
    unknownGeoms: 0,
    corruptSlides: 0,
    hiddenSlides: 0,
  }
  const sldSz = kid(presRoot, 'sldSz')
  const widthPx = emuToPx(numAttr(sldSz, 'cx', 9144000))
  const heightPx = emuToPx(numAttr(sldSz, 'cy', 6858000))
  const fonts = new Set<string>()

  // Slide order: sldIdLst → the presentation's rels. Decks whose r:id lost
  // its prefix along the way still resolve — attrLocal reads either form.
  const presRels = relsOf(parts, 'ppt/presentation.xml')
  const slideNames: string[] = []
  for (const sldId of kids(kid(presRoot, 'sldIdLst'), 'sldId')) {
    const rel = presRels.get(relIdOf(sldId))
    if (rel && !rel.external) slideNames.push(rel.target)
  }
  if (slideNames.length === 0) {
    slideNames.push(
      ...parts
        .names()
        .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
        .sort((a, b) => Number(/(\d+)/.exec(a)?.[1] ?? 0) - Number(/(\d+)/.exec(b)?.[1] ?? 0))
    )
  }

  const mastersByLayout = new Map<string, MasterInfo>()
  for (const masterId of kids(kid(presRoot, 'sldMasterIdLst'), 'sldMasterId')) {
    const rel = presRels.get(relIdOf(masterId))
    if (!rel || rel.external) continue
    const master = parseMaster(parts, rel.target)
    for (const layoutName of master.layoutNames) mastersByLayout.set(layoutName, master)
  }
  const anyMaster = (): MasterInfo | undefined => mastersByLayout.values().next().value

  const slides: PptxSlideVM[] = []
  const totalSlides = slideNames.length
  for (const name of slideNames.slice(0, PPTX_PREVIEW_SLIDE_LIMIT)) {
    const root = parseXml(parts.entryText(name))[0]
    if (!root || root.tag !== 'sld') {
      skipped.corruptSlides++
      continue
    }
    if (root.attrs.show === '0') {
      skipped.hiddenSlides++
      continue
    }
    const slideRels = relsOf(parts, name)
    const layoutName = relOfType(slideRels, '/slideLayout')?.target
    const layoutRoot = layoutName ? parseXml(parts.entryText(layoutName))[0] : undefined
    const master = layoutName ? mastersByLayout.get(layoutName) : undefined
    // Each decorated tree resolves ITS images through its own part's rels —
    // a master's r:embed names slideMaster1.xml.rels, and looking it up in
    // the slide's rels either misses or collides with a different rId.
    const layoutRels = layoutName ? relsOf(parts, layoutName) : undefined
    // Theme preference: the slide's own master's; any master's as a fallback
    // (a deck with dangling rels still deserves colours).
    const theme = master?.theme ?? anyMaster()?.theme ?? FALLBACK_THEME
    for (const f of [theme.majorLatin, theme.majorEa, theme.minorLatin, theme.minorEa]) {
      if (f) fonts.add(f)
    }
    const clrMap = master?.clrMap ?? new Map(Object.entries(DEFAULT_CLR_MAP))
    const ctx: ParseCtx = { theme, clrMap }
    const cSld = kid(root, 'cSld')
    const layoutCSld = kid(layoutRoot, 'cSld')
    const masterCSld = kid(master?.root, 'cSld')
    const background =
      bgOf(cSld, ctx) ?? bgOf(layoutCSld, ctx) ?? bgOf(masterCSld, ctx) ?? '#FFFFFF'
    const shapes: PptxShapeVM[] = []
    let totalShapes = 0
    const env: SlideEnv = {
      parts,
      rels: slideRels,
      skipped,
      fonts,
      masterStyles: master?.txStyles,
      layoutSpTree: spTreeOf(layoutCSld),
      masterSpTree: spTreeOf(masterCSld),
      shapeBudget: () => {
        totalShapes++
        return shapes.length < PPTX_PREVIEW_SHAPE_LIMIT
      },
    }
    const spTree = spTreeOf(cSld)
    if (spTree) {
      // Master decoration first (slideshow stacking), unless the layout opts
      // out with showMasterSp="0"; then the layout's own decoration; the
      // slide's shapes last, on top. Each tree keeps its OWN rels — only the
      // budget and inheritance facts are shared.
      if (layoutRoot?.attrs.showMasterSp !== '0' && master) {
        const masterTree = spTreeOf(masterCSld)
        if (masterTree) walkSpTree(masterTree, ctx, { ...env, rels: master.rels }, shapes, { sx: 1, sy: 1, dx: 0, dy: 0 }, true)
      }
      const layoutTree = spTreeOf(layoutCSld)
      if (layoutTree) walkSpTree(layoutTree, ctx, { ...env, rels: layoutRels ?? slideRels }, shapes, { sx: 1, sy: 1, dx: 0, dy: 0 }, true)
      walkSpTree(spTree, ctx, env, shapes, { sx: 1, sy: 1, dx: 0, dy: 0 }, false)
    }
    slides.push({
      index: slides.length + 1,
      name: cSld?.attrs.name,
      background,
      shapes,
      totalShapes,
      truncatedShapes: totalShapes > shapes.length,
    })
  }

  // The theme's minor face is the deck's default (a run that names nothing);
  // masters overwhelmingly share one theme, so the first master's wins.
  const defaultFont = anyMaster()?.theme?.minorLatin
  return {
    widthPx,
    heightPx,
    slides,
    totalSlides,
    truncatedSlides: totalSlides > slides.length,
    skipped,
    shapeLimit: PPTX_PREVIEW_SHAPE_LIMIT,
    fonts: [...fonts],
    defaultFont,
  }
}
