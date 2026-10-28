import { BrowserWindow, ipcMain, nativeTheme } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { settingsStore } from '../storage/settings-store'
import { agentSessionManager } from '../agent/session-manager'
import { keepAwake } from '../system/keep-awake'
import { cleanupExpiredConversations } from '../services/conversation-retention'
import { expireOldBackups } from '../services/backup-retention'
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
    // 「上次使用」的保底透传 + 默认模型的 remember。设置编辑器存的是渲染端的
    // 整份快照（settingsStore.set 是整存），而 last-used 是主进程随时可能在写
    // 的字段（面板/其他窗口的修改）—— 用当前值覆盖快照里的旧值，整存就不会把
    // 主进程较新的 last-used 悄悄回滚。随后「默认模型变了」也是一次用户对模型
    // 的最新表达：直接落进这份整存载荷（不能走 rememberLastUsedProfileId 的
    // merge 写 —— 它排在 writeChain 前面，会被紧随其后的整存用旧值盖回去），
    // 与面板侧同一动作在 setActiveProfile 里的 remember 语义一致。
    try {
      const current = await settingsStore.get()
      settings.lastUsedApprovalMode = current.lastUsedApprovalMode
      settings.lastUsedProfileId = current.lastUsedProfileId
      // 运行态时间戳（上次记忆提取）：主进程每轮 sweep 落笔，渲染端快照必旧
      // ——同 last-used 的保底透传，整存不得悄悄回滚它。
      settings.memoryLastSweepAt = current.memoryLastSweepAt
      if (settings.activeProfileId && settings.activeProfileId !== current.activeProfileId) {
        settings.lastUsedProfileId = settings.activeProfileId
      }
    } catch { /* 读不出当前值就不猜 —— last-used 保持快照原样 */ }
    await settingsStore.set(settings)
    // P3-a: the retention family runs on every settings save, so a tightened
    // backup window takes effect without a restart (cleanupExpiredConversations
    // precedent — its own save path is below).
    try { expireOldBackups(settings.backupRetentionDays) } catch { /* best-effort */ }
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
