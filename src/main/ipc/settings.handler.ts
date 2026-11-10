import { BrowserWindow, ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { settingsStore } from '../storage/settings-store'
import { applySettingsSideEffects } from '../services/settings-side-effects'
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
    } catch {
      /* 读不出当前值就不猜 —— last-used 保持快照原样 */
    }
    await settingsStore.set(settings)
    // 生效动作与模板包导入共用一份（services/settings-side-effects.ts）：
    // 主题重绘 / 开机自启 / 休眠守卫 / 记忆开关 / 菜单语言 / 保留期清扫 +
    // SETTINGS_CHANGED 广播。
    await applySettingsSideEffects(settings, { window: BrowserWindow.fromWebContents(event.sender) })
  })
}
