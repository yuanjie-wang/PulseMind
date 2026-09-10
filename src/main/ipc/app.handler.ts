import { ipcMain, shell, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { platform, release, arch } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { DATA_DIR, SKILLS_DIR, WORKSPACE_DIR, SETTINGS_PATH, KNOWLEDGE_DIR } from '../storage'

const PLATFORM_NAMES: Record<string, string> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
  freebsd: 'FreeBSD',
  openbsd: 'OpenBSD',
  sunos: 'SunOS'
}

export function getBundledRipgrepPath(): string | null {
  const p = platform()
  const a = arch()
  const key = `${p}-${a}`
  const binaryName = p === 'win32' ? 'rg.exe' : 'rg'
  // Production: inside app resources
  const prodPath = join(process.resourcesPath, 'bin', key, binaryName)
  if (existsSync(prodPath)) return prodPath
  // Dev mode: look in project resources/bin/
  const devPath = join(__dirname, '../../resources/bin', key, binaryName)
  if (existsSync(devPath)) return devPath
  return null
}

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
}

export function getPlatformName(p: string): string {
  return PLATFORM_NAMES[p] || p
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
            err ? reject(err) : resolve()
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
      settingsPath: SETTINGS_PATH,
      knowledgeDir: KNOWLEDGE_DIR
    }
  })

  ipcMain.handle(IPC_CHANNELS.SHELL_OPEN_FOLDER, async (_event, folderPath: string): Promise<void> => {
    await shell.openPath(folderPath)
  })

  ipcMain.handle(IPC_CHANNELS.SHELL_OPEN_EXTERNAL, async (_event, url: string): Promise<void> => {
    await shell.openExternal(url)
  })

  ipcMain.handle(IPC_CHANNELS.FILE_STAT, async (_event, filePath: string): Promise<{ size: number; birthtime: string; mtime: string } | null> => {
    try {
      const s = await stat(filePath)
      return { size: s.size, birthtime: s.birthtime.toISOString(), mtime: s.mtime.toISOString() }
    } catch { return null }
  })
}
