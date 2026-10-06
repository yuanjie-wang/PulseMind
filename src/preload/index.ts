import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc-channels'
import { resolveWindowControlsLayout } from '../shared/window-chrome'
import type { WindowControlsLayout } from '../shared/window-chrome'
import type { Conversation, ConversationIndexEntry, Message, TokenStats, ToolResultBatchEntry } from '../shared/types/conversation'
import type { ProjectCreateInput, ProjectUpdateInput } from '../shared/types/project'
import type { AppSettings } from '../shared/types/settings'
import type {
  TerminalOutputEvent,
  TerminalExitEvent,
  ApiStreamChunkEvent,
  ApiStreamErrorEvent,
  ApiStreamDoneEvent,
  ApiStreamRetryEvent,
  PlatformInfo,
  DataPaths,
  ServiceStatus,
} from '../shared/types/electron-bridge'
import type { ToolPreferences } from '../shared/types/tool-types'
import type { SkillPreferences, SkillPreferencesPatch, SkillDefinition } from '../shared/types/skill-types'
import type { ExperienceRecord, ExperienceDraft } from '../shared/types/experience-types'
import type { MemoryEntry, MemorySearchInput } from '../shared/types/memory'
import type { KnowledgeFile, KnowledgeBase, KnowledgeStats, KnowledgeImportResult, KnowledgeListOptions, KnowledgeListResult } from '../shared/types/knowledge'
import type { MCPManagedServer, MCPClientConfig, MCPToolCallResult } from '../shared/types/electron-bridge'
import type { ExpertProfile } from '../shared/types/expert'
import type { SummonedExpert } from '../shared/expert-context'
import type { GitAction, GitResult } from '../shared/types/git'
import type { AgentSessionCreateOptions, StatusSnapshot } from '../shared/agent-protocol'

const electronAPI = {
  // Window chrome. Static for the process lifetime, so the renderer can reserve room
  // for the native window controls synchronously on first paint.
  getWindowControls: (): WindowControlsLayout => resolveWindowControlsLayout(process.platform),
  // Mask watcher → native caption buttons pre-dimmed while a global modal is
  // open. Fire-and-forget: it is a visual state, not a request with a reply.
  setTitleBarMaskAlpha: (alpha: number): void => ipcRenderer.send(IPC_CHANNELS.WINDOW_SET_TITLE_BAR_MASK, alpha),

  // Debug
  // ── Projects (welcome page picker; management UI removed) ──
  projectList: () => ipcRenderer.invoke(IPC_CHANNELS.PROJECT_LIST),
  projectGet: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.PROJECT_GET, id),
  // Project input/patch types are the shared ones (ProjectCreateInput /
  // ProjectUpdateInput) — inline copies here went stale the day overview was
  // added (2026-09-18): the payload passes through untouched at runtime, but
  // an inline shape silently drops new fields from the typed surface.
  projectCreate: (input: ProjectCreateInput) => ipcRenderer.invoke(IPC_CHANNELS.PROJECT_CREATE, input),
  projectUpdate: (id: string, patch: ProjectUpdateInput) => ipcRenderer.invoke(IPC_CHANNELS.PROJECT_UPDATE, id, patch),
  projectDelete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.PROJECT_DELETE, id),
  projectValidateDir: (workspaceDir: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_VALIDATE_DIR, workspaceDir),
  projectReorder: (orderedIds: string[]) => ipcRenderer.invoke(IPC_CHANNELS.PROJECT_REORDER, orderedIds),
  setConversationProject: (id: string, projectId: string) => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_SET_PROJECT, id, projectId),
  setConversationExpert: (id: string, expertId: string | null) => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_SET_EXPERT, id, expertId),
  setConversationApprovalMode: (id: string, mode: unknown, source?: 'user' | 'derived') => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_SET_APPROVAL_MODE, id, mode, source),
  setConversationProfile: (id: string, profileId: string | null, source?: 'user' | 'derived') => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_SET_PROFILE, id, profileId, source),
  routineList: () => ipcRenderer.invoke(IPC_CHANNELS.ROUTINE_LIST),
  routineGet: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.ROUTINE_GET, id),
  routineCreate: (input: Record<string, unknown>) => ipcRenderer.invoke(IPC_CHANNELS.ROUTINE_CREATE, input),
  routineUpdate: (id: string, patch: Record<string, unknown>) => ipcRenderer.invoke(IPC_CHANNELS.ROUTINE_UPDATE, id, patch),
  routineDelete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.ROUTINE_DELETE, id),
  routineToggle: (id: string, enabled: boolean) => ipcRenderer.invoke(IPC_CHANNELS.ROUTINE_TOGGLE, id, enabled),
  routineRun: (id: string, params?: Record<string, string>) => ipcRenderer.invoke(IPC_CHANNELS.ROUTINE_RUN, id, params),
  routineRunStop: (runId: string) => ipcRenderer.invoke(IPC_CHANNELS.ROUTINE_RUN_STOP, runId),
  routineRuns: (routineId?: string, limit?: number) => ipcRenderer.invoke(IPC_CHANNELS.ROUTINE_RUNS, routineId, limit),
  routineRunDelete: (runId: string) => ipcRenderer.invoke(IPC_CHANNELS.ROUTINE_RUN_DELETE, runId),
  routineRunsClear: (routineId: string) => ipcRenderer.invoke(IPC_CHANNELS.ROUTINE_RUNS_CLEAR, routineId),
  routineRunsPrune: (days?: number) => ipcRenderer.invoke(IPC_CHANNELS.ROUTINE_RUNS_PRUNE, days),
  // Batch mode (PLAN-routine-batch)
  routineBatchRun: (id: string, concurrency?: number, timeoutMinutes?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.ROUTINE_BATCH_RUN, id, concurrency, timeoutMinutes),
  routineBatchStop: (parentRunId: string) => ipcRenderer.invoke(IPC_CHANNELS.ROUTINE_BATCH_STOP, parentRunId),
  routineBatchResume: (parentRunId: string) => ipcRenderer.invoke(IPC_CHANNELS.ROUTINE_BATCH_RESUME, parentRunId),
  routineBatchItems: (parentRunId: string) => ipcRenderer.invoke(IPC_CHANNELS.ROUTINE_BATCH_ITEMS, parentRunId),
  routineCsvPreview: (filePath: string, params?: Array<{ key: string; label: string; required?: boolean; default?: string }>) =>
    ipcRenderer.invoke(IPC_CHANNELS.ROUTINE_CSV_PREVIEW, filePath, params),
  toolList: () => ipcRenderer.invoke(IPC_CHANNELS.TOOL_LIST),
  toolGet: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.TOOL_GET, id),
  toolCreate: (input: { name: string; description?: string; category?: string; capabilities?: string[] }) =>
    ipcRenderer.invoke(IPC_CHANNELS.TOOL_CREATE, input),
  toolUpdate: (id: string, patch: Record<string, unknown>) => ipcRenderer.invoke(IPC_CHANNELS.TOOL_UPDATE, id, patch),
  toolDelete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.TOOL_DELETE, id),
  toolDuplicate: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.TOOL_DUPLICATE, id),
  toolReadHtml: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.TOOL_READ_HTML, id),
  toolWriteHtml: (id: string, html: string) => ipcRenderer.invoke(IPC_CHANNELS.TOOL_WRITE_HTML, id, html),
  toolGetDeletedPresets: () => ipcRenderer.invoke(IPC_CHANNELS.TOOL_DELETED_PRESETS),
  toolRestorePresets: () => ipcRenderer.invoke(IPC_CHANNELS.TOOL_RESTORE_PRESETS),
  browserRunCode: (code: string, opts?: { timeoutMs?: number; conversationId?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_RUN_CODE, { code, timeoutMs: opts?.timeoutMs, scopeId: opts?.conversationId }),
  hostedToolCall: (tool: string, args: Record<string, unknown>, opts: { sessionId: string; timeoutMs?: number }) =>
    ipcRenderer.invoke(IPC_CHANNELS.HOSTED_TOOL_CALL, tool, args, opts),
  // Browser pane (A-M5): chrome state / width / user tab actions + live updates.
  browserPaneSetState: (state: { viewKind: string; conversationId: string | null; chatAreaWidth: number; browserActive?: boolean; chromeOverlayHeight?: number }) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_PANE_STATE, state),
  browserPaneSetWidth: (width: number) => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_PANE_WIDTH, width),
  browserPaneAction: (action: Record<string, unknown>) => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_PANE_ACTION, action),
  browserHistoryQuery: (text: string): Promise<Array<{ url: string; title: string | null; visitCount: number; lastVisitAt: number }>> =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_HISTORY_QUERY, text),
  browserHistoryClear: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_HISTORY_CLEAR),
  browserFavoriteAdd: (url: string, title?: string): Promise<{ ok: boolean; url: string; created: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_FAVORITE_ADD, url, title),
  browserFavoriteRemove: (url: string): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_FAVORITE_REMOVE, url),
  browserFavoriteList: (): Promise<Array<{ url: string; title: string | null; createdAt: number; updatedAt: number }>> =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_FAVORITE_LIST),
  browserFavoriteQuery: (text: string, limit?: number): Promise<Array<{ url: string; title: string | null; createdAt: number; updatedAt: number }>> =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_FAVORITE_QUERY, text, limit),
  browserFavoriteHas: (url: string): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_FAVORITE_HAS, url),
  onBrowserPaneUpdate: (cb: (update: unknown) => void) => {
    const listener = (_event: unknown, update: unknown) => cb(update)
    ipcRenderer.on(IPC_CHANNELS.BROWSER_PANE_UPDATE, listener as never)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.BROWSER_PANE_UPDATE, listener as never)
  },
  toolBridgeInvoke: (toolId: string, method: string, params: Record<string, unknown>) =>
    ipcRenderer.invoke(IPC_CHANNELS.TOOLBRIDGE_INVOKE, toolId, method, params),

  dbCheck: (): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.DB_CHECK),

  // Conversations
  listConversations: (): Promise<ConversationIndexEntry[]> => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_LIST),
  getConversation: (id: string): Promise<Conversation | null> => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_GET, id),
  hydrateConversation: (id: string, maxContentLength?: number): Promise<Conversation | null> => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_HYDRATE, id, maxContentLength),
  saveConversation: (conv: Conversation): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_SAVE, conv),
  saveConversationSync: (conv: Conversation): void => {
    ipcRenderer.sendSync(IPC_CHANNELS.CONVERSATION_SAVE_SYNC, conv)
  },
  appendConversationMessages: (convId: string, title: string, messages: Message[]): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_APPEND_MESSAGES, convId, title, messages),
  updateMessageMetadata: (msgId: string, data: { liked?: boolean; favorited?: boolean }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_UPDATE_MESSAGE_METADATA, msgId, data),
  deleteConversation: (id: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_DELETE, id),
  updateConversationTitle: (id: string, title: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_UPDATE_TITLE, id, title),
  updateConversationSummary: (id: string, summary: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_UPDATE_SUMMARY, id, summary),
  updateConversationKeywords: (id: string, keywords: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_UPDATE_KEYWORDS, id, keywords),
  toggleConversationPin: (id: string, pinned: boolean): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_TOGGLE_PIN, id, pinned),
  touchConversation: (id: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_TOUCH, id),
  saveConversationPlan: (id: string, planJson: string | null): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_SAVE_PLAN, id, planJson),
  getConversationPlan: (id: string): Promise<string | null> => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_GET_PLAN, id),
  getToolResult: (
    ids: string[],
  ): Promise<
    Array<{ ref_id: string; conversation_id: string; message_id: string; block_index: number; tool_use_id: string; content: string; is_error: number }>
  > => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_GET_TOOL_RESULT, ids),
  persistToolResults: (convId: string, results: ToolResultBatchEntry[]): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_PERSIST_TOOL_RESULTS, convId, results),
  getConversationExtractedMsgCount: (id: string): Promise<number> => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_GET_EXTRACTED_MSG_COUNT, id),
  updateConversationExtractedMsgCount: (id: string, count: number): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_UPDATE_EXTRACTED_MSG_COUNT, id, count),
  getConversationExperienceExtractedCount: (id: string): Promise<number> => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_GET_EXPERIENCE_EXTRACTED_COUNT, id),
  updateConversationExperienceExtractedCount: (id: string, count: number): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_UPDATE_EXPERIENCE_EXTRACTED_COUNT, id, count),
  listConversationsForMemory: (opts: {
    afterTime?: string
    beforeTime?: string
    limit?: number
  }): Promise<Array<{ id: string; title: string; summary: string | null; keywords: string | null; updatedAt: string }>> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_LIST_FOR_MEMORY, opts),
  searchConversationsByKeyword: (
    query: string,
    limit?: number,
    dateFilter?: Record<string, string>,
  ): Promise<Array<{ id: string; title: string; summary: string | null; keywords: string | null; updatedAt: string }>> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_SEARCH_KEYWORD, query, limit, dateFilter),
  searchMessagesByKeyword: (
    query: string,
    limit?: number,
  ): Promise<Array<{ conversationId: string; conversationTitle: string; role: 'user' | 'assistant'; snippet: string; createdAt: string }>> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_SEARCH_MESSAGES, query, limit),
  getConversationLastUserMessage: (id: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_LAST_USER_MESSAGE, id),

  // Token Statistics
  getTokenStats: (): Promise<TokenStats> => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_TOKEN_STATS),

  // Settings
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET),
  setSettings: (settings: AppSettings): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SET, settings),

  // Tools
  getToolPreferences: (): Promise<ToolPreferences> => ipcRenderer.invoke(IPC_CHANNELS.TOOLS_GET_PREFERENCES),
  setToolPreferences: (prefs: ToolPreferences): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.TOOLS_SET_PREFERENCES, prefs),

  // Skills
  getSkillPreferences: (): Promise<SkillPreferences> => ipcRenderer.invoke(IPC_CHANNELS.SKILLS_GET_PREFERENCES),
  setSkillPreferences: (prefs: SkillPreferences): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.SKILLS_SET_PREFERENCES, prefs),
  updateSkillPreferences: (patch: SkillPreferencesPatch): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.SKILLS_UPDATE_PREFERENCES, patch),

  // Skills - Import
  importSkill: (): Promise<{ imported: SkillDefinition[]; errors: string[]; warnings: string[] } | null> => ipcRenderer.invoke(IPC_CHANNELS.SKILLS_IMPORT),
  listImportedSkills: (): Promise<SkillDefinition[]> => ipcRenderer.invoke(IPC_CHANNELS.SKILLS_LIST_IMPORTED),
  deleteImportedSkill: (name: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.SKILLS_DELETE_IMPORTED, name),
  ensureBuiltInSkills: (skills: SkillDefinition[]): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.SKILLS_ENSURE_BUILT_IN, skills),
  installSkill: (name: string): Promise<SkillDefinition | null> => ipcRenderer.invoke(IPC_CHANNELS.SKILLS_INSTALL, name),
  readSkillRaw: (name: string): Promise<string | null> => ipcRenderer.invoke(IPC_CHANNELS.SKILLS_READ_RAW, name),
  writeSkill: (skill: SkillDefinition): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.SKILLS_WRITE, skill),
  writeSkillSource: (content: string, expectedName?: string): Promise<{ ok: true; skill: SkillDefinition } | { ok: false; error: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILLS_WRITE_SOURCE, content, expectedName),
  listSkillFiles: (name: string): Promise<string[]> => ipcRenderer.invoke(IPC_CHANNELS.SKILLS_LIST_FILES, name),
  readSkillFile: (name: string, relPath: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILLS_READ_FILE, name, relPath),

  // Experiences
  listExperiences: (): Promise<ExperienceRecord[]> => ipcRenderer.invoke(IPC_CHANNELS.EXPERIENCES_LIST),
  saveExperienceRecord: (draft: ExperienceDraft): Promise<{ record: ExperienceRecord; evicted?: ExperienceRecord }> =>
    ipcRenderer.invoke(IPC_CHANNELS.EXPERIENCES_SAVE, draft),
  deleteExperienceRecord: (name: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.EXPERIENCES_DELETE, name),
  readExperienceRecord: (name: string): Promise<string | null> => ipcRenderer.invoke(IPC_CHANNELS.EXPERIENCES_READ, name),
  readExperienceFile: (name: string, relPath: string): Promise<string | null> => ipcRenderer.invoke(IPC_CHANNELS.EXPERIENCES_READ_FILE, name, relPath),
  touchExperienceRecord: (name: string, outcome?: 'ok' | 'fail'): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.EXPERIENCES_TOUCH, name, outcome),
  clearExperiences: (): Promise<number> => ipcRenderer.invoke(IPC_CHANNELS.EXPERIENCES_CLEAR),
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
  killCommand: (processId: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_KILL, processId),
  // Background process mode (P0-3) + session exec allowlist (P0-2) — see the
  // channel comments in ipc-channels.ts.
  executeBackground: (command: string, cwd?: string): Promise<{ pid: number }> =>
    ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_EXECUTE_BACKGROUND, command, cwd),
  execLogs: (pid: number, tailBytes?: number): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_EXEC_LOGS, pid, tailBytes),
  execKill: (pid: number): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_EXEC_KILL, pid),
  getExecAllowlist: (): Promise<string[]> => ipcRenderer.invoke(IPC_CHANNELS.EXEC_ALLOWLIST_GET),
  addExecAllowlist: (prefix: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.EXEC_ALLOWLIST_ADD, prefix),
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
  gitInvoke: (action: GitAction): Promise<GitResult> => ipcRenderer.invoke(IPC_CHANNELS.GIT_INVOKE, action),

  // API Proxy
  apiFetchStream: (
    requestId: string,
    url: string,
    options?: { method?: string; headers?: Record<string, string>; body?: string | object; profileId?: string },
  ): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.API_FETCH_STREAM, requestId, url, options || {}),
  apiAbortStream: (requestId: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.API_ABORT_STREAM, requestId),
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
  // 原生菜单 / 加速键动作（AppLayout 消费；payload 是 MenuActionId 字符串）
  onMenuAction: (callback: (action: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, action: string) => callback(action)
    ipcRenderer.on(IPC_CHANNELS.MENU_ACTION, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MENU_ACTION, handler)
  },

  // 设置页「测试连接」：main 侧对 provider 发一次最小非流式探测
  testLlmConnection: (input: { provider?: 'anthropic' | 'openai'; baseURL?: string; apiKey?: string; model?: string; headers?: Record<string, string>; profileId?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.LLM_TEST_CONNECTION, input),

  // Non-streaming fetch via main process (avoids CORS)
  apiFetch: (
    url: string,
    options?: { method?: string; headers?: Record<string, string>; body?: string; withProfileHeaders?: boolean; profileId?: string },
  ): Promise<string | null> => ipcRenderer.invoke(IPC_CHANNELS.API_FETCH, url, options || {}),

  // App / Platform Info
  getPlatformInfo: (): Promise<PlatformInfo> => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_PLATFORM_INFO),
  getDataPaths: (): Promise<DataPaths> => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_DATA_PATHS),
  openFolder: (folderPath: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.SHELL_OPEN_FOLDER, folderPath),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.SHELL_OPEN_EXTERNAL, url),
  getFileStat: (filePath: string): Promise<{ size: number; birthtime: string; mtime: string; isDirectory: boolean } | null> => ipcRenderer.invoke(IPC_CHANNELS.FILE_STAT, filePath),
  // Synchronous, no IPC: the disk path behind a pasted/dropped File. Electron
  // 33 removed the runtime `File.path` (the ambient `interface File { path }`
  // in electron.d.ts still declares it, so the renderer's read typechecks and
  // evaluates undefined — every pasted/dropped file was silently dropped
  // before this existed). webUtils is the only remaining source, and it lives
  // here in the preload, where contextBridge hands the File through intact
  // (measured, even under this app's `sandbox: true`). A non-File throws —
  // caught so the renderer sees '' and falls to the image-blob branch instead
  // of losing the whole batch to one exception.
  getPathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },

  // Dialog
  showDialog: (options: {
    type: 'choice' | 'prompt'
    title: string
    message: string
    choices?: string[]
  }): Promise<{ value: string | null; cancelled: boolean }> => ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SHOW, options),
  showSaveDialog: (options: {
    defaultName?: string
    filters?: Array<{ name: string; extensions: string[] }>
  }): Promise<{ filePath: string | null; canceled: boolean }> => ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SHOW_SAVE, options),
  showOpenDialog: (options?: {
    properties?: Array<'openFile' | 'openDirectory' | 'multiSelections'>
    filters?: Array<{ name: string; extensions: string[] }>
  }): Promise<{ filePaths: string[]; canceled: boolean }> => ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SHOW_OPEN, options ?? {}),

  // ── File operations ──
  readFile: (filePath: string): Promise<string | null> => ipcRenderer.invoke(IPC_CHANNELS.UTIL_READ_FILE, filePath),
  readFileBinary: (filePath: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.UTIL_READ_FILE_BINARY, filePath),
  listDir: (dirPath: string): Promise<{ entries: Array<{ name: string; path: string; isDir: boolean }> } | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.UTIL_LIST_DIR, dirPath),
  deletePath: (target: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.UTIL_DELETE_PATH, target),
  editFile: (input: {
    filePath: string
    oldStr: string
    newStr: string
    multi: boolean
  }): Promise<{ success: boolean; replacements: number; error?: string }> => ipcRenderer.invoke(IPC_CHANNELS.UTIL_EDIT_FILE, input),
  patchFile: (input: { filePath: string; diff: string }): Promise<{ success: boolean; replacements: number; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.UTIL_PATCH_FILE, input),
  writeFile: (input: { filePath: string; content: string; append?: boolean; expectContent?: string }): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.UTIL_WRITE_FILE, input),
  editDocx: (input: { filePath: string; ops: unknown; workspaceDir?: string }): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.UTIL_EDIT_DOCX, input),
  editPptx: (input: { filePath: string; ops: unknown; workspaceDir?: string }): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.UTIL_EDIT_PPTX, input),
  editXlsx: (input: { filePath: string; ops: unknown; workspaceDir?: string }): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.UTIL_EDIT_XLSX, input),
  inspectOffice: (input: { filePath: string }): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.UTIL_INSPECT_OFFICE, input),
  readOffice: (input: { filePath: string; offset?: number; limit?: number; tables?: boolean; sheet?: string; range?: string; slide?: number }): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.UTIL_READ_OFFICE, input),
  exportDocument: (input: { format: string; content?: string; sourcePath?: string; htmlPath?: string; fontSize?: number; filePath: string }): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.UTIL_EXPORT_DOCUMENT, input),
  convertFileToMarkdown: (filePath: string): Promise<{ content: string; cachePath: string; hit: boolean } | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.UTIL_CONVERT_TO_MARKDOWN, filePath),
  registerPreviewNonce: (input: { filePath: string; nonce: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.UTIL_REGISTER_PREVIEW_NONCE, input),
  measurePreviewFrame: (frameName: string, centerX?: boolean): Promise<{ width: number; height: number } | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.UTIL_MEASURE_PREVIEW_FRAME, frameName, centerX === true),
  saveBase64Image: (data: string): Promise<{ success: boolean; path: string }> => ipcRenderer.invoke(IPC_CHANNELS.UTIL_SAVE_BASE64_IMAGE, data),
  copyFileToTmp: (sourcePath: string): Promise<{ success: boolean; path: string }> => ipcRenderer.invoke(IPC_CHANNELS.UTIL_COPY_FILE_TO_TMP, sourcePath),
  copyFile: (input: { sourceUrl?: string; destination: string }): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.UTIL_COPY_FILE, input),

  // Memory
  listMemories: (category?: string): Promise<MemoryEntry[]> => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_LIST, category),
  saveMemory: (data: { id: string; content: string; type: string; category: string; source?: string | null }): Promise<MemoryEntry> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_SAVE, data),
  deleteMemory: (id: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_DELETE, id),
  countMemories: (types: string[]): Promise<number> => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_COUNT, types),
  searchMemories: (data: MemorySearchInput): Promise<MemoryEntry[]> => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_SEARCH, data),
  getMemoryMd: (): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_GET_MD),
  saveMemoryMd: (content: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_SAVE_MD, content),
  appendMemoryMd: (data: { sectionHeading: string; entry: string }): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_APPEND_MD, data),
  updateMemory: (id: string, data: { content?: string; type?: string; category?: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_UPDATE, id, data),

  // MCP - Model Context Protocol
  mcpListServers: (): Promise<MCPManagedServer[]> => ipcRenderer.invoke(IPC_CHANNELS.MCP_LIST_SERVERS),
  mcpGetServer: (id: string): Promise<MCPManagedServer | null> => ipcRenderer.invoke(IPC_CHANNELS.MCP_GET_SERVER, id),
  mcpStartServer: (id: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke(IPC_CHANNELS.MCP_START_SERVER, id),
  mcpStopServer: (id: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke(IPC_CHANNELS.MCP_STOP_SERVER, id),
  mcpRestartServer: (id: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke(IPC_CHANNELS.MCP_RESTART_SERVER, id),
  mcpCallTool: (serverId: string, toolName: string, args: Record<string, unknown>): Promise<MCPToolCallResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_CALL_TOOL, serverId, toolName, args),
  mcpRegisterServer: (config: MCPClientConfig): Promise<{ success: boolean; server?: MCPManagedServer; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_REGISTER_SERVER, config),
  mcpUnregisterServer: (id: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke(IPC_CHANNELS.MCP_UNREGISTER_SERVER, id),
  mcpUpdateServer: (id: string, config: MCPClientConfig): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_UPDATE_SERVER, id, config),
  mcpReloadServers: (): Promise<{ success: boolean; servers?: MCPManagedServer[]; error?: string }> => ipcRenderer.invoke(IPC_CHANNELS.MCP_RELOAD_SERVERS),
  mcpUpdateServerSummary: (id: string, summary: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.MCP_UPDATE_SERVER_SUMMARY, id, summary),

  // Knowledge Base
  knowledgeListFiles: (status?: string): Promise<KnowledgeFile[]> => ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_LIST, status),
  knowledgeListAdvanced: (opts?: KnowledgeListOptions): Promise<KnowledgeListResult> => ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_LIST_ADVANCED, opts),
  knowledgeGetFile: (id: string): Promise<KnowledgeFile | null> => ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_GET, id),
  knowledgeAddFile: (filePaths: string[], baseId?: string): Promise<KnowledgeImportResult[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_ADD_FILE, filePaths, baseId),
  knowledgePrepareImport: (filePaths: string[], baseId?: string): Promise<{ existing: { id: string; filePath: string }[]; new: string[] }> =>
    ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_PREPARE_IMPORT, filePaths, baseId),
  knowledgeScanFolder: (folderPath: string): Promise<{ fileCount: number; filePaths: string[] }> =>
    ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_SCAN_FOLDER, folderPath),
  knowledgeAddFolder: (folderPath: string, baseId?: string): Promise<KnowledgeImportResult[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_ADD_FOLDER, folderPath, baseId),
  knowledgeAddUrl: (url: string, baseId?: string): Promise<KnowledgeImportResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_ADD_URL, url, baseId),
  knowledgeDelete: (id: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_DELETE, id),
  knowledgeGetRaw: (relativePath: string, baseId?: string): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_GET_RAW, relativePath, baseId),
  knowledgeGetRawPath: (relativePath: string, baseId?: string): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_GET_RAW_PATH, relativePath, baseId),
  knowledgeReadWiki: (relativePath?: string, baseId?: string): Promise<{ content: string | null; files: string[] | null }> =>
    ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_READ_WIKI, relativePath, baseId),
  knowledgeWriteExperience: (data: { content: string; convId: string; title?: string }): Promise<KnowledgeFile> =>
    ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_WRITE_EXPERIENCE, data),
  knowledgeWriteFavorite: (data: { content: string; messageId: string; conversationId: string; title?: string }): Promise<KnowledgeFile> =>
    ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_WRITE_FAVORITE, data),
  knowledgeGetStats: (baseId?: string): Promise<KnowledgeStats> => ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_GET_STATS, baseId),
  knowledgeApplyWikiChanges: (data: {
    actions: { filePath: string; content: string }[]
    logEntry?: string
    compiledIds?: string[]
    baseId?: string
  }): Promise<{ written: number; logAppended: boolean; markedCompiled: number }> => ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_APPLY_WIKI_CHANGES, data),
  knowledgeUpdateStatus: (data: { id: string; status: 'compiled' }): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_UPDATE_STATUS, data),
  knowledgeClearAll: (): Promise<{ deletedRaw: number; deletedWiki: number }> => ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_CLEAR_ALL),
  knowledgeSearchContent: (query: string, baseId?: string): Promise<Array<{ id: string; filePath: string; title: string; sourceType: string; excerpts: string[] }>> =>
    ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_SEARCH_CONTENT, query, baseId),
  knowledgeSearchWiki: (query: string, baseId?: string): Promise<Array<{ wikiPath: string; title: string; type: string; lineNum: number; content: string }>> =>
    ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_SEARCH_WIKI, query, baseId),
  knowledgeRebuildIndex: (baseId?: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_REBUILD_INDEX, baseId),
  knowledgeGetSchema: (): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_GET_SCHEMA),
  knowledgeGetWikiDir: (baseId?: string): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_GET_WIKI_DIR, baseId),
  knowledgeRebuildWiki: (baseId?: string): Promise<{ clearedPages: number; resetSources: number }> => ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_REBUILD_WIKI, baseId),
  knowledgeListBases: (): Promise<KnowledgeBase[]> => ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_BASE_LIST),
  knowledgeCreateBase: (name: string): Promise<KnowledgeBase> => ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_BASE_CREATE, name),
  knowledgeRenameBase: (id: string, name: string): Promise<KnowledgeBase> => ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_BASE_RENAME, id, name),
  knowledgeDeleteBase: (id: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_BASE_DELETE, id),
  knowledgeSetFileBase: (id: string, baseId: string): Promise<KnowledgeFile> => ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_SET_FILE_BASE, id, baseId),
  knowledgeSetFilesBase: (ids: string[], baseId: string): Promise<number> => ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_SET_FILES_BASE, ids, baseId),
  knowledgeReextract: (id: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_REEXTRACT, id),
  knowledgeAbortImport: (): void => ipcRenderer.send(IPC_CHANNELS.KNOWLEDGE_ABORT_IMPORT),

  // SubAgent
  expertList: (): Promise<ExpertProfile[]> => ipcRenderer.invoke(IPC_CHANNELS.EXPERT_LIST),
  expertCreate: (profile: ExpertProfile): Promise<ExpertProfile[]> => ipcRenderer.invoke(IPC_CHANNELS.EXPERT_CREATE, profile),
  expertUpdate: (profile: ExpertProfile): Promise<ExpertProfile[]> => ipcRenderer.invoke(IPC_CHANNELS.EXPERT_UPDATE, profile),
  expertDelete: (id: string): Promise<ExpertProfile[]> => ipcRenderer.invoke(IPC_CHANNELS.EXPERT_DELETE, id),
  expertReset: (): Promise<ExpertProfile[]> => ipcRenderer.invoke(IPC_CHANNELS.EXPERT_RESET),

  // ── Agent sessions (engines hosted in main) ──
  agentSessionCreate: (sessionId: string, opts?: AgentSessionCreateOptions): Promise<{ sessionId: string; agentId: string; workspaceDir?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_SESSION_CREATE, sessionId, opts),
  agentSessionAsk: (sessionId: string, content: string, summon?: SummonedExpert[], knowledgeBase?: { id: string; name: string } | null): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_SESSION_ASK, sessionId, content, summon, knowledgeBase),
  agentSessionCancel: (sessionId: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_SESSION_CANCEL, sessionId),
  agentSessionHistory: (sessionId: string): Promise<{ messages: unknown[]; agentId: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_SESSION_HISTORY, sessionId),
  agentSessionHydrate: (sessionId: string, messages: unknown[], historySummary?: { text: string; firstKeptId: string } | null): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_SESSION_HYDRATE, sessionId, messages, historySummary),
  agentSessionSnapshot: (sessionId: string): Promise<{ messages: unknown[]; status: StatusSnapshot; streamingBlocks: unknown[]; plan: unknown } | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_SESSION_SNAPSHOT, sessionId),
  agentSessionEngineCall: (sessionId: string, method: string, args?: unknown[]): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_SESSION_ENGINE_CALL, sessionId, method, args ?? []),
  agentSessionRefreshOptions: (sessionId: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_SESSION_REFRESH_OPTIONS, sessionId),
  serviceGetStatus: (): Promise<ServiceStatus> => ipcRenderer.invoke(IPC_CHANNELS.SERVICE_GET_STATUS),
  serviceSetEnabled: (enabled: boolean): Promise<{ running: boolean; port: number | null }> => ipcRenderer.invoke(IPC_CHANNELS.SERVICE_SET_ENABLED, enabled),
  serviceSetPort: (port: number): Promise<{ running: boolean; port: number | null }> => ipcRenderer.invoke(IPC_CHANNELS.SERVICE_SET_PORT, port),
  serviceResetToken: (): Promise<{ token: string }> => ipcRenderer.invoke(IPC_CHANNELS.SERVICE_RESET_TOKEN),
  extensionExportZip: (): Promise<{ ok: boolean; path?: string; canceled?: boolean; message?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.EXTENSION_EXPORT_ZIP),
  onAgentSessionEvent: (callback: (event: { sessionId: string; data: unknown }) => void): (() => void) => {
    const listener = (_e: unknown, event: { sessionId: string; data: unknown }): void => callback(event)
    ipcRenderer.on(IPC_CHANNELS.AGENT_SESSION_EVENT, listener)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.AGENT_SESSION_EVENT, listener)
    }
  },
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)
