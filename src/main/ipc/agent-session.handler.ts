/**
 * Agent session IPC bridge (PLAN-0.3.5 M1.4④): exposes the main-hosted
 * session manager to renderers over the agent protocol's session methods.
 * Session events broadcast to every window (single-user app; per-client
 * routing arrives with the WS server in M2).
 */
import { ipcMain, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { agentSessionManager } from '../agent/session-manager'
import type { AgentEventData, AgentSessionCreateOptions } from '../../shared/agent-protocol'

export function registerAgentSessionHandlers(): void {
  agentSessionManager.onEvent((sessionId, data: AgentEventData) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        try { win.webContents.send(IPC_CHANNELS.AGENT_SESSION_EVENT, { sessionId, data }) } catch { /* window closing */ }
      }
    }
  })

  // Thin pass-through on purpose: createSession registers its pending create
  // synchronously, so a create that is still resolving the conversation's
  // workspace is visible to a racing ask (which then awaits it instead of
  // failing "session not found" and losing the first message).
  ipcMain.handle(IPC_CHANNELS.AGENT_SESSION_CREATE, (_event, sessionId: string, opts: AgentSessionCreateOptions = {}) =>
    agentSessionManager.createSession(sessionId, opts))

  ipcMain.handle(IPC_CHANNELS.AGENT_SESSION_ASK, async (_event, sessionId: string, content: string) => {
    await agentSessionManager.ask(sessionId, content)
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_SESSION_CANCEL, (_event, sessionId: string) => {
    agentSessionManager.cancel(sessionId)
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_SESSION_HISTORY, (_event, sessionId: string) => {
    return agentSessionManager.history(sessionId)
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_SESSION_HYDRATE, (_event, sessionId: string, messages: unknown[], historySummary?: { text: string; firstKeptId: string } | null) => {
    agentSessionManager.hydrate(sessionId, messages as never, historySummary ?? null)
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_SESSION_SNAPSHOT, (_event, sessionId: string) => {
    return agentSessionManager.snapshot(sessionId)
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_SESSION_ENGINE_CALL, async (_event, sessionId: string, method: string, args: unknown[]) => {
    return agentSessionManager.engineCall(sessionId, method, args ?? [])
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_SESSION_REFRESH_OPTIONS, async (_event, sessionId: string) => {
    await agentSessionManager.refreshOptions(sessionId)
  })
}
