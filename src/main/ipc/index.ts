import { registerConversationHandlers } from './conversation.handler'
import { registerProjectHandlers } from './project.handler'
import { registerSettingsHandlers } from './settings.handler'
import { registerTerminalHandlers } from './terminal.handler'
import { registerToolHandlers } from './tools.handler'
import { registerSkillHandlers } from './skills.handler'
import { registerExperienceHandlers } from './experiences.handler'
import { registerApiProxyHandlers } from './api-proxy.handler'
import { registerMemoryHandlers, registerMemoryPageHandlers } from './memory.handler'
import { registerAppHandlers } from './app.handler'
import { registerDialogHandlers } from './dialog.handler'
import { registerFileOpsHandlers } from './file-ops.handler'
import { registerAgentSessionHandlers } from './agent-session.handler'
import { registerPopoutHandlers } from './popout.handler'
import { registerServiceHandlers } from './service.handler'
import { registerMcpHandlers } from './mcp.handler'
import { registerKnowledgeHandlers } from './knowledge.handler'
import { registerExpertHandlers } from './expert.handler'
import { registerGitHandlers } from './git.handler'
import { registerRoutineHandlers } from './routine.handler'
import { registerToolStudioHandlers } from './tool.handler'
import { registerBrowserHandlers } from './browser.handler'
import { registerHostedHandlers } from './hosted.handler'
import { registerLlmProbeHandlers } from './llm-probe.handler'

// Idempotence guard: ipcMain.handle throws 'second handler' if a channel is
// registered twice, which aborts the whole startup (observed 2026-09-11 21:56,
// cause unclear — likely a dev-restart bundle race). A second invocation is a
// bug, but failing the boot over it is worse: skip and log instead.
let handlersRegistered = false

export function registerIpcHandlers(): void {
  if (handlersRegistered) {
    console.warn('[IPC] registerIpcHandlers called twice — skipping')
    return
  }
  handlersRegistered = true
  registerConversationHandlers()
  registerProjectHandlers()
  registerSettingsHandlers()
  registerTerminalHandlers()
  registerToolHandlers()
  registerSkillHandlers()
  registerExperienceHandlers()
  registerApiProxyHandlers()
  registerMemoryHandlers()
  registerMemoryPageHandlers()
  registerAppHandlers()
  registerDialogHandlers()
  registerFileOpsHandlers()
  registerAgentSessionHandlers()
  registerPopoutHandlers()
  registerServiceHandlers()
  registerMcpHandlers()
  registerKnowledgeHandlers()
  registerExpertHandlers()
  registerGitHandlers()
  registerRoutineHandlers()
  registerToolStudioHandlers()
  registerBrowserHandlers()
  registerHostedHandlers()
  registerLlmProbeHandlers()
}
