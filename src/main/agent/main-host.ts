/**
 * Main-process PulseHost (PLAN-0.3.5 M1.4④): implements the same capability
 * seam the renderer bridge implements, but with direct in-process calls —
 * the agent engine runs HERE, next to SQLite/MCP/terminal services, instead
 * of making an IPC round-trip per operation from the renderer.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { settingsStore } from '../storage/settings-store'
import {
  getConversation,
  saveConversation,
  appendConversationMessages,
  searchConversationsByKeyword,
  getToolResultsByIds,
  persistToolResults,
  saveConversationPlan,
  getConversationPlan,
  listConversationsForMemory,
  updateConversationSummary,
  updateConversationKeywords,
  updateConversationExtractedMsgCount,
  getConversationExtractedMsgCount,
  updateConversationExperienceExtractedCount,
  getConversationExperienceExtractedCount,
} from '../storage/conversation.db'
import { skillStore } from '../storage/skill-store'
import { expertStore } from '../storage/expert-store'
import { experienceStore } from '../storage/experience-store'
import { saveMemory, listMemories, deleteMemory, searchMemories, updateMemory, countMemoriesByType, type MemoryRow } from '../storage/memory.db'
import { applyPageOps, listMemoryPages, searchMemoryPages, touchMemoryPage } from '../storage/memory-pages-store'
import { recordSkillUse } from '../storage/skill-use-store'
import { MEMORY_MD_PATH } from '../storage'
import * as svcDocx from '../services/docx-ops'
import * as svcPptx from '../services/pptx-ops'
import * as svcXlsx from '../services/xlsx-ops'
import * as svcExport from '../services/office-export'
import { invokeGitAction } from '../git/git.service'
import { serverManager } from '../mcp/MCPServerManager'
import { persistCustomServers, validateMcpConfig } from '../ipc/mcp.handler'
import { performLlmStream, performSimpleFetch, abortLlmStream } from '../ipc/api-proxy.handler'
import { svcExecuteCommand, svcKillCommand, svcExecSync, svcExecuteBackground, svcExecLogs, svcExecKill, svcPromoteToBackground } from '../services/terminal'
import { currentSessionSandbox } from '../sandbox/session-context'
import * as fileOps from '../services/file-ops'
import * as kq from '../services/knowledge-queries'
import type { ElectronAPI } from '../../shared/types/electron-bridge'
import type { PulseHost } from '../../renderer/src/agent/host/types'
import type { MemoryEntry } from '../../shared/types/memory'
import type { KnowledgeImportResult, KnowledgeFile, KnowledgeStats, KnowledgeListResult } from '../../shared/types/knowledge'
import { browserService } from '../browser/BrowserService'
import { agentClientRegistry } from './client-registry'
import { hostedToolProxy } from './hosted/proxy'

// ── API stream event bus ─────────────────────────────────────────────
// The renderer bridge delivers stream events over IPC channels; in-process the
// engine registers the same-shaped callbacks against this bus instead.

type ApiStreamEvent =
  | { channel: 'chunk'; requestId: string; data: string }
  | { channel: 'retry'; requestId: string; attempt: number; maxRetries: number; delay: number; message: string }
  | { channel: 'error'; requestId: string; error: string }
  | { channel: 'done'; requestId: string }

const apiStreamListeners = new Set<(event: ApiStreamEvent) => void>()

function emitApiStream(event: ApiStreamEvent): void {
  for (const listener of apiStreamListeners) listener(event)
}

function onApiStreamEvent<T extends ApiStreamEvent['channel']>(channel: T, callback: (event: Extract<ApiStreamEvent, { channel: T }>) => void): () => void {
  const listener = (event: ApiStreamEvent): void => {
    if (event.channel === channel) callback(event as Extract<ApiStreamEvent, { channel: T }>)
  }
  apiStreamListeners.add(listener)
  return () => apiStreamListeners.delete(listener)
}

// ── Terminal event fan-out ───────────────────────────────────────────

type TerminalEvent =
  | { channel: 'output'; processId: string; type: 'stdout' | 'stderr'; data: string }
  | { channel: 'exit'; processId: string; code: number | null; signal: string | null }
  | { channel: 'error'; processId: string; message: string }

const terminalListeners = new Set<(event: TerminalEvent) => void>()

function emitTerminal(event: TerminalEvent): void {
  for (const listener of terminalListeners) listener(event)
}

// ── Memory row → API entry mapping (mirrors memory.handler.toMemoryEntry) ──

function toMemoryEntry(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    content: row.content,
    type: row.type,
    category: row.category,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } as MemoryEntry
}

// ── The host ─────────────────────────────────────────────────────────

export const mainHost: PulseHost = {
  // ── LLM transport ──
  apiFetchStream: (requestId, url, options) => {
    const controller = new AbortController()
    return performLlmStream(
      requestId,
      url,
      options ?? {},
      {
        onError: (error) => emitApiStream({ channel: 'error', requestId, error }),
        onRetry: (attempt, maxRetries, delay, message) => emitApiStream({ channel: 'retry', requestId, attempt, maxRetries, delay, message }),
        onChunk: (data) => emitApiStream({ channel: 'chunk', requestId, data }),
        onDone: () => emitApiStream({ channel: 'done', requestId }),
      },
      controller,
    )
  },
  apiAbortStream: async (requestId) => {
    abortLlmStream(requestId)
  },
  apiFetch: async (url, options) => performSimpleFetch(url, options ?? {}),
  onApiStreamChunk: (callback) => onApiStreamEvent('chunk', callback),
  onApiStreamError: (callback) => onApiStreamEvent('error', callback),
  onApiStreamDone: (callback) => onApiStreamEvent('done', callback),
  onApiStreamRetry: (callback) => onApiStreamEvent('retry', callback),

  // ── Terminal ──
  // shellKey = the calling engine's conversationId → its persistent shell
  // (review P0-1); the service falls back to the per-command spawn on Windows
  // and outside a session.
  executeCommand: async (command, cwd, timeoutMs, shellKey) =>
    svcExecuteCommand(command, cwd, timeoutMs, {
      output: (processId, type, data) => emitTerminal({ channel: 'output', processId, type, data }),
      exit: (processId, code, signal) => emitTerminal({ channel: 'exit', processId, code, signal }),
      error: (processId, message) => emitTerminal({ channel: 'error', processId, message }),
    }, shellKey),
  execCommandSync: (command, cwd, timeoutMs) => svcExecSync(command, cwd, timeoutMs),
  killCommand: async (processId) => {
    svcKillCommand(processId)
  },
  // Background process mode (P0-3) + session exec allowlist (P0-2). Both read
  // the ALS session context wrapped around engine entry points, so they only
  // answer inside one — outside a session the allowlist reads empty and pid
  // channels refuse (no session → nothing is ours).
  executeBackground: async (command, cwd, shellKey) => svcExecuteBackground(command, cwd, shellKey),
  execLogs: async (pid, tailBytes) => svcExecLogs(pid, tailBytes),
  execKill: async (pid) => svcExecKill(pid),
  // Foreground promotion (PLAN-background-tasks A): the engineCall path wraps
  // the dispatch in the session's ALS scope, so the promoted pid lands in the
  // session's backgroundPids and exec_logs/exec_kill answer for it.
  promoteToBackground: async (processId) => svcPromoteToBackground(processId),
  getExecAllowlist: async () => {
    const ctx = currentSessionSandbox()
    return ctx ? [...ctx.execAllowlist] : []
  },
  addExecAllowlist: async (prefix) => {
    currentSessionSandbox()?.execAllowlist.add(prefix)
  },
  onTerminalOutput: (callback) => {
    const listener = (e: TerminalEvent) => {
      if (e.channel === 'output') callback({ processId: e.processId, type: e.type, data: e.data })
    }
    terminalListeners.add(listener)
    return () => terminalListeners.delete(listener)
  },
  onTerminalExit: (callback) => {
    const listener = (e: TerminalEvent) => {
      if (e.channel === 'exit') callback({ processId: e.processId, code: e.code, signal: e.signal })
    }
    terminalListeners.add(listener)
    return () => terminalListeners.delete(listener)
  },
  onTerminalError: (callback) => {
    const listener = (e: TerminalEvent) => {
      if (e.channel === 'error') callback({ processId: e.processId, message: e.message })
    }
    terminalListeners.add(listener)
    return () => terminalListeners.delete(listener)
  },

  // ── Filesystem ──
  readFile: (filePath) => fileOps.svcReadFile(filePath),
  writeFile: (input) => fileOps.svcWriteFile(input),
  editFile: (input) => fileOps.svcEditFile(input),
  patchFile: (input) => fileOps.svcPatchFile(input),
  patchFiles: (input) => fileOps.svcPatchFiles(input),
  getFileStat: (filePath) => fileOps.svcFileStat(filePath),
  convertFileToMarkdown: (filePath) => fileOps.svcConvertToMarkdown(filePath),
  ocrImage: (filePath) => fileOps.svcOcrImage(filePath),
  copyFileToTmp: (sourcePath) => fileOps.svcCopyFileToTmp(sourcePath),
  saveBase64Image: (data) => fileOps.svcSaveBase64Image(data),

  // ── Git ──
  gitInvoke: (action) => invokeGitAction(action),

  // ── MCP ──
  mcpListServers: async () => serverManager.listServers().map((s) => ({ ...s })),
  mcpStartServer: async (id) => {
    try {
      await serverManager.start(id)
      serverManager.markAutoStart(id, true)
      await persistCustomServers()
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
  mcpRegisterServer: async (config) => {
    try {
      validateMcpConfig(config)
      const server = serverManager.register(config)
      await persistCustomServers()
      const { client: _client, ...info } = server
      return { success: true, server: info }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
  mcpUpdateServerSummary: (id, summary) => {
    serverManager.setSummary(id, summary)
    return persistCustomServers()
  },
  mcpCallTool: (serverId, toolName, args) => serverManager.callTool(serverId, toolName, args),
  onMcpServersChanged: () => {
    // v1: in-process consumers re-list on demand; no cross-window broadcast here.
    return () => {}
  },
  onSkillsChanged: () => {
    return () => {}
  },

  // ── Skills / experience / sub-agents ──
  getSkillPreferences: () => Promise.resolve(skillStore.get()),
  setSkillPreferences: async (prefs) => {
    skillStore.set(prefs)
  },
  updateSkillPreferences: async (patch) => {
    skillStore.update(patch)
  },
  readSkillRaw: (name) => Promise.resolve(skillStore.readRawContent(name)),
  installSkill: (name) => Promise.resolve(skillStore.install(name)),
  writeSkillSource: (content, expectedName) => Promise.resolve(skillStore.writeRawSkill(content, expectedName)),
  expertList: async () => expertStore.getAll(),
  listExperiences: async () => experienceStore.list(),
  saveExperienceRecord: async (draft) => experienceStore.save(draft),
  deleteExperienceRecord: async (name) => {
    experienceStore.delete(name)
  },
  readExperienceRecord: (name) => Promise.resolve(experienceStore.read(name)),
  readExperienceFile: (name, relPath) => experienceStore.readFileContent(name, relPath),
  touchExperienceRecord: async (name, outcome) => {
    experienceStore.touch(name, outcome)
  },

  // ── Memory / knowledge / conversation store ──
  saveMemory: async (data) => {
    saveMemory(data.id, data.content, data.type, data.category, data.source ?? null)
    const row = listMemories().find((m) => m.id === data.id)
    return (
      row
        ? toMemoryEntry(row)
        : {
            id: data.id,
            content: data.content,
            type: data.type,
            category: data.category,
            source: data.source ?? null,
            createdAt: '',
            updatedAt: '',
          }
    ) as MemoryEntry
  },
  searchConversationsByKeyword: async (query, limit) => searchConversationsByKeyword(query, limit),
  getToolResult: async (ids) => getToolResultsByIds(ids),
  getConversation: async (id) => getConversation(id),

  // ── Persistence ──
  saveConversation: async (conversation) => {
    saveConversation(conversation)
  },
  appendConversationMessages: async (convId, title, messages) => {
    appendConversationMessages(convId, title, messages)
  },
  persistToolResults: async (convId, results) => {
    persistToolResults(convId, results as never)
  },
  saveConversationPlan: async (id, planJson) => {
    saveConversationPlan(id, planJson)
  },
  getConversationPlan: async (id) => getConversationPlan(id),

  // ── Misc ──
  getSettings: () => settingsStore.get(),

  // ── Knowledge ──
  knowledgeAddFile: (filePaths, baseId) => kq.svcAddFile(filePaths, baseId) as Promise<KnowledgeImportResult[]>,
  knowledgeAddFolder: async (folderPath, baseId) => (await kq.svcAddFolder(folderPath, baseId)) as KnowledgeImportResult[],
  knowledgeAddUrl: async (url, baseId) => await kq.svcAddUrl(url, baseId),
  knowledgeApplyWikiChanges: async (data) => kq.svcApplyWikiChanges(data) as { written: number; logAppended: boolean; markedCompiled: number },
  knowledgeClearAll: async () => kq.svcClearAll() as { deletedRaw: number; deletedWiki: number },
  knowledgeDelete: async (id) => {
    kq.svcDelete(id)
  },
  knowledgeGetFile: async (id) => kq.svcGetFile(id) as KnowledgeFile | null,
  knowledgeGetRaw: async (relativePath) => kq.svcGetRaw(relativePath) as string,
  knowledgeGetRawPath: async (relativePath) => kq.svcGetRawPath(relativePath),
  knowledgeGetStats: async (baseId?: string) => kq.svcGetStats(baseId) as KnowledgeStats,
  knowledgeListAdvanced: async (opts) => kq.svcListAdvanced(opts) as KnowledgeListResult,
  knowledgeListFiles: async (status) => kq.svcListFiles(status) as KnowledgeFile[],
  knowledgePrepareImport: async (filePaths) => kq.svcPrepareImport(filePaths) as { existing: { id: string; filePath: string }[]; new: string[] },
  knowledgeReadWiki: async (relativePath) => kq.svcReadWiki(relativePath) as { content: string | null; files: string[] | null },
  knowledgeRebuildIndex: async () => {
    kq.svcRebuildIndex()
  },
  // svcScanFolder owns the { fileCount, filePaths } shape the bridge declares —
  // wrapping it here while the IPC handler passed the bare array through is
  // what let the desktop folder import break unnoticed.
  knowledgeScanFolder: async (folderPath) => kq.svcScanFolder(folderPath),
  knowledgeSearchContent: async (query, baseId) => kq.svcSearchContent(query, baseId),
  knowledgeSearchWiki: (query, baseId) =>
    kq.svcSearchWiki(query, baseId) as Promise<Array<{ wikiPath: string; title: string; type: string; lineNum: number; content: string }>>,
  knowledgeGetSchema: async () => kq.svcGetSchema(),
  knowledgeGetWikiDir: async () => kq.svcGetWikiDir(),
  knowledgeRebuildWiki: async () => kq.svcRebuildWiki(),
  knowledgeListBases: async () => kq.svcListBases(),
  knowledgeCreateBase: async (name: string) => kq.svcCreateBase(name),
  knowledgeRenameBase: async (id: string, name: string) => kq.svcRenameBase(id, name),
  knowledgeDeleteBase: async (id: string) => kq.svcDeleteBase(id),
  knowledgeSetFileBase: async (id: string, baseId: string) => kq.svcSetFileBase(id, baseId),
  knowledgeSetFilesBase: async (ids: string[], baseId: string) => kq.svcSetFilesBase(ids, baseId),
  knowledgeReextract: (id: string) => kq.svcReextract(id),
  editDocx: async (input: { filePath: string; ops: any[] }) =>
    svcDocx.svcEditDocx(input as { filePath: string; ops: never[] }) as Promise<
      import('../../shared/office/ops').DocxEditOutcome & { success: boolean; error?: string; backup?: string; diff?: string; changeSummary?: string }
    >,
  editPptx: async (input: { filePath: string; ops: any[] }) =>
    svcPptx.svcEditPptx(input as { filePath: string; ops: never[] }) as Promise<
      import('../../shared/office/ops').PptxEditOutcome & { success: boolean; error?: string; backup?: string; diff?: string; changeSummary?: string }
    >,
  editXlsx: async (input: { filePath: string; ops: any[] }) =>
    svcXlsx.svcEditXlsx(input as { filePath: string; ops: never[] }) as Promise<
      import('../../shared/office/ops').XlsxEditOutcome & { success: boolean; error?: string; backup?: string }
    >,
  inspectOffice: async (input: { filePath: string }) => (await import('../services/office-inspect')).svcInspectOffice(input),
  readOffice: async (input: import('../../shared/office/ops').OfficeReadInput) => (await import('../services/office-read')).svcReadOffice(input),
  searchOffice: async (input: import('../../shared/office/ops').OfficeSearchInput) => (await import('../services/office-search')).svcSearchOffice(input),
  exportDocument: async (input: {
    format: 'docx' | 'xlsx' | 'csv' | 'pptx' | 'pdf'
    content?: string
    sourcePath?: string
    htmlPath?: string
    fontSize?: number
    filePath: string
  }) => svcExport.svcExportDocument(input),
  knowledgeWriteExperience: (data) => Promise.resolve(kq.svcWriteExperience(data)),

  // ── Memory store + conversation counters ──
  countMemories: (types) => Promise.resolve(countMemoriesByType(types)),
  deleteMemory: async (id) => {
    deleteMemory(id)
  },
  getMemoryMd: () => {
    const content = existsSync(MEMORY_MD_PATH) ? readFileSync(MEMORY_MD_PATH, 'utf-8') : ''
    return Promise.resolve(content)
  },
  saveMemoryMd: (content) => {
    writeFileSync(MEMORY_MD_PATH, content, 'utf-8')
    return Promise.resolve()
  },
  listMemories: (category) => Promise.resolve(listMemories(category).map(toMemoryEntry)),
  searchMemories: async (data) => searchMemories(data.query, data.limit, data.category).map(toMemoryEntry),
  // memory pages（PLAN-memory-wiki，2026-10-25）
  listMemoryPages: (type) => Promise.resolve(listMemoryPages(type)),
  searchMemoryPages: (data) => Promise.resolve(searchMemoryPages(data).map((h) => ({ ...h.record, viaFts: h.viaFts }))),
  applyMemoryPageOps: async (ops) => applyPageOps(ops),
  touchMemoryPage: async (pageId) => touchMemoryPage(pageId),
  recordSkillUse: async (name) => recordSkillUse(name),
  updateMemory: async (id, data) => {
    updateMemory(id, data)
  },
  listConversationsForMemory: async (opts) => listConversationsForMemory(opts),
  getConversationExperienceExtractedCount: (id) => Promise.resolve(getConversationExperienceExtractedCount(id)),
  getConversationExtractedMsgCount: (id) => Promise.resolve(getConversationExtractedMsgCount(id)),
  updateConversationExperienceExtractedCount: async (id, count) => {
    updateConversationExperienceExtractedCount(id, count)
  },
  updateConversationExtractedMsgCount: async (id, count) => {
    updateConversationExtractedMsgCount(id, count)
  },
  updateConversationKeywords: async (id, keywords) => {
    updateConversationKeywords(id, keywords)
  },
  updateConversationSummary: async (id, summary) => {
    updateConversationSummary(id, summary)
  },
  // Browser Use (A-M1): in the main-process host the kernel is a direct call.
  browserRunCode: (code, opts) => {
    const scopeId = opts?.conversationId || 'unscoped'
    return browserService.runCode(code, opts?.timeoutMs, scopeId)
  },
  // Hosted page tools (PLAN-browser-extension M0.2): forwarded to the browser
  // extension currently bound to this session; rejects when none is.
  hostedToolCall: (tool, args, opts) => hostedToolProxy.call(agentClientRegistry.get(opts.sessionId), opts.sessionId, tool, args, opts.timeoutMs),
} satisfies PulseHost

// ElectronAPI import kept out of runtime: PulseHost is a structural Pick of it.
export type { ElectronAPI }
