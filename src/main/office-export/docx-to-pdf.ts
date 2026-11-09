// ── docx → PDF conversion (PLAN-office-export: pdf target) ──
// A hidden, sandboxed BrowserWindow loads the docx2pdf renderer page (built by
// scripts/build.js alongside main/preload), which renders the document with
// docx-preview — the SAME engine the in-app DocxPreview uses, so what the PDF
// paginates like is what the preview showed — and then webContents.printToPDF
// emits it with @page sized from the document's own first page.
//
// Why not the docx package's PDF path: it goes through jsPDF, whose CJK support
// requires embedding a full CJK font (~20MB) and is officially unsupported —
// every 中文 contract would come out as blanks.
//
// The handshake is deliberately IPC-free (see docx2pdf/index.ts): bytes go IN
// via an executeJavaScript injection, state comes BACK via a polled
// window global. One window per conversion — the export path lock guards
// per-target concurrency, but two different targets could otherwise share a
// window; a fresh window is ~100ms and cannot interleave.

import { BrowserWindow, app } from 'electron'
import { join } from 'node:path'

/** md-to-docx caps inline content at 100KB, but sourcePath docx conversion has
 *  no such cap — real contracts reach several MB; 60s covers those on cold
 *  start (first window also pays Chromium font-cache warmup). */
const CONVERT_TIMEOUT_MS = 60_000
const POLL_INTERVAL_MS = 150

/** A failure message that names the converter, not Chromium internals — it
 *  becomes the office_export tool's error verbatim. */
export class DocxToPdfError extends Error {}

export interface DocxToPdfOptions {
  /** Fallback PDF Title for a document with no headings of its own (the
   *  conversion page prefers the first heading); main passes the export
   *  filename's stem. */
  title?: string
}

export async function docxToPdfBuffer(docx: Buffer, options: DocxToPdfOptions = {}): Promise<Buffer> {
  const htmlPath =
    process.env.PM_DOCX2PDF_HTML ?? join(app.getAppPath(), 'out', 'docx2pdf', 'index.html')

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // No preload by design: the page needs no bridge — bytes in over
      // executeJavaScript, state out over a window global (docx2pdf/index.ts).
      preload: undefined,
    },
  })

  try {
    await win.loadFile(htmlPath)

    // Two injections, not one: the source arrives only after did-finish-load,
    // and the title hint is a separate global the page reads at the end (it
    // may be absent — then the page keeps the document's own heading).
    await win.webContents.executeJavaScript(
      `window.__pmDocxSource = ${JSON.stringify(docx.toString('base64'))}; undefined`
    )
    if (options.title && options.title.trim()) {
      await win.webContents.executeJavaScript(
        `window.__pmDocxTitle = ${JSON.stringify(options.title.trim())}; undefined`
      )
    }

    const deadline = Date.now() + CONVERT_TIMEOUT_MS
    for (;;) {
      if (win.isDestroyed()) throw new DocxToPdfError('转换窗口提前关闭')
      const raw = await win.webContents.executeJavaScript(
        'JSON.stringify(window.__pmDocx2Pdf ?? null)'
      )
      const handshake: { state?: string; error?: string } | null = raw ? JSON.parse(raw) : null
      if (handshake?.state === 'error') {
        throw new DocxToPdfError(handshake.error || 'docx 渲染失败')
      }
      if (handshake?.state === 'ready') break
      if (Date.now() > deadline) {
        throw new DocxToPdfError('docx 渲染超时（60s）——文档可能过大或结构异常')
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    }

    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      // The page carries `@page { size: Wpt Hpt; margin: 0 }` measured from the
      // document's own first page — margins belong to the docx layout.
      preferCSSPageSize: true,
      // Chromium derives both from real <h1..h6> elements (the page promotes
      // docx-preview's heading paragraphs before printing): the outline is what
      // makes the resulting PDF navigable in Preview/Acrobat, the tagging what
      // makes it readable by screen readers and text extractors.
      generateDocumentOutline: true,
      generateTaggedPDF: true,
    })
    return Buffer.from(pdf)
  } finally {
    // destroy(), not close(): no 'close' event choreography is needed for a
    // window nobody else holds a reference to.
    if (!win.isDestroyed()) win.destroy()
  }
}
