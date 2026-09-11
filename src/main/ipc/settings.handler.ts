import { BrowserWindow, ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { settingsStore } from '../storage/settings-store'
import { setTitleBarTheme } from '../window-chrome'
import type { AppSettings } from '../../shared/types/settings'

export function registerSettingsHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, async () => {
    return settingsStore.get()
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, async (event, settings: AppSettings) => {
    await settingsStore.set(settings)
    // The window chrome follows the theme, which this save may have just changed.
    setTitleBarTheme(settings.theme, BrowserWindow.fromWebContents(event.sender))
  })
}
