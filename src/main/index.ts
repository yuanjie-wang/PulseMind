import { app, BrowserWindow, dialog, shell, nativeImage, nativeTheme, protocol, powerMonitor, screen } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, appendFileSync, mkdirSync } from 'node:fs'
import { serveLocalFile } from './preview/serve-preview'
import { registerIpcHandlers } from './ipc'
import { ensureDataDir, getBundlePresetsDir, DATA_DIR } from './storage'
import { safeExternalUrl } from './utils/external-url'
import { initializeDatabase, ensureDbHealthy } from './storage/database'
import { backfillConversationWorkspaces } from './storage/conversation-workspace'
import { repairSwappedProjectBindings } from './storage/conversation.db'
import { backfillProjectColors } from './storage/project-store'
import { cleanupExpiredConversations } from './services/conversation-retention'
import { skillStore } from './storage/skill-store'
import { runTmpCleanup, TMP_CLEANUP_INTERVAL_MS } from './storage/tmp-cleanup'
import { ensureLaunchHooks, skipLaunchHooks } from './hooks-runner'
import { setHookWindowOpenListener, wasLastHookWindowUserClosed } from './hook-browser'
import { beginGateEscape, cancelGateEscape } from './gate-escape'
import { IPC_CHANNELS } from '../shared/ipc-channels'
import { resolveTitleBarOptions, setTitleBarTheme } from './window-chrome'
import { installPopupMotionGuard } from './motion-guard'
import { closeAllPopouts, refreshPopoutTitleBarTheme } from './popout-window'
import { resolveThemePreference } from '../shared/theme'
import { installApplicationMenu, attachShortcutFallback } from './menu'
import { cancelAllRequests } from './ipc/api-proxy.handler'
import { createTray, applyLaunchAtLogin } from './tray'
import { windowIconName } from './app-icon'
import { routineScheduler } from './routine/routine-scheduler'
import { browserService } from './browser/BrowserService'
import { enableAppViewDebugPort } from './browser/cdp-port'
import { appViewDock } from './browser/app-view-dock'

// Must run before app ready: the app-view backend (A-M3) drives in-window
// tabs over the loopback DevTools protocol; port 0 → Chromium picks a free
// loopback port and records it in DevToolsActivePort.
enableAppViewDebugPort()
import { toolStore } from './storage/tool-store'
import { serviceRuntime } from './service-runtime'
import { settingsStore } from './storage/settings-store'
import { keepAwake } from './system/keep-awake'
import { notifyResume } from './ipc/app.handler'
import { hardenDataDirPermissions } from './storage/permissions'
import { migrateEncryptedSecrets } from './storage/settings-store'
import { expireOldBackups } from './services/backup-retention'

// P0 (PLAN-security-hardening): everything this process creates from here on
// is 0600/0700 — settings.json tmp files (plaintext keys mid-rename), the
// -wal/-shm siblings, future service-token writes. Must precede any fs write,
// which is why it sits at module top. Windows is skipped entirely: its chmod
// carries only a read-only bit and umask semantics differ, so the whole
// hardening档 (umask here + the chmod sweep in whenReady) is a no-op there.
if (process.platform !== 'win32') process.umask(0o077)

let mainWindow: BrowserWindow | null = null

// The resolved mode at window-creation time (PLAN-dark-mode M1). The window
// background must match the theme the renderer will paint, or the first frames
// flash the wrong ground; it is seeded from settings before createWindow and
// re-set by the nativeTheme 'updated' listener when 'system' follows the OS.
// Same values as palette's --pm-bg light/dark.
let bootThemeMode: 'light' | 'dark' = 'light'
const WINDOW_BACKGROUND = { light: '#ffffff', dark: '#141414' } as const

/** Re-resolve the 'system' preference against the OS and repaint native chrome. */
function applyNativeThemeChange(): void {
  void settingsStore
    .get()
    .then((stored) => {
      if (stored.theme !== 'system') return
      bootThemeMode = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
      setTitleBarTheme(bootThemeMode, mainWindow)
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setBackgroundColor(WINDOW_BACKGROUND[bootThemeMode])
      }
      // Popped-out windows follow the main window's own refresh (same mode).
      refreshPopoutTitleBarTheme(bootThemeMode)
    })
    .catch(() => {})
}
let splashWindow: BrowserWindow | null = null
// Set by the main window's ready-to-show (first renderer paint). The splash
// crossfade holds for it — fading onto a window whose renderer hasn't painted
// shows the bare background colour. Reset per window: createWindow also runs
// on the tray/activate relaunch paths.
let mainWindowReadyAt: number | null = null
// APP_HOOKS_COMPLETED joins two conditions: the fade-in finished AND the
// launch hooks finished. Since the login gate (2026-09-25) hooks always
// finish BEFORE the window exists, but the renderer's onHooksCompleted →
// reloadSettings must still imply "hooks are done", or hook-written
// settings would be re-read before they exist — keep both.
let fadeCompleted = false
let hooksComplete = false
// When the launch-hook gate released — the anchor for the splash's
// MAX_SPLASH_MS safety valve (see scheduleSplashFade): after a long login
// the splash has long outlived that budget, and the valve must measure the
// wait for the MAIN WINDOW instead of the whole startup. Null = gate held.
let hooksCompletedAt: number | null = null

function maybeNotifyHooksCompleted(): void {
  if (!fadeCompleted || !hooksComplete) return
  if (!mainWindow || mainWindow.isDestroyed()) return
  try { mainWindow.webContents.send(IPC_CHANNELS.APP_HOOKS_COMPLETED) } catch { /* window gone */ }
}
// Pending unresponsive-renderer recovery timer (see createWindow); module-level
// so a re-created window's handler can clear a stale one.
let rendererRecoveryTimer: ReturnType<typeof setTimeout> | null = null
// Set right before forcefullyCrashRenderer(): render-process-gone then reports
// reason 'killed' for our own recovery kill, which must be reloaded (external
// SIGTERM kills are not).
let forcedRendererRecovery = false

// ── Startup & crash log ──────────────────────────────────────────────
// Packaged builds on Windows have no visible console, so a silent first-run
// auto-close (app.quit from the startup catch, window-all-closed, or an
// uncaught exception) leaves no trace. Record every startup step and any
// fatal error to ~/.pulsemind/logs/main.log to make it diagnosable.
const LOG_DIR = join(homedir(), '.pulsemind', 'logs')
function writeLog(level: 'INFO' | 'WARN' | 'ERROR' | 'FATAL', message: string): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(join(LOG_DIR, 'main.log'), `[${new Date().toISOString()}] [${level}] ${message}\n`)
  } catch {
    // Logging must never take the app down.
  }
}

let startupComplete = false
let isQuitting = false

// A closed parent terminal turns every console write into EPIPE. Without this
// guard, the exception handlers below rethrow EPIPE from their own
// console.error and loop-crash the process (observed as the repeated FATAL
// `write EPIPE` entries on 2026-08-24 in main.log).
for (const stream of [process.stdout, process.stderr]) {
  stream?.on?.('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE') throw err
  })
}

// Keep the process alive long enough to record the failure. Without a handler
// an uncaught exception kills the app with no trace; during the critical
// startup window we still exit (a half-initialized zombie would hold the
// single-instance lock and block relaunch) after writing the log.
process.on('uncaughtException', (err) => {
  writeLog('FATAL', `uncaughtException: ${err?.stack || String(err)}`)
  console.error('[Main] uncaughtException:', err)
  if (!startupComplete) process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  writeLog('FATAL', `unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}`)
  console.error('[Main] unhandledRejection:', reason)
})

// ── Renderer/subprocess crash diagnostics ──
// Distinguishes "renderer white-screened" causes: a *crash* (render-process-gone
// with reason 'crashed'/'killed') vs a *reload* (HMR restart / manual refresh,
// which fires no such event). Reason 403 on macOS is the App Sandbox killing the
// renderer for a violation; 'oom' means the renderer ran out of memory.
app.on('render-process-gone', (_e, wc, details) => {
  let url = ''
  try { url = wc.getURL() } catch {}
  writeLog('WARN', `render-process-gone: reason=${details.reason} exitCode=${details.exitCode} url=${url}`)
  console.warn('[Main] render-process-gone:', details, url)
  // Auto-recover: a dead renderer (crash/OOM — including the forced crash
  // from the unresponsive watchdog in createWindow) leaves a white/frozen
  // window the user previously had to restart the whole app for. Reload in
  // place unless the app is quitting. Plain 'killed' is skipped deliberately:
  // SIGTERM shutdowns arrive as killed, and racing a reload against quit can
  // re-spawn windows — but the watchdog's own forced crash sets
  // forcedRendererRecovery so its kill DOES reload (observed 2026-09-12:
  // forced crash succeeded, reload was skipped, window stayed dead for hours).
  const selfInflicted = details.reason === 'killed' && forcedRendererRecovery
  forcedRendererRecovery = false
  if (isQuitting) return
  if ((details.reason === 'crashed' || details.reason === 'oom' || selfInflicted) && !wc.isDestroyed()) {
    try {
      writeLog('INFO', `render-process-gone: reloading window to recover (reason=${details.reason})`)
      wc.reload()
    } catch { /* webContents may already be gone */ }
  }
  if (rendererRecoveryTimer) {
    clearTimeout(rendererRecoveryTimer)
    rendererRecoveryTimer = null
  }
})
app.on('child-process-gone', (_e, details) => {
  writeLog('WARN', `child-process-gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`)
})

// ── Event-loop stall watchdog ──
// Long-idle freezes (especially after macOS sleep/wake) leave no trace in
// main.log because everything downstream of the stall is frozen too — the log
// only ever showed clean startups. A drifting interval records the stall right
// after it ends: a stall here means the MAIN process was blocked (sync
// SQLite/fs, retry storms…), not just the renderer. Drifts above the sleep
// ceiling are treated as system sleep rather than a stall (timers pause while
// asleep; suspend/resume log lines bracket those), and repeats are throttled.
// Drifts overlapping a suspend (or a dark-wake blip mid-sleep, observed
// 2026-09-12: 283s "stall" logged while the machine was still asleep) are
// suppressed via lastSuspendAt/lastResumeAt — those are sleep, not stalls.
const WATCHDOG_INTERVAL_MS = 2_000
const WATCHDOG_STALL_THRESHOLD_MS = 5_000
const WATCHDOG_SLEEP_CEILING_MS = 10 * 60_000
let watchdogLastTick = Date.now()
let watchdogLastLogAt = 0
export const powerEventTimestamps = { lastSuspendAt: 0, lastResumeAt: 0 }
setInterval(() => {
  const now = Date.now()
  const drift = now - watchdogLastTick - WATCHDOG_INTERVAL_MS
  watchdogLastTick = now
  if (drift <= WATCHDOG_STALL_THRESHOLD_MS || drift > WATCHDOG_SLEEP_CEILING_MS) return
  // Overlap with a suspend/resume boundary → the machine slept through it.
  const { lastSuspendAt, lastResumeAt } = powerEventTimestamps
  if ((lastSuspendAt && now - lastSuspendAt <= drift + 30_000)
    || (lastResumeAt && now - lastResumeAt <= drift + 30_000)) return
  if (now - watchdogLastLogAt < 60_000) return
  watchdogLastLogAt = now
  writeLog('WARN', `watchdog: main event loop stalled ~${Math.round(drift / 100) / 10}s`)
}, WATCHDOG_INTERVAL_MS)

// Splash timing is anchored to the splash's first paint (ready-to-show), not to
// window creation, so a slow Windows compositor can't get the splash closed
// before it was ever visible. MAX_SPLASH_MS caps the wait as a fallback.
const FADE_MS = 350
const OVERLAP_MS = 300
const MIN_SPLASH_MS = 500
const MAX_SPLASH_MS = 8000
// How often to re-check whether the main window is ready before fading the
// splash. Holds the splash across slow launch hooks instead of leaving a gap.
const MAIN_WINDOW_CHECK_MS = 50
let splashCreatedAt: number | null = null
let splashShownAt: number | null = null
let fadeTimer: ReturnType<typeof setTimeout> | null = null

function fadeInMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.setOpacity(0)
  mainWindow.show()
  // Windows: show() on a show:false window may leave it minimized
  if (process.platform === 'win32') {
    mainWindow.restore()
    mainWindow.focus()
  }
  const start = Date.now()
  const tick = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    const p = Math.min(1, (Date.now() - start) / FADE_MS)
    mainWindow.setOpacity(p)
    if (p < 1) setTimeout(tick, 16)
    else { fadeCompleted = true; maybeNotifyHooksCompleted() }
  }
  tick()
}

function fadeOutSplash(): void {
  if (!splashWindow || splashWindow.isDestroyed()) return
  const start = Date.now()
  const tick = () => {
    if (!splashWindow || splashWindow.isDestroyed()) return
    const p = Math.min(1, (Date.now() - start) / FADE_MS)
    splashWindow.setOpacity(1 - p)
    if (p < 1) setTimeout(tick, 16)
    else { splashWindow.close(); splashWindow = null }
  }
  tick()
}

function scheduleSplashFade(): void {
  if (fadeTimer) clearTimeout(fadeTimer)
  // Anchor to first paint when available; otherwise count from the call site
  // (right after createWindow), to be re-anchored once ready-to-show fires.
  const anchor = splashShownAt ?? Date.now()
  const delay = Math.max(0, MIN_SPLASH_MS - (Date.now() - anchor))
  fadeTimer = setTimeout(() => {
    fadeTimer = null
    if (!splashWindow || splashWindow.isDestroyed()) {
      // Splash already gone. Normal after the crossfade (nothing to do), or
      // because a launch hook opened the login window and the listener closed
      // the splash for it — then the main window must still wait for its own
      // first paint, with the SAME gate hold and MAX_SPLASH_MS valve as the
      // painted path below: a straight fadeInMainWindow() here would show the
      // bare background colour, the exact thing the holds exist to avoid.
      if (fadeCompleted) return
      if (mainWindow && !mainWindow.isDestroyed() && mainWindowReadyAt !== null) {
        fadeInMainWindow()
        return
      }
      if (!hooksComplete) {
        fadeTimer = setTimeout(() => { fadeTimer = null; scheduleSplashFade() }, MAIN_WINDOW_CHECK_MS)
        return
      }
      const valveAnchor = hooksCompletedAt ?? splashCreatedAt
      if (valveAnchor !== null && Date.now() - valveAnchor < MAX_SPLASH_MS) {
        fadeTimer = setTimeout(() => { fadeTimer = null; scheduleSplashFade() }, MAIN_WINDOW_CHECK_MS)
        return
      }
      fadeInMainWindow()
      return
    }
    if (splashShownAt === null) {
      // Splash hasn't painted yet — don't close it blank. Retry until
      // MAX_SPLASH_MS; while the launch-hook gate holds (login flow) retry
      // indefinitely — the splash must outlive the login, it is the only
      // surface besides the login window.
      if (!hooksComplete || (splashCreatedAt !== null && Date.now() - splashCreatedAt < MAX_SPLASH_MS)) {
        scheduleSplashFade()
        return
      }
    } else if (!mainWindow || mainWindow.isDestroyed() || mainWindowReadyAt === null) {
      // Splash painted but the main window hasn't had its first paint yet
      // (still loading the renderer bundle). Hold the splash instead of
      // fading onto the bare window background; re-check shortly.
      // While the launch-hook gate holds (login flow) hold INDEFINITELY —
      // a login takes as long as the user takes. After the gate, the
      // MAX_SPLASH_MS safety valve is anchored to hooks COMPLETION, not
      // splash creation: a two-minute login would otherwise have burnt the
      // whole budget before createWindow even ran, and the crossfade would
      // fire before the renderer painted (the bare-background flash the
      // hold exists to avoid).
      if (!hooksComplete) {
        fadeTimer = setTimeout(() => { fadeTimer = null; scheduleSplashFade() }, MAIN_WINDOW_CHECK_MS)
        return
      }
      const valveAnchor = hooksCompletedAt ?? splashCreatedAt
      if (valveAnchor !== null && Date.now() - valveAnchor < MAX_SPLASH_MS) {
        fadeTimer = setTimeout(() => { fadeTimer = null; scheduleSplashFade() }, MAIN_WINDOW_CHECK_MS)
        return
      }
    }
    // Crossfade: splash fades out while main fades in with overlap
    fadeOutSplash()
    setTimeout(fadeInMainWindow, Math.max(0, FADE_MS - OVERLAP_MS))
  }, delay)
}

/**
 * Resolve a runtime resource under resources/.
 * Production: loose files copied to process.resourcesPath/resources via extraResources.
 * Dev: files in the project's resources/ dir (out/main/../../resources).
 */
function getResourcePath(...segments: string[]): string {
  const prodPath = join(process.resourcesPath, 'resources', ...segments)
  if (existsSync(prodPath)) return prodPath
  return join(__dirname, '../../resources', ...segments)
}

// Single-instance lock: prevent multiple processes from corrupting SQLite
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  writeLog('WARN', 'single-instance lock not acquired — quitting (another instance already running)')
  app.quit()
}

function createSplashWindow(): void {
  splashCreatedAt = Date.now()
  splashWindow = new BrowserWindow({
    width: 340,
    height: 360,
    resizable: false,
    frame: false,
    alwaysOnTop: true,
    center: true,
    // Hidden until ready-to-show: showing before first paint leaves a blank
    // window frame on screen while the renderer warms up — especially slow
    // on Windows where DWM first-paint is expensive. See ready-to-show below.
    show: false,
    // Opaque black window: transparent frameless windows are composited
    // per-pixel through DWM on Windows and can take hundreds of ms to first
    // paint. The splash page's body is fully black anyway, so opaque costs
    // nothing visually and paints much faster.
    transparent: false,
    backgroundColor: '#000',
    icon: getResourcePath(windowIconName()),
    webPreferences: {
      // No preload: splash.html is pure HTML/CSS/images and never touches
      // window.electronAPI. Loading the 348-line IPC bridge here only delays
      // first paint.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    }
  })
  // Version rides in the query string so the splash never needs a manual bump —
  // it always shows app.getVersion() (single source of truth: package.json).
  splashWindow.loadFile(getResourcePath('splash', 'splash.html'), {
    query: { v: app.getVersion() },
  })
  splashWindow.on('ready-to-show', () => {
    if (!splashWindow || splashWindow.isDestroyed()) return
    // Reveal only once the page is painted, so the window never appears blank.
    splashWindow.show()
    splashShownAt = Date.now()
    scheduleSplashFade()
  })
  splashWindow.on('closed', () => { splashWindow = null })
}

// Total margin left between the window and the usable screen area, keeping the
// window visibly inset from the menu bar / dock instead of filling the screen.
// Height keeps a smaller margin: the work area already excludes the menu bar, so
// a wide horizontal inset only wastes vertical room on a short laptop screen.
const WINDOW_WIDTH_INSET = 100
const WINDOW_HEIGHT_INSET = 50
// Ceiling for the work-area-derived size, so a large external monitor gets a
// comfortable window rather than a near-full-screen one.
const MAX_WINDOW_WIDTH = 1800
const MAX_WINDOW_HEIGHT = 1200
const MIN_WINDOW_WIDTH = 800
const MIN_WINDOW_HEIGHT = 600
// Fraction of the leftover vertical space left above the window. 0.5 centers it
// in the work area; lower values bias it upward.
const WINDOW_VERTICAL_POSITION = 0.5

// Place and size the window from the current display's work area (screen minus
// menu bar, dock and taskbar) rather than fixed pixels: a hardcoded size either
// overflows a small laptop screen — pushing the title bar under the menu bar or
// off-screen entirely — or wastes space on a large monitor. The work area is
// inset by a fixed margin and then capped, so the window shrinks to fit a small
// screen but never grows past MAX_* on a big one.
//
// The position is set explicitly because Electron's default centering (when x/y
// are omitted) centers on the full screen, not the work area. On a display with
// a dock the window ends up flush against the dock and visibly low — measured at
// 47px below the menu bar vs 3px above the dock — where centering in the work
// area gives an even split.
//
// Resolved per call so a window re-created on another display (macOS activate,
// tray restore) picks up that display's metrics. Must run after app ready:
// `screen` is unavailable before.
function resolveWindowBounds(): {
  x: number
  y: number
  width: number
  height: number
  minWidth: number
  minHeight: number
} {
  const { x: workAreaX, y: workAreaY, width: workAreaWidth, height: workAreaHeight } =
    screen.getPrimaryDisplay().workArea
  const width = Math.min(MAX_WINDOW_WIDTH, Math.max(1, workAreaWidth - WINDOW_WIDTH_INSET))
  const height = Math.min(MAX_WINDOW_HEIGHT, Math.max(1, workAreaHeight - WINDOW_HEIGHT_INSET))
  return {
    x: workAreaX + Math.round((workAreaWidth - width) / 2),
    y: workAreaY + Math.round((workAreaHeight - height) * WINDOW_VERTICAL_POSITION),
    width,
    height,
    // Never let a minimum exceed the size we open at: Electron would otherwise
    // be asked for a window smaller than its own resize floor.
    minWidth: Math.min(MIN_WINDOW_WIDTH, width),
    minHeight: Math.min(MIN_WINDOW_HEIGHT, height),
  }
}

/** CONVERSATION_HANDOFF 的窗口保障（PLAN-extension-handoff）：mac 关窗不退出
 *  时服务仍在跑，移交广播到达前必须有一扇主窗。与 dock activate 同一条
 *  hooksComplete 门——门期（登录流程）零窗口是常态，不抢。 */
export async function ensureMainWindowForHandoff(): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    return
  }
  if (hooksComplete) createWindow()
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    ...resolveWindowBounds(),
    ...resolveTitleBarOptions(),
    show: false,
    backgroundColor: WINDOW_BACKGROUND[bootThemeMode],
    icon: getResourcePath(windowIconName()),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false,
    }
  })
  appViewDock.attach(mainWindow)
  // Popouts die with the main window (user ruling 2026-10-30): the registry
  // destroy runs on 'closed' — after this, window count reaches 0, so the
  // win/linux quit path and the mac activate-recreate path both behave as if
  // only the main window ever existed. Re-attached per createWindow (the
  // tray relaunch path) — by then the previous popouts are long gone.
  mainWindow.on('closed', closeAllPopouts)
  // Pin prefers-reduced-motion to no-preference for this target (see the
  // module header): a mid-session Windows reduce flip parks every antd popup
  // off-screen — rendered, animating, permanently invisible.
  installPopupMotionGuard(mainWindow)
  // Readiness anchor for the splash crossfade (see scheduleSplashFade): the
  // fade holds until the renderer's first paint, revealing a finished window
  // instead of the background colour. Also logged — the main.log line is the
  // renderer-boot measurement for startup-timeline work.
  mainWindowReadyAt = null
  mainWindow.once('ready-to-show', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindowReadyAt = Date.now()
    writeLog('INFO', 'startup: main window ready-to-show')
  })
  // Action accelerators on Windows/Linux ride before-input-event (no visible
  // menu bar exists under the hidden title bar); macOS uses the real menu's
  // accelerators instead. Attached per window — createWindow also runs on the
  // tray relaunch path after the previous window was destroyed.
  attachShortcutFallback(mainWindow)

  mainWindow.webContents.setWindowOpenHandler((details) => {
    // Scheme-gated (review 2026-09-25 P0-2): window.open/target=_blank from
    // any content reaches here — untrusted markup must not be able to hand
    // the OS launcher smb://, file:///.command or a custom app protocol.
    const safe = safeExternalUrl(details.url, DATA_DIR)
    if (safe) void shell.openExternal(safe)
    return { action: 'deny' }
  })

  // In-app navigation is the renderer's own business (Vite full-reload,
  // wc.reload() after the unresponsive recovery) — both re-enter at the URL
  // already loaded, or at the dev server origin in dev. Everything else that
  // would move the window (a stray href, a file:// drop that somehow escaped
  // the renderer guard) is refused rather than replacing the whole app UI.
  const devOrigin = process.env.ELECTRON_RENDERER_URL
    ? new URL(process.env.ELECTRON_RENDERER_URL).origin
    : null
  mainWindow.webContents.on('will-navigate', (details) => {
    try {
      if (details.url === mainWindow?.webContents.getURL()) return
      if (devOrigin && new URL(details.url).origin === devOrigin) return
    } catch {
      // unparsable URL — fall through and block
    }
    details.preventDefault()
  })

  // ── Preview-frame navigation forensics (2026-10-29 白屏现场) ── The pane's
  // white screen showed: the protocol handler serves 200 every time, yet the
  // iframe sits on about:blank forever — the document never commits, with no
  // error anywhere. These hooks persist the frame-navigation lifecycle for
  // local-file URLs into main.log, so the next occurrence says exactly which
  // link broke: start without commit = delivery problem; no start at all =
  // the renderer never dispatched the navigation. Main frame and app-origin
  // traffic stays out of the log.
  const isPreviewNav = (url: string): boolean => url.startsWith('local-file://')
  mainWindow.webContents.on('did-start-navigation', (details) => {
    if (isPreviewNav(details.url)) writeLog('INFO', `preview-nav start frame=${details.isMainFrame ? 'main' : 'sub'} ${details.url.slice(0, 160)}`)
  })
  // `did-frame-navigate` fires post-commit — its main-frame variant is the
  // app's own business; subframe commits are the preview evidence (start
  // without this line = the response was never delivered to the frame loader).
  mainWindow.webContents.on('did-frame-navigate', (_event, url, _inPlace, isMainFrame) => {
    if (isPreviewNav(url)) writeLog('INFO', `preview-nav COMMIT frame=${isMainFrame ? 'main' : 'sub'} ${url.slice(0, 160)}`)
  })
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isPreviewNav(url)) writeLog('WARN', `preview-nav FAIL code=${code} ${description} frame=${isMainFrame ? 'main' : 'sub'} ${url.slice(0, 160)}`)
  })

  // ── Unresponsive-renderer recovery ──
  // 'unresponsive' fires when the renderer's JS loop is stuck (long sync task,
  // GC death spiral) — the "app frozen but not crashed" state that used to
  // require a full app restart. Give it a grace period; if it doesn't come
  // back, crash it deliberately: render-process-gone above then reloads the
  // window, converting a permanent freeze into a brief reload.
  mainWindow.webContents.on('unresponsive', () => {
    if (rendererRecoveryTimer) return // recovery already pending
    const wc = mainWindow?.webContents
    if (!wc || wc.isDestroyed() || isQuitting) return
    writeLog('WARN', 'renderer unresponsive — will crash+reload in 15s unless it recovers')
    rendererRecoveryTimer = setTimeout(() => {
      rendererRecoveryTimer = null
      if (!wc || wc.isDestroyed() || isQuitting) return
      writeLog('WARN', 'renderer still unresponsive after 15s — forcing crash to recover')
      forcedRendererRecovery = true
      try { wc.forcefullyCrashRenderer() } catch { /* already gone */ }
    }, 15_000)
    wc.once('responsive', () => {
      if (rendererRecoveryTimer) {
        clearTimeout(rendererRecoveryTimer)
        rendererRecoveryTimer = null
      }
      writeLog('INFO', 'renderer responsive again')
    })
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ── Gate-period escape surface (review 2026-09-26 中4) ──
// The dialog is async on purpose: showMessageBoxSync would freeze the main
// thread the hook's poll loop is running on. 继续等待 leaves the gate as it
// is — bounded by the hook's own deadline and the hooks-runner watchdog —
// 跳过 resolves the gate without waiting for the hooks (they keep running
// in the background; a late env var still reaches hookEnv).
let gateSkipDialogOpen = false
async function offerGateSkipDialog(): Promise<void> {
  if (gateSkipDialogOpen || hooksComplete || startupComplete) return
  gateSkipDialogOpen = true
  writeLog('WARN', 'startup: all windows closed while the launch-hook gate holds — offering wait/skip')
  try {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: 'PulseMind',
      message: '启动流程仍在等待（例如登录）',
      detail: '所有窗口已关闭，但启动门还没有放行。可以继续等待启动流程自行结束，或跳过它直接进入应用。',
      buttons: ['继续等待', '跳过并启动'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    if (response === 1) {
      writeLog('INFO', 'startup: user chose to skip the launch gate')
      skipLaunchHooks()
    }
  } catch (err) {
    writeLog('WARN', `startup: gate-skip dialog failed: ${err instanceof Error ? err.message : err}`)
  } finally {
    gateSkipDialogOpen = false
  }
}

if (gotTheLock) {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.on('window-all-closed', () => {
    const openWindows = BrowserWindow.getAllWindows().length
    writeLog('INFO', `window-all-closed (open windows: ${openWindows}, startupComplete: ${startupComplete})`)
    if (process.platform !== 'darwin') {
      // Never quit mid-transition: if a window was closed before startup
      // finished (e.g. splash closed while the main window was still hidden),
      // closing the app is the "auto-close" symptom we're chasing. This also
      // covers the login gate (2026-09-25): startupComplete stays false
      // until after createWindow, so closing the login window — or every
      // window — during app-start's login flow never quits the app.
      if (!startupComplete) {
        // Gate-period escape surface (review 2026-09-26 中4, refined
        // 2026-09-28 → gate-escape.ts): with every window closed and the
        // launch hook still pending, the process used to sit on with no
        // window, no tray, no taskbar presence — killable only from task
        // manager. The decision is no longer instant: a short grace absorbs
        // 「login completed right after the user closed the page」 and the
        // watchdog race; a user-closed hook window then reads as 「stop
        // waiting」 and skips the gate silently; the dialog remains only for
        // a zero-window state no user close explains.
        if (!hooksComplete) {
          beginGateEscape({
            gateHeld: () => !hooksComplete && !startupComplete,
            lastHookWindowCloseFromUser: wasLastHookWindowUserClosed,
            skipGate: () => {
              writeLog('INFO', 'startup: gate escape skipped the launch gate (user closed the hook window)')
              skipLaunchHooks()
            },
            showDialog: () => void offerGateSkipDialog(),
            log: (message) => writeLog('INFO', `startup: ${message}`),
          })
        }
        return
      }
      app.quit()
    }
  })

  app.whenReady().then(async () => {
  // Custom protocol to serve local files to sandboxed renderer. Reads via
  // fs/promises instead of net.fetch to avoid redirect/encoding issues on
  // Windows and to properly handle binary files (images). Async on purpose:
  // conversation images (tool screenshots etc.) all route through here, and
  // a sync read of a large file — or the first read after wake, while the
  // disk is still spinning up — would block the whole main-process event
  // loop and freeze every IPC handler with it. The handler body (and the
  // ?pmPreview=1 HTML preview-copy branch with the injected element picker)
  // lives in preview/serve-preview.ts (PLAN-html-element-edit M1).
  protocol.handle('local-file', (request) => serveLocalFile(request))

  writeLog('INFO', `startup: platform=${process.platform} execPath=${process.execPath}`)
  ensureDataDir()
  createSplashWindow()
  writeLog('INFO', 'startup: splash window created')

  // Initialize DB before the IPC handlers open (needed by settings, skills, etc.)
  await initializeDatabase()
  writeLog('INFO', 'startup: database initialized')
  // Backfill conversations.workspace_dir before any session can be created
  // (PLAN-0.4.0 M8): old conversations keep the global workspace, new ones
  // mint their own timestamped folder on first use.
  await backfillConversationWorkspaces()
  // Projects created before their identity color was a stored field (2026-09-16)
  // get it here, from the same name hash the renderer used to derive — so every
  // existing color survives the switch to reading it back.
  await backfillProjectColors()
  // Project-mode conversations whose stub-insert swapped type/project_id
  // (fixed 2026-09-17) were invisible to every type='normal' surface — put the
  // columns back before anything lists or cleans them up.
  repairSwappedProjectBindings()
  // P0 (PLAN-security-hardening): repair the EXISTING tree's modes — the
  // umask at module top only covers files created from now on. Best-effort
  // by design; its own summary line reports what it found.
  if (process.platform !== 'win32') hardenDataDirPermissions()
  // 对话管理 · 最长保留时长: expire conversations older than the policy allows
  // before any session can resurrect one.
  try { await cleanupExpiredConversations() } catch (err) { writeLog('WARN', `startup: conversation retention failed: ${err}`) }
  // P1 (PLAN-security-hardening): rewrite settings.json whose secrets are
  // still plaintext. Before the retention pass, because the backups this
  // expires hold the same secrets the migration is about to encrypt.
  try { await migrateEncryptedSecrets() } catch (err) { writeLog('WARN', `startup: secret migration failed: ${err}`) }
  // P3-a: expire unmanaged db backups past their retention window.
  try { expireOldBackups() } catch (err) { writeLog('WARN', `startup: backup retention failed: ${err}`) }
  registerIpcHandlers()
  writeLog('INFO', 'startup: ipc handlers registered')

  // The caption button overlay colour follows the theme, and it has to be right at
  // window creation — bootSettings below is read too late for that. 'system'
  // resolves against nativeTheme here; the renderer resolves the same preference
  // against prefers-color-scheme for its own surfaces (PLAN-dark-mode M1).
  // A fast settings-file read, deliberately the last critical-path step: the
  // window background must match the theme the renderer will paint.
  bootThemeMode = resolveThemePreference(
    (await settingsStore.get()).theme,
    nativeTheme.shouldUseDarkColors
  )
  setTitleBarTheme(bootThemeMode, null)
  // OS light/dark flips while running: only the 'system' preference reacts.
  nativeTheme.on('updated', applyNativeThemeChange)

  // ── Critical path ends here ──
  // Everything between the splash and this line is what the user waits on
  // before the renderer even starts loading.

  // Launch hooks GATE the main window (user decision 2026-09-25 — this
  // reverses the earlier "hooks run concurrently with window creation"
  // fix): app-start.js may run a login flow — open the built-in browser
  // (ctx.browser.open), poll its server-side session endpoint, close it —
  // and the app must not start until that resolves. The splash holds the
  // screen while we wait (scheduleSplashFade holds INDEFINITELY while
  // hooksComplete is false): a valid session is a fast local check, an
  // invalid one costs exactly the login. Consumers already gate on
  // ensureLaunchHooks(): terminal spawn, MCPClient.start,
  // applyProfileHeaders — this is also where the env vars they read are
  // collected. Never rejects: a broken hook degrades to default env and
  // the gate opens anyway.
  // The splash and the login window must never share the screen (user ruling
  // 2026-09-25, replacing the earlier demote-only behaviour): the moment a
  // hook opens its browser window the splash is destroyed — same synchronous
  // tick as the window's creation, so no frame is ever composited with both
  // (the splash sits alwaysOnTop over the new window until it dies; what
  // the user sees is splash → login page). destroy(), not the fade: a
  // fading splash is still a second surface. Everything downstream already
  // tolerates a missing splash: fadeOutSplash and scheduleSplashFade
  // re-check isDestroyed(), and scheduleSplashFade's splash-less branch
  // carries the same gate hold and MAX_SPLASH_MS valve as the painted path.
  setHookWindowOpenListener(() => {
    // A hook window opening also means the gate escape's zero-window premise
    // is gone: a pending grace must not auto-skip the gate behind a live
    // login window (it re-arms if that window closes again).
    cancelGateEscape()
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.destroy()
      splashWindow = null
      writeLog('INFO', 'startup: splash closed for launch-hook window')
    }
  })
  await ensureLaunchHooks()
  hooksComplete = true
  hooksCompletedAt = Date.now()
  maybeNotifyHooksCompleted()
  writeLog('INFO', 'startup: launch hooks completed')

  createWindow()
  writeLog('INFO', 'startup: main window created')

  // Application menu + action accelerators (mac: a real menu with native
  // accelerators; see menu.ts for the Windows/Linux fallback split).
  installApplicationMenu(() => mainWindow)
    .then(() => writeLog('INFO', 'startup: application menu installed'))
    .catch((err) => writeLog('WARN', `startup: application menu failed: ${err}`))

  // Calibrate skill preferences against actual files on disk
  skillStore.calibrate().catch((err) => writeLog('WARN', `startup: skillStore.calibrate failed: ${err}`))

  // Set dock icon on macOS (dev mode runs inside Electron.app, so it needs explicit icon)
  if (process.platform === 'darwin') {
    const iconPath = getResourcePath('pulseMind.png')
    app.dock.setIcon(nativeImage.createFromPath(iconPath))
  }

  // ── Tray residency + launch-at-login (PLAN-0.3.5 M2.3) ──
  // The tray anchors the resident process (closed window keeps the service
  // alive) and hosts the launch-at-login toggle; the preference persists in
  // settings.json and is applied to the OS on every startup.
  // Fire-and-forget: the block takes a few hundred ms (service bind, tool
  // seeding) and must not hold the splash crossfade — the renderer boots far
  // slower than it finishes, so a session can never outrun the keep-awake
  // seed below.
  void (async () => {
    try {
      const bootSettings = await settingsStore.get()
      applyLaunchAtLogin(!!bootSettings.launchAtLogin)
      // Seed the keep-awake switch (defaults off like every 高级 toggle) before
      // any session can start.
      keepAwake.setEnabled(bootSettings.keepAwakeEnabled ?? false)
      // ── Local agent service (M2.1): loopback WS for browser extensions ──
      if (bootSettings.serviceEnabled !== false) {
        try {
          const { restartService } = await import('./service-runtime')
          const handle = await restartService()
          writeLog('INFO', `startup: agent service on :${handle?.port}`)
        } catch (err) {
          writeLog('WARN', `startup: agent service failed: ${err}`)
        }
      }
      toolStore.init()
      // Preset tools (M5R): stamp bundle distributions into real tool dirs and
      // promote pre-M5R legacy template copies (both idempotent).
      toolStore.seedPresets(getBundlePresetsDir())
      toolStore.migrateLegacyTemplates()
      // Routine scheduler: ticks for due cron schedules (works under tray residency).
      routineScheduler.start()
      app.on('before-quit', () => { isQuitting = true; routineScheduler.stop(); void serviceRuntime.handle?.close(); void browserService.stopAll() })
      createTray({
        getServiceStatus: async () => serviceRuntime.handle ? `服务运行中 :${serviceRuntime.handle.port}` : '服务未运行',
        getLaunchAtLogin: async () => !!(await settingsStore.get()).launchAtLogin,
        onToggleLaunchAtLogin: async (enabled) => {
          await settingsStore.update(s => ({ ...s, launchAtLogin: enabled }))
          applyLaunchAtLogin(enabled)
        },
        onShowWindow: () => {
          if (!mainWindow || mainWindow.isDestroyed()) { createWindow(); return }
          if (mainWindow.isMinimized()) mainWindow.restore()
          mainWindow.show()
          mainWindow.focus()
        },
        onQuit: () => app.quit(),
      })
      writeLog('INFO', 'startup: tray created')
    } catch (err) {
      writeLog('WARN', `startup: tray creation failed: ${err}`)
    }
  })()

  // Tmp cleanup runs in the background (async fs, fire-and-forget) so it never
  // blocks window creation or the UI event loop. Also swept periodically for
  // long-running sessions.
  void runTmpCleanup().catch((err) => writeLog('WARN', `startup: tmp cleanup failed: ${err}`))
  setInterval(() => { void runTmpCleanup().catch(() => {}) }, TMP_CLEANUP_INTERVAL_MS)

  // Splash → main window crossfade. The fade countdown is anchored to the
  // splash's first paint (MIN_SPLASH_MS floor) and now also holds for the main
  // window's ready-to-show — with createWindow this early, the renderer is
  // usually still loading when the floor elapses, and fading then would paint
  // the bare background colour. MAX_SPLASH_MS remains the safety valve.
  scheduleSplashFade()
  startupComplete = true
  writeLog('INFO', 'startup: complete')

  // ── Sleep/resume resilience ──
  // System sleep can freeze SSE streams (fetch hangs), SQLite, and GPU context.
  powerMonitor.on('suspend', () => {
    powerEventTimestamps.lastSuspendAt = Date.now()
    writeLog('INFO', 'power: system suspending')
  })
  powerMonitor.on('resume', () => {
    powerEventTimestamps.lastResumeAt = Date.now()
    writeLog('INFO', 'power: system resumed from sleep')

    // Give network stack time to come back before any recovery actions
    setTimeout(() => {
      // 1. Abort all hanging API streams (SSE fetch readers block forever
      //    after sleep). Runs regardless of window state: main-hosted agent
      //    sessions (ws :8765) keep streaming with no UI attached.
      try {
        cancelAllRequests()
      } catch (err) {
        writeLog('WARN', `power: cancelAllRequests failed: ${err}`)
      }

      // 2. Reinitialize database connection (SQLite may have stale locks)
      try {
        ensureDbHealthy()
      } catch (err) {
        writeLog('ERROR', `power: DB reinit failed: ${err}`)
      }

      // 3. Notify renderer to recover gracefully (GPU context, WebGL, timers).
      //    If renderer doesn't ack within 5s, fall back to a full reload.
      const win = mainWindow
      if (!win || win.isDestroyed()) return
      notifyResume(win, 5000, () => {
        try {
          // Reload only helps something on screen. A hidden/closed window has
          // nothing to recover visually — reloading it would just reset its
          // state for no benefit.
          if (!win.isVisible()) return
          writeLog('WARN', 'power: renderer did not ack resume — reloading')
          win.webContents.reload()
        } catch { /* window may be destroyed */ }
      })
    }, 3000)
  })

  app.on('activate', () => {
    // hooksComplete guard: while the launch-hook gate holds (login flow), a
    // dock click must not conjure the main window around the login. The
    // zero-window case there is the login window being closed mid-gate (the
    // splash closes itself the moment that window opens) — leaving it
    // windowless beats starting ungated.
    if (BrowserWindow.getAllWindows().length === 0 && hooksComplete) {
      createWindow()
    }
  })
}).catch((err) => {
  writeLog('FATAL', `startup failed: ${err instanceof Error ? err.stack : String(err)}`)
  console.error('[Main] Failed to initialize:', err)
  app.quit()
})
}
