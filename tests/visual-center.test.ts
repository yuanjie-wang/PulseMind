// ── visual-center: the padding that makes the grey read symmetric from the
// pane's edge under a classic scrollbar (see the module header). Pure math —
// the browser-side fact (a classic scrollbar really renders and consumes
// layout) is pinned by scripts/probe-visual-center.mjs.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { visualCenterPaddingX, visualCenterPaddingY } from '../src/renderer/src/components/preview/visual-center'

/** HTMLElement stand-in carrying only the four geometry reads. */
function box(client: number, offset: number) {
  return { clientWidth: client, offsetWidth: offset, clientHeight: client, offsetHeight: offset } as unknown as HTMLElement
}

describe('visual centering', () => {
  it('reduces to plain centering under overlay scrollbars', () => {
    expect(visualCenterPaddingX(box(800, 800), 668)).toBe(66)
  })

  it('splits a classic scrollbar strip evenly across the two sides', () => {
    // pane content 685 + 15px scrollbar; painted 653 (the fit state) — both
    // visual gutters land at 23.5.
    expect(visualCenterPaddingX(box(685, 700), 653)).toBe(23.5)
  })

  it('clamps to the spare so the content never pokes past the content box', () => {
    // spare 4 < scrollbar 15: the split would summon a horizontal scrollbar —
    // fall back to the spare (the right gutter then reads as just the strip).
    expect(visualCenterPaddingX(box(657, 672), 653)).toBe(4)
  })

  it('lands 0 once the content overflows (a panning surface, not a framed one)', () => {
    expect(visualCenterPaddingX(box(685, 700), 1175)).toBe(0)
  })

  it('the vertical axis mirrors it against a horizontal scrollbar', () => {
    expect(visualCenterPaddingY(box(600, 615), 568)).toBe(23.5)
  })
})

describe('wiring (source scans)', () => {
  const viewers = ['PptxPreview', 'ImagePreview', 'PdfPreview', 'XlsxPreview', 'DocxPreview']
  it('all five desk-style viewers center through the shared helper', () => {
    for (const name of viewers) {
      const src = readFileSync(`src/renderer/src/components/preview/${name}.tsx`, 'utf-8')
      expect(src, name).toContain('visualCenterPadding')
    }
  })

  it('pdf / xlsx / docx fits reserve the symmetric breathing room', () => {
    for (const name of ['PdfPreview', 'XlsxPreview', 'DocxPreview']) {
      const src = readFileSync(`src/renderer/src/components/preview/${name}.tsx`, 'utf-8')
      expect(src, name).toContain('clientWidth - PANE_PADDING * 2')
    }
  })
})
