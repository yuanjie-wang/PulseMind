// Caption-button overlay × modal mask (穿帮 report: on Windows the native
// min/max/close buttons are drawn ON TOP of the web content, so a global
// modal's dim layer never reaches them — they stay bright over a dimmed
// header). The contract has three halves, pinned here:
//   1. shared/window-chrome.ts — the blend (pure maths, the whole fix);
//   2. main/window-chrome.ts — theme × alpha → setTitleBarOverlay, with the
//      short-circuit, the clamp and the PER-WINDOW alpha (a secondary window's
//      repaint must not inherit the main window's open modal, and a theme save
//      reaches every secondary window: settings.handler → refreshPopoutTitleBarTheme);
//   3. the chain that carries alpha from a DOM mutation to that repaint —
//      asserted as source (vitest here is node-env; the DOM half lives in
//      tests/title-bar-mask-watcher.test.ts, which drives the real observer).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, afterEach } from 'vitest'
import { BrowserWindow } from 'electron'
import {
  captionButtonVars,
  dimTitleBarOverlayColors,
  resolveCaptionButtonStyle,
  resolveTitleBarOverlayColors,
  resolveWindowControlsLayout,
  titleBarActionsRight,
  titleBarRightInset,
  TITLE_BAR_HEIGHT,
} from '../src/shared/window-chrome'
import { resolveTitleBarOptions, setTitleBarMaskAlpha, setTitleBarTheme } from '../src/main/window-chrome'

const ROOT = join(__dirname, '..')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8')

// ── platform ──
// applyTitleBarOverlay is a no-op on darwin (traffic lights have no background
// to repaint), and the tests run ON darwin — flip to win32 for the repaint
// assertions and back for the darwin one.
const platformDesc = Object.getOwnPropertyDescriptor(process, 'platform')!
function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}
afterEach(() => {
  // Mask state is per window (a WeakMap keyed by the stub instances), and every
  // test mints its own window — nothing leaks between `it`s. Only the THEME is
  // module-global; tests that flip it restore it inline.
  Object.defineProperty(process, 'platform', platformDesc)
})

describe('titleBarRightInset — the top-right cluster clears the OS controls', () => {
  it('Windows/Linux reserve the caption-button strip (inset > 0)', () => {
    const win = resolveWindowControlsLayout('win32')
    expect(win.side).toBe('right')
    expect(titleBarRightInset(win)).toBe(win.inset)
    expect(titleBarRightInset(win)).toBeGreaterThan(0)
  })

  it('macOS keeps the right edge free (traffic lights are on the left)', () => {
    const mac = resolveWindowControlsLayout('darwin')
    expect(mac.side).toBe('left')
    expect(titleBarRightInset(mac)).toBe(0)
  })
})

describe('titleBarActionsRight — cluster offset = OS strip + app gutter', () => {
  it('Windows/Linux sit flush against the caption strip (gutter 0)', () => {
    // 2026-11-04 user rulings: first 24px → 9px ("间距过大"), then 9px → 0
    // ("干脆把那 9px 也去掉") — the app buttons and the native min/max/close
    // read as one row of caption buttons.
    const win = resolveWindowControlsLayout('win32')
    expect(titleBarActionsRight(win)).toBe(win.inset)
    // Never inside the strip — there the buttons are hidden and dead.
    expect(titleBarActionsRight(win)).toBeGreaterThanOrEqual(win.inset)
  })

  it('macOS keeps the header gutter (24px) — nothing on the right to hug', () => {
    expect(titleBarActionsRight(resolveWindowControlsLayout('darwin'))).toBe(24)
  })
})

describe('resolveCaptionButtonStyle — the app buttons copy the native ones', () => {
  it('footprint matches the OS overlay strip (46 wide, bar height)', () => {
    for (const theme of ['light', 'dark']) {
      const s = resolveCaptionButtonStyle(theme)
      expect(s.width).toBe(46)
      expect(s.height).toBe(TITLE_BAR_HEIGHT)
    }
  })

  it('glyph colour IS the value the OS draws with (no drift by construction)', () => {
    for (const theme of ['light', 'dark']) {
      expect(resolveCaptionButtonStyle(theme).symbolColor).toBe(resolveTitleBarOverlayColors(theme).symbolColor)
    }
    expect(resolveCaptionButtonStyle('light').symbolColor).toBe('#333333')
    expect(resolveCaptionButtonStyle('dark').symbolColor).toBe('#CCCCCC')
  })

  it('hover and press differ (a press must read as a press)', () => {
    const s = resolveCaptionButtonStyle('light')
    expect(s.hoverBg).not.toBe(s.activeBg)
    // Neutral greys, not an accent — the native buttons light up grey.
    expect(s.hoverBg).toMatch(/^#[0-9A-Fa-f]{6}$/)
    expect(s.activeBg).toMatch(/^#[0-9A-Fa-f]{6}$/)
  })

  it('captionButtonVars projects the spec onto the CSS custom properties', () => {
    const vars = captionButtonVars('light')
    const s = resolveCaptionButtonStyle('light')
    expect(vars['--pm-caption-btn-width']).toBe(`${s.width}px`)
    expect(vars['--pm-caption-btn-height']).toBe(`${s.height}px`)
    expect(vars['--pm-caption-hover']).toBe(s.hoverBg)
    expect(vars['--pm-caption-active']).toBe(s.activeBg)
    expect(vars['--pm-caption-symbol']).toBe(s.symbolColor)
  })
})

describe('dimTitleBarOverlayColors — the blend', () => {  it('alpha 0 returns the colours untouched (identity, not a re-derivation)', () => {
    const colors = resolveTitleBarOverlayColors('light')
    expect(dimTitleBarOverlayColors(colors, 0)).toBe(colors)
  })

  it('clamps out-of-range alpha instead of painting nonsense hex', () => {
    const colors = resolveTitleBarOverlayColors('light')
    expect(dimTitleBarOverlayColors(colors, -1)).toBe(colors)
    expect(dimTitleBarOverlayColors(colors, Number.NaN)).toBe(colors)
    expect(dimTitleBarOverlayColors(colors, 7)).toEqual(dimTitleBarOverlayColors(colors, 1))
  })

  it('light theme under the antd default mask (rgba(0,0,0,0.45))', () => {
    expect(dimTitleBarOverlayColors(resolveTitleBarOverlayColors('light'), 0.45)).toEqual({
      color: '#8c8c8c',
      symbolColor: '#1c1c1c',
    })
  })

  it('dark theme under the same mask', () => {
    expect(dimTitleBarOverlayColors(resolveTitleBarOverlayColors('dark'), 0.45)).toEqual({
      color: '#0b0b0b',
      symbolColor: '#707070',
    })
  })

  it("the image viewer's hand-rolled 0.85 backdrop dims much further", () => {
    expect(dimTitleBarOverlayColors(resolveTitleBarOverlayColors('light'), 0.85)).toEqual({
      color: '#262626',
      symbolColor: '#080808',
    })
  })

  it('alpha 1 collapses to black — a solid backdrop hides the buttons entirely', () => {
    expect(dimTitleBarOverlayColors(resolveTitleBarOverlayColors('light'), 1)).toEqual({
      color: '#000000',
      symbolColor: '#000000',
    })
  })

  it('every channel stays two-digit hex (a rounding slip would corrupt the parse)', () => {
    for (let a = 0.05; a < 1; a += 0.07) {
      const { color, symbolColor } = dimTitleBarOverlayColors(resolveTitleBarOverlayColors('light'), a)
      expect(color).toMatch(/^#[0-9a-f]{6}$/)
      expect(symbolColor).toMatch(/^#[0-9a-f]{6}$/)
    }
  })
})

describe('title-bar overlay repaint (main)', () => {
  it('darwin: no repaint ever reaches the window (traffic lights are native dots)', () => {
    setPlatform('darwin')
    const win = new BrowserWindow()
    setTitleBarTheme('light', win)
    setTitleBarMaskAlpha(0.45, win)
    expect(win.overlayUpdates).toEqual([])
  })

  it('win32: a mask repaints the overlay blended with the header', () => {
    setPlatform('win32')
    const win = new BrowserWindow()
    setTitleBarMaskAlpha(0.45, win)
    expect(win.overlayUpdates.at(-1)).toEqual({ color: '#8c8c8c', symbolColor: '#1c1c1c', height: TITLE_BAR_HEIGHT })
  })

  it('win32: an unchanged alpha is a compare, not a repaint (the watcher sits on a DOM that churns constantly)', () => {
    setPlatform('win32')
    const win = new BrowserWindow()
    setTitleBarMaskAlpha(0.45, win)
    const count = win.overlayUpdates.length
    setTitleBarMaskAlpha(0.45, win)
    expect(win.overlayUpdates.length).toBe(count)
    // …and back to 0 is a real change again.
    setTitleBarMaskAlpha(0, win)
    expect(win.overlayUpdates.length).toBe(count + 1)
    expect(win.overlayUpdates.at(-1)).toEqual({ color: '#FFFFFF', symbolColor: '#333333', height: TITLE_BAR_HEIGHT })
  })

  it('win32: a theme save mid-modal repaints the DIMMED variant of the new theme', () => {
    setPlatform('win32')
    const win = new BrowserWindow()
    setTitleBarMaskAlpha(0.45, win)
    setTitleBarTheme('dark', win)
    expect(win.overlayUpdates.at(-1)).toEqual({ color: '#0b0b0b', symbolColor: '#707070', height: TITLE_BAR_HEIGHT })
    setTitleBarMaskAlpha(0, win)
    setTitleBarTheme('light', win) // restore the shared theme state for later tests
    expect(win.overlayUpdates.at(-1)).toEqual({ color: '#FFFFFF', symbolColor: '#333333', height: TITLE_BAR_HEIGHT })
  })

  it('a fresh window opens undimmed — another window’s reported alpha does not leak (tray relaunch)', () => {
    setPlatform('win32')
    const old = new BrowserWindow()
    setTitleBarMaskAlpha(0.45, old)
    expect(old.overlayUpdates.at(-1)!.color).toBe('#8c8c8c')
    resolveTitleBarOptions()
    const fresh = new BrowserWindow()
    setTitleBarTheme('light', fresh)
    expect(fresh.overlayUpdates.at(-1)).toEqual({ color: '#FFFFFF', symbolColor: '#333333', height: TITLE_BAR_HEIGHT })
  })

  it('mask alpha is per window: one window’s open modal never dims another’s repaint', () => {
    setPlatform('win32')
    // Main window mid-modal; the popout has no mask and opens clean…
    const main = new BrowserWindow()
    setTitleBarMaskAlpha(0.45, main)
    const popout = new BrowserWindow()
    setTitleBarTheme('light', popout)
    expect(popout.overlayUpdates.at(-1)).toEqual({ color: '#FFFFFF', symbolColor: '#333333', height: TITLE_BAR_HEIGHT })
    // …and a THEME repaint of the popout stays undimmed while the main
    // window's own keeps its dim (2026-11-02: settings save → all windows).
    setTitleBarTheme('dark', popout)
    expect(popout.overlayUpdates.at(-1)).toEqual({ color: '#141414', symbolColor: '#CCCCCC', height: TITLE_BAR_HEIGHT })
    setTitleBarTheme('dark', main)
    expect(main.overlayUpdates.at(-1)).toEqual({ color: '#0b0b0b', symbolColor: '#707070', height: TITLE_BAR_HEIGHT })
  })

  it('a report with no window (sender gone) or for a destroyed window is dropped, not recorded anywhere', () => {
    setPlatform('win32')
    expect(() => setTitleBarMaskAlpha(0.45, null)).not.toThrow()
    const gone = new BrowserWindow()
    gone.destroy()
    setTitleBarMaskAlpha(0.45, gone)
    expect(gone.overlayUpdates).toEqual([])
    // …and did not poison a window created afterwards.
    const next = new BrowserWindow()
    setTitleBarTheme('light', next)
    expect(next.overlayUpdates.at(-1)).toEqual({ color: '#FFFFFF', symbolColor: '#333333', height: TITLE_BAR_HEIGHT })
  })

  it('win32: creation options carry the theme colours undimmed', () => {
    setPlatform('win32')
    setTitleBarTheme('dark', null)
    const options = resolveTitleBarOptions()
    expect(options).toEqual({
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#141414', symbolColor: '#CCCCCC', height: TITLE_BAR_HEIGHT },
    })
    setTitleBarTheme('light', null) // restore
  })
})

describe('wiring — renderer mask → IPC → repaint', () => {
  const preload = read('src/preload/index.ts')
  const bridge = read('src/shared/types/electron-bridge.ts')
  const appHandler = read('src/main/ipc/app.handler.ts')
  const channels = read('src/shared/ipc-channels.ts')
  const watcher = read('src/renderer/src/utils/title-bar-mask.ts')
  const app = read('src/renderer/src/App.tsx')
  const imageView = read('src/renderer/src/components/chat/ImageViewer.tsx')

  it('non-vacuity: the scans read real sources', () => {
    expect(preload).toContain('getWindowControls')
    expect(bridge).toContain('getWindowControls')
    expect(appHandler).toContain('registerAppHandlers')
    expect(watcher).toContain('startTitleBarMaskWatcher')
  })

  it('the bridge type declares the report and preload sends it fire-and-forget', () => {
    expect(bridge).toMatch(/setTitleBarMaskAlpha: \(alpha: number\) => void/)
    expect(preload).toMatch(
      /setTitleBarMaskAlpha: \(alpha: number\): void => ipcRenderer\.send\(IPC_CHANNELS\.WINDOW_SET_TITLE_BAR_MASK, alpha\)/,
    )
  })

  it('main receives the channel and forwards it to the blend', () => {
    expect(channels).toContain("WINDOW_SET_TITLE_BAR_MASK: 'window:set-title-bar-mask'")
    expect(appHandler).toMatch(/ipcMain\.on\(IPC_CHANNELS\.WINDOW_SET_TITLE_BAR_MASK/)
    expect(appHandler).toMatch(/setTitleBarMaskAlpha\(/)
  })

  it('the App mounts the watcher once', () => {
    expect(app).toContain("import { startTitleBarMaskWatcher } from './utils/title-bar-mask'")
    expect(app).toContain('useEffect(() => startTitleBarMaskWatcher(), [])')
  })

  it('the selector covers every antd mask family plus the hand-rolled hook', () => {
    expect(watcher).toContain(".ant-modal-mask")
    expect(watcher).toContain(".ant-image-preview-mask")
    expect(watcher).toContain(".ant-drawer-mask")
    expect(watcher).toContain('[data-pm-mask]')
  })

  it('the chat image viewer opts in through the data hook', () => {
    expect(imageView).toContain('data-pm-mask')
  })
})

describe('wiring — a theme save reaches every secondary window', () => {
  const settings = read('src/main/ipc/settings.handler.ts')
  // 2026-11-10：这串保存后动作搬进共享模块（模板包导入跑同一份）。
  const effects = read('src/main/services/settings-side-effects.ts')
  const popout = read('src/main/popout-window.ts')
  const index = read('src/main/index.ts')

  it('the settings save repaints the sender AND the secondaries with ONE resolved mode', () => {
    expect(effects).toContain("import { refreshPopoutTitleBarTheme } from '../popout-window'")
    // One resolution, both consumers — the two halves must never disagree.
    expect(effects).toMatch(
      /const chromeTheme = resolveThemePreference\(settings\.theme, nativeTheme\.shouldUseDarkColors\)/,
    )
    expect(effects).toMatch(/setTitleBarTheme\(chromeTheme, opts\.window \?\? null\)/)
    expect(effects).toMatch(/refreshPopoutTitleBarTheme\(chromeTheme\)/)
    // The save door must route through the shared block and hand it the sender.
    expect(settings).toContain('applySettingsSideEffects(')
    expect(settings).toMatch(/window: BrowserWindow\.fromWebContents\(event\.sender\)/)
  })

  it('the secondary refresh takes the mode from its caller, not from nativeTheme', () => {
    expect(popout).toMatch(/export function refreshPopoutTitleBarTheme\(mode: string\): void/)
    // A 'light' preference must win over a dark OS — the old shape re-derived
    // the mode inside and would paint dark over a light-content popout.
    expect(popout).not.toMatch(/refreshPopoutTitleBarTheme\(\): void[\s\S]{0,200}shouldUseDarkColors/)
    expect(index).toMatch(/refreshPopoutTitleBarTheme\(bootThemeMode\)/)
  })
})
