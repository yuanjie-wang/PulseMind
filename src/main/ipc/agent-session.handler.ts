/**
 * Agent session IPC bridge (PLAN-0.3.5 M1.4④): exposes the main-hosted
 * session manager to renderers over the agent protocol's session methods.
 * Session events broadcast to every window (single-user app; per-client
 * routing arrives with the WS server in M2).
 */
import { ipcMain, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { agentSessionManager } from '../agent/session-manager'
import type { AgentEventData } from '../../shared/agent-protocol'

export function registerAgentSessionHandlers(): void {
  agentSessionManager.onEvent((sessionId, data: AgentEventData) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        try { win.webContents.send(IPC_CHANNELS.AGENT_SESSION_EVENT, { sessionId, data }) } catch { /* window closing */ }
      }
    }
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_SESSION_CREATE, async (_event, sessionId: string, opts?: { agentId?: string; title?: string }) => {
    return agentSessionManager.createSession(sessionId, opts)
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_SESSION_ASK, async (_event, sessionId: string, content: string) => {
    await agentSessionManager.ask(sessionId, content)
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_SESSION_CANCEL, (_event, sessionId: string) => {
    agentSessionManager.cancel(sessionId)
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_SESSION_HISTORY, (_event, sessionId: string) => {
    return agentSessionManager.history(sessionId)
  })
}
