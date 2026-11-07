// ── docx→PDF conversion page (PLAN-office-export: pdf target) ──
// A plain-DOM page (no React — docx-preview's renderAsync is the whole UI)
// loaded by the hidden conversion window in src/main/office-export/docx-to-pdf.ts.
//
// Handshake contract with the main process (no IPC, no nodeIntegration — the
// window is sandboxed):
//   main  →  window.__pmDocxSource   base64 docx bytes, injected after load
//            window.__pmDocxTitle    optional title hint (export filename)
//   page  →  window.__pmDocx2Pdf     { state: 'ready' } | { state: 'error', error }
// The main process polls the second value with executeJavaScript and prints
// only after `ready`; `error` carries a human-readable reason that becomes the
// export tool's failure message. Any path that fails MUST report state — a
// silent page would burn the main-side timeout for nothing.
//
// The page runs the SAME two post-render passes the in-app DocxPreview runs
// (font aliases + measurement-based pagination), then two of its own that only
// matter for print — heading semantics for the PDF outline, and page numbers.
// Skipping the shared passes is what made exported PDFs ugly: docx-preview
// renders a generated docx as one continuous sheet, and printToPDF's own
// paginator then slices it at arbitrary offsets, ignoring the docx margins.

import { renderAsync } from 'docx-preview'
import { docxFontCss } from '../src/components/preview/docx-fonts'
import { docxQuoteCss } from '../src/components/preview/docx-quote-css'
import { paginateDocxPages } from '../src/components/preview/docx-paginate'

/** Must match the className handed to renderAsync — both passes select on it. */
const DOCX_CLASS = 'docx'

interface Handshake {
  state: 'ready' | 'error'
  error?: string
}

declare global {
  interface Window {
    __pmDocxSource?: string
    __pmDocxTitle?: string
    __pmDocx2Pdf?: Handshake
  }
}

function report(state: Handshake['state'], error?: string): void {
  window.__pmDocx2Pdf = error ? { state, error } : { state }
}

/** CSS px → print points (1pt = 1/72in, 1px = 1/96in). */
function toPt(value: string, fallbackUnitPx = false): number {
  const n = parseFloat(value)
  if (!Number.isFinite(n)) return NaN
  return fallbackUnitPx && value.trim().endsWith('px') ? n * 0.75 : n
}

/** The @page rule must name the FIRST page's dimensions: printToPDF's
 *  preferCSSPageSize takes one page size for the whole job, and a mixed
 *  orientation document is out of scope for this converter anyway.
 *  docx-preview writes the page box as inline `width` + `min-height`
 *  (createPageElement), already in pt — NOT style.height. */
function firstPageSizePt(root: HTMLElement): { w: number; h: number } | null {
  const page = root.querySelector<HTMLElement>(`section.${DOCX_CLASS}`)
  if (!page) return null
  const w = toPt(page.style.width)
  const h = toPt(page.style.minHeight)
  if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(h) || h <= 0) return null
  return { w, h }
}

async function waitForImages(root: HTMLElement): Promise<void> {
  const imgs = Array.from(root.querySelectorAll('img'))
  await Promise.all(imgs.map((img) => (img.decode ? img.decode().catch(() => undefined) : Promise.resolve())))
}

/** The main process injects __pmDocxSource only AFTER did-finish-load — this
 *  script has already evaluated by then, so the source must be waited for. */
async function waitForSource(timeoutMs = 15000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (!window.__pmDocxSource) {
    if (Date.now() > deadline) throw new Error('docx 源数据未注入（主进程握手超时）')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return window.__pmDocxSource
}

/** docx-preview renders headings as `p.docx_headingN`. Chromium builds a PDF's
 *  outline (and tagged-PDF structure) only from real `h1..h6` elements, so the
 *  paragraphs are promoted here — attributes and children move over verbatim.
 *  The generated sheet writes its rules as `p.docx_headingN span`, so the tag
 *  in those selectors is rewritten to a class selector or the promoted
 *  headings would lose their font size and weight. */
function promoteHeadings(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>(`p[class*="docx_heading"]`).forEach((paragraph) => {
    const level = /docx_heading([1-6])/.exec(paragraph.className)?.[1]
    if (!level) return
    const heading = document.createElement(`h${level}`)
    for (const attr of Array.from(paragraph.attributes)) heading.setAttribute(attr.name, attr.value)
    while (paragraph.firstChild) heading.appendChild(paragraph.firstChild)
    paragraph.replaceWith(heading)
  })
  document.querySelectorAll('style').forEach((sheet) => {
    const css = sheet.textContent
    if (css && css.includes('p.docx_heading')) {
      sheet.textContent = css.replace(/p\.docx_heading/g, '.docx_heading')
    }
  })
  // A `<p>` has no UA margin, an `<h1>` does (0.67em) — without this reset a
  // heading whose docx declares no spacing would GROW after promotion, and the
  // pagination measured right after would then describe a layout that no
  // longer exists. The type selector keeps docx-preview's class rules in
  // charge (class beats type), so a heading that does declare spacing keeps it.
  const reset = document.createElement('style')
  reset.textContent = 'h1, h2, h3, h4, h5, h6 { margin: 0; }'
  document.head.appendChild(reset)
}

/** A folio on every page, unless the document brings its own footer (a
 *  contract with 第 X 页 共 Y 页 must not get a second number below it).
 *  Absolutely positioned inside the page's bottom margin, so it never
 *  competes with the content box the splitter measured. */
function addPageNumbers(root: HTMLElement): void {
  const pages = Array.from(root.querySelectorAll<HTMLElement>(`section.${DOCX_CLASS}`))
  pages.forEach((section, index) => {
    if (section.querySelector('footer')) return
    if (getComputedStyle(section).position === 'static') section.style.position = 'relative'
    const folio = document.createElement('div')
    folio.className = 'pm-pdf-folio'
    folio.textContent = `${index + 1} / ${pages.length}`
    folio.setAttribute(
      'style',
      'position:absolute;left:0;right:0;bottom:36px;text-align:center;' + 'font-family:Calibri,"PingFang SC",sans-serif;font-size:10pt;color:#8A9099;',
    )
    section.appendChild(folio)
  })
}

/** PDF metadata Title comes from document.title — the page's own is the
 *  converter's name ("docx→pdf"), which every exported file would carry. The
 *  document's first heading is the honest answer; the filename is the fallback
 *  for a document with no headings at all. */
function applyDocumentTitle(root: HTMLElement): void {
  const heading = root.querySelector('h1, h2, p[class*="docx_title"]')?.textContent?.trim()
  const title = heading || window.__pmDocxTitle?.trim()
  if (title) document.title = title
}

async function run(): Promise<void> {
  const source = await waitForSource()
  const bin = atob(source)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)

  const root = document.getElementById('root')
  if (!root) throw new Error('转换页缺少 #root 容器')

  // Font aliases go in BEFORE docx-preview's own <style>, so a document that
  // embeds its font still wins; they must also be in place before rendering —
  // metrics decide the page breaks.
  const fontStyle = document.createElement('style')
  fontStyle.id = 'pm-docx-fonts'
  fontStyle.textContent = docxFontCss(DOCX_CLASS)
  document.head.appendChild(fontStyle)

  // 引用块的横向内边距：docx-preview 丢掉 w:pBdr/@w:space，Word 有的内边距
  // 在预览/PDF 里得由 CSS 补上。同样必须在测量之前就位。
  const quoteStyle = document.createElement('style')
  quoteStyle.id = 'pm-docx-quote'
  quoteStyle.textContent = docxQuoteCss(DOCX_CLASS)
  document.head.appendChild(quoteStyle)

  await renderAsync(bytes, root, undefined, {
    inWrapper: true,
    breakPages: true,
    className: DOCX_CLASS,
    // Word documents carry real page boundaries as w:lastRenderedPageBreak —
    // the same choice the in-app DocxPreview makes. Generated docx (our own
    // md-to-docx) paginates by content height instead.
    ignoreLastRenderedPageBreak: false,
    experimental: true,
    useBase64URL: true,
  })
  // Fonts decide glyph metrics; images (data: URLs here) decide page heights
  // — both must settle before anything is measured.
  await document.fonts?.ready
  await waitForImages(root)

  promoteHeadings(root)
  paginateDocxPages(root, DOCX_CLASS)
  addPageNumbers(root)
  applyDocumentTitle(root)

  const size = firstPageSizePt(root)
  if (!size) throw new Error('docx 渲染完成但没有可打印的页面（文档可能为空或不受支持）')
  const style = document.createElement('style')
  style.id = 'pm-page-size'
  style.textContent = `@page { size: ${size.w}pt ${size.h}pt; margin: 0; }`
  document.head.appendChild(style)
}

run()
  .then(() => report('ready'))
  .catch((err: unknown) => {
    report('error', err instanceof Error ? err.message : String(err))
  })
