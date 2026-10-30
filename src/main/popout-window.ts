// ── Secondary windows: conversation popouts + project (immersive) windows ──
// (PLAN-conversation-popout 2026-10-30; project windows 2026-10-30 — the
// project window REUSES this module rather than introducing a second window
// class: same chrome, same gates, same single-writer chain.)
//
// A conversation popped out of the main window into its own BrowserWindow.
// The window loads the SAME renderer entry with a `?popout=<convId>` query
// param; the renderer boots a reduced app (PopoutApp) bound to that one
// conversation. Everything that matters lives elsewhere on purpose:
//   • Sessions are main-hosted (M1.4) and AGENT_SESSION_EVENT already
//     broadcasts to every window (agent-session.handler.ts), so the popout is
//     just another protocol client — createSession is idempotent, snapshot()
//     re-attaches.
//   • The popout NEVER disposes a session: closing the window only closes the
//     window (user ruling 2026-10-30); the conversation keeps running in the
//     main-hosted engine and the main window's mirror keeps saving it.
//   • This module owns NO agent state — a registry of windows, their chrome,
//     and the popout event broadcast. Importing it into tests is safe (the
//     electron import resolves to the vitest stub).
//
// A PROJECT window (`?project=<projectId>`) is the same mechanism bound to a
// project instead of a fixed conversation: it picks the project's most recent
// conversation, and its ACTIVE conversation follows the in-window switcher.
// That is what `watchedSessions` is for — the window tells main which session
// it is currently driving (secondaryWatch), main rebroadcasts it on the very
// same POPOUT_EVENT channel, and the main window's existing adoption/read-
// receipt/retreat handler covers it with zero changes.
import { BrowserWindow, app, nativeTheme, screen, shell, type WebContents } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { IPC_CHANNELS } from '../shared/ipc-channels'
import { resolveThemePreference } from '../shared/theme'
import { resolveTitleBarOptions, setTitleBarTheme } from './window-chrome'
import { installPopupMotionGuard } from './motion-guard'
import { safeExternalUrl } from './utils/external-url'
import { DATA_DIR } from './storage/index'
import { settingsStore } from './storage/settings-store'

/** One conversation, at most one popout: opening an already-popped
 *  conversation focuses the existing window instead of stacking mirrors. */
const popouts = new Map<string, BrowserWindow>()

/** One project, at most one project window (idempotent focus, same rule). */
const projectWindows = new Map<string, BrowserWindow>()

/** session id → the project window currently driving it. Only PROJECT windows
 *  register here; a conversation popout is keyed by its own id in `popouts`
 *  and announces itself at open/close. The registry is what keeps two windows
 *  from carrying the same conversation: `openPopoutWindow` refuses to mint a
 *  popout for a session a project window already holds, and
 *  `listPopoutConversations` unions it so the main window's mount re-sync
 *  (which rebuilds its registry empty after a renderer reload) sees them. */
const watchedSessions = new Map<string, BrowserWindow>()

/** Cascade offset for successive windows so two don't land exactly on top of
 *  each other. Wraps after a handful — this is a nudge, not a layout. */
const CASCADE_STEP = 28
const CASCADE_WRAP = 6
let cascadeCount = 0

function appIconPath(): string {
  const name = process.platform === 'win32' ? 'pulseMind-win.ico' : 'pulseMind.png'
  const prodBase = process.resourcesPath
  if (prodBase) {
    const prodPath = join(prodBase, 'resources', name)
    if (existsSync(prodPath)) return prodPath
  }
  return join(__dirname, '../../resources', name)
}

/** Pre-paint background matching the theme the renderer will resolve (same
 *  resolution the main window boot does: preference against nativeTheme). */
async function popoutBackground(): Promise<string> {
  try {
    const theme = resolveThemePreference((await settingsStore.get()).theme, nativeTheme.shouldUseDarkColors)
    return theme === 'dark' ? '#141414' : '#ffffff'
  } catch {
    return nativeTheme.shouldUseDarkColors ? '#141414' : '#ffffff'
  }
}

/** Cascade origin for the next secondary window, centered on the work area. */
function cascadeOrigin(width: number, height: number): { x: number; y: number } {
  const workArea = screen.getPrimaryDisplay().workArea
  const cascade = (cascadeCount++ % CASCADE_WRAP) * CASCADE_STEP
  return {
    x: workArea.x + Math.max(0, Math.round((workArea.width - width) / 2)) + cascade,
    y: workArea.y + Math.max(0, Math.round((workArea.height - height) / 2)) + cascade,
  }
}

/** The shared window skeleton: preload, sandbox posture, chrome and the motion
 *  guard. Divergent sizing is the caller's business. */
function createSecondaryWindow(opts: {
  width: number
  height: number
  minWidth: number
  minHeight: number
  title: string
  background: string
}): BrowserWindow {
  const { x, y } = cascadeOrigin(opts.width, opts.height)
  const win = new BrowserWindow({
    x,
    y,
    width: opts.width,
    height: opts.height,
    minWidth: opts.minWidth,
    minHeight: opts.minHeight,
    title: opts.title,
    show: false,
    backgroundColor: opts.background,
    icon: appIconPath(),
    ...resolveTitleBarOptions(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      // A hidden secondary window still streams a live turn — never throttle it.
      backgroundThrottling: false,
    },
  })
  setTitleBarTheme(opts.background === '#141414' ? 'dark' : 'light', win)
  installPopupMotionGuard(win)
  return win
}

/** The two navigation gates every window carries (index.ts P0-2): the
 *  renderer's window.open goes to the OS launcher through the scheme gate, and
 *  in-window navigation is the renderer's own business (HMR reload, wc.reload)
 *  — same URL or dev origin only. */
function attachNavigationGates(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler((details) => {
    const safe = safeExternalUrl(details.url, DATA_DIR)
    if (safe) void shell.openExternal(safe)
    return { action: 'deny' }
  })
  const devOrigin = process.env.ELECTRON_RENDERER_URL ? new URL(process.env.ELECTRON_RENDERER_URL).origin : null
  win.webContents.on('will-navigate', (details) => {
    try {
      if (details.url === win.webContents.getURL()) return
      if (devOrigin && new URL(details.url).origin === devOrigin) return
    } catch {
      // unparsable URL — fall through and block
    }
    details.preventDefault()
  })
}

/** The window's title is a hard commitment: Electron would otherwise retitle
 *  the window to the loaded page's <title> (hook-browser's sticky-title
 *  lesson), which would flip the OS window identity to index.html on load. */
function pinTitle(win: BrowserWindow): void {
  win.on('page-title-updated', (event) => { event.preventDefault() })
}

/** Main → every window. The MAIN window consumes popout events (adoption +
 *  read receipt); the secondary windows themselves receive them and ignore. */
export function broadcastPopoutEvent(type: 'opened' | 'closed', sessionId: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      try { win.webContents.send(IPC_CHANNELS.POPOUT_EVENT, { type, sessionId }) } catch { /* window closing */ }
    }
  }
}

export function popoutWindowCount(): number {
  return popouts.size + projectWindows.size
}

/** The conversations currently carried by a secondary window — the main window
 *  re-syncs its popout registry from this on mount. A renderer reload (HMR,
 *  the unresponsive-recovery reload) rebuilds that registry empty, and an empty
 *  registry silently re-enables in-window opening AND drops the adoption that
 *  keeps such conversations saved; the mount query heals both. Project windows
 *  contribute the session they are driving RIGHT NOW (their registry entry). */
export function listPopoutConversations(): string[] {
  return [...popouts.keys(), ...watchedSessions.keys()]
}

export function closeAllPopouts(): void {
  for (const win of popouts.values()) {
    if (!win.isDestroyed()) win.destroy()
  }
  popouts.clear()
  // Project windows are secondary windows too (user ruling 2026-10-30: the
  // main window's close takes every secondary window with it).
  for (const win of projectWindows.values()) {
    if (!win.isDestroyed()) win.destroy()
  }
  projectWindows.clear()
  watchedSessions.clear()
}

/**
 * A project window reports the conversation it is currently driving (null when
 * it has none — a brand-new project, or a draft). Main owns the broadcast, so
 * the renderer never has to know about POPOUT_EVENT.
 *
 * A SWITCH is naturally two transitions: this drops the window's previous
 * watch (broadcasting 'closed') before taking the new one (broadcasting
 * 'opened') — the main window's handler treats 'closed' as 「stop judging this
 * conversation as popped out」, which is exactly right for the conversation the
 * project window just left.
 */
export function recordSecondaryWatch(win: BrowserWindow, sessionId: string | null): void {
  if (win.isDestroyed()) return
  for (const [sid, holder] of [...watchedSessions]) {
    if (holder === win && sid !== sessionId) {
      watchedSessions.delete(sid)
      broadcastPopoutEvent('closed', sid)
    }
  }
  if (!sessionId) return
  if (watchedSessions.get(sessionId) === win) return
  watchedSessions.set(sessionId, win)
  broadcastPopoutEvent('opened', sessionId)
}

/** The IPC-side entry: resolve the sending window from the webContents. */
export function recordSecondaryWatchFromSender(sender: WebContents, sessionId: string | null): void {
  const win = BrowserWindow.fromWebContents(sender)
  if (win) recordSecondaryWatch(win, sessionId)
}

/**
 * Pop `convId` out into its own window (focus the existing one if already
 * popped). Fire-and-forget from the IPC handler's perspective: window
 * creation problems are logged, never thrown into the renderer's send path.
 */
export async function openPopoutWindow(convId: string, title?: string): Promise<void> {
  if (!convId) return
  await app.whenReady()
  // The conversation may already be living in a PROJECT window (its switcher
  // drove it there). Minting a second window for it would put one conversation
  // in two windows and two live clients on one session — raise the holder.
  const holder = watchedSessions.get(convId)
  if (holder && !holder.isDestroyed()) {
    if (holder.isMinimized()) holder.restore()
    holder.focus()
    return
  }
  const existing = popouts.get(convId)
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.focus()
    return
  }

  const background = await popoutBackground()
  const workArea = screen.getPrimaryDisplay().workArea
  const width = Math.max(480, Math.min(720, Math.round(workArea.width * 0.42)))
  const height = Math.max(480, Math.min(workArea.height, Math.round(workArea.height * 0.78)))
  const win = createSecondaryWindow({
    width,
    height,
    minWidth: 420,
    minHeight: 360,
    title: title || 'PulseMind',
    background,
  })

  popouts.set(convId, win)
  // Announce IMMEDIATELY (synchronously): the main window's reaction is
  // load-bearing and must not wait on the popout's own renderer boot — it
  // adopts the conversation (single-writer saves), clears the unread light,
  // and retreats its own view to the welcome page so the same conversation is
  // never shown in two windows. Without this broadcast every downstream effect
  // silently disappears (found in testing 2026-10-30: the event had a 'closed'
  // sender only).
  broadcastPopoutEvent('opened', convId)
  win.once('closed', () => {
    popouts.delete(convId)
    // Ruling: closing the popout only closes the window — the main-hosted
    // session is untouched; this event just tells the main window to stop
    // treating the conversation as popped out (eviction/unread semantics).
    broadcastPopoutEvent('closed', convId)
  })

  attachNavigationGates(win)
  // The window's title IS the conversation: the renderer retitles its header
  // live, but the OS window must not flip to index.html's <title> on load
  // (hook-browser's sticky-title lesson). A later rename goes through
  // setPopoutTitle; the initial title is pinned here.
  if (title) pinTitle(win)

  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    const devUrl = new URL(process.env.ELECTRON_RENDERER_URL)
    devUrl.searchParams.set('popout', convId)
    void win.loadURL(devUrl.toString()).catch((err: unknown) => {
      console.warn(`[popout] loadURL failed for ${convId}:`, err)
    })
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { query: { popout: convId } }).catch((err: unknown) => {
      console.warn(`[popout] loadFile failed for ${convId}:`, err)
    })
  }

  // Ruling: closing the MAIN window closes every popout. Wired from
  // index.ts's createWindow (mainWindow.on('closed')) — popouts only exist
  // after startup, so the launch-gate's zero-window escape is unaffected.
}

/**
 * Open the immersive window for a project (focus the existing one). Sized for
 * three columns (tree | preview | chat) — deliberately much wider than a
 * conversation popout's 480–720px, which is built for a single chat column.
 */
export async function openProjectWindow(projectId: string, name?: string): Promise<void> {
  if (!projectId) return
  await app.whenReady()
  const existing = projectWindows.get(projectId)
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.focus()
    return
  }

  const background = await popoutBackground()
  const workArea = screen.getPrimaryDisplay().workArea
  const width = Math.max(1000, Math.min(workArea.width, Math.round(workArea.width * 0.9)))
  const height = Math.max(640, Math.min(workArea.height, Math.round(workArea.height * 0.88)))
  const win = createSecondaryWindow({
    width,
    height,
    minWidth: 1000,
    minHeight: 640,
    title: name || 'PulseMind',
    background,
  })

  projectWindows.set(projectId, win)
  // No 'opened' broadcast here: at this instant the window carries no
  // conversation yet (it picks the project's latest on boot). The per-session
  // announcement rides `recordSecondaryWatch`, which keeps the main window's
  // adoption in step with whatever the in-window switcher selects.
  win.once('closed', () => {
    projectWindows.delete(projectId)
    // Whatever session it was driving is no longer watched — the main window
    // stops treating it as popped out (mirror and saves stay).
    for (const [sid, holder] of [...watchedSessions]) {
      if (holder === win) {
        watchedSessions.delete(sid)
        broadcastPopoutEvent('closed', sid)
      }
    }
  })

  attachNavigationGates(win)
  if (name) pinTitle(win)

  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    const devUrl = new URL(process.env.ELECTRON_RENDERER_URL)
    devUrl.searchParams.set('project', projectId)
    void win.loadURL(devUrl.toString()).catch((err: unknown) => {
      console.warn(`[project-window] loadURL failed for ${projectId}:`, err)
    })
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { query: { project: projectId } }).catch((err: unknown) => {
      console.warn(`[project-window] loadFile failed for ${projectId}:`, err)
    })
  }
}

/** A conversation was renamed (DB write already done): keep the popped
 *  window's OS title in step. No-op when it isn't popped. */
export function setPopoutTitle(convId: string, title: string): void {
  const win = popouts.get(convId)
  if (win && !win.isDestroyed()) win.setTitle(title)
}

/** OS light/dark flipped while running: secondary caption overlays follow the
 *  main window's own refresh (index.ts applyNativeThemeChange). */
export function refreshPopoutTitleBarTheme(): void {
  const mode = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  for (const win of [...popouts.values(), ...projectWindows.values()]) {
    if (!win.isDestroyed()) setTitleBarTheme(mode, win)
  }
}
