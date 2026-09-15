/** IPC surface for the local agent service settings (PLAN-0.3.5 M2.4) and the
 *  browser-extension card (PLAN-browser-extension M1.5). */
import { ipcMain, app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { serviceRuntime, restartService, readToken, writeToken } from '../service-runtime'
import { settingsStore } from '../storage/settings-store'
import { randomUUID } from 'node:crypto'

/** Where `npm run build:extension` leaves the loadable extension. Packaged
 *  builds host it elsewhere (M5), so the card only offers the path when it
 *  actually exists on disk. */
function extensionDir(): string | null {
  const candidates = [
    join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'extension'),
    join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'out', 'extension'),
  ]
  return candidates.find((dir) => existsSync(dir)) ?? null
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
    const settings = await settingsStore.get()
    await settingsStore.set({ ...settings, serviceEnabled: enabled })
    if (enabled) {
      await restartService()
    } else {
      await serviceRuntime.handle?.close()
      serviceRuntime.handle = null
    }
    return { running: !!serviceRuntime.handle, port: serviceRuntime.handle?.port ?? null }
  })

  ipcMain.handle(IPC_CHANNELS.SERVICE_SET_PORT, async (_event, port: number) => {
    const settings = await settingsStore.get()
    await settingsStore.set({ ...settings, servicePort: port })
    await restartService()
    return { running: !!serviceRuntime.handle, port: serviceRuntime.handle?.port ?? null }
  })

  ipcMain.handle(IPC_CHANNELS.SERVICE_RESET_TOKEN, async () => {
    const token = randomUUID().replace(/-/g, '')
    writeToken(token)
    await restartService()
    return { token }
  })
}
