// ── Browser command protocol (PLAN: Browser Use A-M1) ──
// The only coupling between the three layers: the renderer-side facade turns
// method calls into these commands, the main-side BrowserService executes them
// against a backend. Pure types + pure URL policy — no Playwright import, so
// the vitest suite can cover the shared halves.

/** Schemes a browser command may navigate to; `file:` is only a backend
 *  selection hint, never a navigation target (安全边界 §6). */
export const BROWSER_ALLOWED_SCHEMES = ['http:', 'https:', 'about:'] as const

export const BROWSER_DEFAULT_TIMEOUT_MS = 60_000
/** Return values above this size are truncated — big payloads must go through
 *  emitImage/screenshot instead of the JSON return channel. */
export const BROWSER_MAX_RETURN_BYTES = 256 * 1024

export type BrowserBackendType = 'managed' | 'app-view'

export interface BackendDescriptor {
  id: string
  type: BrowserBackendType
  /** Capability names per object level; the manifest policy hides members the
   *  backend does not carry (M5R-style negotiation, ZCode-aligned). */
  capabilities: { browser: string[]; tab: string[] }
}

export interface BrowserTabInfo {
  id: string
  url: string
  title?: string
}

/** What `evaluate` takes: source text, or a function Playwright calls inside
 *  the page. Both are legal because BrowserCommand never crosses IPC — the
 *  kernel builds it in-process (main/host calls `runBrowserCode` with a code
 *  string), so a function value survives the trip. */
export type PageExpression = string | ((...args: unknown[]) => unknown)

export type BrowserCommand =
  | { method: 'getDescriptor' }
  | { method: 'setActiveBackend'; backend: 'managed' | 'app-view' }
  | { method: 'userOpenTabs' }
  | { method: 'claimTab'; tabId: string }
  | { method: 'listTabs' }
  | { method: 'listDownloads' }
  | { method: 'listFavorites' }
  | { method: 'addFavorite'; url: string; title?: string }
  | { method: 'removeFavorite'; url: string }
  | { method: 'newTab'; url?: string }
  | { method: 'getState'; tabId: string }
  | { method: 'navigate'; tabId: string; url: string }
  | { method: 'back'; tabId: string }
  | { method: 'forward'; tabId: string }
  | { method: 'reload'; tabId: string }
  | { method: 'close'; tabId: string }
  | { method: 'snapshot'; tabId: string; full?: boolean }
  | { method: 'screenshot'; tabId: string; fullPage?: boolean; selector?: string }
  | { method: 'evaluate'; tabId: string; expression: PageExpression }
  | { method: 'playwright'; tabId: string; selector: string; op: string; arg?: string; timeoutMs?: number }
  | { method: 'playwrightWaitForTimeout'; tabId: string; ms: number }

export type BrowserCommandResult =
  | { ok: true; value?: unknown }
  | { ok: false; error: { code: string; message: string } }

export function browserOk(value?: unknown): BrowserCommandResult {
  return value === undefined ? { ok: true } : { ok: true, value }
}

export function browserError(code: string, message: string): BrowserCommandResult {
  return { ok: false, error: { code, message } }
}

/** Throw-on-bad URL policy shared by facade (pre-check) and service (enforce). */
export function assertAllowedUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`非法 URL：${url}`)
  }
  if (!(BROWSER_ALLOWED_SCHEMES as readonly string[]).includes(parsed.protocol)) {
    throw new Error(`不允许的 URL scheme：${parsed.protocol}（仅支持 http/https）`)
  }
  return parsed.toString()
}
