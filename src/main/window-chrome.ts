import { BrowserWindow } from 'electron'
import { resolveTitleBarOverlayColors, TITLE_BAR_HEIGHT } from '../shared/window-chrome'

// macOS traffic light buttons are 12px across; centring them in the top bar keeps
// them level with the caption buttons on Windows/Linux.
const TRAFFIC_LIGHT_DIAMETER = 12
const TRAFFIC_LIGHT_LEFT_INSET = 16

// The caption button overlay has to match the header it is drawn over, and that
// colour follows the app theme. Held here because the theme is known before the
// window exists (read from settings at startup) and can change while it is open.
let titleBarTheme = 'light'

interface TitleBarOptions {
  titleBarStyle: 'hidden'
  trafficLightPosition?: { x: number; y: number }
  titleBarOverlay?: { color: string; symbolColor: string; height: number }
}

/**
 * Window options that hand the title bar to the app while the OS keeps owning the
 * window controls. Deliberately not `frame: false`: keeping a real title bar style
 * preserves native resize edges, double-click-to-zoom, the green-button full screen
 * animation and Windows snap, none of which then have to be reimplemented.
 */
export function resolveTitleBarOptions(): TitleBarOptions {
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
  if (process.platform === 'darwin' || !win || win.isDestroyed()) return
  win.setTitleBarOverlay({ ...resolveTitleBarOverlayColors(theme), height: TITLE_BAR_HEIGHT })
}
