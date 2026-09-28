// ── App-view pane layout math (A-M5) ──
// Pure geometry shared by the renderer chrome (DOM) and the main-process dock
// (native WebContentsView bounds) — both must agree on every pixel, so the
// rules live here and are unit-tested. Decisions (2026-09-13): strict 16:9
// WebView, vertically centered below the chrome; pane width default 40% of
// the chat area, draggable, clamped to [320, 60% of chat area], remembered
// globally in settings.

/** Chrome rows above the WebView, measured from the pane's top: the
 *  workbench's tool-tab strip (32px, PLAN-workbench W4) + the browser pane's
 *  own tab strip (32px) + address bar (36px). Shared by the renderer chrome
 *  and the main-process dock — both must agree on every pixel. */
export const PANE_CHROME_HEIGHT = 100
export const PANE_MIN_WIDTH = 320
/** Drag ceiling: the chat area always keeps at least 40% of its width. */
export const PANE_MAX_CHAT_RATIO = 0.6
/** First-open default before the user drags. */
export const PANE_DEFAULT_CHAT_RATIO = 0.4
/** Left-edge drag handle thickness (renderer DOM). */
export const PANE_DRAG_HANDLE_WIDTH = 6
/** The chat/pane divider is the workbench pane's own 1px CSS border —
 *  renderer DOM — and a native WebContentsView paints over DOM, so the
 *  WebView is inset past it (one px narrower) or a loaded page hides the
 *  divider. */
export const PANE_BORDER_WIDTH = 1

// ── Pane state contract (A-M5) ──
// Renderer → main: what is on screen (drives fold/restore and width clamping).
export interface BrowserPaneState {
  viewKind: string
  conversationId: string | null
  chatAreaWidth: number
  /** PLAN-workbench W3: false while the workbench shows a non-browser tab —
   *  the native WebView folds (tabs stay alive), the chrome stays put.
   *  Absent/true = the browser tab is frontmost. */
  browserActive?: boolean
  /** PLAN-browser-pane-ux T3.5: pixel height of chrome UI that overhangs the
   *  webview area (the address bar's suggestion dropdown). A WebContentsView
   *  paints ABOVE all DOM, so an open dropdown is invisible unless the dock
   *  shifts the webview down by exactly this much. 0/absent = closed. */
  chromeOverlayHeight?: number
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
  /** Address-bar navigation. `tabId` is absent when the pane has no tab open
   *  yet — the address then means "open a tab and go there", which the service
   *  fulfils. The chrome cannot mint the id itself: main owns tab ids and only
   *  reports them on the next pane update. */
  | { op: 'navigate'; tabId?: string; url: string }
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

// ── window.open routing (2026-09-28) ──
// A page inside the pane that calls window.open — or a target=_blank link —
// used to hit Electron's DEFAULT handler, which spawns a real OS window
// floating over the app (user report 2026-09-28: 「会出现一个新窗口，而不是
// 在内置浏览器中增加一个新页签」). The pane tab's setWindowOpenHandler
// classifies every request through this pure function and denies it; the
// survivors are re-opened by BrowserService as pane tabs of the OPENER's own
// conversation. Discardable shapes (about:blank write-backs, downloads) die
// here — one place, unit-covered, so the Electron side stays a thin pipe.

export type WindowOpenRoute =
  /** Open as a new pane tab in the opener's conversation. */
  | { action: 'tab'; url: string }
  /** Not pane content — the caller gates it through safeExternalUrl and
   *  hands it to the OS launcher (mailto:, custom protocols). */
  | { action: 'external'; url: string }
  /** Deny and do nothing. */
  | { action: 'ignore' }

/** Classify one window-open request from a pane page. `disposition` is
 *  Electron's own (this is only ever called from setWindowOpenHandler). */
export function routeWindowOpen(rawUrl: string, disposition: string): WindowOpenRoute {
  // A download is not a window: the session's will-download hook already
  // routes it (user → ~/Downloads, agent → the conversation workspace).
  // Minting a tab here would park an empty page next to the download.
  if (disposition === 'save-to-disk') return { action: 'ignore' }
  const url = typeof rawUrl === 'string' ? rawUrl.trim() : ''
  // `window.open('')` + the opener writes into the window cannot be
  // honoured: the denied window.open returns null to the page, so nothing
  // can reach a tab we mint — a blank pane tab would be dead weight.
  if (!url || /^about:/i.test(url)) return { action: 'ignore' }
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return { action: 'tab', url: parsed.toString() }
    }
  } catch {
    return { action: 'ignore' }
  }
  return { action: 'external', url }
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

/** 收藏键的规范化（PLAN-browser-favorites L3）：host 小写、去尾斜杠、去
 *  hash——`https://a.com/b` 与 `https://A.com/b/#top` 是同一条收藏。查询
 *  串保留（不同参数常常是不同页面）。非 http(s) 原样返回 trim 后的值，
 *  空/null 返回空串（调用方拒收）。 */
export function normalizeFavoriteUrl(raw: string): string {
  const input = (raw ?? '').trim()
  if (!input) return ''
  try {
    const u = new URL(input)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return input
    u.hash = ''
    u.hostname = u.hostname.toLowerCase()
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1)
    let out = u.toString()
    if (out.endsWith('/') && u.pathname === '/') out = out.slice(0, -1)
    return out
  } catch {
    return input
  }
}

/** 收藏行（下拉联想的输入形状）——与 HistorySuggestionRow 同构除来源。 */
export interface FavoriteSuggestionRow {
  url: string
  title: string | null
}

/** 下拉联想的合并（PLAN-browser-favorites M2）：收藏先于历史（收藏是刻意
 *  数据，访问历史是副产品），同 rank 内收藏按加入时间倒序。`rankHistorySuggestions`
 *  不动——它只管历史行；合并层把收藏置顶、去重（同 URL 只出现一次），再
 *  用历史填满 limit。 */
export function mergeSuggestions(
  text: string,
  favorites: Array<FavoriteSuggestionRow & { createdAt?: number }>,
  history: Array<{ url: string; title: string | null; visitCount?: number; lastVisitAt?: number }>,
  limit = 8,
): MergedSuggestion[] {
  const needle = text.trim().toLowerCase()
  const matches = (row: { url: string; title: string | null }): boolean =>
    !needle || row.url.toLowerCase().includes(needle) || (row.title ?? '').toLowerCase().includes(needle)

  const seen = new Set<string>()
  const out: MergedSuggestion[] = []

  const favs = [...favorites]
    .filter(matches)
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  for (const f of favs) {
    const key = normalizeFavoriteUrl(f.url)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ url: f.url, title: f.title, favorite: true })
    if (out.length >= limit) return out
  }

  // 历史行按 rankHistorySuggestions 的口径交给调用方排好序；这里只去重填空。
  for (const h of history) {
    if (out.length >= limit) break
    const key = normalizeFavoriteUrl(h.url)
    if (seen.has(key)) continue
    if (!matches(h)) continue
    seen.add(key)
    out.push({ url: h.url, title: h.title, favorite: false })
  }
  return out
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

/** WebView box for a pane: strict 16:9, vertically centered in the space
 *  below the chrome. The box is inset one px on EACH side (user ruling
 *  2026-09-21, 「左右各缩进去1px，高度同比缩小」): the pane's 1px left border
 *  is renderer DOM and a native WebContentsView paints above all DOM, so a
 *  view flush against it read as covering the chat scrollbar's last pixel —
 *  the view now starts a full px past the divider and stops a px short of the
 *  window's right edge, and the height follows the width's 16:9. `x` is
 *  relative to the pane's left edge — the dock adds the pane origin. When the
 *  window is too short for the box, it hugs the chrome (top-aligned) instead
 *  of overflowing. */
export function webviewBox(paneWidth: number, paneTop: number, paneHeight: number, chromeHeight: number = PANE_CHROME_HEIGHT): PaneBox {
  // 1px divider + 1px clear on each side of the view: width = pane − 3.
  const width = Math.max(0, Math.round(paneWidth) - PANE_BORDER_WIDTH * 3)
  const height = Math.round((width * 9) / 16)
  const available = Math.max(0, paneHeight - chromeHeight)
  const top = paneTop + chromeHeight + Math.max(0, Math.floor((available - height) / 2))
  return { x: PANE_BORDER_WIDTH * 2, y: Math.max(paneTop + chromeHeight, top), width, height: Math.min(height, available) }
}

/** True while a tab has nothing the user navigated to: '' (no URL reported
 *  yet) or about:blank (a just-opened tab). ONE predicate for two readers —
 *  the main-process dock folds a fresh tab so the renderer's empty state is
 *  visible (T4.3), and the renderer shows that empty state on it (T4.4); a
 *  second copy of this rule would fold one side while the other shows a page.
 *  A tab that navigated somewhere and came BACK to about:blank also reads
 *  fresh — a blank view is a blank view, and the empty state is nicer. */
export function isFreshTabUrl(url: string | null | undefined): boolean {
  return !url || url === 'about:blank'
}

/** Display host for a URL ('example.com'); unparseable input falls back to
 *  the input itself. */
export function hostLabel(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** One address-bar history suggestion (PLAN-browser-pane-ux T3.4). */
export interface HistorySuggestionRow {
  url: string
  title?: string | null
  visitCount?: number
  lastVisitAt?: number
}

export interface RankedSuggestion {
  url: string
  title: string
  /** host-prefix beats url-substring beats title-substring; peers by
   *  recency then visit count (裁定 L4's ordering, testable here). */
  rank: 0 | 1 | 2
}

/** One merged address-bar row (PLAN-browser-favorites M2): favorites first,
 *  history fills the rest — the dropdown renders the star off `favorite`. */
export interface MergedSuggestion {
  url: string
  title: string | null
  favorite?: boolean
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return ''
  }
}

function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//i, '')
}

/**
 * Rank address-bar history rows against the typed text (pure — no IO, unit
 * covered in vitest): a host that STARTS WITH the text wins over a url that
 * merely contains it, which wins over a title match; peers order by
 * last_visit_at desc then visit_count desc. Rows that match nothing drop.
 * The typed text is compared SCHEME-LESS (same as the stored url): re-typing
 * the full "https://…" just visited — or a wrong-scheme variant of it — must
 * still联想 (user repro 2026-09-17: SQL LIKE matched, this ranker dropped the
 * row, dropdown never opened).
 */
export function rankHistorySuggestions(text: string, rows: HistorySuggestionRow[], limit = 8): RankedSuggestion[] {
  const needle = text.trim().toLowerCase()
  if (!needle) return []
  const bare = stripScheme(needle)
  const ranked: Array<RankedSuggestion & { lastVisitAt: number; visitCount: number }> = []
  for (const row of rows) {
    const url = row.url || ''
    const title = (row.title || '').toLowerCase()
    const host = hostOf(url)
    let rank: 0 | 1 | 2 | null = null
    if (host.startsWith(bare)) rank = 0
    else if (stripScheme(url).toLowerCase().includes(bare)) rank = 1
    else if (title.includes(needle)) rank = 2
    if (rank === null) continue
    ranked.push({
      url,
      title: row.title || url,
      rank,
      lastVisitAt: row.lastVisitAt ?? 0,
      visitCount: row.visitCount ?? 0,
    })
  }
  ranked.sort((a, b) =>
    a.rank - b.rank ||
    b.lastVisitAt - a.lastVisitAt ||
    b.visitCount - a.visitCount ||
    a.url.localeCompare(b.url),
  )
  return ranked.slice(0, Math.max(0, limit)).map(({ url, title, rank }) => ({ url, title, rank }))
}
