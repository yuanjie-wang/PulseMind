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

/**
 * Pixels the app's own TOP-RIGHT cluster must reserve so it never sits under
 * the OS window controls. The OS draws the controls ON TOP of the web content,
 * so an app button placed in their strip is both hidden and dead (clicks land
 * on the caption buttons) — the chat header's action buttons (side-pane toggle
 * + popout) inset past them instead of hugging the corner. macOS puts its
 * traffic lights on the LEFT, so the right edge is free there; Windows/Linux
 * overlay the caption buttons on the right.
 */
export function titleBarRightInset(controls: WindowControlsLayout): number {
  return controls.side === 'right' ? controls.inset : 0
}

/** The app's own gutter before the top-right action cluster, on top of the
 *  reserved OS strip. The header's regular 24px is right on macOS, where the
 *  traffic lights are across the bar and the cluster is the last thing on the
 *  right. Windows/Linux is the opposite: the caption buttons sit flush against
 *  the web content and already bring their own whitespace (each glyph is
 *  centred in a 46px button), so any gutter reads as a hole between the two
 *  clusters — user rulings 2026-11-04: 先减 15px（24 → 9），随后「干脆把那
 *  9px 也去掉」，于是 Win/Linux 贴到 OS 条边上、与原生按钮连成一条。 */
const TITLE_BAR_ACTION_GUTTER = 24
const CAPTION_ADJACENT_ACTION_GUTTER = 0

/** `right` offset for the header's action cluster: its own gutter plus the OS
 *  strip it must stay clear of. Both windows read this so they cannot drift. */
export function titleBarActionsRight(controls: WindowControlsLayout): number {
  const gutter = controls.side === 'right' ? CAPTION_ADJACENT_ACTION_GUTTER : TITLE_BAR_ACTION_GUTTER
  return gutter + titleBarRightInset(controls)
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
export function dimTitleBarOverlayColors(  colors: TitleBarOverlayColors,
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

/** Width of one Windows caption button at 100% scale — the footprint the
 *  app's own top-right actions copy so the two clusters read as one row. */
const CAPTION_BUTTON_WIDTH = 46

export interface CaptionButtonStyle {
  /** Button footprint. The height matches the OS overlay strip
   *  (titleBarOverlay.height = TITLE_BAR_HEIGHT), so the app's buttons are the
   *  same size as the OS-drawn min/max/close next to them. */
  width: number
  height: number
  /** Fill on hover / press — Windows' caption buttons light up under the
   *  pointer; theirs is a neutral grey, and close's red is not applicable. */
  hoverBg: string
  activeBg: string
  /** Glyph colour: the very value the OS draws with
   *  (resolveTitleBarOverlayColors), so the symbols match, not merely rhyme. */
  symbolColor: string
}

/**
 * The visual spec for the header's top-right actions on Windows/Linux, where
 * they sit directly beside the native caption buttons (user ruling 2026-10-30:
 * 风格尽量贴近 windows/linux 的窗口按钮). Consumed as CSS custom properties by
 * the `.pm-caption-btn` class in src/renderer/index.html; macOS keeps the
 * app's own rounded icon-button look (its traffic lights are elsewhere, so
 * there is no neighbour idiom to match).
 */
export function resolveCaptionButtonStyle(theme: string): CaptionButtonStyle {
  const { symbolColor } = resolveTitleBarOverlayColors(theme)
  return theme === 'dark'
    ? { width: CAPTION_BUTTON_WIDTH, height: TITLE_BAR_HEIGHT, hoverBg: '#3A3A3A', activeBg: '#4A4A4A', symbolColor }
    : { width: CAPTION_BUTTON_WIDTH, height: TITLE_BAR_HEIGHT, hoverBg: '#E5E5E5', activeBg: '#D6D6D6', symbolColor }
}

/** The spec above as CSS custom properties, ready to spread onto the header
 *  actions cluster (`.pm-caption-btn` reads them; see src/renderer/index.html).
 *  Kept here so the main window and the popout window cannot drift. */
export function captionButtonVars(theme: string): Record<string, string> {
  const s = resolveCaptionButtonStyle(theme)
  return {
    '--pm-caption-btn-width': `${s.width}px`,
    '--pm-caption-btn-height': `${s.height}px`,
    '--pm-caption-hover': s.hoverBg,
    '--pm-caption-active': s.activeBg,
    '--pm-caption-symbol': s.symbolColor,
  }
}
