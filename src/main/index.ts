import { app, BrowserWindow, shell, nativeImage, protocol, powerMonitor } from 'electron'
import { homedir } from 'node:os'
import { join, extname } from 'node:path'
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs'
import { registerIpcHandlers } from './ipc'
import { ensureDataDir } from './storage'
import { initializeDatabase, ensureDbHealthy } from './storage/database'
import { skillStore } from './storage/skill-store'
import { runTmpCleanup, TMP_CLEANUP_INTERVAL_MS } from './storage/tmp-cleanup'
import { runLaunchHooks } from './hooks-runner'
import { IPC_CHANNELS } from '../shared/ipc-channels'
import { cancelAllRequests } from './ipc/api-proxy.handler'
import { notifyResume } from './ipc/app.handler'

let mainWindow: BrowserWindow | null = null
let splashWindow: BrowserWindow | null = null

// ── Startup & crash log ──────────────────────────────────────────────
// Packaged builds on Windows have no visible console, so a silent first-run
// auto-close (app.quit from the startup catch, window-all-closed, or an
// uncaught exception) leaves no trace. Record every startup step and any
// fatal error to ~/.pulsemind/logs/main.log to make it diagnosable.
const LOG_DIR = join(homedir(), '.pulsemind', 'logs')
function writeLog(level: 'INFO' | 'WARN' | 'FATAL', message: string): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(join(LOG_DIR, 'main.log'), `[${new Date().toISOString()}] [${level}] ${message}\n`)
  } catch {
    // Logging must never take the app down.
  }
}

let startupComplete = false

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
})
app.on('child-process-gone', (_e, details) => {
  writeLog('WARN', `child-process-gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`)
})

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
  splashWindow.loadFile(getResourcePath('splash', 'splash.html'))
  splashWindow.on('ready-to-show', () => {
    if (!splashWindow || splashWindow.isDestroyed()) return
    // Reveal only once the page is painted, so the window never appears blank.
    splashWindow.show()
    splashShownAt = Date.now()
    scheduleSplashFade()
  })
  splashWindow.on('closed', () => { splashWindow = null })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
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
  // Uses fs.readFileSync instead of net.fetch to avoid redirect/encoding issues
  // on Windows and to properly handle binary files (images).
  protocol.handle('local-file', (request) => {
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
      const content = readFileSync(filePath)
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

  createWindow()
  writeLog('INFO', 'startup: main window created')

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
  powerMonitor.on('resume', () => {
    console.log('[Power] System resumed from sleep')
    const win = mainWindow
    if (!win) return

    // Give network stack time to come back before any recovery actions
    setTimeout(() => {
      // 1. Abort all hanging API streams (SSE fetch readers block forever after sleep)
      try {
        cancelAllRequests()
      } catch (err) {
        console.warn('[Power] cancelAllRequests failed:', err)
      }

      // 2. Reinitialize database connection (SQLite may have stale locks)
      try {
        ensureDbHealthy()
      } catch (err) {
        console.error('[Power] DB reinit failed:', err)
      }

      // 3. Notify renderer to recover gracefully (GPU context, WebGL, timers).
      //    If renderer doesn't ack within 5s, fall back to a full reload.
      notifyResume(win, 5000, () => {
        try {
          console.log('[Power] Renderer unresponsive — reloading')
          win.webContents.reload()
        } catch (_) { /* window may be destroyed */ }
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
