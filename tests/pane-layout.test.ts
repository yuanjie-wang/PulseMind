import { describe, it, expect } from 'vitest'
import {
  PANE_BORDER_WIDTH,
  PANE_CHROME_HEIGHT,
  PANE_MIN_WIDTH,
  clampPaneWidth,
  defaultPaneWidth,
  normalizeAddressBarInput,
  webviewBox,
  zoomForWidth,
} from '../src/shared/browser/pane'

describe('pane width clamp', () => {
  it('defaults to 40% of the chat area', () => {
    expect(defaultPaneWidth(1300)).toBe(520)
  })
  it('clamps to [320, 60% of chat area]', () => {
    expect(clampPaneWidth(100, 1300)).toBe(320)
    expect(clampPaneWidth(5000, 1300)).toBe(780)
    expect(clampPaneWidth(520, 1300)).toBe(520)
  })
  it('never clamps below the minimum even on a tiny chat area', () => {
    expect(clampPaneWidth(280, 400)).toBe(320)
  })
})

describe('webview 16:9 box', () => {
  it('fills the pane width minus the border inset, derives height, centers below the chrome', () => {
    const box = webviewBox(520, 48, 852)
    // The pane's 1px left border (the chat/pane divider) is renderer DOM and a
    // native WebView paints over it — the box must start past the border.
    expect(box.x).toBe(PANE_BORDER_WIDTH)
    expect(box.width).toBe(519) // 520 - 1px border inset
    expect(box.height).toBe(292) // 519 * 9/16
    const available = 852 - PANE_CHROME_HEIGHT
    expect(box.y).toBe(48 + PANE_CHROME_HEIGHT + Math.floor((available - 292) / 2))
  })
  it('never lets the border inset widen a zero-width pane', () => {
    const box = webviewBox(0, 48, 852)
    expect(box.width).toBe(0)
    expect(box.height).toBe(0)
  })
  it('hugs the chrome instead of overflowing on a short window', () => {
    const box = webviewBox(520, 48, 200)
    expect(box.y).toBe(48 + PANE_CHROME_HEIGHT)
    expect(box.height).toBeLessThanOrEqual(200 - PANE_CHROME_HEIGHT)
  })
  it('stays inside the pane (x is assigned by the dock, width never negative)', () => {
    const box = webviewBox(0, 48, 852)
    expect(box.width).toBe(0)
    expect(box.height).toBe(0)
  })
})

describe('proportional page zoom', () => {
  it('scales from the 1280 design width, capped at 1, floored at 0.2', () => {
    expect(zoomForWidth(640)).toBe(0.5)
    expect(zoomForWidth(1280)).toBe(1)
    expect(zoomForWidth(1600)).toBe(1) // never zoom in beyond 100%
    expect(zoomForWidth(100)).toBe(0.2)
  })
})

describe('address-bar normalization', () => {
  it('completes bare hosts with https:// (mail.163.com case)', () => {
    expect(normalizeAddressBarInput('mail.163.com')).toBe('https://mail.163.com')
    expect(normalizeAddressBarInput('localhost:5173')).toBe('https://localhost:5173')
    expect(normalizeAddressBarInput('  example.com/path?q=1  ')).toBe('https://example.com/path?q=1')
  })
  it('passes through schemed urls untouched', () => {
    expect(normalizeAddressBarInput('http://a.com/')).toBe('http://a.com/')
    expect(normalizeAddressBarInput('HTTPS://A.COM/x')).toBe('HTTPS://A.COM/x')
    expect(normalizeAddressBarInput('about:blank')).toBe('about:blank')
  })
})
