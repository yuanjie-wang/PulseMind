import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { toolPreferencesStore } from '../storage/tool-preferences-store'

export function registerToolHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.TOOLS_GET_PREFERENCES, async () => {
    return toolPreferencesStore.get()
  })

  ipcMain.handle(
    IPC_CHANNELS.TOOLS_SET_PREFERENCES,
    async (_event, prefs) => {
      await toolPreferencesStore.set(prefs)
    }
  )
}
