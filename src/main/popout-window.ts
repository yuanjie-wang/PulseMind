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
import { windowIconName } from './app-icon'
import { DATA_DIR } from './storage/index'
import { settingsStore } from './storage/settings-store'
import type { PopoutWorkbenchSeed } from '../shared/types/electron-bridge'

/** One conversation, at most one popout: opening an already-popped
 *  conversation focuses the existing window instead of stacking mirrors. */
const popouts = new Map<string, BrowserWindow>()

/** convId → the donor window's side-window state (2026-10-31 ruling: 弹出携带
 *  侧边窗口的打开状态 — workbench open tab + preview file tabs). The popout
 *  renderer fetches it via POPOUT_SEED before its first render and applies it
 *  to its own stores. Purely in-memory: the entry is overwritten by the next
 *  popout of the same conversation and deleted when the window closes —
 *  nothing here is ever persisted. */
const popoutSeeds = new Map<string, PopoutWorkbenchSeed>()

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
  const name = windowIconName()
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

/** Cascade origin for the next secondary window, centered on the work area.
 *  Final x/y are clamped INTO the work area — a donor-width popout (2026-10-31
 *  同宽裁定) leaves no room for the cascade nudge, which would otherwise push
 *  it partly off-screen. */
function cascadeOrigin(width: number, height: number): { x: number; y: number } {
  const workArea = screen.getPrimaryDisplay().workArea
  const cascade = (cascadeCount++ % CASCADE_WRAP) * CASCADE_STEP
  const x = workArea.x + Math.max(0, Math.round((workArea.width - width) / 2)) + cascade
  const y = workArea.y + Math.max(0, Math.round((workArea.height - height) / 2)) + cascade
  return {
    x: Math.max(workArea.x, Math.min(x, workArea.x + Math.max(0, workArea.width - width))),
    y: Math.max(workArea.y, Math.min(y, workArea.y + Math.max(0, workArea.height - height))),
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

/** The donor's side-window seed for a popout conversation, or null. The
 *  popout renderer calls this once at boot (POPOUT_SEED), BEFORE rendering —
 *  the workbench and the preview tab strip are restored on the first frame.
 *  The entry survives renderer reloads (a reload re-fetches and re-restores);
 *  it dies with the window. */
export function getPopoutSeed(convId: string): PopoutWorkbenchSeed | null {
  return popoutSeeds.get(convId) ?? null
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
 * The main window clicked one of a project's conversations: raise the project's
 * immersive window and switch it onto `convId`. Resolves false when the project
 * has no open window — the caller opens the conversation in-window as usual.
 *
 * Holder priority mirrors `openPopoutWindow`: a single-conversation popout is
 * the more precise holder of `convId`, so it wins over the project window (and
 * switching the project window onto a session a popout already carries would
 * put one conversation in two windows). The switch order itself rides
 * POPOUT_SWITCH — a targeted send to the holding window only; the downstream
 * opened/closed announcements are recordSecondaryWatch's business, exactly as
 * for the in-window switcher.
 */
export function focusProjectConversation(projectId: string, convId: string): boolean {
  if (!projectId || !convId) return false
  const popout = popouts.get(convId)
  if (popout && !popout.isDestroyed()) {
    if (popout.isMinimized()) popout.restore()
    popout.focus()
    return true
  }
  const win = projectWindows.get(projectId)
  if (!win || win.isDestroyed()) return false
  if (win.isMinimized()) win.restore()
  win.focus()
  try { win.webContents.send(IPC_CHANNELS.POPOUT_SWITCH, { sessionId: convId }) } catch { /* window closing */ }
  return true
}

/**
 * Pop `convId` out into its own window (focus the existing one if already
 * popped). Fire-and-forget from the IPC handler's perspective: window
 * creation problems are logged, never thrown into the renderer's send path.
 *
 * `seed` is the donor window's side-window state (2026-10-31 ruling: 弹出携带
 * 侧边窗口的打开状态) — stashed in `popoutSeeds` for the popout renderer to
 * fetch via POPOUT_SEED before its first render. Omit when there is nothing
 * to carry; absent seed = the previous behavior.
 *
 * `donorWidth`/`donorHeight` size the popout to 90% of the donor window's
 * dimensions (2026-10-31 裁定「初始高度和宽度都修改为主窗的90%」) — clamped
 * into the work area; the workbench pane width itself is already shared via
 * workbenchStore's localStorage persist. Absent → the historical
 * 42%×78%-of-work-area sizing.
 */
export async function openPopoutWindow(
  convId: string,
  title?: string,
  seed?: PopoutWorkbenchSeed,
  donorWidth?: number,
  donorHeight?: number,
): Promise<void> {
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
  // 尺寸裁定（2026-10-31）：弹窗 = 主窗的 90%（宽高同口径，夹进工作区）；
  // donor 缺席回落历史形态。
  const width = donorWidth
    ? Math.max(420, Math.min(workArea.width, Math.round(donorWidth * 0.9)))
    : Math.max(480, Math.min(720, Math.round(workArea.width * 0.42)))
  const height = donorHeight
    ? Math.max(360, Math.min(workArea.height, Math.round(donorHeight * 0.9)))
    : Math.max(480, Math.min(workArea.height, Math.round(workArea.height * 0.78)))
  const win = createSecondaryWindow({
    width,
    height,
    minWidth: 420,
    minHeight: 360,
    title: title || 'PulseMind',
    background,
  })

  popouts.set(convId, win)
  if (seed) popoutSeeds.set(convId, seed)
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
    popoutSeeds.delete(convId)
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

/** Repaint every secondary window's caption overlay for `mode`. The mode is
 *  RESOLVED BY THE CALLER (index.ts applyNativeThemeChange for an OS flip,
 *  settings.handler for an in-app save — a 'light' preference must win over a
 *  dark OS), because this window's renderer resolves the same preference for
 *  its own surfaces and the two halves must agree. */
export function refreshPopoutTitleBarTheme(mode: string): void {
  for (const win of [...popouts.values(), ...projectWindows.values()]) {
    if (!win.isDestroyed()) setTitleBarTheme(mode, win)
  }
}
