// ── App-view screenshots (2026-11-11 「截图有问题」) ──
// App-view pages do NOT live at the pane's CSS size: the dock lays every page
// out at the 1280px design width and shrinks it with Chromium page zoom
// (zoomForWidth = paneWidth / 1280, app-view-dock stamps it). Over
// connectOverCDP Playwright sizes the capture canvas from the LAYOUT viewport
// (346×195) but hands the clip to Chromium as CSS pixels (1280×721), so the
// returned PNG is a 2560-wide white canvas with the page squeezed into its
// top-left corner — the user's baidu-home.png: 2538×1426, 97% pure white,
// content bbox 668×373.
//
// Raw Page.captureScreenshot against the same session is the only shape that
// matches what the pane actually paints. Probe-settled rules
// (scripts/probe-appview-screenshot.*, run under a real Electron):
//   • no clip                 → exactly the painted visible viewport, at any
//                               scroll offset;
//   • clip x/y/width/height   → DOCUMENT DIP = CSS × zoom (not CSS, not
//                               viewport CSS) — a selector's boundingBox is
//                               viewport-relative, so add window.scrollX/Y
//                               BEFORE scaling;
//   • captureBeyondViewport   → required to rasterize content taller than the
//                               viewport (full page); a rect that fits needs
//                               false, else the page may re-layout to a
//                               simulated larger viewport.
// Output pixels = DIP × the display's physical DPR (a 346 DIP pane on a 2x
// display → 692px wide PNG): the screenshot is the pane's own raster, which is
// the point — it must match what the user sees.
//
// The managed backend keeps Playwright's screenshot path (no zoom there).

import type { Page } from 'playwright-core'

export interface ScreenshotBox {
  x: number
  y: number
  width: number
  height: number
}

/** Page zoom as stamped on the view's webContents. Garbage (0/NaN) is 1 —
 *  a capture at the wrong scale is still better than a division by zero. */
export function safeZoom(zoom: number): number {
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1
}

/** Selector clip in document DIP. `box` is `boundingBox()` — viewport-relative
 *  CSS — and `scroll` is the window offset at measure time; both are CSS
 *  units, so they add before the zoom is applied. */
export function clipForBox(box: ScreenshotBox, scroll: { x: number; y: number }, zoom: number): ScreenshotBox {
  const z = safeZoom(zoom)
  return {
    x: (box.x + scroll.x) * z,
    y: (box.y + scroll.y) * z,
    width: box.width * z,
    height: box.height * z,
  }
}

/** Full-page clip in document DIP: the CSS content size scaled by the zoom.
 *  (Playwright's fullPage clip is CSS-sized and therefore overshoots by 1/zoom
 *  here — probe: only the top band painted in a 2560×5400 canvas.) */
export function clipForDocument(content: { width: number; height: number }, zoom: number): ScreenshotBox {
  const z = safeZoom(zoom)
  return { x: 0, y: 0, width: content.width * z, height: content.height * z }
}

/** Playwright's own rule: an element that fits the layout viewport (CSS px)
 *  is captured with captureBeyondViewport=false; a taller one needs true. */
export function needsBeyondViewport(
  box: { width: number; height: number },
  viewport: { width: number; height: number } | null,
): boolean {
  if (!viewport) return true
  return box.width > viewport.width || box.height > viewport.height
}

interface CssMetrics {
  viewport: { width: number; height: number } | null
  content: { width: number; height: number } | null
}

interface CdpLayoutMetrics {
  cssLayoutViewport?: { clientWidth: number; clientHeight: number }
  cssContentSize?: { width: number; height: number }
}

export interface AppViewScreenshotOptions {
  /** Actual page zoom of the view (`webContents.getZoomFactor()`), NOT the
   *  dock's current width formula — a folded tab can be at another host's
   *  persisted scale until the next restamp. */
  zoom: number
  selector?: string
  fullPage?: boolean
}

/**
 * Capture a screenshot of an app-view page in the coordinate system Chromium
 * actually paints it in. Selector wins over fullPage, mirroring the Playwright
 * path's precedence.
 */
export async function captureAppViewScreenshot(page: Page, opts: AppViewScreenshotOptions): Promise<Buffer> {
  const zoom = safeZoom(opts.zoom)
  const session = await page.context().newCDPSession(page)
  try {
    const metrics = (await session.send('Page.getLayoutMetrics')) as CdpLayoutMetrics
    const css: CssMetrics = {
      viewport: metrics.cssLayoutViewport
        ? { width: metrics.cssLayoutViewport.clientWidth, height: metrics.cssLayoutViewport.clientHeight }
        : null,
      content: metrics.cssContentSize
        ? { width: metrics.cssContentSize.width, height: metrics.cssContentSize.height }
        : null,
    }

    if (opts.selector) {
      const locator = page.locator(opts.selector)
      await locator.scrollIntoViewIfNeeded()
      const box = await locator.boundingBox()
      if (!box) throw new Error(`截图失败：选择器「${opts.selector}」没有可见元素`)
      const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))
      const result = await session.send('Page.captureScreenshot', {
        format: 'png',
        clip: { ...clipForBox(box, scroll, zoom), scale: 1 },
        captureBeyondViewport: needsBeyondViewport(box, css.viewport),
      })
      return Buffer.from((result as { data: string }).data, 'base64')
    }

    if (opts.fullPage) {
      const content =
        css.content ??
        (await page.evaluate(() => ({
          width: document.documentElement.scrollWidth,
          height: document.documentElement.scrollHeight,
        })))
      const result = await session.send('Page.captureScreenshot', {
        format: 'png',
        clip: { ...clipForDocument(content, zoom), scale: 1 },
        captureBeyondViewport: true,
      })
      return Buffer.from((result as { data: string }).data, 'base64')
    }

    // No clip = the painted visible viewport at any scroll — the pane's view.
    const result = await session.send('Page.captureScreenshot', { format: 'png' })
    return Buffer.from((result as { data: string }).data, 'base64')
  } finally {
    await session.detach().catch(() => {
      /* page closed mid-capture — the caller sees the capture error */
    })
  }
}
