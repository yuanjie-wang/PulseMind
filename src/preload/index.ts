import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc-channels'
import { resolveWindowControlsLayout } from '../shared/window-chrome'
import type { WindowControlsLayout } from '../shared/window-chrome'
import type { Conversation, ConversationIndexEntry, Message, TokenStats, ToolResultBatchEntry } from '../shared/types/conversation'
import type { AppSettings } from '../shared/types/settings'
import type { TerminalOutputEvent, TerminalExitEvent, ApiStreamChunkEvent, ApiStreamErrorEvent, ApiStreamDoneEvent, ApiStreamRetryEvent, PlatformInfo, DataPaths } from '../renderer/src/types/electron'
import type { ToolPreferences } from '../shared/types/tool-types'
import type { SkillPreferences, SkillDefinition } from '../shared/types/skill-types'
import type { ExperienceRecord, ExperienceDraft } from '../shared/types/experience-types'
import type { MemoryEntry, MemorySearchInput } from '../renderer/src/memory/types'
import type { KnowledgeFile, KnowledgeStats, KnowledgeImportResult, KnowledgeListOptions, KnowledgeListResult } from '../shared/types/knowledge'
import type { MCPManagedServer, MCPClientConfig, MCPToolCallResult } from '../renderer/src/types/electron'
import type { SubAgentProfile } from '../shared/types/subagent'
import type { GitAction, GitResult } from '../shared/types/git'

const electronAPI = {
  // Window chrome. Static for the process lifetime, so the renderer can reserve room
  // for the native window controls synchronously on first paint.
  getWindowControls: (): WindowControlsLayout => resolveWindowControlsLayout(process.platform),

  // Debug
    // ── Projects / sandbox / audit (PLAN-0.4.0 M3) ──
  projectList: () => ipcRenderer.invoke(IPC_CHANNELS.PROJECT_LIST),
  projectGet: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.PROJECT_GET, id),
  projectCreate: (input: { name: string; workspaceDir: string; icon?: string; sandbox?: unknown }) =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_CREATE, input),
  projectUpdate: (id: string, patch: { name?: string; workspaceDir?: string; icon?: string; sandbox?: unknown }) =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_UPDATE, id, patch),
  projectDelete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.PROJECT_DELETE, id),
  auditList: (limit?: number) => ipcRenderer.invoke(IPC_CHANNELS.AUDIT_LIST, limit),
  sandboxDetect: () => ipcRenderer.invoke(IPC_CHANNELS.SANDBOX_DETECT),

dbCheck: (): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.DB_CHECK),

  // Conversations
  listConversations: (): Promise<ConversationIndexEntry[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_LIST),
  getConversation: (id: string): Promise<Conversation | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_GET, id),
  hydrateConversation: (id: string): Promise<Conversation | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_HYDRATE, id),
  saveConversation: (conv: Conversation): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_SAVE, conv),
  saveConversationSync: (conv: Conversation): void => {
    ipcRenderer.sendSync(IPC_CHANNELS.CONVERSATION_SAVE_SYNC, conv)
  },
  appendConversationMessages: (convId: string, title: string, messages: Message[]): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_APPEND_MESSAGES, convId, title, messages),
  updateMessageMetadata: (msgId: string, data: { liked?: boolean; favorited?: boolean }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_UPDATE_MESSAGE_METADATA, msgId, data),
  deleteConversation: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_DELETE, id),
  updateConversationTitle: (id: string, title: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_UPDATE_TITLE, id, title),
  updateConversationSummary: (id: string, summary: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_UPDATE_SUMMARY, id, summary),
  updateConversationKeywords: (id: string, keywords: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_UPDATE_KEYWORDS, id, keywords),
  toggleConversationPin: (id: string, pinned: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_TOGGLE_PIN, id, pinned),
  touchConversation: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_TOUCH, id),
  saveConversationPlan: (id: string, planJson: string | null): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_SAVE_PLAN, id, planJson),
  getConversationPlan: (id: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_GET_PLAN, id),
  getToolResult: (ids: string[]): Promise<Array<{ ref_id: string; conversation_id: string; message_id: string; block_index: number; tool_use_id: string; content: string; is_error: number }>> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_GET_TOOL_RESULT, ids),
  persistToolResults:(convId: string, results: ToolResultBatchEntry[]): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_PERSIST_TOOL_RESULTS, convId, results),
  getConversationExtractedMsgCount: (id: string): Promise<number> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_GET_EXTRACTED_MSG_COUNT, id),
  updateConversationExtractedMsgCount: (id: string, count: number): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_UPDATE_EXTRACTED_MSG_COUNT, id, count),
  getConversationExperienceExtractedCount: (id: string): Promise<number> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_GET_EXPERIENCE_EXTRACTED_COUNT, id),
  updateConversationExperienceExtractedCount: (id: string, count: number): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_UPDATE_EXPERIENCE_EXTRACTED_COUNT, id, count),
  listConversationsForMemory: (opts: { afterTime?: string; beforeTime?: string; limit?: number }): Promise<
    Array<{ id: string; title: string; summary: string | null; keywords: string | null; updatedAt: string }>
  > => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_LIST_FOR_MEMORY, opts),
  searchConversationsByKeyword: (query: string, limit?: number, dateFilter?: Record<string, string>): Promise<
    Array<{ id: string; title: string; summary: string | null; keywords: string | null; updatedAt: string }>
  > => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_SEARCH_KEYWORD, query, limit, dateFilter),

  // Token Statistics
  getTokenStats: (): Promise<TokenStats> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_TOKEN_STATS),

  // Settings
  getSettings: (): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET),
  setSettings: (settings: AppSettings): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SET, settings),

  // Tools
  getToolPreferences: (): Promise<ToolPreferences> =>
    ipcRenderer.invoke(IPC_CHANNELS.TOOLS_GET_PREFERENCES),
  setToolPreferences: (prefs: ToolPreferences): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.TOOLS_SET_PREFERENCES, prefs),

  // Skills
  getSkillPreferences: (): Promise<SkillPreferences> =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILLS_GET_PREFERENCES),
  setSkillPreferences: (prefs: SkillPreferences): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILLS_SET_PREFERENCES, prefs),

  // Skills - Import
  importSkill: (): Promise<{ imported: SkillDefinition[]; errors: string[] } | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILLS_IMPORT),
  listImportedSkills: (): Promise<SkillDefinition[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILLS_LIST_IMPORTED),
  deleteImportedSkill: (name: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILLS_DELETE_IMPORTED, name),
  ensureBuiltInSkills: (skills: SkillDefinition[]): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILLS_ENSURE_BUILT_IN, skills),
  installSkill: (name: string): Promise<SkillDefinition | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILLS_INSTALL, name),
  readSkillRaw: (name: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILLS_READ_RAW, name),
  writeSkill: (skill: SkillDefinition): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILLS_WRITE, skill),

  // Experiences
  listExperiences: (): Promise<ExperienceRecord[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.EXPERIENCES_LIST),
  saveExperienceRecord: (draft: ExperienceDraft): Promise<{ record: ExperienceRecord; evicted?: ExperienceRecord }> =>
    ipcRenderer.invoke(IPC_CHANNELS.EXPERIENCES_SAVE, draft),
  deleteExperienceRecord: (name: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.EXPERIENCES_DELETE, name),
  readExperienceRecord: (name: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.EXPERIENCES_READ, name),
  touchExperienceRecord: (name: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.EXPERIENCES_TOUCH, name),
  onExperiencesChanged: (callback: () => void): (() => void) => {
    const handler = () => callback()
    ipcRenderer.on(IPC_CHANNELS.EXPERIENCES_CHANGED, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.EXPERIENCES_CHANGED, handler)
  },

  // Terminal
  executeCommand: (command: string, cwd?: string, timeoutMs?: number): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_EXECUTE, command, cwd, timeoutMs),
  execCommandSync: (command: string, cwd?: string, timeoutMs?: number): Promise<{ output: string; code: number | null }> =>
    ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_EXEC_SYNC, command, cwd, timeoutMs),
  killCommand: (processId: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_KILL, processId),
  onTerminalOutput: (callback: (data: TerminalOutputEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: TerminalOutputEvent) => callback(data)
    ipcRenderer.on(IPC_CHANNELS.TERMINAL_OUTPUT, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TERMINAL_OUTPUT, handler)
  },
  onTerminalExit: (callback: (data: TerminalExitEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: TerminalExitEvent) => callback(data)
    ipcRenderer.on(IPC_CHANNELS.TERMINAL_EXIT, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TERMINAL_EXIT, handler)
  },
  onTerminalError: (callback: (data: { processId: string; message: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { processId: string; message: string }) => callback(data)
    ipcRenderer.on(IPC_CHANNELS.TERMINAL_ERROR, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TERMINAL_ERROR, handler)
  },

  // Git
  gitInvoke: (action: GitAction): Promise<GitResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_INVOKE, action),

  // API Proxy
  apiFetchStream: (requestId: string, url: string, options?: { method?: string; headers?: Record<string, string>; body?: string | object; profileId?: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.API_FETCH_STREAM, requestId, url, options || {}),
  apiAbortStream: (requestId: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.API_ABORT_STREAM, requestId),
  onApiStreamChunk: (callback: (data: ApiStreamChunkEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: ApiStreamChunkEvent) => callback(data)
    ipcRenderer.on(IPC_CHANNELS.API_STREAM_CHUNK, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.API_STREAM_CHUNK, handler)
  },
  onApiStreamError: (callback: (data: ApiStreamErrorEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: ApiStreamErrorEvent) => callback(data)
    ipcRenderer.on(IPC_CHANNELS.API_STREAM_ERROR, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.API_STREAM_ERROR, handler)
  },
  onApiStreamDone: (callback: (data: ApiStreamDoneEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: ApiStreamDoneEvent) => callback(data)
    ipcRenderer.on(IPC_CHANNELS.API_STREAM_DONE, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.API_STREAM_DONE, handler)
  },
  onApiStreamRetry: (callback: (data: ApiStreamRetryEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: ApiStreamRetryEvent) => callback(data)
    ipcRenderer.on(IPC_CHANNELS.API_STREAM_RETRY, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.API_STREAM_RETRY, handler)
  },
  onSystemResumed: (callback: () => void): (() => void) => {
    const handler = () => callback()
    ipcRenderer.on(IPC_CHANNELS.APP_SYSTEM_RESUMED, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.APP_SYSTEM_RESUMED, handler)
  },
  systemResumedAck: (): void => {
    ipcRenderer.send(IPC_CHANNELS.APP_SYSTEM_RESUMED_ACK)
  },
  onHooksCompleted: (callback: () => void): (() => void) => {
    const handler = () => callback()
    ipcRenderer.on(IPC_CHANNELS.APP_HOOKS_COMPLETED, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.APP_HOOKS_COMPLETED, handler)
  },
  onMcpServersChanged: (callback: () => void): (() => void) => {
    const handler = () => callback()
    ipcRenderer.on(IPC_CHANNELS.MCP_SERVERS_CHANGED, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MCP_SERVERS_CHANGED, handler)
  },
  onSkillsChanged: (callback: () => void): (() => void) => {
    const handler = () => callback()
    ipcRenderer.on(IPC_CHANNELS.SKILLS_CHANGED, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.SKILLS_CHANGED, handler)
  },

  // Non-streaming fetch via main process (avoids CORS)
  apiFetch: (url: string, options?: { method?: string; headers?: Record<string, string>; body?: string; withProfileHeaders?: boolean; profileId?: string }): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.API_FETCH, url, options || {}),

  // App / Platform Info
  getPlatformInfo: (): Promise<PlatformInfo> =>
    ipcRenderer.invoke(IPC_CHANNELS.APP_GET_PLATFORM_INFO),
  getDataPaths: (): Promise<DataPaths> =>
    ipcRenderer.invoke(IPC_CHANNELS.APP_GET_DATA_PATHS),
  openFolder: (folderPath: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SHELL_OPEN_FOLDER, folderPath),
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SHELL_OPEN_EXTERNAL, url),
  getFileStat: (filePath: string): Promise<{ size: number; birthtime: string; mtime: string } | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_STAT, filePath),

  // Dialog
  showDialog: (options: { type: 'choice' | 'prompt'; title: string; message: string; choices?: string[] }): Promise<{ value: string | null; cancelled: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SHOW, options),
  showSaveDialog: (options: { defaultName?: string; filters?: Array<{ name: string; extensions: string[] }> }): Promise<{ filePath: string | null; canceled: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SHOW_SAVE, options),
  showOpenDialog: (options?: { properties?: Array<'openFile' | 'openDirectory' | 'multiSelections'>; filters?: Array<{ name: string; extensions: string[] }> }): Promise<{ filePaths: string[]; canceled: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SHOW_OPEN, options ?? {}),

  // ── File operations ──
  readFile: (filePath: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.UTIL_READ_FILE, filePath),
  editFile: (input: { filePath: string; oldStr: string; newStr: string; multi: boolean }): Promise<{ success: boolean; replacements: number; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.UTIL_EDIT_FILE, input),
  patchFile: (input: { filePath: string; diff: string }): Promise<{ success: boolean; replacements: number; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.UTIL_PATCH_FILE, input),
  writeFile: (input: { filePath: string; content: string; append?: boolean }): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.UTIL_WRITE_FILE, input),
  convertFileToMarkdown: (filePath: string): Promise<{ content: string; cachePath: string; hit: boolean } | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.UTIL_CONVERT_TO_MARKDOWN, filePath),
  saveBase64Image: (data: string): Promise<{ success: boolean; path: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.UTIL_SAVE_BASE64_IMAGE, data),
  copyFileToTmp: (sourcePath: string): Promise<{ success: boolean; path: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.UTIL_COPY_FILE_TO_TMP, sourcePath),
  copyFile: (input: { sourceUrl?: string; destination: string }): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.UTIL_COPY_FILE, input),

  // Memory
  listMemories: (category?: string): Promise<MemoryEntry[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_LIST, category),
  saveMemory: (data: { id: string; content: string; type: string; category: string; source?: string | null }): Promise<MemoryEntry> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_SAVE, data),
  deleteMemory: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_DELETE, id),
  countMemories: (types: string[]): Promise<number> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_COUNT, types),
  searchMemories: (data: MemorySearchInput): Promise<MemoryEntry[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_SEARCH, data),
  getMemoryMd: (): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_GET_MD),
  saveMemoryMd: (content: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_SAVE_MD, content),
  appendMemoryMd: (data: { sectionHeading: string; entry: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_APPEND_MD, data),
  updateMemory: (id: string, data: { content?: string; type?: string; category?: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_UPDATE, id, data),

  // Favorites
  addFavorite: (data: { id: string; messageId: string; conversationId: string; conversationTitle: string; role: string; content: string; contentBlocks?: string | null }): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.FAVORITE_ADD, data),
  removeFavorite: (messageId: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.FAVORITE_REMOVE, messageId),
  listFavorites: (): Promise<Array<{ id: string; messageId: string; conversationId: string; conversationTitle: string; role: string; content: string; contentBlocks?: any; createdAt: string }>> =>
    ipcRenderer.invoke(IPC_CHANNELS.FAVORITE_LIST),

  // MCP - Model Context Protocol
  mcpListServers: (): Promise<MCPManagedServer[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_LIST_SERVERS),
  mcpGetServer: (id: string): Promise<MCPManagedServer | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_GET_SERVER, id),
  mcpStartServer: (id: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_START_SERVER, id),
  mcpStopServer: (id: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_STOP_SERVER, id),
  mcpRestartServer: (id: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_RESTART_SERVER, id),
  mcpCallTool: (serverId: string, toolName: string, args: Record<string, unknown>): Promise<MCPToolCallResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_CALL_TOOL, serverId, toolName, args),
  mcpRegisterServer: (config: MCPClientConfig): Promise<{ success: boolean; server?: MCPManagedServer; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_REGISTER_SERVER, config),
  mcpUnregisterServer: (id: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_UNREGISTER_SERVER, id),
  mcpUpdateServer: (id: string, config: MCPClientConfig): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_UPDATE_SERVER, id, config),
  mcpReloadServers: (): Promise<{ success: boolean; servers?: MCPManagedServer[]; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_RELOAD_SERVERS),
  mcpUpdateServerSummary: (id: string, summary: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_UPDATE_SERVER_SUMMARY, id, summary),

  // Knowledge Base
  knowledgeListFiles: (status?: string): Promise<KnowledgeFile[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_LIST, status),
  knowledgeListAdvanced: (opts?: KnowledgeListOptions): Promise<KnowledgeListResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_LIST_ADVANCED, opts),
  knowledgeGetFile: (id: string): Promise<KnowledgeFile | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_GET, id),
  knowledgeAddFile: (filePaths: string[]): Promise<KnowledgeImportResult[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_ADD_FILE, filePaths),
  knowledgePrepareImport: (filePaths: string[]): Promise<{ existing: { id: string; filePath: string }[]; new: string[] }> =>
    ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_PREPARE_IMPORT, filePaths),
  knowledgeScanFolder: (folderPath: string): Promise<{ fileCount: number; filePaths: string[] }> =>
    ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_SCAN_FOLDER, folderPath),
  knowledgeAddFolder: (folderPath: string): Promise<KnowledgeImportResult[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_ADD_FOLDER, folderPath),
  knowledgeAddUrl: (url: string): Promise<KnowledgeImportResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_ADD_URL, url),
  knowledgeDelete: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_DELETE, id),
  knowledgeGetRaw: (relativePath: string): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_GET_RAW, relativePath),
  knowledgeGetRawPath: (relativePath: string): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_GET_RAW_PATH, relativePath),
  knowledgeReadWiki: (relativePath?: string): Promise<{ content: string | null; files: string[] | null }> =>
    ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_READ_WIKI, relativePath),
  knowledgeWriteExperience: (data: { content: string; convId: string; title?: string }): Promise<KnowledgeFile> =>
    ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_WRITE_EXPERIENCE, data),
  knowledgeGetStats: (): Promise<KnowledgeStats> =>
    ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_GET_STATS),
  knowledgeApplyWikiChanges: (data: { actions: { filePath: string; content: string }[]; logEntry?: string; compiledIds?: string[] }): Promise<{ written: number; logAppended: boolean; markedCompiled: number }> =>
    ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_APPLY_WIKI_CHANGES, data),
  knowledgeUpdateStatus: (data: { id: string; status: 'compiled' }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_UPDATE_STATUS, data),
  knowledgeClearAll: (): Promise<{ deletedRaw: number; deletedWiki: number }> =>
    ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_CLEAR_ALL),
  knowledgeSearchContent: (query: string): Promise<Array<{ id: string; filePath: string; title: string; sourceType: string; excerpts: string[] }>> =>
    ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_SEARCH_CONTENT, query),
  knowledgeSearchWiki: (query: string): Promise<Array<{ wikiPath: string; title: string; type: string; lineNum: number; content: string }>> =>
    ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_SEARCH_WIKI, query),
  knowledgeRebuildIndex: (): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_REBUILD_INDEX),
  knowledgeAbortImport: (): void =>
    ipcRenderer.send(IPC_CHANNELS.KNOWLEDGE_ABORT_IMPORT),

  // SubAgent
  subagentList: (): Promise<SubAgentProfile[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.SUBAGENT_LIST),
  subagentCreate: (profile: SubAgentProfile): Promise<SubAgentProfile[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.SUBAGENT_CREATE, profile),
  subagentUpdate: (profile: SubAgentProfile): Promise<SubAgentProfile[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.SUBAGENT_UPDATE, profile),
  subagentDelete: (id: string): Promise<SubAgentProfile[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.SUBAGENT_DELETE, id),
  subagentReset: (): Promise<SubAgentProfile[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.SUBAGENT_RESET),

  // Canvas
  canvasPrepareWorkDir: (rectId: string, existingCode?: string, fresh?: boolean): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.CANVAS_PREPARE_WORK_DIR, rectId, existingCode, fresh),
  canvasExportHtml: (rectId: string): Promise<{ success: boolean; filePath?: string; error?: string; canceled?: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.CANVAS_EXPORT_HTML, rectId),
  canvasOpenInBrowser: (rectId: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.CANVAS_OPEN_IN_BROWSER, rectId),
  // ── Agent sessions (engines hosted in main) ──
  agentSessionCreate: (sessionId: string, opts?: { agentId?: string; title?: string }): Promise<{ sessionId: string; agentId: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_SESSION_CREATE, sessionId, opts),
  agentSessionAsk: (sessionId: string, content: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_SESSION_ASK, sessionId, content),
  agentSessionCancel: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_SESSION_CANCEL, sessionId),
  agentSessionHistory: (sessionId: string): Promise<{ messages: unknown[]; agentId: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_SESSION_HISTORY, sessionId),
  agentSessionHydrate: (sessionId: string, messages: unknown[], historySummary?: { text: string; firstKeptId: string } | null): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_SESSION_HYDRATE, sessionId, messages, historySummary),
  agentSessionSnapshot: (sessionId: string): Promise<{ messages: unknown[]; status: { status: string }; streamingBlocks: unknown[]; plan: unknown } | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_SESSION_SNAPSHOT, sessionId),
  agentSessionEngineCall: (sessionId: string, method: string, args?: unknown[]): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_SESSION_ENGINE_CALL, sessionId, method, args ?? []),
  agentSessionRefreshOptions: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_SESSION_REFRESH_OPTIONS, sessionId),
  serviceGetStatus: (): Promise<{ enabled: boolean; port: number; running: boolean; token: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.SERVICE_GET_STATUS),
  serviceSetEnabled: (enabled: boolean): Promise<{ running: boolean; port: number | null }> =>
    ipcRenderer.invoke(IPC_CHANNELS.SERVICE_SET_ENABLED, enabled),
  serviceSetPort: (port: number): Promise<{ running: boolean; port: number | null }> =>
    ipcRenderer.invoke(IPC_CHANNELS.SERVICE_SET_PORT, port),
  serviceResetToken: (): Promise<{ token: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.SERVICE_RESET_TOKEN),
  onAgentSessionEvent: (callback: (event: { sessionId: string; data: unknown }) => void): (() => void) => {
    const listener = (_e: unknown, event: { sessionId: string; data: unknown }): void => callback(event)
    ipcRenderer.on(IPC_CHANNELS.AGENT_SESSION_EVENT, listener)
    return () => { ipcRenderer.removeListener(IPC_CHANNELS.AGENT_SESSION_EVENT, listener) }
  },
  canvasExportImage: (rectId: string, viewport?: { width: number; height: number }, htmlContent?: string): Promise<{ success: boolean; error?: string; canceled?: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.CANVAS_EXPORT_IMAGE, rectId, viewport, htmlContent),
  canvasCleanupRect: (rectId: string): Promise<{ success: boolean; deletedConvs: number }> =>
    ipcRenderer.invoke(IPC_CHANNELS.CANVAS_CLEANUP_RECT, rectId),
  canvasClearAll: (): Promise<{ success: boolean; deletedConvs: number }> =>
    ipcRenderer.invoke(IPC_CHANNELS.CANVAS_CLEAR_ALL),
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)
