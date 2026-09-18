// ── PDF preview pure model (PLAN-pdf-preview) ── covers the shared half in
// src/shared/preview/pdf.ts: the cumulative layout, the lazy-render window,
// fit arithmetic, and the honest gates (page cap, byte cap, password
// classification) — plus the PreviewContent wiring that routes .pdf to the
// renderer (source scan; vitest here is node-env, no DOM, and the 1.5MB
// pdfjs-dist dependency must stay out of this file's import graph).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  base64Bytes,
  currentPageIndex,
  isPdfPasswordError,
  pdfFitScale,
  pdfLayout,
  pdfPageWindow,
  PDF_MAX_BYTES,
  PDF_PAGE_GAP,
  PDF_PREVIEW_MAX_PAGES,
  PDF_RENDER_BUFFER_PAGES,
  type PdfPageLayout,
} from '../src/shared/preview/pdf'

const A4 = { width: 595, height: 842 }
const LANDSCAPE = { width: 1400, height: 800 }

describe('gates', () => {
  it('the page cap bounds the DOM, the byte cap bounds the bridge', () => {
    expect(PDF_PREVIEW_MAX_PAGES).toBeGreaterThanOrEqual(1)
    expect(PDF_MAX_BYTES).toBe(64 * 1024 * 1024)
  })

  it('base64Bytes approximates the decoded size (4 chars → 3 bytes)', () => {
    expect(base64Bytes('')).toBe(0)
    expect(base64Bytes('AAAA')).toBe(3) // 4 chars decode to 3 bytes
    expect(base64Bytes('AAAAQQ==')).toBe(6) // trailing = padding still counts
  })

  it('isPdfPasswordError matches pdf.js PasswordException by name', () => {
    const real = Object.assign(new Error('No password given'), { name: 'PasswordException' })
    expect(isPdfPasswordError(real)).toBe(true)
    expect(isPdfPasswordError({ name: 'PasswordException' })).toBe(true)
    expect(isPdfPasswordError(new Error('Invalid PDF structure'))).toBe(false)
    expect(isPdfPasswordError('boom')).toBe(false)
    expect(isPdfPasswordError(null)).toBe(false)
    expect(isPdfPasswordError(undefined)).toBe(false)
  })
})

describe('pdfLayout', () => {
  it('rounds each page and accumulates tops with the gap between them', () => {
    const layout = pdfLayout([A4, { width: 100.4, height: 200.6 }, A4], 1)
    expect(layout[0]).toEqual({ width: 595, height: 842, top: 0 })
    expect(layout[1]).toEqual({ width: 100, height: 201, top: 842 + PDF_PAGE_GAP })
    expect(layout[2].top).toBe(842 + PDF_PAGE_GAP + 201 + PDF_PAGE_GAP)
  })

  it('zoom scales the boxes, the gap stays fixed', () => {
    const layout = pdfLayout([A4], 0.5)
    expect(layout[0]).toEqual({ width: 298, height: 421, top: 0 })
  })

  it('never produces a zero-sized box', () => {
    const layout = pdfLayout([{ width: 0.0001, height: 0.0001 }], 0.01)
    expect(layout[0].width).toBeGreaterThanOrEqual(1)
    expect(layout[0].height).toBeGreaterThanOrEqual(1)
  })
})

describe('pdfFitScale', () => {
  it('shrinks a wide document to the container, never past 100%', () => {
    expect(pdfFitScale(700, [LANDSCAPE.width], 0.1)).toBeCloseTo(700 / 1400)
    // A4 at a normal pane width fits without shrinking.
    expect(pdfFitScale(900, [A4.width], 0.1)).toBe(1)
    // The widest page drives the fit — no horizontal scrolling at rest.
    expect(pdfFitScale(700, [A4.width, LANDSCAPE.width], 0.1)).toBeCloseTo(0.5)
  })

  it('floors at minZoom and survives degenerate measurements', () => {
    expect(pdfFitScale(1, [LANDSCAPE.width], 0.4)).toBe(0.4)
    expect(pdfFitScale(0, [A4.width], 0.1)).toBe(1)
    expect(pdfFitScale(700, [], 0.1)).toBe(1)
    expect(pdfFitScale(700, [0], 0.1)).toBe(1)
    expect(pdfFitScale(Number.NaN, [A4.width], 0.1)).toBe(1)
  })
})

function windows(layout: PdfPageLayout[], scrollTop: number, viewportHeight: number, buffer: number) {
  return pdfPageWindow(layout, scrollTop, viewportHeight, buffer)
}

describe('pdfPageWindow', () => {
  // Five A4 pages at zoom 1: page i occupies [i*(842+16), …+842).
  const layout = pdfLayout(Array.from({ length: 5 }, () => A4), 1)
  const H = A4.height + PDF_PAGE_GAP

  it('returns the visible band widened by the buffer on both sides', () => {
    expect(windows(layout, 0, 842, PDF_RENDER_BUFFER_PAGES)).toEqual({ first: 0, last: 2 })
    // Scrolled to page 3 (index 2): band covers pages 3±buffer.
    expect(windows(layout, 2 * H, 842, PDF_RENDER_BUFFER_PAGES)).toEqual({ first: 0, last: 4 })
    expect(windows(layout, 4 * H, 842, PDF_RENDER_BUFFER_PAGES)).toEqual({ first: 2, last: 4 })
  })

  it('a band strictly inside one page stays that page', () => {
    expect(windows(layout, 100, 200, 0)).toEqual({ first: 0, last: 0 })
    expect(windows(layout, H + 100, 200, 0)).toEqual({ first: 1, last: 1 })
  })

  it('a page whose top is above the band but whose body crosses it counts', () => {
    // scrollTop lands 100px into page 1 (index 1): its bottom is below scrollTop.
    expect(windows(layout, H + 100, 200, 0)).toEqual({ first: 1, last: 1 })
  })

  it('empty layout, zero viewport and scrolled-past-end stay sane', () => {
    expect(windows([], 0, 842, 2)).toEqual({ first: 0, last: -1 })
    const scrolledPast = windows(layout, 50 * H, 842, 2)
    expect(scrolledPast.last).toBe(-1)
    expect(windows(layout, 0, 0, 0).last).toBe(-1)
  })

  it('the buffer clamps at the document edges', () => {
    const single = pdfLayout([A4], 1)
    expect(windows(single, 0, 842, PDF_RENDER_BUFFER_PAGES)).toEqual({ first: 0, last: 0 })
  })
})

describe('currentPageIndex', () => {
  const layout = pdfLayout(Array.from({ length: 3 }, () => A4), 1)
  const H = A4.height + PDF_PAGE_GAP

  it('the page under the viewport centre is the current one', () => {
    expect(currentPageIndex(layout, 0, 842)).toBe(0)
    expect(currentPageIndex(layout, H, 842)).toBe(1)
    expect(currentPageIndex(layout, 2 * H, 842)).toBe(2)
  })

  it('clamps past the end (footer gap) and on an empty document', () => {
    expect(currentPageIndex(layout, 10 * H, 842)).toBe(2)
    expect(currentPageIndex([], 0, 842)).toBe(0)
  })
})

describe('wiring', () => {
  const previewContent = readFileSync(
    join(__dirname, '../src/renderer/src/components/preview/PreviewContent.tsx'),
    'utf8'
  )
  it('PreviewContent routes .pdf to PdfPreview before the markitdown fallback', () => {
    expect(previewContent).toContain("import { PdfPreview } from './PdfPreview'")
    expect(previewContent).toContain("if (ext === 'pdf') return <PdfPreview")
    const pdfBranch = previewContent.indexOf("ext === 'pdf'")
    const officeFallback = previewContent.indexOf('return <OfficePreview')
    expect(pdfBranch).toBeGreaterThan(-1)
    expect(officeFallback).toBeGreaterThan(pdfBranch)
  })

  it('the renderer is the pdfjs consumer and keeps the dynamic import', () => {
    const component = readFileSync(
      join(__dirname, '../src/renderer/src/components/preview/PdfPreview.tsx'),
      'utf8'
    )
    expect(component).toContain("await import('pdfjs-dist')")
    // The worker rides a Vite ?url asset, not an eager import.
    expect(component).toContain("import('pdfjs-dist/build/pdf.worker.min.mjs?url')")
    // CSP: the app ships script-src without 'unsafe-eval'.
    expect(component).toContain('isEvalSupported: false')
    // The gates are real: the oversized card never decodes the bytes.
    const gateFirst = component.indexOf('base64Bytes(base64)')
    const decode = component.indexOf('atob(base64)')
    expect(gateFirst).toBeGreaterThan(-1)
    expect(decode).toBeGreaterThan(gateFirst)
  })

  it('the shared half stays pdfjs-free (vitest can import it without the dep)', () => {
    const shared = readFileSync(join(__dirname, '../src/shared/preview/pdf.ts'), 'utf8')
    expect(/from\s+['"]pdfjs-dist|import\(['"]pdfjs-dist/.test(shared)).toBe(false)
  })
})
