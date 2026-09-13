import { describe, it, expect } from 'vitest'
import { PANE_CHROME_HEIGHT, PANE_MIN_WIDTH, clampPaneWidth, defaultPaneWidth, webviewBox, zoomForWidth } from '../src/shared/browser/pane'

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
  it('fills the pane width, derives height, centers below the chrome', () => {
    const box = webviewBox(520, 48, 852)
    expect(box.width).toBe(520)
    expect(box.height).toBe(293) // 520 * 9/16
    const available = 852 - PANE_CHROME_HEIGHT
    expect(box.y).toBe(48 + PANE_CHROME_HEIGHT + Math.floor((available - 293) / 2))
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
