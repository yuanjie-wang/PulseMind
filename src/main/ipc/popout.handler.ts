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
import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import {
  openPopoutWindow,
  listPopoutConversations,
  openProjectWindow,
  recordSecondaryWatchFromSender,
} from '../popout-window'

export function registerPopoutHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.POPOUT_OPEN, (_event, convId: string, title?: string) => {
    void openPopoutWindow(convId, title)
  })
  ipcMain.handle(IPC_CHANNELS.POPOUT_LIST, () => listPopoutConversations())
  ipcMain.handle(IPC_CHANNELS.PROJECT_WINDOW_OPEN, (_event, projectId: string, name?: string) => {
    void openProjectWindow(projectId, name)
  })
  // Main owns the broadcast: the renderer reports which session it drives, and
  // main turns that into the popout lifecycle event every other window already
  // knows how to consume.
  ipcMain.handle(IPC_CHANNELS.SECONDARY_WATCH, (event, sessionId: string | null) => {
    recordSecondaryWatchFromSender(event.sender, sessionId ?? null)
  })
}
