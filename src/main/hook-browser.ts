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

/** Windows whose close was ordered by code (handle.close() or the watchdog),
 *  marked BEFORE destroy() so the classification below is deterministic no
 *  matter when the 'closed' event actually lands. */
const programmaticCloses = new WeakSet<BrowserWindow>()

/** Whether the most recent hook-window close was the USER's (title-bar X) as
 *  opposed to a programmatic one. index.ts's gate escape (gate-escape.ts)
 *  reads this as intent: with every window gone and the launch gate still
 *  holding, a user-closed login window means 「stop waiting」 — the gate is
 *  skipped silently instead of asking. Reset when a new hook window opens:
 *  the judgement is about the window population that exists now, and a
 *  user close of window A must not outlive a hook that moved on to window B. */
let lastCloseFromUser = false

export function wasLastHookWindowUserClosed(): boolean {
  return lastCloseFromUser
}

/** Close every window openBuiltInWindow created. Idempotent; the hook's own
 *  late handle.close() is idempotent too (destroyed-window check). */
export function closeAllHookWindows(): void {
  for (const win of openHookWindows) {
    programmaticCloses.add(win)
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

  lastCloseFromUser = false

  const win = new BrowserWindow({
    width: options?.width ?? DEFAULT_WIDTH,
    height: options?.height ?? DEFAULT_HEIGHT,
    title: options?.title ?? '',
    show: true,
    // The app-wide menu template (menu.ts installs one on every platform)
    // paints a menu strip on any FRAMED window — the main window never shows
    // it only because it is frameless. autoHideMenuBar covers the first
    // paint; setMenu(null) below strips it outright so Alt doesn't resurrect
    // it. Clipboard shortcuts in the page's own fields are Chromium
    // built-ins, not menu roles, so the login form keeps copy/paste.
    autoHideMenuBar: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  if (process.platform !== 'darwin') win.setMenu(null)
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

  // The constructor `title` is only the window's INITIAL title: as soon as a
  // page loads, Electron retitles the window to the page's <title> — which
  // made the hook's `title` option silent decoration on every real login
  // page. When the hook names the window, the name is load-bearing (it is
  // what the taskbar / alt-tab show while the login page may itself be
  // titled after the vendor's product), so it sticks for the window's whole
  // life, across redirects and SPA title changes alike. No title option =
  // no preference; the window keeps following the page title.
  if (options?.title) {
    win.on('page-title-updated', (event) => {
      event.preventDefault()
    })
  }

  openHookWindows.add(win)
  win.once('closed', () => {
    openHookWindows.delete(win)
    // Set.delete answers "was this a programmatic close?" — a user close
    // leaves the set untouched and is recorded as intent.
    if (!programmaticCloses.delete(win)) lastCloseFromUser = true
  })
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
        programmaticCloses.add(win)
        win.destroy()
      }
      return closed
    },
  }
}
