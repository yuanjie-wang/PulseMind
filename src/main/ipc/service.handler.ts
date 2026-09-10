/** IPC surface for the local agent service settings (PLAN-0.3.5 M2.4). */
import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { serviceRuntime, restartService, readToken, writeToken } from '../service-runtime'
import { settingsStore } from '../storage/settings-store'
import { randomUUID } from 'node:crypto'

export function registerServiceHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.SERVICE_GET_STATUS, async () => {
    const settings = await settingsStore.get()
    const handle = serviceRuntime.handle
    return {
      enabled: settings.serviceEnabled !== false,
      port: handle?.port ?? settings.servicePort ?? 8765,
      running: !!handle,
      token: readToken(),
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
