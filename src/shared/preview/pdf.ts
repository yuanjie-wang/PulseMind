// ── PDF preview pure model (PLAN-pdf-preview) ── the dep-free half of the
// PDF renderer, as preview/xlsx.ts is for the grid: the cumulative page
// layout, the lazy-render window, the fit arithmetic and the honest gates
// (page cap / byte cap / password classification). No pdfjs-dist import —
// vitest covers this file without the 1.5MB dependency.

/** Pages beyond this get no placeholder at all, and an amber note names the
 *  total (the xlsx truncation bar's posture). Lazy rendering already bounds
 *  canvas memory — the cap bounds the DOM and the scrollbar arithmetic. */
export const PDF_PREVIEW_MAX_PAGES = 300

/** Files above this never decode: readFileBinary hands the whole file over
 *  base64-encoded (~1.33x) and the decoded bytes plus pdf.js's parsed model
 *  land on top of that. 64MB covers effectively every real document; the
 *  honest gate is a card, not a hang. */
export const PDF_MAX_BYTES = 64 * 1024 * 1024

/** Rendered pages leading/trailing the visible band — a scroll must never
 *  expose a page whose canvas has not started drawing. */
export const PDF_RENDER_BUFFER_PAGES = 2

/** Vertical gap between page cards, in px. */
export const PDF_PAGE_GAP = 16

/** Approximate decoded size of a base64 payload (3 bytes per 4 chars) — the
 *  size gate fires on the string, before atob materialises the bytes. */
export function base64Bytes(base64: string): number {
  return Math.floor((base64.length * 3) / 4)
}

export interface PdfPageSize {
  width: number
  height: number
}

/** One page's on-screen box at the current zoom plus its cumulative top
 *  offset (gaps included), in px; `top[0]` is 0. */
export interface PdfPageLayout {
  width: number
  height: number
  top: number
}

/** Lay the pages out at `zoom` — viewport px at scale 1 × zoom, rounded per
 *  page so consecutive pages abut without seams. */
export function pdfLayout(pages: PdfPageSize[], zoom: number, gap: number = PDF_PAGE_GAP): PdfPageLayout[] {
  const out: PdfPageLayout[] = []
  let top = 0
  for (const page of pages) {
    const width = Math.max(1, Math.round(page.width * zoom))
    const height = Math.max(1, Math.round(page.height * zoom))
    out.push({ width, height, top })
    top += height + gap
  }
  return out
}

/** The scale that fits the widest page into the container — shrink-to-fit,
 *  never blown past 100%. Widths are pdf.js viewport px at scale 1 (1pt = 1px
 *  there, so no unit conversion exists anywhere in this module). A degenerate
 *  measurement (no pages, zero container) keeps 1 rather than collapsing the
 *  document. */
export function pdfFitScale(containerWidth: number, pageWidths: number[], minZoom: number): number {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return 1
  const widest = pageWidths.reduce((a, b) => Math.max(a, b), 0)
  if (!Number.isFinite(widest) || widest <= 0) return 1
  return Math.min(1, Math.max(minZoom, containerWidth / widest))
}

export interface PdfPageWindow {
  first: number
  /** Inclusive; `first > last` means nothing should be rendered. */
  last: number
}

/** Which pages should hold canvases right now: those intersecting the
 *  [scrollTop, scrollTop + viewportHeight] band of the layout, widened by
 *  `buffer` pages on each side. */
export function pdfPageWindow(
  layout: PdfPageLayout[],
  scrollTop: number,
  viewportHeight: number,
  buffer: number,
): PdfPageWindow {
  const n = layout.length
  if (n === 0) return { first: 0, last: -1 }
  const bottom = scrollTop + Math.max(0, viewportHeight)
  let first = 0
  while (first < n && layout[first].top + layout[first].height <= scrollTop) first++
  if (first >= n) return { first: n, last: -1 }
  let last = first
  while (last < n && layout[last].top < bottom) last++
  last--
  return { first: Math.max(0, first - buffer), last: Math.min(n - 1, last + buffer) }
}

/** The 0-based page occupying the viewport's vertical centre — the one the
 *  reader is "on". Past the last page (footer gap) clamps to it. */
export function currentPageIndex(layout: PdfPageLayout[], scrollTop: number, viewportHeight: number): number {
  const centre = scrollTop + viewportHeight / 2
  for (let i = 0; i < layout.length; i++) {
    if (centre < layout[i].top + layout[i].height) return i
  }
  return Math.max(0, layout.length - 1)
}

/** pdf.js rejects a password-required document with PasswordException; class
 *  identity can differ across bundle instances, so match the name. */
export function isPdfPasswordError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'PasswordException'
}
