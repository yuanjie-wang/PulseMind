import { app, BrowserWindow, shell, nativeImage, protocol, powerMonitor, screen } from 'electron'
import { homedir } from 'node:os'
import { join, extname } from 'node:path'
import { existsSync, appendFileSync, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { registerIpcHandlers } from './ipc'
import { ensureDataDir } from './storage'
import { initializeDatabase, ensureDbHealthy } from './storage/database'
import { skillStore } from './storage/skill-store'
import { runTmpCleanup, TMP_CLEANUP_INTERVAL_MS } from './storage/tmp-cleanup'
import { runLaunchHooks } from './hooks-runner'
import { IPC_CHANNELS } from '../shared/ipc-channels'
import { resolveTitleBarOptions, setTitleBarTheme } from './window-chrome'
import { cancelAllRequests } from './ipc/api-proxy.handler'
import { createTray, applyLaunchAtLogin } from './tray'
import { routineScheduler } from './routine/routine-scheduler'
import { serviceRuntime } from './service-runtime'
import { settingsStore } from './storage/settings-store'
import { notifyResume } from './ipc/app.handler'

let mainWindow: BrowserWindow | null = null
let splashWindow: BrowserWindow | null = null
// Pending unresponsive-renderer recovery timer (see createWindow); module-level
// so a re-created window's handler can clear a stale one.
let rendererRecoveryTimer: ReturnType<typeof setTimeout> | null = null

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
  // place unless the app is quitting. 'killed' is skipped deliberately:
  // SIGTERM shutdowns arrive as killed, and racing a reload against quit
  // can re-spawn windows.
  if (isQuitting) return
  if ((details.reason === 'crashed' || details.reason === 'oom') && !wc.isDestroyed()) {
    try {
      writeLog('INFO', 'render-process-gone: reloading window to recover')
      wc.reload()
    } catch { /* webContents may already be gone */ }
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
const WATCHDOG_INTERVAL_MS = 2_000
const WATCHDOG_STALL_THRESHOLD_MS = 5_000
const WATCHDOG_SLEEP_CEILING_MS = 10 * 60_000
let watchdogLastTick = Date.now()
let watchdogLastLogAt = 0
setInterval(() => {
  const now = Date.now()
  const drift = now - watchdogLastTick - WATCHDOG_INTERVAL_MS
  watchdogLastTick = now
  if (drift <= WATCHDOG_STALL_THRESHOLD_MS || drift > WATCHDOG_SLEEP_CEILING_MS) return
  if (now - watchdogLastLogAt < 60_000) return
  watchdogLastLogAt = now
  writeLog('WARN', `watchdog: main event loop stalled ~${Math.round(drift / 100) / 10}s`)
}, WATCHDOG_INTERVAL_MS)

// Splash timing is anchored to the splash's first paint (ready-to-show), not to
// window creation, so a slow Windows compositor can't get the splash closed
// before it was ever visible. MAX_SPLASH_MS caps the wait as a fallback.
const FADE_MS = 350
const OVERLAP_MS = 300
const MIN_SPLASH_MS = 1500
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
    else mainWindow.webContents.send(IPC_CHANNELS.APP_HOOKS_COMPLETED)
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
      fadeInMainWindow()
      return
    }
    if (splashShownAt === null) {
      // Splash hasn't painted yet — don't close it blank. Retry until MAX_SPLASH_MS.
      if (splashCreatedAt !== null && Date.now() - splashCreatedAt < MAX_SPLASH_MS) {
        scheduleSplashFade()
        return
      }
    } else if (!mainWindow || mainWindow.isDestroyed()) {
      // Splash painted but the main window isn't created yet (slow launch
      // hooks). Hold the splash instead of fading to a black gap; re-check
      // shortly. Gives up after MAX_SPLASH_MS as a safety valve.
      if (splashCreatedAt !== null && Date.now() - splashCreatedAt < MAX_SPLASH_MS) {
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
    icon: getResourcePath(process.platform === 'win32' ? 'pulseMind-win.ico' : 'pulseMind.png'),
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

function createWindow(): void {
  mainWindow = new BrowserWindow({
    ...resolveWindowBounds(),
    ...resolveTitleBarOptions(),
    show: false,
    backgroundColor: '#fff',
    icon: getResourcePath(process.platform === 'win32' ? 'pulseMind-win.ico' : 'pulseMind.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false,
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
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
      // closing the app is the "auto-close" symptom we're chasing.
      if (!startupComplete) return
      app.quit()
    }
  })

  // Windows DPI awareness: high-DPI displays (125%/150%/200%) render crisp
  app.commandLine.appendSwitch('high-dpi-support', '1')
  app.commandLine.appendSwitch('enable-windows-high-dpi')

  app.whenReady().then(async () => {
  // Custom protocol to serve local files to sandboxed renderer.
  // Reads via fs/promises instead of net.fetch to avoid redirect/encoding
  // issues on Windows and to properly handle binary files (images). Async on
  // purpose: conversation images (tool screenshots etc.) all route through
  // here, and a sync read of a large file — or the first read after wake,
  // while the disk is still spinning up — would block the whole main-process
  // event loop and freeze every IPC handler with it.
  protocol.handle('local-file', async (request) => {
    // Use URL API to extract pathname reliably (avoids regex issues with custom schemes)
    let filePath: string
    try {
      const parsed = new URL(request.url)
      filePath = decodeURIComponent(parsed.pathname)
      // Windows: URL parser treats "C:" as hostname for non-standard schemes
      // (local-file://C:/Users/... → hostname="c" pathname="/Users/...").
      // Detect and prepend the drive letter when it's a single letter host.
      if (process.platform === 'win32' && parsed.hostname && /^[A-Za-z]$/.test(parsed.hostname)) {
        filePath = `${parsed.hostname}:${filePath}`
      }
    } catch {
      // Fallback for URLs the URL constructor can't parse
      filePath = decodeURIComponent(request.url.replace(/^local-file:/, '').replace(/^\/\//, '/'))
    }
    // Windows: strip leading slash from absolute paths (/C:/ → C:/)
    if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(filePath)) {
      filePath = filePath.slice(1)
    }
    // Resolve /.pulsemind/ to ~/.pulsemind/ (LLM strips home dir prefix)
    if (filePath.startsWith('/.pulsemind/')) {
      filePath = join(homedir(), '.pulsemind', filePath.slice('/.pulsemind/'.length))
    }
    console.log('[local-file] URL:', request.url, '→ path:', filePath)
    const ext = extname(filePath).toLowerCase()
    const MIME: Record<string, string> = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
      '.bmp': 'image/bmp', '.ico': 'image/x-icon',
      '.md': 'text/markdown; charset=utf-8',
      '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.txt': 'text/plain; charset=utf-8',
      '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
      '.pdf': 'application/pdf',
    }
    try {
      const content = await readFile(filePath)
      const mime = MIME[ext] || 'application/octet-stream'
      return new Response(content, {
        status: 200,
        headers: { 'Content-Type': mime }
      })
    } catch (err) {
      console.error('[local-file] Read failed:', filePath, err)
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return new Response('Not Found', { status: 404 })
      if (code === 'EACCES') return new Response('Forbidden', { status: 403 })
      return new Response('Internal Error', { status: 500 })
    }
  })

  writeLog('INFO', `startup: platform=${process.platform} execPath=${process.execPath}`)
  ensureDataDir()
  createSplashWindow()
  writeLog('INFO', 'startup: splash window created')

  // Initialize DB before hooks (needed by settings, skills, etc.)
  await initializeDatabase()
  writeLog('INFO', 'startup: database initialized')
  // Run hooks first to collect env vars (before MCP servers start)
  await runLaunchHooks()
  writeLog('INFO', 'startup: launch hooks completed')

  registerIpcHandlers()
  writeLog('INFO', 'startup: ipc handlers registered')

  // Calibrate skill preferences against actual files on disk
  skillStore.calibrate().catch((err) => writeLog('WARN', `startup: skillStore.calibrate failed: ${err}`))

  // Set dock icon on macOS (dev mode runs inside Electron.app, so it needs explicit icon)
  if (process.platform === 'darwin') {
    const iconPath = getResourcePath('pulseMind.png')
    app.dock.setIcon(nativeImage.createFromPath(iconPath))
  }

  // The caption button overlay colour follows the theme, and it has to be right at
  // window creation — bootSettings below is read too late for that.
  setTitleBarTheme((await settingsStore.get()).theme, null)

  createWindow()
  writeLog('INFO', 'startup: main window created')

  // ── Tray residency + launch-at-login (PLAN-0.3.5 M2.3) ──
  // The tray anchors the resident process (closed window keeps the service
  // alive) and hosts the launch-at-login toggle; the preference persists in
  // settings.json and is applied to the OS on every startup.
  try {
    const bootSettings = await settingsStore.get()
    applyLaunchAtLogin(!!bootSettings.launchAtLogin)
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
    // Routine scheduler: ticks for due cron schedules (works under tray residency).
    routineScheduler.start()
    app.on('before-quit', () => { isQuitting = true; routineScheduler.stop(); void serviceRuntime.handle?.close() })
    createTray({
      getServiceStatus: async () => serviceRuntime.handle ? `服务运行中 :${serviceRuntime.handle.port}` : '服务未运行',
      getLaunchAtLogin: async () => !!(await settingsStore.get()).launchAtLogin,
      onToggleLaunchAtLogin: async (enabled) => {
        const s = await settingsStore.get()
        await settingsStore.set({ ...s, launchAtLogin: enabled })
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

  // Tmp cleanup runs in the background (async fs, fire-and-forget) so it never
  // blocks window creation or the UI event loop. Also swept periodically for
  // long-running sessions.
  void runTmpCleanup().catch((err) => writeLog('WARN', `startup: tmp cleanup failed: ${err}`))
  setInterval(() => { void runTmpCleanup().catch(() => {}) }, TMP_CLEANUP_INTERVAL_MS)

  // Splash → main window crossfade (independent of hooks). The fade countdown
  // is anchored to the splash's first paint via scheduleSplashFade (see
  // createSplashWindow), so a slow compositor never closes the splash before
  // it was visible. Called after createWindow() above.
  scheduleSplashFade()
  startupComplete = true
  writeLog('INFO', 'startup: complete')

  // ── Sleep/resume resilience ──
  // System sleep can freeze SSE streams (fetch hangs), SQLite, and GPU context.
  powerMonitor.on('suspend', () => {
    writeLog('INFO', 'power: system suspending')
  })
  powerMonitor.on('resume', () => {
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
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
}).catch((err) => {
  writeLog('FATAL', `startup failed: ${err instanceof Error ? err.stack : String(err)}`)
  console.error('[Main] Failed to initialize:', err)
  app.quit()
})
}
