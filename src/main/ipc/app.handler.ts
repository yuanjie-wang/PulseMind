import { ipcMain, shell, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { platform, release, arch } from 'node:os'
import { stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { DATA_DIR, SKILLS_DIR, WORKSPACE_DIR, SETTINGS_PATH, KNOWLEDGE_DIR, TOOLS_DIR } from '../storage'
import { getBundledRipgrepPath, getPlatformName } from '../services/platform-info'
import { safeExternalUrl } from '../utils/external-url'
import { setTitleBarMaskAlpha } from '../window-chrome'

export interface PlatformInfo {
  platform: string
  platformName: string
  release: string
  arch: string
  ripgrepPath: string | null
}

export interface DataPaths {
  dataDir: string
  skillsDir: string
  workspaceDir: string
  settingsPath: string
  knowledgeDir: string
  /** User tools (tool studio), PLAN-0.4.0 M5. */
  toolsDir: string
}


// ── Sleep/resume ack tracking ───────────────────────────────────────
// The renderer acknowledges resume so the main process can avoid a full reload.
let resumeAckReceived = false
let resumeFallbackTimer: ReturnType<typeof setTimeout> | null = null

ipcMain.on(IPC_CHANNELS.APP_SYSTEM_RESUMED_ACK, () => {
  resumeAckReceived = true
  if (resumeFallbackTimer) {
    clearTimeout(resumeFallbackTimer)
    resumeFallbackTimer = null
  }
})

/**
 * Send a resume notification to the renderer and wait for its ack.
 * If the renderer doesn't ack within `timeoutMs`, the `fallback` callback runs.
 */
export function notifyResume(win: BrowserWindow, timeoutMs: number, fallback: () => void): void {
  resumeAckReceived = false
  win.webContents.send(IPC_CHANNELS.APP_SYSTEM_RESUMED)
  resumeFallbackTimer = setTimeout(() => {
    if (!resumeAckReceived) {
      console.warn('[Power] Renderer did not ack resume — running fallback')
      fallback()
    }
    resumeFallbackTimer = null
  }, timeoutMs)
}

export function registerAppHandlers(): void {
  // The renderer's mask watcher reports the combined alpha of the full-window
  // masks currently open (fire-and-forget — a visual state has no reply). The
  // blend itself lives in window-chrome (theme × alpha → overlay colours), so
  // a theme save racing a modal open still repaints both halves correctly.
  ipcMain.on(IPC_CHANNELS.WINDOW_SET_TITLE_BAR_MASK, (event, alpha: number) => {
    setTitleBarMaskAlpha(alpha, BrowserWindow.fromWebContents(event.sender))
  })

  ipcMain.handle(IPC_CHANNELS.APP_GET_PLATFORM_INFO, async (): Promise<PlatformInfo> => {
    const p = platform()
    const info: PlatformInfo = {
      platform: p,
      platformName: getPlatformName(p),
      release: release(),
      arch: arch(),
      ripgrepPath: getBundledRipgrepPath()
    }
    // Validate the ripgrep binary: if it can't execute (e.g. arch mismatch on ARM64 Windows),
    // fall back to PATH or built-in alternatives.
    if (info.ripgrepPath) {
      try {
        await new Promise<void>((resolve, reject) => {
          execFile(info.ripgrepPath!, ['--version'], { timeout: 5000 }, (err) => {
            if (err) reject(err)
            else resolve()
          })
        })
      } catch {
        info.ripgrepPath = null
      }
    }
    return info
  })

  ipcMain.handle(IPC_CHANNELS.APP_GET_DATA_PATHS, async (): Promise<DataPaths> => {
    return {
      dataDir: DATA_DIR,
      skillsDir: SKILLS_DIR,
      workspaceDir: WORKSPACE_DIR,
      toolsDir: TOOLS_DIR,
      settingsPath: SETTINGS_PATH,
      knowledgeDir: KNOWLEDGE_DIR
    }
  })

  ipcMain.handle(IPC_CHANNELS.SHELL_OPEN_FOLDER, async (_event, folderPath: string): Promise<void> => {
    await shell.openPath(folderPath)
  })

  ipcMain.handle(IPC_CHANNELS.SHELL_OPEN_EXTERNAL, async (_event, url: string): Promise<void> => {
    // Scheme-gated (review 2026-09-25 P0-2) — see utils/external-url.ts.
    const safe = safeExternalUrl(url, DATA_DIR)
    if (!safe) throw new Error(`blocked external URL (scheme not allowed): ${String(url).slice(0, 120)}`)
    await shell.openExternal(safe)
  })

  ipcMain.handle(IPC_CHANNELS.FILE_STAT, async (_event, filePath: string): Promise<{ size: number; birthtime: string; mtime: string; isDirectory: boolean } | null> => {
    try {
      const s = await stat(filePath)
      return { size: s.size, birthtime: s.birthtime.toISOString(), mtime: s.mtime.toISOString(), isDirectory: s.isDirectory() }
    } catch { return null }
  })
}
