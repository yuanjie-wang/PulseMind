import { BrowserWindow, ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { settingsStore } from '../storage/settings-store'
import { agentSessionManager } from '../agent/session-manager'
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
    // The 记忆/经验 master switches must reach the main-hosted managers right
    // away — engines and hooks read them through the shared manager instances.
    void agentSessionManager.applyFeatureToggles(settings).catch((err: unknown) =>
      console.warn('[settings] Failed to apply feature toggles:', err))
  })
}
