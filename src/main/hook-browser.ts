// ── Hook browser primitive (ctx.browser.open) ──
// The login-flow seam for app-start.js: open a page in a standalone window
// of the app's OWN Chromium (default persistent session — a login performed
// here lands in the same profile the in-app pane uses) and hand the hook a
// handle to close it when its own polling says the login is done.
//
// Deliberately minimal (user decision 2026-09-25): open + close only. The
// completion signal is the hook polling its server-side session endpoint —
// no url()/cookies() observation on the handle (they can grow later as
// optional fields without breaking a single hook). Kept as its own module,
// free of DB/audit/service dependencies, so a future flow registry or a
// runtime trigger (connector missing credentials) calls this same function.

import { BrowserWindow, app, shell } from 'electron'
import { assertAllowedUrl } from '../shared/browser-client/protocol'
import { safeExternalUrl } from './utils/external-url'
import { DATA_DIR } from './storage/index'
import type { HookWindowHandle, HookWindowOptions } from '../shared/types/hooks'

const DEFAULT_WIDTH = 1024
const DEFAULT_HEIGHT = 768

/** Every window this module opened, so the launch-hook watchdog can close the
 *  hook's login window when it abandons the flow (review 2026-09-26 中4) — a
 *  timed-out hook must not leave a login window floating over the app that
 *  already moved on. */
const openHookWindows = new Set<BrowserWindow>()

/** Close every window openBuiltInWindow created. Idempotent; the hook's own
 *  late handle.close() is idempotent too (destroyed-window check). */
export function closeAllHookWindows(): void {
  for (const win of openHookWindows) {
    if (!win.isDestroyed()) win.destroy()
  }
  openHookWindows.clear()
}

/** Registered by index.ts: the splash and the login window must never share
 *  the screen (user ruling 2026-09-25), so the owner CLOSES the splash the
 *  moment this fires — same synchronous tick as the window's creation, so
 *  no frame is ever composited with both. Kept as a listener rather than an
 *  import so this module stays free of entry-point coupling (a future flow
 *  registry reuses it untouched). */
let onWindowOpen: (() => void) | null = null

export function setHookWindowOpenListener(fn: (() => void) | null): void {
  onWindowOpen = fn
}

/**
 * Open `url` in a standalone built-in-browser window and return a handle.
 * Throws on a URL the built-in browser's scheme gate rejects (http/https/
 * about) — before any window is created.
 *
 * Resolves once the window exists and navigation has been STARTED: a slow or
 * failing page is the user's to see (loadURL failures are logged, not
 * thrown), so the hook's own wait loop is never held by page load.
 */
export async function openBuiltInWindow(
  url: string,
  options?: HookWindowOptions,
): Promise<HookWindowHandle> {
  const target = assertAllowedUrl(url)
  await app.whenReady()

  const win = new BrowserWindow({
    width: options?.width ?? DEFAULT_WIDTH,
    height: options?.height ?? DEFAULT_HEIGHT,
    title: options?.title ?? '',
    show: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  onWindowOpen?.()

  // The login window loads ARBITRARY remote content (third-party scripts
  // included), so it carries the same two gates the main window got in P0-2
  // (review 2026-09-26 中3) — assertAllowedUrl only gated the FIRST url:
  //   • window.open/target=_blank: denied as a new window; the URL goes to
  //     the OS launcher through safeExternalUrl's scheme gate, never raw.
  //   • will-navigate: the login flow legitimately redirects and the user
  //     clicks links, so every http/https navigation passes (unlike the main
  //     window's own-origin-only rule) — what must not happen is the page
  //     moving this window to file:// or a custom scheme.
  win.webContents.setWindowOpenHandler((details) => {
    const safe = safeExternalUrl(details.url, DATA_DIR)
    if (safe) void shell.openExternal(safe)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (details) => {
    let protocol = ''
    try {
      protocol = new URL(details.url).protocol
    } catch {
      // unparsable URL — fall through and block
    }
    if (protocol === 'http:' || protocol === 'https:') return
    details.preventDefault()
    console.warn(`[hook-browser] blocked in-window navigation to ${protocol || details.url}`)
  })

  openHookWindows.add(win)
  win.once('closed', () => { openHookWindows.delete(win) })
  win.loadURL(target).catch((err: unknown) => {
    // The window is already open and showing whatever it can (an error page
    // is a visible answer); failing open() here would tear down the flow.
    console.warn(`[hook-browser] loadURL failed for ${target}:`, err)
  })

  let closed: Promise<void> | null = null
  return {
    close(): Promise<void> {
      if (win.isDestroyed()) return Promise.resolve()
      if (!closed) {
        closed = new Promise<void>((resolve) => {
          win.once('closed', () => resolve())
        })
        // destroy, not close: the login page may hold an beforeunload prompt
        // and close()'s contract is "resolved once it is gone", not "asked".
        win.destroy()
      }
      return closed
    },
  }
}
