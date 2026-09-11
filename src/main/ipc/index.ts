import { registerConversationHandlers } from './conversation.handler'
import { registerSettingsHandlers } from './settings.handler'
import { registerTerminalHandlers } from './terminal.handler'
import { registerToolHandlers } from './tools.handler'
import { registerSkillHandlers } from './skills.handler'
import { registerExperienceHandlers } from './experiences.handler'
import { registerApiProxyHandlers } from './api-proxy.handler'
import { registerMemoryHandlers } from './memory.handler'
import { registerAppHandlers } from './app.handler'
import { registerDialogHandlers } from './dialog.handler'
import { registerFileOpsHandlers } from './file-ops.handler'
import { registerAgentSessionHandlers } from './agent-session.handler'
import { registerServiceHandlers } from './service.handler'
import { registerFavoriteHandlers } from './favorites.handler'
import { registerMcpHandlers } from './mcp.handler'
import { registerCanvasHandlers } from './canvas.handler'
import { registerKnowledgeHandlers } from './knowledge.handler'
import { registerSubAgentHandlers } from './subagent.handler'
import { registerGitHandlers } from './git.handler'
import { registerProjectHandlers } from './project.handler'
import { registerRoutineHandlers } from './routine.handler'
import { registerToolStudioHandlers } from './tool.handler'

export function registerIpcHandlers(): void {
  registerConversationHandlers()
  registerSettingsHandlers()
  registerTerminalHandlers()
  registerToolHandlers()
  registerSkillHandlers()
  registerExperienceHandlers()
  registerApiProxyHandlers()
  registerMemoryHandlers()
  registerAppHandlers()
  registerDialogHandlers()
  registerFileOpsHandlers()
  registerAgentSessionHandlers()
  registerServiceHandlers()
  registerFavoriteHandlers()
  registerMcpHandlers()
  registerCanvasHandlers()
  registerKnowledgeHandlers()
  registerSubAgentHandlers()
  registerGitHandlers()
  registerProjectHandlers()
  registerRoutineHandlers()
  registerToolHandlers()
}
