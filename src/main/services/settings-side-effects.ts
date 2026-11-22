// ── 设置写盘后的生效动作（2026-11-10 抽出）──
// 「整份设置刚被替换」有两个入口：设置页的 SETTINGS_SET 与 welcome 引导卡的
// 一次性模板包导入（TEMPLATE_IMPORT）。这串动作原先只写在 SETTINGS_SET 里，
// 于是导入模板后主题/标题栏/开机自启/菜单语言/记忆开关都要等重启才生效——
// 「导进来了但看起来没变」，而模板包存在的意义恰恰是让一台空机器立刻可用。
//
// 这里每个动作都是「已经落盘了，但内存里还有人拿着旧值」的那一类：主题、开机
// 自启、休眠守卫、记忆开关、菜单语言、保留期清扫，以及活会话的引擎 option
// bag（模型连接与预算——见 option-bag-sync）。
//
// 逐个动作独立兜底：设置已经落盘，副作用是尽力而为，任一失败不得中断其余。
// 广播也在这里（SETTINGS_CHANGED 用**存储层视图**而非调用方载荷——set() 会
// 重算派生 profiles，调用方的快照是旧的）。

import { BrowserWindow, nativeTheme } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { resolveThemePreference } from '../../shared/theme'
import type { AppSettings } from '../../shared/types/settings'
import { settingsStore } from '../storage/settings-store'
import { agentSessionManager } from '../agent/session-manager'
import { keepAwake } from '../system/keep-awake'
import { cleanupExpiredConversations } from '../services/conversation-retention'
import { expireOldBackups } from '../services/backup-retention'
import { refreshOptionBags } from './option-bag-sync'
import { setTitleBarTheme } from '../window-chrome'
import { refreshPopoutTitleBarTheme } from '../popout-window'
import { rebuildApplicationMenu } from '../menu'
import { applyLaunchAtLogin } from '../tray'

export interface SettingsSideEffectOptions {
  /** 触发这次保存的窗口：标题栏重绘只作用于它，其余窗口靠下面的广播。 */
  window?: BrowserWindow | null
  /** 是否在副作用之后广播 SETTINGS_CHANGED（默认 true）。 */
  broadcast?: boolean
  /** 保存**之前**的设置（settings.handler 读到的旧值）。给了才有「引擎 option
   *  bag 的输入是否真变了」的判据；没给（模板包导入，设置已由导入步骤写入）
   *  按一定变了处理——那条路可能整批换模型。 */
  previous?: AppSettings | null
}

/**
 * Apply the effects a settings save must have immediately, then (optionally)
 * broadcast the store's fresh view. Caller must have awaited `set()` first —
 * the retention sweep re-reads the store.
 */
export async function applySettingsSideEffects(settings: AppSettings, opts: SettingsSideEffectOptions = {}): Promise<void> {
  // P3-a: the retention family runs on every settings save, so a tightened
  // backup window takes effect without a restart.
  try {
    expireOldBackups(settings.backupRetentionDays)
  } catch {
    /* best-effort */
  }
  // The window chrome follows the theme, which this save may have just changed.
  // 'system' resolves against nativeTheme here; the renderer resolves the same
  // preference against prefers-color-scheme for its own surfaces. The sender
  // repaint covers the saving window; the secondaries (popout + project
  // windows) get the SAME resolved mode — their web content follows this save
  // via the SETTINGS_CHANGED broadcast below, and their OS-drawn caption
  // buttons must move with it (2026-11-02: they used to keep the previous
  // theme's colours until the OS itself flipped).
  const chromeTheme = resolveThemePreference(settings.theme, nativeTheme.shouldUseDarkColors)
  setTitleBarTheme(chromeTheme, opts.window ?? null)
  refreshPopoutTitleBarTheme(chromeTheme)
  // 开机自启 was tray-only; the settings UI now writes the same preference.
  // Idempotent, and the tray's 30s rebuild() picks the checkbox up on its own.
  applyLaunchAtLogin(!!settings.launchAtLogin)
  // 运行期间阻止休眠 takes effect on save, not on the next run: off releases
  // immediately, on re-acquires if a session is still mid-run (the guard
  // keeps tracking statuses while switched off). Defaults off.
  keepAwake.setEnabled(settings.keepAwakeEnabled ?? false)
  // The 记忆/经验 master switches must reach the main-hosted managers right
  // away — engines and hooks read them through the shared manager instances.
  void agentSessionManager.applyFeatureToggles(settings).catch((err: unknown) => console.warn('[settings] Failed to apply feature toggles:', err))
  // 模型连接与预算（最大上下文 / 输出上限 / 模型名 / Base URL / API Key）、
  // 人格与人称、语言、工作区：这些是引擎 option bag 的输入，改完必须当场换袋。
  // 漏了这一步的后果是「改完设置在同一个会话里继续问，引擎还在用旧窗口」——
  // 用户以为在验 50K，实际按 150K 跑（2026-11-22 真机病例，见 option-bag-sync）。
  //
  // 比的是**存储层视图**，不是调用方的保存载荷：写入只认 providers，派生的
  // profiles 由 set() 重算，渲染端快照里那份可能是旧的——拿它当「新值」会
  // 把真改动判成没改（同一个陷阱，下面的广播注释也记着）。`previous` 缺席
  // = 没有旧值可比（模板包导入），按一定变了处理。
  try {
    const fresh = await settingsStore.get()
    await refreshOptionBags(opts.previous ?? null, fresh, () => agentSessionManager.refreshAllSessions())
  } catch (err) {
    console.warn('[settings] Failed to refresh session option bags:', err)
  }
  // The application menu's labels follow the locale; this save may have just
  // changed it. Cheap rebuild from the stored getter.
  void rebuildApplicationMenu().catch((err: unknown) => console.warn('[settings] Failed to rebuild application menu:', err))
  // 对话管理 · 最长保留时长：the policy takes effect on save, not on the next
  // restart. Awaiting it means the save resolves AFTER the expiries landed,
  // so the caller's list reload sees the pruned DB. Bounded work (≤500 rows).
  try {
    await cleanupExpiredConversations()
  } catch (err) {
    console.warn('[settings] conversation retention failed:', err)
  }
  if (opts.broadcast === false) return
  // Push the saved settings to every window. Settings are per-process state
  // (the popout resolves its theme/locale from the same file); without this
  // a theme/locale switch in one window leaves the others stale until reload.
  try {
    const fresh = await settingsStore.get()
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        try {
          win.webContents.send(IPC_CHANNELS.SETTINGS_CHANGED, fresh)
        } catch {
          /* window closing */
        }
      }
    }
  } catch (err) {
    console.warn('[settings] failed to broadcast settings change:', err)
  }
}
