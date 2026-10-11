// ── ElectronAPI bridge contract (moved from src/renderer/src/types/electron.d.ts) ──
// The single source of truth for the preload↔main↔renderer IPC surface: every
// method here must be exposed by src/preload/index.ts and handled by a
// registered ipcMain handler. Both processes and preload import this file, so
// it must stay import-free of DOM/window/node APIs (type-only imports only).
// src/renderer/src/types/electron.d.ts re-exports everything here and adds the
// ambient `Window.electronAPI` declaration.

import type { Conversation, ConversationIndexEntry, Message, TokenStats, ToolResultBatchEntry } from './conversation'
import type { AppSettings } from './settings'
import type { ToolPreferences } from './tool-types'
import type { SkillPreferences, SkillPreferencesPatch, SkillDefinition } from './skill-types'
import type { MemoryEntry, MemorySearchInput } from './memory'
import type { KnowledgeFile, KnowledgeBase, KnowledgeStats, KnowledgeImportResult, KnowledgeListOptions, KnowledgeListResult } from './knowledge'
import type { ExpertProfile } from './expert'
import type { SummonedExpert } from '../expert-context'
import type { GitAction, GitResult } from './git'
import type { ExperienceRecord, ExperienceDraft } from './experience-types'
import type { WindowControlsLayout } from '../window-chrome'
import type { Project, ProjectCreateInput, ProjectUpdateInput } from './project'
import type { SandboxApprovalMode } from '../sandbox/policy'
import type { Routine, RoutineParam, RoutineRun } from './routine'
import type { CsvPreviewResult } from '../routine/batch'
import type { UserTool } from './user-tool'
import type { AgentSessionCreateOptions, StatusSnapshot } from '../agent-protocol'

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
  /** User tools (tool studio), PLAN-0.4.0 M5. */
  toolsDir?: string
}

// --- Local agent service (PLAN-0.3.5 M2.4 / PLAN-browser-extension M1.5) ---

/** One connected protocol client. The browser extension shows up as
 *  `pulsemind-extension`. */
export interface ServiceClientInfo {
  clientId: string
  sessions: number
}

export interface ServiceStatus {
  enabled: boolean
  port: number
  running: boolean
  token: string
  clients: ServiceClientInfo[]
  /** Ready-to-paste endpoint for a client's manual configuration. */
  wsUrl: string
  /** Built extension bundle to load unpacked, when it exists on disk. */
  extensionDir: string | null
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
  /** When true, this server's tools wait for user approval unless the session's approval mode is 'auto'. */
  requireApproval?: boolean
  /** Per tool-call timeout in ms (default 180s). The generic 60s request budget
   *  is too tight for data-heavy servers; handshake/ping keep their own budgets. */
  toolCallTimeoutMs?: number
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
  hydrateConversation: (id: string, maxContentLength?: number) => Promise<Conversation | null>
  saveConversation: (conv: Conversation) => Promise<void>
  saveConversationSync: (conv: Conversation) => void
  appendConversationMessages: (convId: string, title: string, messages: Message[]) => Promise<void>
  updateMessageMetadata: (msgId: string, data: { liked?: boolean; favorited?: boolean }) => Promise<void>
  /** `deleteWorkspace` rides ONLY the autoCleanup eviction (12h disk bound):
   *  also remove the conversation's minted workspace folder (guarded main-side
   *  to per-conversation folders under the global workspace — project jail
   *  roots and backfill rows pointing at the root itself are never touched).
   *  A manual delete omits it and keeps the folder. */
  deleteConversation: (id: string, opts?: { deleteWorkspace?: boolean }) => Promise<void>
  updateConversationTitle: (id: string, title: string) => Promise<void>
  updateConversationSummary: (id: string, summary: string) => Promise<void>
  updateConversationKeywords: (id: string, keywords: string) => Promise<void>
  toggleConversationPin: (id: string, pinned: boolean) => Promise<void>
  touchConversation: (id: string) => Promise<void>
  getConversationExtractedMsgCount: (id: string) => Promise<number>
  updateConversationExtractedMsgCount: (id: string, count: number) => Promise<void>
  getConversationExperienceExtractedCount: (id: string) => Promise<number>
  updateConversationExperienceExtractedCount: (id: string, count: number) => Promise<void>
  listConversationsForMemory: (opts: {
    afterTime?: string
    beforeTime?: string
    limit?: number
  }) => Promise<Array<{ id: string; title: string; summary: string | null; keywords: string | null; updatedAt: string }>>
  searchConversationsByKeyword: (
    query: string,
    limit?: number,
  ) => Promise<Array<{ id: string; title: string; summary: string | null; keywords: string | null; updatedAt: string }>>
  searchMessagesByKeyword: (
    query: string,
    limit?: number,
  ) => Promise<Array<{ conversationId: string; conversationTitle: string; role: 'user' | 'assistant'; snippet: string; createdAt: string }>>
  getConversationLastUserMessage: (id: string) => Promise<string | null>
  saveConversationPlan: (id: string, planJson: string | null) => Promise<void>
  getConversationPlan: (id: string) => Promise<string | null>
  getToolResult: (
    ids: string[],
  ) => Promise<
    Array<{ ref_id: string; conversation_id: string; message_id: string; block_index: number; tool_use_id: string; content: string; is_error: number }>
  >
  persistToolResults: (convId: string, results: ToolResultBatchEntry[]) => Promise<void>

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
  updateSkillPreferences: (patch: SkillPreferencesPatch) => Promise<void>

  // Skills - Import
  importSkill: () => Promise<{ imported: SkillDefinition[]; errors: string[]; warnings: string[] } | null>
  listImportedSkills: () => Promise<SkillDefinition[]>
  deleteImportedSkill: (name: string) => Promise<void>
  ensureBuiltInSkills: (skills: SkillDefinition[]) => Promise<void>
  installSkill: (name: string) => Promise<SkillDefinition | null>
  readSkillRaw: (name: string) => Promise<string | null>
  writeSkill: (skill: SkillDefinition) => Promise<void>
  /**
   * Write a raw SKILL.md verbatim (the agent install tool's `content`). The
   * frontmatter `name` names the directory; refuses to overwrite an existing
   * skill. This is the sanctioned door into the deny-rooted skills dir — it
   * must never route through the fs guard. Resolves { ok:false, error } on
   * any refusal.
   */
  writeSkillSource: (content: string, expectedName?: string) => Promise<{ ok: true; skill: SkillDefinition } | { ok: false; error: string }>
  /** Relative file paths of a skill directory (recursive), e.g. ['SKILL.md', 'scripts/run.py']. */
  listSkillFiles: (name: string) => Promise<string[]>
  /** Read one file inside the skill directory by its skill-relative path. */
  readSkillFile: (name: string, relPath: string) => Promise<string | null>

  // Experiences
  listExperiences: () => Promise<ExperienceRecord[]>
  saveExperienceRecord: (draft: ExperienceDraft) => Promise<{ record: ExperienceRecord; evicted?: ExperienceRecord; rejectedFiles?: string[] }>
  /** Read a companion script of an experience (read-only panel view). Jail-checked; null on any refusal. */
  readExperienceFile: (name: string, relPath: string) => Promise<string | null>
  deleteExperienceRecord: (name: string) => Promise<void>
  readExperienceRecord: (name: string) => Promise<string | null>
  touchExperienceRecord: (name: string, outcome?: 'ok' | 'fail') => Promise<void>
  clearExperiences: () => Promise<number>
  onExperiencesChanged: (callback: () => void) => () => void

  // Terminal
  executeCommand: (command: string, cwd?: string, timeoutMs?: number) => Promise<string>
  execCommandSync: (command: string, cwd?: string, timeoutMs?: number) => Promise<{ output: string; code: number | null }>
  killCommand: (processId: string) => Promise<void>
  // Background process mode (PLAN-coding-contract P0-3) + session exec
  // allowlist (P0-2 #5). The agent graph reaches these only through the
  // main-process host; the bridge implementations satisfy the PulseHost shape.
  executeBackground: (command: string, cwd?: string) => Promise<{ pid: number }>
  execLogs: (pid: number, tailBytes?: number) => Promise<string | null>
  execKill: (pid: number) => Promise<boolean>
  getExecAllowlist: () => Promise<string[]>
  addExecAllowlist: (prefix: string) => Promise<void>
  onTerminalOutput: (callback: (data: TerminalOutputEvent) => void) => () => void
  onTerminalExit: (callback: (data: TerminalExitEvent) => void) => () => void
  onTerminalError: (callback: (data: { processId: string; message: string }) => void) => () => void

  // Git
  gitInvoke: (action: GitAction) => Promise<GitResult>

  // API Proxy
  apiFetchStream: (
    requestId: string,
    url: string,
    options?: { method?: string; headers?: Record<string, string>; body?: string | object; profileId?: string },
  ) => Promise<void>
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
  /** 原生菜单 / 加速键动作（src/main/menu.ts 的 MenuActionId，以字符串过线）。 */
  onMenuAction: (callback: (action: string) => void) => () => void

  // 设置页「测试连接」：main 侧对 provider 发一次最小非流式探测
  testLlmConnection: (
    input: import('../llm/probe').LlmProbeInput & { profileId?: string },
  ) => Promise<import('../llm/probe').LlmProbeOutcome>

  // Non-streaming fetch (avoids CORS)
  apiFetch: (
    url: string,
    options?: { method?: string; headers?: Record<string, string>; body?: string; withProfileHeaders?: boolean; profileId?: string },
  ) => Promise<string | null>

  // App / Platform Info
  getPlatformInfo: () => Promise<PlatformInfo>
  getWindowControls: () => WindowControlsLayout
  /** Combined alpha of the full-window masks currently open (0 = none), fed by
   *  the renderer's mask watcher (utils/title-bar-mask.ts). The OS draws the
   *  caption buttons above the web content, so main repaints them pre-dimmed —
   *  otherwise they stay at full brightness over a modal's dimmed header. */
  setTitleBarMaskAlpha: (alpha: number) => void

  // ── Projects / conversation bindings (PLAN-0.4.0 M3) ──
  projectList: () => Promise<Project[]>
  projectGet: (id: string) => Promise<Project | null>
  projectCreate: (input: ProjectCreateInput) => Promise<Project>
  projectUpdate: (id: string, patch: ProjectUpdateInput) => Promise<Project | null>
  projectDelete: (id: string) => Promise<{ removedConversations: number }>
  projectValidateDir: (workspaceDir: string) => Promise<{ ok: boolean; error?: string }>
  /** Persist the sidebar's drag order: the full id list, display order. */
  projectReorder: (orderedIds: string[]) => Promise<void>
  setConversationProject: (id: string, projectId: string) => Promise<void>
  setConversationExpert: (id: string, expertId: string | null) => Promise<void>
  /** `source` marks a write that is NOT the user's choice — the tool studio's
   *  first-create seed passes 'derived' so the sticky last-used value
   *  (「新建会话沿用上次选择」) is not polluted by it. Default 'user'. */
  setConversationApprovalMode: (id: string, mode: SandboxApprovalMode, source?: 'user' | 'derived') => Promise<void>
  /** Pin (profileId) or unpin (null → follow the global default) the
   *  conversation's own model. The session re-resolves it on refreshOptions.
   *  Same `source` contract as setConversationApprovalMode. */
  setConversationProfile: (id: string, profileId: string | null, source?: 'user' | 'derived') => Promise<void>
  routineList: () => Promise<Routine[]>
  routineGet: (id: string) => Promise<Routine | null>
  routineCreate: (input: Partial<Routine>) => Promise<Routine>
  routineUpdate: (id: string, patch: Partial<Routine>) => Promise<Routine | null>
  routineDelete: (id: string) => Promise<void>
  routineToggle: (id: string, enabled: boolean) => Promise<Routine | null>
  routineRun: (id: string, params?: Record<string, string>) => Promise<RoutineRun>
  /** 停止一次进行中的单笔运行：中断引擎，记录落为失败（用户停止）。批量运行
   *  不走这里（routineBatchStop）。无 live 句柄（已结束/重启前的旧行/批量行）
   *  抛错给调用方展示。 */
  routineRunStop: (runId: string) => Promise<void>
  routineRuns: (routineId?: string, limit?: number) => Promise<RoutineRun[]>
  /** 删除一条运行记录（连同它的对话）。返回删除条数。 */
  routineRunDelete: (runId: string) => Promise<number>
  /** 清空一个任务的运行记录（正在运行的那条保留）。返回删除条数。 */
  routineRunsClear: (routineId: string) => Promise<number>
  /** 按保留策略清理已结束的运行记录；days 省略时用设置里的策略。返回删除条数。 */
  routineRunsPrune: (days?: number) => Promise<number>
  // ── Batch mode (PLAN-routine-batch) ──
  /** 手动启动一次批量运行，返回 parent 运行记录。concurrency / timeoutMinutes
   *  为本次运行的并发（1–5 整数）与单次超时（1–120 整数分钟）覆盖；缺省用任务
   *  配置，只影响这一批、不回写配置。拒绝情形（已有批量进行中、文件不可读、
   *  缺必填列、超行数上限、非法并发数/超时）抛错给调用方展示。 */
  routineBatchRun: (id: string, concurrency?: number, timeoutMinutes?: number) => Promise<RoutineRun>
  /** 停止一次批量运行（未知/已结束的 parent 是 no-op）。 */
  routineBatchStop: (parentRunId: string) => Promise<void>
  /** 继续一次被中断的批量运行（用户停止或应用退出）：同一 parent 下只重跑未
   *  成功的行。拒绝情形（记录不存在、仍在进行、任务已有批量在跑、任务已删、
   *  全部行已成功、CSV 行数已变）抛错给调用方展示。 */
  routineBatchResume: (parentRunId: string) => Promise<RoutineRun>
  /** 一次批量运行的行记录：按 CSV 行折叠到最新一次尝试（续跑会为同一行追加
   *  attempt 行），attempts>1 时携带该行的总尝试次数。 */
  routineBatchItems: (parentRunId: string) => Promise<RoutineRun[]>
  /** PLAN-routine-triggers M1: the resolved loopback port of the webhook
   *  endpoint (0 = dormant this session). */
  routineTriggersInfo: () => Promise<{ port: number }>
  /** CSV/Excel 映射预览（.csv/.txt 走 GBK 回退解析，.xlsx 走首张工作表）。
   *  解析失败不抛错，返回 { ok: false, error } 由界面就地展示。 */
  routineCsvPreview: (filePath: string, params?: RoutineParam[]) => Promise<CsvPreviewResult>
  toolList: () => Promise<UserTool[]>
  toolGet: (id: string) => Promise<UserTool | null>
  toolCreate: (input: { name: string; description?: string; category?: string; capabilities?: string[] }) => Promise<UserTool>
  toolUpdate: (id: string, patch: Record<string, unknown>) => Promise<UserTool | null>
  toolDelete: (id: string) => Promise<void>
  toolDuplicate: (id: string) => Promise<UserTool | null>
  toolReadHtml: (id: string) => Promise<string | null>
  toolWriteHtml: (id: string, html: string) => Promise<void>
  toolGetDeletedPresets: () => Promise<string[]>
  toolRestorePresets: () => Promise<UserTool[]>
  /** Browser Use (A-M1): run a JS snippet against the host browser runtime. */
  browserRunCode: (
    code: string,
    opts?: { timeoutMs?: number; conversationId?: string },
  ) => Promise<{ result: string; truncated: boolean; images: Array<{ mime: string; base64: string }>; console: string[]; error?: string }>
  /** Hosted (reverse-RPC) page tool: forwarded over the local agent service to
   *  the browser extension that is driving the session (PLAN-browser-extension
   *  M0.2). Only sessions with a connected hosted client can execute. */
  hostedToolCall: (
    tool: string,
    args: Record<string, unknown>,
    opts: { sessionId: string; timeoutMs?: number },
  ) => Promise<unknown>
  /** Browser pane (A-M5). `browserActive`: PLAN-workbench W3 — false folds the
   *  native WebView while the workbench shows a non-browser tab. */
  browserPaneSetState: (state: { viewKind: string; conversationId: string | null; chatAreaWidth: number; browserActive?: boolean; chromeOverlayHeight?: number }) => Promise<void>
  browserPaneSetWidth: (width: number) => Promise<void>
  browserPaneAction: (action: Record<string, unknown>) => Promise<void>
  /** Address-bar history (PLAN-browser-pane-ux T3): manual navigation only. */
  browserHistoryQuery: (text: string) => Promise<Array<{ url: string; title: string | null; visitCount: number; lastVisitAt: number }>>
  browserHistoryClear: () => Promise<void>
  browserFavoriteAdd: (url: string, title?: string) => Promise<{ ok: boolean; url: string; created: boolean; error?: string }>
  browserFavoriteRemove: (url: string) => Promise<boolean>
  browserFavoriteList: () => Promise<Array<{ url: string; title: string | null; createdAt: number; updatedAt: number }>>
  browserFavoriteQuery: (text: string, limit?: number) => Promise<Array<{ url: string; title: string | null; createdAt: number; updatedAt: number }>>
  browserFavoriteHas: (url: string) => Promise<boolean>
  onBrowserPaneUpdate: (
    cb: (update: {
      visible: boolean
      width: number
      conversationId: string | null
      tabs: Array<{ id: string; url: string; title: string; active: boolean }>
    }) => void,
  ) => () => void
  toolBridgeInvoke: (toolId: string, method: string, params: Record<string, unknown>) => Promise<unknown>
  getDataPaths: () => Promise<DataPaths>
  openFolder: (folderPath: string) => Promise<void>
  openExternal: (url: string) => Promise<void>
  getFileStat: (filePath: string) => Promise<{ size: number; birthtime: string; mtime: string; isDirectory: boolean } | null>
  /** Disk path behind a pasted/dropped `File` — sync, no IPC. Electron 33
   *  removed the runtime `File.path` (the ambient d.ts still declares it, so
   *  that read typechecks and evaluates undefined); the preload's
   *  `webUtils.getPathForFile` is the only remaining source. `''` for
   *  pathless blobs (clipboard screenshots, JS-built Files) — the caller
   *  routes those to its image branch. */
  getPathForFile: (file: File) => string

  // Dialog (cross-platform ask_user)
  showDialog: (options: {
    type: 'choice' | 'prompt'
    title: string
    message: string
    choices?: string[]
  }) => Promise<{ value: string | null; cancelled: boolean }>
  showSaveDialog: (options: {
    defaultName?: string
    filters?: Array<{ name: string; extensions: string[] }>
  }) => Promise<{ filePath: string | null; canceled: boolean }>
  showOpenDialog: (options?: {
    properties?: Array<'openFile' | 'openDirectory' | 'multiSelections'>
    filters?: Array<{ name: string; extensions: string[] }>
  }) => Promise<{ filePaths: string[]; canceled: boolean }>

  readFile: (filePath: string) => Promise<string | null>
  readFileBinary: (filePath: string) => Promise<string | null>
  listDir: (dirPath: string) => Promise<{ entries: Array<{ name: string; path: string; isDir: boolean }> } | null>
  deletePath: (target: string) => Promise<{ success: boolean; error?: string }>
  editFile: (input: { filePath: string; oldStr: string; newStr: string; multi: boolean }) => Promise<{ success: boolean; replacements: number; error?: string }>
  patchFile: (input: { filePath: string; diff: string }) => Promise<{ success: boolean; replacements: number; error?: string }>
  writeFile: (input: { filePath: string; content: string; append?: boolean; expectContent?: string }) => Promise<{ success: boolean; error?: string }>
  editDocx: (input: { filePath: string; ops: import('../office/ops').DocxToolOp[]; workspaceDir?: string }) => Promise<import('../office/ops').DocxEditOutcome & { success: boolean; error?: string; backup?: string }>
  editPptx: (input: { filePath: string; ops: import('../office/ops').PptxToolOp[]; workspaceDir?: string }) => Promise<import('../office/ops').PptxEditOutcome & { success: boolean; error?: string; backup?: string }>
  editXlsx: (input: { filePath: string; ops: import('../office/ops').XlsxToolOp[]; workspaceDir?: string }) => Promise<import('../office/ops').XlsxEditOutcome & { success: boolean; error?: string; backup?: string }>
  inspectOffice: (input: { filePath: string }) => Promise<import('../office/ops').OfficeInspectResult>
  readOffice: (input: import('../office/ops').OfficeReadInput) => Promise<import('../office/ops').OfficeReadResult>
  exportDocument: (input: { format: 'docx' | 'xlsx' | 'csv' | 'pptx' | 'pdf'; content?: string; sourcePath?: string; htmlPath?: string; fontSize?: number; filePath: string }) => Promise<{ success: boolean; error?: string; path?: string; bytes?: number; report?: string }>
  convertFileToMarkdown: (filePath: string) => Promise<{ content: string; cachePath: string; hit: boolean } | null>
  /** M10: register the per-mount element-edit nonce in the main process —
   *  the served picker copy reads it there, never the frame URL. */
  registerPreviewNonce: (input: { filePath: string; nonce: string }) => Promise<void>
  /** Measure a named sandboxed preview iframe from the main process — the
   *  frame's DOM is unreachable from the renderer (opaque origin). `centerX`
   *  also parks the frame's own horizontal scroll at the middle of its
   *  overflow. Null = frame not found or the in-frame read failed. */
  measurePreviewFrame: (frameName: string, centerX?: boolean) => Promise<{ width: number; height: number } | null>
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
  knowledgeAddFile: (filePaths: string[], baseId?: string) => Promise<KnowledgeImportResult[]>
  knowledgeScanFolder: (folderPath: string) => Promise<{ fileCount: number; filePaths: string[] }>
  knowledgePrepareImport: (filePaths: string[], baseId?: string) => Promise<{ existing: { id: string; filePath: string }[]; new: string[] }>
  knowledgeAddFolder: (folderPath: string, baseId?: string) => Promise<KnowledgeImportResult[]>
  knowledgeAddUrl: (url: string, baseId?: string) => Promise<KnowledgeImportResult>
  knowledgeDelete: (id: string) => Promise<void>
  knowledgeGetRaw: (relativePath: string, baseId?: string) => Promise<string>
  knowledgeGetRawPath: (relativePath: string, baseId?: string) => Promise<string>
  knowledgeReadWiki: (relativePath?: string, baseId?: string) => Promise<{ content: string | null; files: string[] | null }>
  knowledgeWriteExperience: (data: { content: string; convId: string; title?: string }) => Promise<KnowledgeFile>
  knowledgeWriteFavorite: (data: { content: string; messageId: string; conversationId: string; title?: string }) => Promise<KnowledgeFile>
  knowledgeGetStats: (baseId?: string) => Promise<KnowledgeStats>
  knowledgeApplyWikiChanges: (data: {
    actions: { filePath: string; content: string }[]
    logEntry?: string
    compiledIds?: string[]
    baseId?: string
  }) => Promise<{ written: number; logAppended: boolean; markedCompiled: number }>
  knowledgeUpdateStatus: (data: { id: string; status: 'compiled' }) => Promise<void>
  knowledgeClearAll: () => Promise<{ deletedRaw: number; deletedWiki: number }>
  knowledgeSearchContent: (query: string, baseId?: string) => Promise<Array<{ id: string; filePath: string; title: string; sourceType: string; excerpts: string[] }>>
  knowledgeSearchWiki: (query: string, baseId?: string) => Promise<Array<{ wikiPath: string; title: string; type: string; lineNum: number; content: string }>>
  knowledgeRebuildIndex: (baseId?: string) => Promise<void>
  knowledgeGetSchema: () => Promise<string>
  knowledgeGetWikiDir: (baseId?: string) => Promise<string>
  knowledgeRebuildWiki: (baseId?: string) => Promise<{ clearedPages: number; resetSources: number }>
  knowledgeListBases: () => Promise<KnowledgeBase[]>
  knowledgeCreateBase: (name: string) => Promise<KnowledgeBase>
  knowledgeRenameBase: (id: string, name: string) => Promise<KnowledgeBase>
  knowledgeDeleteBase: (id: string) => Promise<void>
  knowledgeSetFileBase: (id: string, baseId: string) => Promise<KnowledgeFile>
  knowledgeSetFilesBase: (ids: string[], baseId: string) => Promise<number>
  knowledgeReextract: (id: string) => Promise<{ success: boolean; error?: string }>
  knowledgeAbortImport: () => void

  // ── Agent sessions (engines hosted in main, PLAN-0.3.5 M1.4) ──
  agentSessionCreate: (sessionId: string, opts?: AgentSessionCreateOptions) => Promise<{ sessionId: string; agentId: string; workspaceDir?: string }>
  /** `summon` is the turn's @-mention roster: one name delegates (the expert's
   *  conclusion is delivered verbatim), several enter plan mode. Absent or empty
   *  is a normal turn. */
  agentSessionAsk: (sessionId: string, content: string, summon?: SummonedExpert[], knowledgeBase?: { id: string; name: string } | null) => Promise<void>
  agentSessionCancel: (sessionId: string) => Promise<void>
  agentSessionHistory: (sessionId: string) => Promise<{ messages: unknown[]; agentId: string }>
  agentSessionHydrate: (sessionId: string, messages: unknown[], historySummary?: { text: string; firstKeptId: string } | null) => Promise<void>
  agentSessionSnapshot: (sessionId: string) => Promise<{ messages: unknown[]; status: StatusSnapshot; streamingBlocks: unknown[]; plan: unknown } | null>
  agentSessionEngineCall: (sessionId: string, method: string, args?: unknown[]) => Promise<unknown>
  agentSessionRefreshOptions: (sessionId: string) => Promise<void>
  serviceGetStatus: () => Promise<ServiceStatus>
  serviceSetEnabled: (enabled: boolean) => Promise<{ running: boolean; port: number | null }>
  serviceSetPort: (port: number) => Promise<{ running: boolean; port: number | null }>
  serviceResetToken: () => Promise<{ token: string }>
  /** Zip the built browser extension and save it through a file dialog. */
  extensionExportZip: () => Promise<{ ok: boolean; path?: string; canceled?: boolean; message?: string }>
  onAgentSessionEvent: (callback: (event: { sessionId: string; data: unknown }) => void) => () => void

  // SubAgent
  expertList: () => Promise<ExpertProfile[]>
  expertCreate: (profile: ExpertProfile) => Promise<ExpertProfile[]>
  expertUpdate: (profile: ExpertProfile) => Promise<ExpertProfile[]>
  expertDelete: (id: string) => Promise<ExpertProfile[]>
  expertReset: () => Promise<ExpertProfile[]>
}
