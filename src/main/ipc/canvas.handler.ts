import { ipcMain, dialog, shell, BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { getDb } from '../storage/database'

// ── Persistent manifest ──

const CANVAS_DIR = path.join(homedir(), '.pulsemind', 'canvas')
const MANIFEST_PATH = path.join(CANVAS_DIR, 'manifest.json')

let _manifest: Record<string, string> | null = null

function loadManifest(): Record<string, string> {
  if (_manifest) return _manifest
  try {
    if (fs.existsSync(MANIFEST_PATH)) {
      const raw = fs.readFileSync(MANIFEST_PATH, 'utf-8')
      _manifest = JSON.parse(raw)
    } else {
      _manifest = {}
    }
  } catch {
    _manifest = {}
  }
  return _manifest!
}

function saveManifest(): void {
  if (!_manifest) return
  fs.mkdirSync(CANVAS_DIR, { recursive: true })
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(_manifest, null, 2), 'utf-8')
}

function workDir(rectId: string): string {
  const manifest = loadManifest()
  let dir = manifest[rectId]
  if (!dir || !fs.existsSync(dir)) {
    const now = new Date()
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`
    dir = path.join(CANVAS_DIR, `${stamp}-${rectId.slice(0, 8)}`)
    manifest[rectId] = dir
    saveManifest()
  }
  return dir
}

/** Scan canvas dir for directories not referenced by the manifest and remove them. */
function cleanupOrphanedDirs(): void {
  const manifest = loadManifest()
  const known = new Set(Object.values(manifest))
  if (!fs.existsSync(CANVAS_DIR)) return
  for (const entry of fs.readdirSync(CANVAS_DIR)) {
    if (entry === 'manifest.json') continue
    const fullPath = path.join(CANVAS_DIR, entry)
    if (!fs.existsSync(fullPath)) continue
    const stat = fs.statSync(fullPath)
    if (stat.isDirectory() && !known.has(fullPath)) {
      try {
        fs.rmSync(fullPath, { recursive: true, force: true })
      } catch {
        // best-effort cleanup
      }
    }
  }
}

// ── Register handlers ──

export function registerCanvasHandlers(): void {
  // Clean up orphaned directories from previous sessions on first handler registration
  cleanupOrphanedDirs()

  ipcMain.handle(IPC_CHANNELS.CANVAS_PREPARE_WORK_DIR, async (_event, rectId: string, existingCode?: string, fresh?: boolean) => {
    if (fresh) {
      const manifest = loadManifest()
      delete manifest[rectId]
      saveManifest()
    }
    const dir = workDir(rectId)
    fs.mkdirSync(dir, { recursive: true })
    const p = path.join(dir, 'index.html')
    if (!fs.existsSync(p)) {
      fs.writeFileSync(p, existingCode || '<!DOCTYPE html><html><head></head><body></body></html>')
    }
    return dir
  })

  ipcMain.handle(IPC_CHANNELS.CANVAS_EXPORT_HTML, async (_event, rectId: string) => {
    const htmlPath = path.join(workDir(rectId), 'index.html')
    if (!fs.existsSync(htmlPath)) return { success: false, error: 'No generated content found' }

    const dirName = path.basename(workDir(rectId))
    const result = await dialog.showSaveDialog({
      defaultPath: `${dirName}.html`,
      filters: [{ name: 'HTML', extensions: ['html'] }],
    })
    if (result.canceled || !result.filePath) return { success: false, canceled: true }

    fs.copyFileSync(htmlPath, result.filePath)
    return { success: true, filePath: result.filePath }
  })

  ipcMain.handle(IPC_CHANNELS.CANVAS_OPEN_IN_BROWSER, async (_event, rectId: string) => {
    const htmlPath = path.join(workDir(rectId), 'index.html')
    if (!fs.existsSync(htmlPath)) return { success: false, error: 'No generated content found' }

    const tmpDir = tmpdir()
    const tmpPath = path.join(tmpDir, `pulsemind-canvas-${rectId.slice(0, 8)}.html`)
    fs.copyFileSync(htmlPath, tmpPath)
    await shell.openPath(tmpPath)
    return { success: true }
  })

  ipcMain.handle(IPC_CHANNELS.CANVAS_EXPORT_IMAGE, async (_event, rectId: string, viewport?: { width: number; height: number }, htmlContent?: string) => {
    // Fall back to reading from disk if no inline content provided
    const html = htmlContent || (() => {
      const htmlPath = path.join(workDir(rectId), 'index.html')
      if (!fs.existsSync(htmlPath)) return null
      return fs.readFileSync(htmlPath, 'utf-8')
    })()
    if (!html) return { success: false, error: 'No generated content found' }

    const dirName = path.basename(workDir(rectId))
    const result = await dialog.showSaveDialog({
      defaultPath: `${dirName}.png`,
      filters: [{ name: 'PNG Image', extensions: ['png'] }],
    })
    if (result.canceled || !result.filePath) return { success: false, canceled: true }

    return captureCanvasImage(html, result.filePath, viewport)
  })

  // ── Cleanup a single canvas rect: delete work dir + conversation ──
  ipcMain.handle(IPC_CHANNELS.CANVAS_CLEANUP_RECT, async (_event, rectId: string) => {
    // Delete work directory
    const manifest = loadManifest()
    const dir = manifest[rectId]
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
    delete manifest[rectId]
    saveManifest()
    _manifest = manifest

    // Delete conversation records with convId matching this rectId
    const db = getDb()
    const convs = db.prepare(
      `SELECT id FROM conversations WHERE rect_id = ?`
    ).all(rectId) as { id: string }[]
    for (const conv of convs) {
      db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conv.id)
      db.prepare('DELETE FROM conversations WHERE id = ?').run(conv.id)
    }

    return { success: true, deletedConvs: convs.length }
  })

  // ── Clear ALL canvas data: delete all work dirs + all canvas conversations ──
  ipcMain.handle(IPC_CHANNELS.CANVAS_CLEAR_ALL, async () => {
    // Delete all canvas work directories
    if (fs.existsSync(CANVAS_DIR)) {
      const entries = fs.readdirSync(CANVAS_DIR)
      for (const entry of entries) {
        if (entry === 'manifest.json') continue
        const fullPath = path.join(CANVAS_DIR, entry)
        fs.rmSync(fullPath, { recursive: true, force: true })
      }
    }
    _manifest = {}
    saveManifest()

    // Delete all canvas conversations
    const db = getDb()
    const convs = db.prepare(
      `SELECT id FROM conversations WHERE type = 'canvas'`
    ).all() as { id: string }[]
    for (const conv of convs) {
      db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conv.id)
      db.prepare('DELETE FROM conversations WHERE id = ?').run(conv.id)
    }

    return { success: true, deletedConvs: convs.length }
  })
}

async function captureCanvasImage(html: string, outputPath: string, viewport?: { width: number; height: number }): Promise<{ success: boolean; error?: string }> {
  const vw = viewport?.width ?? 1280
  const vh = viewport?.height ?? 800

  const win = new BrowserWindow({
    width: Math.ceil(vw),
    height: Math.ceil(vh),
    show: false,
    webPreferences: {
      sandbox: false,
      javascript: true,
      images: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })

  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)

    // Wait for fonts/images/scripts to load
    await new Promise((resolve) => setTimeout(resolve, 1500))

    // Measure actual content height and trim if shorter than viewport
    const contentH = await win.webContents.executeJavaScript(
      `Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)`
    ) as number
    const trimH = Math.min(Math.ceil(contentH), vh)

    if (trimH < vh) {
      win.setMinimumSize(100, 100)
      win.setSize(Math.ceil(vw), trimH)
      win.center()
      await new Promise((resolve) => setTimeout(resolve, 200))
    }

    const image = await win.webContents.capturePage()
    fs.writeFileSync(outputPath, image.toPNG())
    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}
