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
import { deriveConvType, getConversationProjectId } from '../storage/conversation.db'
import { resolveConversationWorkspace } from '../storage/conversation-workspace'

export function registerAgentSessionHandlers(): void {
  agentSessionManager.onEvent((sessionId, data: AgentEventData) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        try { win.webContents.send(IPC_CHANNELS.AGENT_SESSION_EVENT, { sessionId, data }) } catch { /* window closing */ }
      }
    }
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_SESSION_CREATE, async (_event, sessionId: string, opts: { agentId?: string; title?: string; clientId?: string; projectId?: string; workspaceDir?: string; sandbox?: unknown } = {}) => {
    // Local UI conversations resolve their working directory here (PLAN-0.4.0
    // M8): project-bound ones use the project's fixed workspace, plain ones get
    // a lazily-created timestamped folder under the global workspace. Canvas /
    // spawn ids and callers with an explicit workspaceDir keep the old fallback
    // (ws extensions and routines talk to the session manager directly).
    let workspaceDir = opts.workspaceDir
    if (!workspaceDir && deriveConvType(sessionId) === 'normal') {
      const projectId = opts.projectId ?? getConversationProjectId(sessionId)
      workspaceDir = await resolveConversationWorkspace(sessionId, projectId)
    }
    return agentSessionManager.createSession(sessionId, { ...opts, workspaceDir })
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
