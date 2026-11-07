// ── Secondary-window IPC (PLAN-conversation-popout 2026-10-30; project
//    windows 2026-10-30) ──
// Two invokes, one per window kind, plus the watch registration. Everything
// else the feature needs already exists: session events broadcast to all
// windows, the agent-session invokes are window-agnostic, window lifecycle
// announcements go out from the window module itself (broadcastPopoutEvent),
// and title renames already fan out through conversation.handler's
// CONVERSATION_UPDATE_TITLE.
//
// The project window reuses the popout module wholesale (same chrome, same
// gates, same single-writer chain) — the only extra wire is SECONDARY_WATCH,
// which is how a project window's moving 「当前会话」 reaches main so it can
// rebroadcast POPOUT_EVENT and keep the main window's adoption (and read
// receipt) in step with the in-window switcher.
import { BrowserWindow, ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import {
  openPopoutWindow,
  listPopoutConversations,
  getPopoutSeed,
  openProjectWindow,
  recordSecondaryWatchFromSender,
  focusProjectConversation,
} from '../popout-window'
import type { PopoutWorkbenchSeed } from '../../shared/types/electron-bridge'

export function registerPopoutHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.POPOUT_OPEN,
    (event, convId: string, title?: string, seed?: PopoutWorkbenchSeed) => {
      // 2026-10-31 追加裁定「窗口宽度，包括侧边窗口宽度，要保持一致」+ 追加
      // 「高度也一致」：弹窗与发起窗口同宽同高（侧边窗格宽度本就经
      // workbenchStore 的 localStorage 共享，窗宽对齐后整列布局才真正一致）。
      // donor 缺席/已销毁（异常发送方）→ undefined，openPopoutWindow 回落
      // 默认 42%×78% 尺寸。
      const donor = BrowserWindow.fromWebContents(event.sender)
      const donorBounds = donor && !donor.isDestroyed() ? donor.getBounds() : undefined
      void openPopoutWindow(convId, title, seed, donorBounds?.width, donorBounds?.height)
    },
  )
  ipcMain.handle(IPC_CHANNELS.POPOUT_LIST, () => listPopoutConversations())
  // The popout renderer's boot fetch (before its first render): the donor's
  // side-window open state — workbench tab + preview file tabs. In-memory
  // registry in popout-window.ts; null when there is nothing to carry.
  ipcMain.handle(IPC_CHANNELS.POPOUT_SEED, (_event, convId: string) => getPopoutSeed(convId))
  ipcMain.handle(IPC_CHANNELS.PROJECT_WINDOW_OPEN, (_event, projectId: string, name?: string) => {
    void openProjectWindow(projectId, name)
  })
  // Main owns the broadcast: the renderer reports which session it drives, and
  // main turns that into the popout lifecycle event every other window already
  // knows how to consume.
  ipcMain.handle(IPC_CHANNELS.SECONDARY_WATCH, (event, sessionId: string | null) => {
    recordSecondaryWatchFromSender(event.sender, sessionId ?? null)
  })
  // Main-window click on one of a project's conversations: raise the project's
  // immersive window and switch it onto the clicked conversation. false = no
  // window open for the project — the caller opens the conversation in-window.
  ipcMain.handle(IPC_CHANNELS.PROJECT_WINDOW_FOCUS_CONV, (_event, projectId: string, convId: string) =>
    focusProjectConversation(projectId, convId),
  )
}
