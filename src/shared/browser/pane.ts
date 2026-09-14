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

// ── Pane state contract (A-M5) ──
// Renderer → main: what is on screen (drives fold/restore and width clamping).
export interface BrowserPaneState {
  viewKind: string
  conversationId: string | null
  chatAreaWidth: number
}

/** One row in the pane's tab strip. */
export interface PaneTabInfo {
  id: string
  url: string
  title: string
  active: boolean
}

/** Main → renderer: the pane snapshot the chrome and chat layout render from. */
export interface BrowserPaneUpdate {
  visible: boolean
  width: number
  conversationId: string | null
  tabs: PaneTabInfo[]
}

/** User gestures from the pane chrome (tab strip, address bar, buttons). */
export type BrowserPaneAction =
  | { op: 'newTab' }
  | { op: 'selectTab'; tabId: string }
  | { op: 'closeTab'; tabId: string }
  | { op: 'navigate'; tabId: string; url: string }
  | { op: 'back'; tabId: string }
  | { op: 'forward'; tabId: string }
  | { op: 'reload'; tabId: string }
  | { op: 'openExternal'; url: string }

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

/** The viewport width pages are authored against — the pane scales pages
 *  down from here so a 16:9 box shows the WHOLE page, proportionally
 *  (setZoomFactor), instead of cropping a 1:1 render. Matches the managed
 *  backend's viewport. */
export const PANE_DESIGN_WIDTH = 1280

/** Proportional page scale for a pane width: pane / design width, never
 *  above 1 (no pointless zoom-in on wide panes), floored so tiny panes stay
 *  at least legible-ish. */
export function zoomForWidth(paneWidth: number): number {
  return Math.min(1, Math.max(0.2, paneWidth / PANE_DESIGN_WIDTH))
}

/** Address-bar normalization: bare hosts like `mail.163.com` or
 *  `localhost:5173` become `https://…` — the URL whitelist requires a scheme
 *  and a real browser completes one silently. Anything already schemed
 *  passes through untouched. */
export function normalizeAddressBarInput(raw: string): string {
  const input = raw.trim()
  if (/^(https?:\/\/|about:)/i.test(input)) return input
  return `https://${input}`
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
