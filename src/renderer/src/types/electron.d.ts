import type { Conversation, ConversationIndexEntry, Message, TokenStats, ToolResultBatchEntry } from './conversation'
import type { AppSettings } from './settings'
import type { ToolPreferences } from '../tools/types'
import type { SkillPreferences, SkillDefinition } from '../skills/types'
import type { MemoryEntry, MemorySearchInput } from '../memory/types'
import type { KnowledgeFile, KnowledgeStats, KnowledgeImportResult, KnowledgeListOptions, KnowledgeListResult } from '../../../shared/types/knowledge'
import type { SubAgentProfile } from '../../../shared/types/subagent'
import type { GitAction, GitResult } from '../../../shared/types/git'

// --- Platform Info ---

export interface PlatformInfo {
  platform: string
  platformName: string
  release: string
  arch: string
  ripgrepPath: string | null
}

export interface DataPaths {
  dataDir: string
  skillsDir: string
  workspaceDir: string
  settingsPath: string
  knowledgeDir: string
}

// --- Terminal Event Types ---

export interface TerminalOutputEvent {
  processId: string
  type: 'stdout' | 'stderr'
  data: string
}

export interface TerminalExitEvent {
  processId: string
  code: number | null
  signal: string | null
}

// --- API Proxy Event Types ---

export interface ApiStreamChunkEvent {
  requestId: string
  data: string
}

export interface ApiStreamErrorEvent {
  requestId: string
  error: string
}

export interface ApiStreamDoneEvent {
  requestId: string
}

export interface ApiStreamRetryEvent {
  requestId: string
  attempt: number
  maxRetries: number
  delay: number
  message: string
}

// --- MCP Types ---

export interface MCPToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface MCPClientConfig {
  command: string
  args: string[]
  env?: Record<string, string>
  name: string
  /** Transport type: 'stdio' (local subprocess, default), 'sse' (remote HTTP server), or 'streamable-http' (streamable HTTP) */
  transportType?: 'stdio' | 'sse' | 'streamable-http'
  /** SSE/Streamable HTTP endpoint URL (required when transportType === 'sse' or 'streamable-http') */
  url?: string
  /** Custom HTTP headers for SSE transport (e.g. Authorization) */
  headers?: Record<string, string>
  /** When true, this server's tools require user approval before execution in mixed mode (auto-executed in YOLO mode). */
  requireApproval?: boolean
}

export interface MCPManagedServer {
  id: string
  name: string
  config: MCPClientConfig
  status: 'stopped' | 'connecting' | 'connected' | 'error'
  error?: string
  tools: MCPToolDefinition[]
  serverInfo: { name: string; version: string } | null
  summary?: string
}

export interface MCPToolCallResult {
  success: boolean
  result?: unknown
  error?: string
}

export interface ElectronAPI {
  // Debug
  dbCheck: () => Promise<string>

  // Conversations
  listConversations: () => Promise<ConversationIndexEntry[]>
  getConversation: (id: string) => Promise<Conversation | null>
  hydrateConversation: (id: string) => Promise<Conversation | null>
  saveConversation: (conv: Conversation) => Promise<void>
  saveConversationSync: (conv: Conversation) => void
  appendConversationMessages: (convId: string, title: string, messages: Message[]) => Promise<void>
  updateMessageMetadata: (msgId: string, data: { liked?: boolean; favorited?: boolean }) => Promise<void>
  deleteConversation: (id: string) => Promise<void>
  updateConversationTitle: (id: string, title: string) => Promise<void>
  updateConversationSummary: (id: string, summary: string) => Promise<void>
  updateConversationKeywords: (id: string, keywords: string) => Promise<void>
  toggleConversationPin: (id: string, pinned: boolean) => Promise<void>
  touchConversation: (id: string) => Promise<void>
  getConversationExtractedMsgCount: (id: string) => Promise<number>
  updateConversationExtractedMsgCount: (id: string, count: number) => Promise<void>
  getConversationExperienceExtractedCount: (id: string) => Promise<number>
  updateConversationExperienceExtractedCount: (id: string, count: number) => Promise<void>
  listConversationsForMemory: (opts: { afterTime?: string; beforeTime?: string; limit?: number }) => Promise<
    Array<{ id: string; title: string; summary: string | null; keywords: string | null; updatedAt: string }>
  >
  searchConversationsByKeyword: (query: string, limit?: number) => Promise<
    Array<{ id: string; title: string; summary: string | null; keywords: string | null; updatedAt: string }>
  >
  saveConversationPlan: (id: string, planJson: string | null) => Promise<void>
  getConversationPlan: (id: string) => Promise<string | null>
  getToolResult: (ids: string[]) => Promise<Array<{ ref_id: string; conversation_id: string; message_id: string; block_index: number; tool_use_id: string; content: string; is_error: number }>>
  persistToolResults:(convId: string, results: ToolResultBatchEntry[]) => Promise<void>

  // Token Statistics
  getTokenStats: () => Promise<TokenStats>

  // Settings
  getSettings: () => Promise<AppSettings>
  setSettings: (settings: AppSettings) => Promise<void>

  // Tools
  getToolPreferences: () => Promise<ToolPreferences>
  setToolPreferences: (prefs: ToolPreferences) => Promise<void>

  // Skills
  getSkillPreferences: () => Promise<SkillPreferences>
  setSkillPreferences: (prefs: SkillPreferences) => Promise<void>

  // Skills - Import
  importSkill: () => Promise<{ imported: SkillDefinition[]; errors: string[] } | null>
  listImportedSkills: () => Promise<SkillDefinition[]>
  deleteImportedSkill: (name: string) => Promise<void>
  ensureBuiltInSkills: (skills: SkillDefinition[]) => Promise<void>
  installSkill: (name: string) => Promise<SkillDefinition | null>
  readSkillRaw: (name: string) => Promise<string | null>
  writeSkill: (skill: SkillDefinition) => Promise<void>

  // Terminal
  executeCommand: (command: string, cwd?: string, timeoutMs?: number) => Promise<string>
  execCommandSync: (command: string, cwd?: string, timeoutMs?: number) => Promise<{ output: string; code: number | null }>
  killCommand: (processId: string) => Promise<void>
  onTerminalOutput: (callback: (data: TerminalOutputEvent) => void) => () => void
  onTerminalExit: (callback: (data: TerminalExitEvent) => void) => () => void
  onTerminalError: (callback: (data: { processId: string; message: string }) => void) => () => void

  // Git
  gitInvoke: (action: GitAction) => Promise<GitResult>

  // API Proxy
  apiFetchStream: (requestId: string, url: string, options?: { method?: string; headers?: Record<string, string>; body?: string | object }) => Promise<void>
  apiAbortStream: (requestId: string) => Promise<void>
  onApiStreamChunk: (callback: (data: ApiStreamChunkEvent) => void) => () => void
  onApiStreamError: (callback: (data: ApiStreamErrorEvent) => void) => () => void
  onApiStreamDone: (callback: (data: ApiStreamDoneEvent) => void) => () => void
  onApiStreamRetry: (callback: (data: ApiStreamRetryEvent) => void) => () => void
  onSystemResumed: (callback: () => void) => () => void
  systemResumedAck: () => void
  onHooksCompleted: (callback: () => void) => () => void
  onMcpServersChanged: (callback: () => void) => () => void
  onSkillsChanged: (callback: () => void) => () => void

  // Non-streaming fetch (avoids CORS)
  apiFetch: (url: string, options?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<string | null>

  // App / Platform Info
  getPlatformInfo: () => Promise<PlatformInfo>
  getDataPaths: () => Promise<DataPaths>
  openFolder: (folderPath: string) => Promise<void>
  openExternal: (url: string) => Promise<void>
  getFileStat: (filePath: string) => Promise<{ size: number; birthtime: string; mtime: string } | null>

  // Dialog (cross-platform ask_user)
  showDialog: (options: { type: 'choice' | 'prompt'; title: string; message: string; choices?: string[] }) => Promise<{ value: string | null; cancelled: boolean }>
  showSaveDialog: (options: { defaultName?: string; filters?: Array<{ name: string; extensions: string[] }> }) => Promise<{ filePath: string | null; canceled: boolean }>
  showOpenDialog: (options?: { properties?: Array<'openFile' | 'openDirectory' | 'multiSelections'>; filters?: Array<{ name: string; extensions: string[] }> }) => Promise<{ filePaths: string[]; canceled: boolean }>

  readFile: (filePath: string) => Promise<string | null>
  editFile: (input: { filePath: string; oldStr: string; newStr: string; multi: boolean }) => Promise<{ success: boolean; replacements: number; error?: string }>
  patchFile: (input: { filePath: string; diff: string }) => Promise<{ success: boolean; replacements: number; error?: string }>
  writeFile: (input: { filePath: string; content: string; append?: boolean }) => Promise<{ success: boolean; error?: string }>
  convertFileToMarkdown: (filePath: string) => Promise<{ content: string; cachePath: string; hit: boolean } | null>
  saveBase64Image: (data: string) => Promise<{ success: boolean; path: string }>
  copyFileToTmp: (sourcePath: string) => Promise<{ success: boolean; path: string }>
  copyFile: (input: { source?: string; sourceUrl?: string; destination: string }) => Promise<{ success: boolean; error?: string }>

  // Memory
  listMemories: (category?: string) => Promise<MemoryEntry[]>
  saveMemory: (data: { id: string; content: string; type: string; category: string; source?: string | null }) => Promise<MemoryEntry>
  deleteMemory: (id: string) => Promise<void>
  countMemories: (types: string[]) => Promise<number>
  searchMemories: (data: MemorySearchInput) => Promise<MemoryEntry[]>
  getMemoryMd: () => Promise<string>
  saveMemoryMd: (content: string) => Promise<void>
  appendMemoryMd: (data: { sectionHeading: string; entry: string }) => Promise<void>
  updateMemory: (id: string, data: { content?: string; type?: string; category?: string }) => Promise<void>

  // Favorites
  addFavorite: (data: {
    id: string
    messageId: string
    conversationId: string
    conversationTitle: string
    role: string
    content: string
    contentBlocks?: string | null
  }) => Promise<{ success: boolean; error?: string }>
  removeFavorite: (messageId: string) => Promise<{ success: boolean; error?: string }>
  listFavorites: () => Promise<Array<{
    id: string
    messageId: string
    conversationId: string
    conversationTitle: string
    role: string
    content: string
    contentBlocks?: any
    createdAt: string
  }>>

  // MCP - Model Context Protocol
  mcpListServers: () => Promise<MCPManagedServer[]>
  mcpGetServer: (id: string) => Promise<MCPManagedServer | null>
  mcpStartServer: (id: string) => Promise<{ success: boolean; error?: string }>
  mcpStopServer: (id: string) => Promise<{ success: boolean; error?: string }>
  mcpRestartServer: (id: string) => Promise<{ success: boolean; error?: string }>
  mcpCallTool: (serverId: string, toolName: string, args: Record<string, unknown>) => Promise<MCPToolCallResult>
  mcpRegisterServer: (config: MCPClientConfig) => Promise<{ success: boolean; server?: MCPManagedServer; error?: string }>
  mcpUnregisterServer: (id: string) => Promise<{ success: boolean; error?: string }>
  mcpReloadServers: () => Promise<{ success: boolean; servers?: MCPManagedServer[]; error?: string }>
  mcpUpdateServer: (id: string, config: MCPClientConfig) => Promise<{ success: boolean; error?: string }>
  mcpUpdateServerSummary: (id: string, summary: string) => Promise<void>

  // Knowledge Base
  knowledgeListFiles: (status?: string) => Promise<KnowledgeFile[]>
  knowledgeListAdvanced: (opts?: KnowledgeListOptions) => Promise<KnowledgeListResult>
  knowledgeGetFile: (id: string) => Promise<KnowledgeFile | null>
  knowledgeAddFile: (filePaths: string[]) => Promise<KnowledgeImportResult[]>
  knowledgeScanFolder: (folderPath: string) => Promise<{ fileCount: number; filePaths: string[] }>
  knowledgePrepareImport: (filePaths: string[]) => Promise<{ existing: { id: string; filePath: string }[]; new: string[] }>
  knowledgeAddFolder: (folderPath: string) => Promise<KnowledgeImportResult[]>
  knowledgeAddUrl: (url: string) => Promise<KnowledgeImportResult>
  knowledgeDelete: (id: string) => Promise<void>
  knowledgeGetRaw: (relativePath: string) => Promise<string>
  knowledgeGetRawPath: (relativePath: string) => Promise<string>
  knowledgeReadWiki: (relativePath?: string) => Promise<{ content: string | null; files: string[] | null }>
  knowledgeWriteExperience: (data: { content: string; convId: string; title?: string }) => Promise<KnowledgeFile>
  knowledgeGetStats: () => Promise<KnowledgeStats>
  knowledgeApplyWikiChanges: (data: { actions: { filePath: string; content: string }[]; logEntry?: string; compiledIds?: string[] }) => Promise<{ written: number; logAppended: boolean; markedCompiled: number }>
  knowledgeUpdateStatus: (data: { id: string; status: 'compiled' }) => Promise<void>
  knowledgeClearAll: () => Promise<{ deletedRaw: number; deletedWiki: number }>
  knowledgeSearchContent: (query: string) => Promise<Array<{ id: string; filePath: string; title: string; sourceType: string; excerpts: string[] }>>
  knowledgeSearchWiki: (query: string) => Promise<Array<{ wikiPath: string; title: string; type: string; lineNum: number; content: string }>>
  knowledgeRebuildIndex: () => Promise<void>
  knowledgeAbortImport: () => void

  // Canvas
  canvasPrepareWorkDir: (rectId: string, existingCode?: string, fresh?: boolean) => Promise<string>
  canvasExportHtml: (rectId: string) => Promise<{ success: boolean; filePath?: string; error?: string; canceled?: boolean }>
  canvasOpenInBrowser: (rectId: string) => Promise<{ success: boolean; error?: string }>
  canvasExportImage: (rectId: string, viewport?: { width: number; height: number }, htmlContent?: string) => Promise<{ success: boolean; error?: string; canceled?: boolean }>
  canvasCleanupRect: (rectId: string) => Promise<{ success: boolean; deletedConvs: number }>
  canvasClearAll: () => Promise<{ success: boolean; deletedConvs: number }>

  // SubAgent
  subagentList: () => Promise<SubAgentProfile[]>
  subagentCreate: (profile: SubAgentProfile) => Promise<SubAgentProfile[]>
  subagentUpdate: (profile: SubAgentProfile) => Promise<SubAgentProfile[]>
  subagentDelete: (id: string) => Promise<SubAgentProfile[]>
  subagentReset: () => Promise<SubAgentProfile[]>
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

declare const __APP_VERSION__: string
