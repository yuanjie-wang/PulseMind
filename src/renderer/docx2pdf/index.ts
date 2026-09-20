// ── docx→PDF conversion page (PLAN-office-export: pdf target) ──
// A plain-DOM page (no React — docx-preview's renderAsync is the whole UI)
// loaded by the hidden conversion window in src/main/office-export/docx-to-pdf.ts.
//
// Handshake contract with the main process (no IPC, no nodeIntegration — the
// window is sandboxed):
//   main  →  window.__pmDocxSource   base64 docx bytes, injected after load
//   page  →  window.__pmDocx2Pdf     { state: 'ready' } | { state: 'error', error }
// The main process polls the second value with executeJavaScript and prints
// only after `ready`; `error` carries a human-readable reason that becomes the
// export tool's failure message. Any path that fails MUST report state — a
// silent page would burn the main-side timeout for nothing.

import { renderAsync } from 'docx-preview'

interface Handshake {
  state: 'ready' | 'error'
  error?: string
}

declare global {
  interface Window {
    __pmDocxSource?: string
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
  const page = root.querySelector<HTMLElement>('section.docx')
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

async function run(): Promise<void> {
  const source = await waitForSource()
  const bin = atob(source)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)

  const root = document.getElementById('root')
  if (!root) throw new Error('转换页缺少 #root 容器')
  await renderAsync(bytes, root, undefined, {
    inWrapper: true,
    breakPages: true,
    // Word documents carry real page boundaries as w:lastRenderedPageBreak —
    // the same choice the in-app DocxPreview makes. Generated docx (our own
    // md-to-docx) paginates by content height instead.
    ignoreLastRenderedPageBreak: false,
    experimental: true,
    useBase64URL: true,
  })
  // Fonts decide glyph metrics; images (data: URLs here) decide page heights
  // — both must settle before the @page size is measured.
  await document.fonts?.ready
  await waitForImages(root)

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
