// App-view screenshot geometry (2026-11-11 「截图有问题」): the dock lays pages
// out at 1280 CSS px and shrinks them with page zoom, so a screenshot must be
// clipped in document DIP = CSS × zoom. These cases pin the pure math and the
// exact CDP parameters (fake page/session — no Electron needed), plus the
// wiring that routes ONLY app-view through it (managed has no zoom).
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import {
  captureAppViewScreenshot,
  clipForBox,
  clipForDocument,
  needsBeyondViewport,
  safeZoom,
} from '../src/main/browser/app-view-screenshot'

const ZOOM = 346 / 1280 // 0.2703125 — the 346px pane from the real probe

interface SentCall {
  method: string
  params?: unknown
}

function fakePage(options: {
  metrics?: unknown
  box?: { x: number; y: number; width: number; height: number } | null
  scroll?: { x: number; y: number }
  content?: { width: number; height: number }
  captureError?: Error
}) {
  const calls: SentCall[] = []
  const detach = vi.fn(async () => {})
  const send = vi.fn(async (method: string, params?: unknown) => {
    calls.push({ method, params })
    if (method === 'Page.getLayoutMetrics') {
      return (
        options.metrics ?? {
          cssLayoutViewport: { clientWidth: 1280, clientHeight: 721 },
          cssContentSize: { width: 1280, height: 2700 },
        }
      )
    }
    if (method === 'Page.captureScreenshot') {
      if (options.captureError) throw options.captureError
      return { data: Buffer.from('png-bytes').toString('base64') }
    }
    throw new Error(`unexpected CDP method ${method}`)
  })
  const page = {
    context: () => ({ newCDPSession: async () => ({ send, detach }) }),
    // The two evaluate shapes differ by their body: scroll offsets vs a
    // document-size fallback when cssContentSize is absent.
    evaluate: vi.fn(async (fn: unknown) =>
      String(fn).includes('scrollX')
        ? (options.scroll ?? { x: 0, y: 0 })
        : (options.content ?? { width: 1280, height: 2700 }),
    ),
    locator: vi.fn(() => ({
      scrollIntoViewIfNeeded: vi.fn(async () => {}),
      boundingBox: vi.fn(async () => options.box ?? null),
    })),
  }
  return { page: page as unknown as Page, calls, send, detach }
}

function captureCall(calls: SentCall[]): SentCall {
  const call = calls.find((c) => c.method === 'Page.captureScreenshot')
  if (!call) throw new Error('no captureScreenshot call')
  return call
}

describe('app-view screenshot clip math', () => {
  it('safeZoom keeps a real zoom and neutralises garbage', () => {
    expect(safeZoom(ZOOM)).toBe(ZOOM)
    expect(safeZoom(0)).toBe(1)
    expect(safeZoom(-0.5)).toBe(1)
    expect(safeZoom(Number.NaN)).toBe(1)
    expect(safeZoom(Number.POSITIVE_INFINITY)).toBe(1)
  })

  it('selector clip adds the viewport-relative box to the scroll offset, then scales', () => {
    const clip = clipForBox({ x: 200, y: 100, width: 200, height: 100 }, { x: 0, y: 600 }, ZOOM)
    expect(clip.x).toBeCloseTo(200 * ZOOM, 10) // 54.0625
    expect(clip.y).toBeCloseTo(700 * ZOOM, 10) // 189.21875
    expect(clip.width).toBeCloseTo(200 * ZOOM, 10) // 54.0625
    expect(clip.height).toBeCloseTo(100 * ZOOM, 10) // 27.03125
  })

  it('full-page clip is the CSS content size scaled by the zoom', () => {
    expect(clipForDocument({ width: 1280, height: 2700 }, ZOOM)).toEqual({
      x: 0,
      y: 0,
      width: 1280 * ZOOM,
      height: 2700 * ZOOM,
    })
  })

  it('an element that fits needs no beyond-viewport raster; a taller one does', () => {
    expect(needsBeyondViewport({ width: 200, height: 100 }, { width: 1280, height: 721 })).toBe(false)
    expect(needsBeyondViewport({ width: 1200, height: 200 }, { width: 1280, height: 721 })).toBe(false)
    expect(needsBeyondViewport({ width: 200, height: 900 }, { width: 1280, height: 721 })).toBe(true)
    expect(needsBeyondViewport({ width: 1400, height: 100 }, { width: 1280, height: 721 })).toBe(true)
    // Unknown metrics: rasterize beyond — a wrong-sized viewport must not clip.
    expect(needsBeyondViewport({ width: 200, height: 100 }, null)).toBe(true)
  })
})

describe('app-view capture over raw CDP', () => {
  it('plain capture sends no clip: the painted visible viewport at any scroll', async () => {
    const { page, calls, detach } = fakePage({})
    const png = await captureAppViewScreenshot(page, { zoom: ZOOM })
    expect(png.toString()).toBe('png-bytes')
    expect(captureCall(calls).params).toEqual({ format: 'png' })
    expect(detach).toHaveBeenCalledOnce()
  })

  it('selector capture clips in document DIP (box + scroll) × zoom', async () => {
    const { page, calls } = fakePage({
      box: { x: 200, y: 100, width: 200, height: 100 },
      scroll: { x: 0, y: 600 },
    })
    await captureAppViewScreenshot(page, { zoom: ZOOM, selector: '#marker' })
    const params = captureCall(calls).params as {
      clip: { x: number; y: number; width: number; height: number; scale: number }
      captureBeyondViewport: boolean
    }
    expect(params.clip.x).toBeCloseTo(200 * ZOOM, 10)
    expect(params.clip.y).toBeCloseTo(700 * ZOOM, 10)
    expect(params.clip.width).toBeCloseTo(200 * ZOOM, 10)
    expect(params.clip.height).toBeCloseTo(100 * ZOOM, 10)
    expect(params.clip.scale).toBe(1)
    expect(params.captureBeyondViewport).toBe(false)
    // Guard the real bug: CSS-sized clips are what produced the white canvas.
    expect(params.clip.width).not.toBe(200)
  })

  it('an element taller than the viewport is captured with captureBeyondViewport', async () => {
    const { page, calls } = fakePage({
      box: { x: 0, y: 0, width: 300, height: 900 },
      scroll: { x: 0, y: 0 },
    })
    await captureAppViewScreenshot(page, { zoom: 1, selector: 'main' })
    const params = captureCall(calls).params as { captureBeyondViewport: boolean }
    expect(params.captureBeyondViewport).toBe(true)
  })

  it('full page = cssContentSize × zoom + captureBeyondViewport', async () => {
    const { page, calls } = fakePage({})
    await captureAppViewScreenshot(page, { zoom: ZOOM, fullPage: true })
    const params = captureCall(calls).params as {
      clip: { x: number; y: number; width: number; height: number }
      captureBeyondViewport: boolean
    }
    expect(params.clip.x).toBe(0)
    expect(params.clip.y).toBe(0)
    expect(params.clip.width).toBeCloseTo(1280 * ZOOM, 10)
    expect(params.clip.height).toBeCloseTo(2700 * ZOOM, 10)
    expect(params.captureBeyondViewport).toBe(true)
  })

  it('falls back to document scroll size in CSS px when cssContentSize is absent', async () => {
    const { page, calls } = fakePage({
      metrics: { cssLayoutViewport: { clientWidth: 1280, clientHeight: 721 } },
      content: { width: 1280, height: 3000 },
    })
    await captureAppViewScreenshot(page, { zoom: ZOOM, fullPage: true })
    const params = captureCall(calls).params as { clip: { width: number; height: number } }
    expect(params.clip.width).toBeCloseTo(1280 * ZOOM, 10)
    expect(params.clip.height).toBeCloseTo(3000 * ZOOM, 10)
  })

  it('selector wins over fullPage (same precedence as the Playwright path)', async () => {
    const { page, calls } = fakePage({ box: { x: 10, y: 10, width: 100, height: 100 }, scroll: { x: 0, y: 0 } })
    await captureAppViewScreenshot(page, { zoom: 1, selector: '#a', fullPage: true })
    const params = captureCall(calls).params as { clip: { width: number } }
    expect(params.clip.width).toBe(100)
    const full = calls.filter((c) => c.method === 'Page.captureScreenshot')
    expect(full).toHaveLength(1)
  })

  it('an invisible selector reports the selector and still detaches', async () => {
    const { page, calls, detach } = fakePage({ box: null })
    await expect(captureAppViewScreenshot(page, { zoom: 1, selector: '#gone' })).rejects.toThrow(/#gone/)
    expect(calls.some((c) => c.method === 'Page.captureScreenshot')).toBe(false)
    expect(detach).toHaveBeenCalledOnce()
  })

  it('detaches the CDP session when the capture itself throws', async () => {
    const { page, detach } = fakePage({ captureError: new Error('Target closed') })
    await expect(captureAppViewScreenshot(page, { zoom: 1 })).rejects.toThrow('Target closed')
    expect(detach).toHaveBeenCalledOnce()
  })
})

describe('app-view screenshot wiring', () => {
  const helperSrc = readFileSync(join(__dirname, '../src/main/browser/app-view-screenshot.ts'), 'utf-8')
  const serviceSrc = readFileSync(join(__dirname, '../src/main/browser/BrowserService.ts'), 'utf-8')
  const shotCase = serviceSrc.slice(
    serviceSrc.indexOf("case 'screenshot':"),
    serviceSrc.indexOf("case 'evaluate':"),
  )

  it('BrowserService routes ONLY the app-view backend through the DIP capture', () => {
    expect(serviceSrc).toContain("import { captureAppViewScreenshot } from './app-view-screenshot'")
    expect(shotCase).toContain("entry.backendId === 'app-view'")
    expect(shotCase).toContain('captureAppViewScreenshot(page, {')
    // The zoom source is the VIEW's actual factor, not the dock width formula:
    // a folded tab may still sit at another host's persisted scale.
    expect(shotCase).toContain('view.webContents.getZoomFactor()')
    expect(shotCase).toContain('selector: cmd.selector')
    expect(shotCase).toContain('fullPage: cmd.fullPage')
  })

  it('the managed backend keeps Playwright screenshots', () => {
    expect(shotCase).toContain('page.locator(cmd.selector).screenshot()')
    expect(shotCase).toContain('page.screenshot({ fullPage: cmd.fullPage })')
  })

  it('the helper captures through CDP in document DIP, not page.screenshot', () => {
    expect(helperSrc).not.toContain('page.screenshot(')
    expect(helperSrc).toContain("'Page.captureScreenshot'")
    expect(helperSrc).toContain("'Page.getLayoutMetrics'")
    expect(helperSrc).toContain('captureBeyondViewport')
    expect(helperSrc).toContain('cssLayoutViewport')
    expect(helperSrc).toContain('cssContentSize')
    expect(helperSrc).toContain('scrollIntoViewIfNeeded')
  })
})
