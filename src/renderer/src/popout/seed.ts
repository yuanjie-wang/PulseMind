// ── Popout side-window seed (2026-10-31 裁定「弹出携带侧边窗口的打开状态」)──
// The donor window hands its side-window state (workbench open tab + preview
// file tabs + the active file) to main at popoutOpen time; the popout renderer
// fetches it via POPOUT_SEED in main.tsx — BEFORE rendering — and applies it
// here, so WorkbenchPane and the 文件页签条 are restored on the first frame
// and useBrowserPaneBinding's first pane-state push already carries the right
// browserActive.
//
// Purely in-memory: the seed rides this one IPC round-trip and dies with the
// popout window. openByConversation stays out of workbenchStore's persist
// partialize and the preview tab maps were never persisted — a restart still
// boots with everything closed; the seed covers the popout handoff only.

import { useWorkbenchStore, WORKBENCH_TAB_IDS, type WorkbenchTab } from '../stores/workbenchStore'
import { usePreviewPaneStore } from '../stores/previewPaneStore'
import { makeTab, MAX_OPEN_TABS } from '../stores/preview-tabs'
import { reportSilentFailure } from '../utils/notify-core'
import type { PopoutWorkbenchSeed } from '../../../shared/types/electron-bridge'

export type { PopoutWorkbenchSeed }

/** Apply the donor seed to this window's stores. No-op on a null/empty seed
 *  (nothing carried = the previous closed-boot behavior). The active preview
 *  path is applied only when it is one of the carried tabs (fail-closed: a
 *  stale pointer must not point at nothing). */
export function applyPopoutSeed(convId: string, seed: PopoutWorkbenchSeed | null | undefined): void {
  if (!seed) return
  // 主视图模式（2026-11-04 裁定「对话在主窗是什么视图模式，弹出独立弹窗后要
  // 保持一致」）：primaryByConversation 不持久化、每窗一份内存态，不播种就恒
  // boot 成对话优先。非 chat 模式必须补 setOpen——chatSlot 只在 dock 渲染、
  // dock 关着时对话列不可达（与循环钮同一对调用）。'chat'/缺席不动：无条目即
  // 对话优先，多写一条空态条目只会让 map 无谓变长。模式先落、tab 后开：下面
  // openTab 的调和直接对最终 side 集合做（setConversationPrimary 自己也调和
  // activeTab，两条顺序的终态一致，先后只表达「模式是这一窗的底」）。
  if (seed.primary === 'files' || seed.primary === 'browser') {
    const store = useWorkbenchStore.getState()
    store.setConversationPrimary(convId, seed.primary)
    store.setOpen(convId, true)
  }
  if (seed.workbenchTab && WORKBENCH_TAB_IDS.has(seed.workbenchTab as WorkbenchTab)) {
    useWorkbenchStore.getState().openTab(convId, seed.workbenchTab)
  }
  const paths = (seed.previewPaths ?? []).slice(0, MAX_OPEN_TABS)
  if (paths.length === 0) return
  const tabs = paths.map(makeTab)
  const active = seed.activePreviewPath && tabs.some((t) => t.path === seed.activePreviewPath) ? seed.activePreviewPath : null
  const preview = usePreviewPaneStore.getState()
  usePreviewPaneStore.setState({
    tabsByConversation: { ...preview.tabsByConversation, [convId]: tabs },
    activeByConversation: { ...preview.activeByConversation, [convId]: active },
  })
}

/** Boot-side entry (main.tsx, BEFORE the first render): fetch this popout's
 *  donor seed over IPC and apply it to the local stores. Never rejects — a
 *  failed fetch reports silently and resolves, so the popout still boots
 *  (closed state = the previous behavior). */
export function loadAndApplyPopoutSeed(convId: string): Promise<void> {
  return window.electronAPI
    .popoutSeed(convId)
    .then((seed) => applyPopoutSeed(convId, seed))
    .catch((err) => {
      reportSilentFailure('popout seed', err)
    })
}
