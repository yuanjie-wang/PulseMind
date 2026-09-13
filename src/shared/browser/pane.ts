// ── App-view pane layout math (A-M5) ──
// Pure geometry shared by the renderer chrome (DOM) and the main-process dock
// (native WebContentsView bounds) — both must agree on every pixel, so the
// rules live here and are unit-tested. Decisions (2026-09-13): strict 16:9
// WebView, vertically centered below the chrome; pane width default 40% of
// the chat area, draggable, clamped to [320, 60% of chat area], remembered
// globally in settings.

/** Chrome rows above the WebView: 32px tab strip + 36px address bar. */
export const PANE_CHROME_HEIGHT = 68
export const PANE_MIN_WIDTH = 320
/** Drag ceiling: the chat area always keeps at least 40% of its width. */
export const PANE_MAX_CHAT_RATIO = 0.6
/** First-open default before the user drags. */
export const PANE_DEFAULT_CHAT_RATIO = 0.4
/** Left-edge drag handle thickness (renderer DOM). */
export const PANE_DRAG_HANDLE_WIDTH = 6

export interface PaneBox {
  /** Native WebView bounds, relative to the window content area. */
  x: number
  y: number
  width: number
  height: number
}

/** Clamp a desired pane width against the chat area. `chatAreaWidth` is the
 *  width of the chat column (window content minus sidebar), as measured by
 *  the renderer. */
export function clampPaneWidth(desired: number, chatAreaWidth: number): number {
  const max = Math.max(PANE_MIN_WIDTH, Math.floor(chatAreaWidth * PANE_MAX_CHAT_RATIO))
  return Math.min(Math.max(Math.round(desired), PANE_MIN_WIDTH), max)
}

/** First-open width for a given chat area. */
export function defaultPaneWidth(chatAreaWidth: number): number {
  return clampPaneWidth(Math.floor(chatAreaWidth * PANE_DEFAULT_CHAT_RATIO), chatAreaWidth)
}

/** WebView box for a pane: full pane width, strict 16:9, vertically centered
 *  in the space below the chrome. When the window is too short for the box,
 *  it hugs the chrome (top-aligned) instead of overflowing. */
export function webviewBox(paneWidth: number, paneTop: number, paneHeight: number): PaneBox {
  const width = Math.max(0, Math.round(paneWidth))
  const height = Math.round((width * 9) / 16)
  const available = Math.max(0, paneHeight - PANE_CHROME_HEIGHT)
  const top = paneTop + PANE_CHROME_HEIGHT + Math.max(0, Math.floor((available - height) / 2))
  return { x: 0, y: Math.max(paneTop + PANE_CHROME_HEIGHT, top), width, height: Math.min(height, available) }
}
