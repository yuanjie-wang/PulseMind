import { registerConversationHandlers } from './conversation.handler'
import { registerSettingsHandlers } from './settings.handler'
import { registerTerminalHandlers } from './terminal.handler'
import { registerToolHandlers } from './tools.handler'
import { registerSkillHandlers } from './skills.handler'
import { registerApiProxyHandlers } from './api-proxy.handler'
import { registerMemoryHandlers } from './memory.handler'
import { registerAppHandlers } from './app.handler'
import { registerDialogHandlers } from './dialog.handler'
import { registerFileOpsHandlers } from './file-ops.handler'
import { registerFavoriteHandlers } from './favorites.handler'
import { registerMcpHandlers } from './mcp.handler'
import { registerCanvasHandlers } from './canvas.handler'
import { registerKnowledgeHandlers } from './knowledge.handler'
import { registerSubAgentHandlers } from './subagent.handler'
import { registerGitHandlers } from './git.handler'

export function registerIpcHandlers(): void {
  registerConversationHandlers()
  registerSettingsHandlers()
  registerTerminalHandlers()
  registerToolHandlers()
  registerSkillHandlers()
  registerApiProxyHandlers()
  registerMemoryHandlers()
  registerAppHandlers()
  registerDialogHandlers()
  registerFileOpsHandlers()
  registerFavoriteHandlers()
  registerMcpHandlers()
  registerCanvasHandlers()
  registerKnowledgeHandlers()
  registerSubAgentHandlers()
  registerGitHandlers()
}
