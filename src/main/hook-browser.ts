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

import { BrowserWindow, app } from 'electron'
import { assertAllowedUrl } from '../shared/browser-client/protocol'
import type { HookWindowHandle, HookWindowOptions } from '../shared/types/hooks'

const DEFAULT_WIDTH = 1024
const DEFAULT_HEIGHT = 768

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
