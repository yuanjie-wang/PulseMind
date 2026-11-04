// 会话头三态循环钮的共用表与换挡动作（2026-11-04 裁定，修订二期「无全局
// 切换器」）。主窗（AppLayout 标题栏）与会话弹出窗口（PopoutApp 头部动作簇）
// 是同一颗钮，表与「换到 files/browser 时补开 dock」的语义只能有一份——两处
// 各写一遍必然漂移（图标/文案换了只改到一边）。

import type { ComponentType, CSSProperties } from 'react'
import { newTaskModeIcon } from '../../navigation/registry'
import { nextPrimary, useWorkbenchStore, type PrimaryPane } from '../../stores/workbenchStore'

// 键 = 当前模式，值 = 当前模式的图标/文案——三态循环，图标即状态、不宣传
// 下一档（用户裁定：图标展示当前状态）。图标不是这里自选的：直接取新建任务
// 子菜单那张表（2026-11-04 用户裁定「需要和新建任务子菜单的图标保持一致，
// 相同语义」）——对话/工作区/浏览器 对应子菜单的 对话/项目/浏览器 三档。
export const PRIMARY_CYCLE_ICON: Record<PrimaryPane, ComponentType<{ style?: CSSProperties }>> = {
  chat: newTaskModeIcon('chat'),
  files: newTaskModeIcon('project'),
  browser: newTaskModeIcon('browser'),
}
export const PRIMARY_CYCLE_TITLE: Record<PrimaryPane, string> = {
  chat: 'appLayout.primaryViewChat',
  files: 'appLayout.primaryViewWorkspace',
  browser: 'appLayout.primaryViewBrowser',
}

/** 循环到下一档。换到 files/browser 时补开 dock——chatSlot 只在 dock 渲染，
 *  dock 关着时对话列不可达（与浏览器任务物化路径的 setOpen(true) 同语义）；
 *  回 chat 不动 dock 开合（标准 chat+dock 态）。activeTab 不手工设：
 *  setConversationPrimary 内部 reconcileActiveTab 已调和。 */
export function cyclePrimaryMode(wbKey: string, primary: PrimaryPane): void {
  const next = nextPrimary(primary)
  useWorkbenchStore.getState().setConversationPrimary(wbKey, next)
  if (next !== 'chat') useWorkbenchStore.getState().setOpen(wbKey, true)
}
