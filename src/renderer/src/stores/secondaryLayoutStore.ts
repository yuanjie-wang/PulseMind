// ── Project (immersive) window layout (2026-10-30) ──
// One persisted width: the explorer region (tree | preview) that sits left of
// the conversation. Global like the workbench pane's width — column geometry
// is about the user, not the project — and clamped at every consumption
// (clampExplorerWidth against the live row), never trusted raw off the disk.
//
// 2026-10-31（用户裁定「目录树/全文检索 + 对话/浏览器/工作计划 三面板」）：
// 左右两卡的激活面板也住这里——但**只在窗口内存里活**（同日追加裁定「进入
// 沉浸模式后，左侧默认选中文件，右侧默认选中对话」：面板选择不持久化，每次
// 进窗都从 文件/对话 起步，PopoutApp 挂载还会显式置一次默认压掉旧 JSON 残留；
// partialize 刻意只带 explorerWidth）。
// Deliberately its own store rather than a field on workbenchStore: the
// project window renders a WorkspacePane (which reads workbenchStore.treeWidth
// for the tree↔preview split), and its own explorer width is a different
// axis. Both are per-window module state, but the persisted keys share the
// origin's localStorage with the main window — which is the intent for both.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { EXPLORER_DEFAULT_WIDTH } from '../../../shared/ui/layout-widths'

/** 左卡的两个面板（2026-10-31 用户裁定）：文件 | 搜索。 */
export type ImmersiveLeftPanel = 'tree' | 'search'
/** 右卡的三个面板（2026-10-31 用户裁定）：对话 | 浏览器 | 工作计划。 */
export type ImmersiveRightPanel = 'chat' | 'browser' | 'plan'

interface SecondaryLayoutState {
  explorerWidth: number
  leftPanel: ImmersiveLeftPanel
  rightPanel: ImmersiveRightPanel
  setExplorerWidth: (width: number) => void
  setLeftPanel: (panel: ImmersiveLeftPanel) => void
  setRightPanel: (panel: ImmersiveRightPanel) => void
}

export const useSecondaryLayoutStore = create<SecondaryLayoutState>()(
  persist(
    (set) => ({
      explorerWidth: EXPLORER_DEFAULT_WIDTH,
      leftPanel: 'tree',
      rightPanel: 'chat',
      setExplorerWidth: (explorerWidth) => set({ explorerWidth }),
      setLeftPanel: (leftPanel) => set({ leftPanel }),
      setRightPanel: (rightPanel) => set({ rightPanel }),
    }),
    {
      name: 'pulsemind-project-window-layout',
      // 面板选择刻意不持久化（见头部 2026-10-31 追加裁定）——持久化的只有
      // explorer 宽度这一条几何。
      partialize: (s) => ({ explorerWidth: s.explorerWidth }) as SecondaryLayoutState,
    },
  ),
)
