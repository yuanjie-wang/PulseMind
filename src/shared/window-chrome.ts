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

/**
 * Blend overlay colours as they would appear under a black mask of `alpha`
 * painted over the header (a global modal's dim layer). The caption buttons are
 * drawn by the OS ON TOP of the web content, so the mask can never dim them —
 * without this they stay at full brightness over a dimmed header while a modal
 * is open (Windows: the buttons 穿帮 through the 弹窗遮罩). The renderer is the
 * one side that knows a mask is open; it reports the combined alpha and main
 * repaints the overlay with these pre-dimmed colours. Masks are black in every
 * case that matters (antd's colorBgMask `rgba(0,0,0,0.45)`, hand-rolled
 * overlays like the image viewer's 0.85), so one alpha is the whole story.
 * `alpha` is clamped to [0, 1]; 0 returns the input colours unchanged.
 */
export function dimTitleBarOverlayColors(
  colors: TitleBarOverlayColors,
  alpha: number,
): TitleBarOverlayColors {
  // Non-finite alpha (a bridge carrying garbage) must read as "no mask", not
  // paint `NaN` hex onto the window chrome.
  const a = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 0
  if (a === 0) return colors
  const dim = (hex: string): string => {
    const ch = (start: number): string =>
      Math.round(Number.parseInt(hex.slice(start, start + 2), 16) * (1 - a))
        .toString(16)
        .padStart(2, '0')
    return `#${ch(1)}${ch(3)}${ch(5)}`
  }
  return { color: dim(colors.color), symbolColor: dim(colors.symbolColor) }
}
