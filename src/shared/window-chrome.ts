// Chrome for the title bar, shared by the main process and the renderer.
//
// The window is created with titleBarStyle 'hidden' (see src/main/window-chrome.ts),
// so the native bar is gone and the OS draws the window controls straight onto the top
// bar the app already had: the 56px header. That header is also the drag surface, so
// no space is spent on empty chrome.
//
// The two sides must agree: the main process sizes the bar and the overlay, and the
// renderer has to reserve the room the controls occupy, or the sidebar title (macOS)
// and the context ring (Windows, Linux) end up underneath them.

/** Height of the app's top bar, which doubles as the window drag area. */
export const TITLE_BAR_HEIGHT = 56

/** Width of the macOS traffic lights, plus the gap before app content may start. */
const MACOS_TRAFFIC_LIGHT_INSET = 64

/** Width of the three Windows/Linux caption buttons. */
const CAPTION_BUTTONS_INSET = 138

export interface WindowControlsLayout {
  /** Side of the top bar the OS draws the window controls on. */
  side: 'left' | 'right'
  /** Pixels to reserve there, on top of the app's own padding. */
  inset: number
}

export function resolveWindowControlsLayout(platform: string): WindowControlsLayout {
  return platform === 'darwin'
    ? { side: 'left', inset: MACOS_TRAFFIC_LIGHT_INSET }
    : { side: 'right', inset: CAPTION_BUTTONS_INSET }
}

export interface TitleBarOverlayColors {
  color: string
  symbolColor: string
}

/**
 * Colours for the caption button overlay, which has to match the header it is drawn
 * over. Those are antd's colorBgContainer values: #ffffff for the light theme,
 * #141414 for the dark one.
 */
export function resolveTitleBarOverlayColors(theme: string): TitleBarOverlayColors {
  return theme === 'dark'
    ? { color: '#141414', symbolColor: '#CCCCCC' }
    : { color: '#FFFFFF', symbolColor: '#333333' }
}
