import { BrowserWindow } from 'electron'
import { dimTitleBarOverlayColors, resolveTitleBarOverlayColors, TITLE_BAR_HEIGHT } from '../shared/window-chrome'

// macOS traffic light buttons are 12px across; centring them in the top bar keeps
// them level with the caption buttons on Windows/Linux.
const TRAFFIC_LIGHT_DIAMETER = 12
const TRAFFIC_LIGHT_LEFT_INSET = 16

// The caption button overlay has to match the header it is drawn over, and that
// colour follows the app theme. Held here because the theme is known before the
// window exists (read from settings at startup) and can change while it is open.
let titleBarTheme = 'light'

// Combined alpha of the renderer's full-window masks (0 = none), reported by the
// mask watcher (renderer/utils/title-bar-mask.ts). The OS draws the caption
// buttons ON TOP of the web content, so a modal's dim layer can never reach
// them — main pre-dims the overlay colours instead, or the buttons stay bright
// over a dimmed header (Windows: 穿帮 through the 弹窗遮罩).
let titleBarMaskAlpha = 0

interface TitleBarOptions {
  titleBarStyle: 'hidden'
  trafficLightPosition?: { x: number; y: number }
  titleBarOverlay?: { color: string; symbolColor: string; height: number }
}

/** Push the current theme × mask state at the window's overlay. No-op on macOS
 *  (the traffic lights are plain native dots — no background to repaint). */
function applyTitleBarOverlay(win: BrowserWindow | null): void {
  if (process.platform === 'darwin' || !win || win.isDestroyed()) return
  const colors = dimTitleBarOverlayColors(resolveTitleBarOverlayColors(titleBarTheme), titleBarMaskAlpha)
  win.setTitleBarOverlay({ ...colors, height: TITLE_BAR_HEIGHT })
}

/**
 * Window options that hand the title bar to the app while the OS keeps owning the
 * window controls. Deliberately not `frame: false`: keeping a real title bar style
 * preserves native resize edges, double-click-to-zoom, the green-button full screen
 * animation and Windows snap, none of which then have to be reimplemented.
 */
export function resolveTitleBarOptions(): TitleBarOptions {
  // A fresh window boots a fresh renderer with no masks open — drop whatever the
  // previous window reported (tray relaunch) rather than opening pre-dimmed and
  // waiting for the watcher's first report to correct it.
  titleBarMaskAlpha = 0
  if (process.platform === 'darwin') {
    return {
      titleBarStyle: 'hidden',
      trafficLightPosition: {
        x: TRAFFIC_LIGHT_LEFT_INSET,
        y: Math.round((TITLE_BAR_HEIGHT - TRAFFIC_LIGHT_DIAMETER) / 2),
      },
    }
  }
  // Windows and Linux: Electron draws the caption buttons over the app's own top bar.
  // symbolColor is Windows-only — Linux uses its own themed symbols.
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...resolveTitleBarOverlayColors(titleBarTheme), height: TITLE_BAR_HEIGHT },
  }
}

/**
 * Record the theme and, if a window is already open, repaint the caption buttons so
 * a runtime theme switch does not leave the previous colours behind.
 */
export function setTitleBarTheme(theme: string, win: BrowserWindow | null): void {
  titleBarTheme = theme
  applyTitleBarOverlay(win)
}

/**
 * Record the combined mask alpha the renderer reports and repaint the caption
 * buttons blended with it. Clamped and short-circuited on no change, so the
 * watcher's structural mutations (chat streaming churns the DOM constantly)
 * cost a compare when they do not move the value.
 */
export function setTitleBarMaskAlpha(alpha: number, win: BrowserWindow | null): void {
  const next = Math.min(1, Math.max(0, Number.isFinite(alpha) ? alpha : 0))
  if (next === titleBarMaskAlpha) return
  titleBarMaskAlpha = next
  applyTitleBarOverlay(win)
}
