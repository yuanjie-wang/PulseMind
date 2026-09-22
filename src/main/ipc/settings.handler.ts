import { BrowserWindow, ipcMain, nativeTheme } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { settingsStore } from '../storage/settings-store'
import { agentSessionManager } from '../agent/session-manager'
import { keepAwake } from '../system/keep-awake'
import { cleanupExpiredConversations } from '../services/conversation-retention'
import { setTitleBarTheme } from '../window-chrome'
import { rebuildApplicationMenu } from '../menu'
import { applyLaunchAtLogin } from '../tray'
import { resolveThemePreference } from '../../shared/theme'
import type { AppSettings } from '../../shared/types/settings'

export function registerSettingsHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, async () => {
    return settingsStore.get()
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, async (event, settings: AppSettings) => {
    await settingsStore.set(settings)
    // The window chrome follows the theme, which this save may have just changed.
    // 'system' resolves against nativeTheme here; the renderer resolves the same
    // preference against prefers-color-scheme for its own surfaces.
    setTitleBarTheme(
      resolveThemePreference(settings.theme, nativeTheme.shouldUseDarkColors),
      BrowserWindow.fromWebContents(event.sender)
    )
    // 开机自启 was tray-only; the settings UI now writes the same preference.
    // Idempotent, and the tray's 30s rebuild() picks the checkbox up on its own.
    applyLaunchAtLogin(!!settings.launchAtLogin)
    // 运行期间阻止休眠 takes effect on save, not on the next run: off releases
    // immediately, on re-acquires if a session is still mid-run (the guard
    // keeps tracking statuses while switched off). Defaults off — every toggle
    // in the 高级 panel does.
    keepAwake.setEnabled(settings.keepAwakeEnabled ?? false)
    // The 记忆/经验 master switches must reach the main-hosted managers right
    // away — engines and hooks read them through the shared manager instances.
    void agentSessionManager.applyFeatureToggles(settings).catch((err: unknown) =>
      console.warn('[settings] Failed to apply feature toggles:', err))
    // The application menu's labels follow the locale; this save may have just
    // changed it. Cheap rebuild from the stored getter.
    void rebuildApplicationMenu().catch((err: unknown) =>
      console.warn('[settings] Failed to rebuild application menu:', err))
    // 对话管理 · 最长保留时长：the policy takes effect on save, not on the next
    // restart. Awaiting it means the save resolves AFTER the expiries landed,
    // so the caller's list reload sees the pruned DB. Bounded work (≤500 rows).
    try { await cleanupExpiredConversations() } catch (err) {
      console.warn('[settings] conversation retention failed:', err)
    }
  })
}
