/** IPC surface for the local agent service settings (PLAN-0.3.5 M2.4) and the
 *  browser-extension panel (PLAN-browser-extension M1.5): status, the
 *  service toggle, and the extension-zip download the panel offers. */
import { ipcMain, app, dialog, BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import AdmZip from 'adm-zip'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { serviceRuntime, restartService, readToken, writeToken } from '../service-runtime'
import { settingsStore } from '../storage/settings-store'
import { randomUUID } from 'node:crypto'

/** Where `npm run build:extension` leaves the loadable extension. Packaged
 *  builds host it elsewhere (extraResources copies out/extension →
 *  resources/extension), so the panel only offers the path when it actually
 *  exists on disk. */
function extensionDir(): string | null {
  const candidates = [
    join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'extension'),
    join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'out', 'extension'),
  ]
  return candidates.find((dir) => existsSync(dir)) ?? null
}

export interface ExtensionExportResult {
  ok: boolean
  path?: string
  canceled?: boolean
  message?: string
}

/** Dev-only convenience: the packaged app ships the extension through
 *  extraResources, so only a dev checkout can start from "no build yet".
 *  `node` is right (not process.execPath — that is the Electron binary and
 *  would launch a second GUI), and dev always has it on PATH. */
async function buildExtensionInDev(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile('node', ['scripts/build-extension.js'], {
      cwd: app.getAppPath(),
      timeout: 120_000,
    }, (error, _stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message))
      else resolve()
    })
  })
}

export function registerServiceHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.SERVICE_GET_STATUS, async () => {
    const settings = await settingsStore.get()
    const handle = serviceRuntime.handle
    const port = handle?.port ?? settings.servicePort ?? 8765
    return {
      enabled: settings.serviceEnabled !== false,
      port,
      running: !!handle,
      token: readToken(),
      // Connected clients (the browser extension's panel shows up here).
      clients: handle?.clients() ?? [],
      wsUrl: `ws://127.0.0.1:${port}`,
      extensionDir: extensionDir(),
    }
  })

  ipcMain.handle(IPC_CHANNELS.SERVICE_SET_ENABLED, async (_event, enabled: boolean) => {
    await settingsStore.update(s => ({ ...s, serviceEnabled: enabled }))
    if (enabled) {
      await restartService()
    } else {
      await serviceRuntime.handle?.close()
      serviceRuntime.handle = null
    }
    return { running: !!serviceRuntime.handle, port: serviceRuntime.handle?.port ?? null }
  })

  ipcMain.handle(IPC_CHANNELS.SERVICE_SET_PORT, async (_event, port: number) => {
    await settingsStore.update(s => ({ ...s, servicePort: port }))
    await restartService()
    return { running: !!serviceRuntime.handle, port: serviceRuntime.handle?.port ?? null }
  })

  ipcMain.handle(IPC_CHANNELS.SERVICE_RESET_TOKEN, async () => {
    const token = randomUUID().replace(/-/g, '')
    writeToken(token)
    await restartService()
    return { token }
  })

  // The extension panel's 下载插件包: zip the built extension (top-level
  // folder so「加载已解压的扩展程序」gets a clean directory after unzip) and
  // let the user save it. A missing build self-heals in dev; in a packaged
  // app the extraResources copy makes it always present.
  ipcMain.handle(IPC_CHANNELS.EXTENSION_EXPORT_ZIP, async (): Promise<ExtensionExportResult> => {
    let dir = extensionDir()
    if (!dir && !app.isPackaged) {
      try {
        await buildExtensionInDev()
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
      dir = extensionDir()
    }
    if (!dir) {
      return { ok: false, message: 'extension build not found (out/extension)' }
    }
    const zip = new AdmZip()
    zip.addLocalFolder(dir, 'pulsemind-extension')
    const zipPath = join(tmpdir(), `pulsemind-extension-${Date.now()}.zip`)
    zip.writeZip(zipPath)
    try {
      const win = BrowserWindow.getAllWindows()[0]
      const result = await dialog.showSaveDialog(win ?? undefined, {
        title: '保存浏览器插件包',
        defaultPath: 'pulsemind-extension.zip',
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
      })
      if (result.canceled || !result.filePath) {
        return { ok: false, canceled: true }
      }
      await writeFile(result.filePath, await readFile(zipPath))
      return { ok: true, path: result.filePath }
    } finally {
      // The staged zip is disposable once read (or abandoned on cancel).
      void rm(zipPath, { force: true }).catch(() => {})
    }
  })
}
