import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { Conversation, Message, TokenStats } from '../../shared/types/conversation'
import {
  listConversations,
  getConversation,
  hydrateConversation,
  saveConversation,
  appendConversationMessages,
  persistToolResults,
  updateMessageMetadata,
  deleteConversation,
  setConversationProject,
  setConversationExpert,
  setConversationApprovalMode,
  setConversationProfile,
  updateConversationTitle,
  updateConversationSummary,
  updateConversationKeywords,
  getConversationExtractedMsgCount,
  updateConversationExtractedMsgCount,
  getConversationExperienceExtractedCount,
  updateConversationExperienceExtractedCount,
  updateConversationPinned,
  touchConversation,
  listConversationsForMemory,
  searchConversationsByKeyword,
  searchMessagesByKeyword,
  getConversationLastUserMessage,
  saveConversationPlan,
  getConversationPlan,
  getToolResultsByIds,
} from '../storage/conversation.db'
import {
  getHourlyTokenStats,
  getDailyTokenStats,
  getMonthlyTokenStats
} from '../storage/stats.db'
import { getDb } from '../storage/database'
import { deleteConversationWorkspace } from '../storage/conversation-workspace'
import type { ToolResultBatchEntry } from '../../shared/types/conversation'
import type { SandboxApprovalMode } from '../../shared/sandbox/policy'
import { rememberLastUsedApprovalMode, rememberLastUsedProfileId } from '../agent/last-used-defaults'

// ── Handler wrappers (reduce try-catch boilerplate) ─────────────────────

function passThrough<T>(channel: string, fn: (...args: any[]) => T, defaultVal: T) {
  return async (_event: IpcMainInvokeEvent, ...args: any[]): Promise<T> => {
    try { return await fn(...args) }
    catch (e) { console.error(`[DB] error ${channel}:`, e); return defaultVal }
  }
}

function voidHandler(channel: string, fn: (...args: any[]) => void) {
  return async (_event: IpcMainInvokeEvent, ...args: any[]): Promise<void> => {
    try { fn(...args) }
    catch (e) { console.error(`[DB] error ${channel}:`, e) }
  }
}

// ── Slot-filling helpers ────────────────────────────────────────────────

function fillHourlySlots(
  rows: Array<{ label: string; inputTokens: number; outputTokens: number }>
): TokenStats['hourly'] {
  const now = new Date()
  const map = new Map<string, { time: string; inputTokens: number; outputTokens: number }>()
  for (const r of rows) {
    if (r.label) map.set(r.label.slice(0, 13), { time: r.label, inputTokens: r.inputTokens, outputTokens: r.outputTokens })
  }
  const slots: TokenStats['hourly'] = []
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 60 * 60 * 1000)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}`
    const label = key + ':00'
    const existing = map.get(key)
    slots.push(existing || { time: label, inputTokens: 0, outputTokens: 0 })
  }
  return slots
}

function fillDailySlots(
  rows: Array<{ label: string; inputTokens: number; outputTokens: number }>
): TokenStats['daily'] {
  const now = new Date()
  const map = new Map<string, { date: string; inputTokens: number; outputTokens: number }>()
  for (const r of rows) {
    if (r.label) map.set(r.label, { date: r.label, inputTokens: r.inputTokens, outputTokens: r.outputTokens })
  }
  const slots: TokenStats['daily'] = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const existing = map.get(key)
    slots.push(existing || { date: key, inputTokens: 0, outputTokens: 0 })
  }
  return slots
}

function fillMonthlySlots(
  rows: Array<{ label: string; inputTokens: number; outputTokens: number }>
): TokenStats['monthly'] {
  const now = new Date()
  const map = new Map<string, { month: string; inputTokens: number; outputTokens: number }>()
  for (const r of rows) {
    if (r.label) map.set(r.label, { month: r.label, inputTokens: r.inputTokens, outputTokens: r.outputTokens })
  }
  const slots: TokenStats['monthly'] = []
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const existing = map.get(key)
    slots.push(existing || { month: key, inputTokens: 0, outputTokens: 0 })
  }
  return slots
}

export function registerConversationHandlers(): void {
  // Debug: test native module directly from renderer
  ipcMain.handle(IPC_CHANNELS.DB_CHECK, async () => {
    try {
      const db = getDb()
      const row = db.prepare('SELECT sqlite_version() as v').get() as { v: string }
      return `SQLite ${row.v}, tables: conversations=${!!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversations'").get()}`
    } catch (e) {
      return `DB error: ${e}`
    }
  })

  ipcMain.handle(IPC_CHANNELS.CONVERSATION_LIST, passThrough(IPC_CHANNELS.CONVERSATION_LIST, listConversations, []))
  ipcMain.handle(IPC_CHANNELS.CONVERSATION_SET_PROJECT, (_event, id: string, projectId: string) => setConversationProject(id, projectId))
  ipcMain.handle(IPC_CHANNELS.CONVERSATION_SET_EXPERT, (_event, id: string, expertId: string | null) => setConversationExpert(id, expertId))
  // 这两扇门都带可选的 source：缺省 = 用户的选择，顺手更新「上次使用」
  // （新建会话沿用上次选择的那个全局变量）；工具工作室的首建种子
  // （useStudioSession 的 'auto'）走同一通道，但那不是用户的决定，必须带
  // 'derived' 进来，否则工作室一开就把 last-used 污染成全部允许。
  ipcMain.handle(IPC_CHANNELS.CONVERSATION_SET_APPROVAL_MODE, (_event, id: string, mode: SandboxApprovalMode, source?: 'user' | 'derived') => {
    try {
      setConversationApprovalMode(id, mode)
      if (source !== 'derived') rememberLastUsedApprovalMode(mode)
    } catch (e) { console.error(`[DB] error ${IPC_CHANNELS.CONVERSATION_SET_APPROVAL_MODE}:`, e) }
  })
  ipcMain.handle(IPC_CHANNELS.CONVERSATION_SET_PROFILE, (_event, id: string, profileId: string | null, source?: 'user' | 'derived') => {
    try {
      setConversationProfile(id, profileId)
      if (profileId && source !== 'derived') rememberLastUsedProfileId(profileId)
    } catch (e) { console.error(`[DB] error ${IPC_CHANNELS.CONVERSATION_SET_PROFILE}:`, e) }
  })
  ipcMain.handle(IPC_CHANNELS.CONVERSATION_GET, passThrough(IPC_CHANNELS.CONVERSATION_GET, getConversation, null))
  ipcMain.handle(IPC_CHANNELS.CONVERSATION_HYDRATE, passThrough(IPC_CHANNELS.CONVERSATION_HYDRATE, hydrateConversation, null))
  // The workspace flag rides ONLY the autoCleanup eviction (12h disk bound):
  // a manual delete keeps today's folder-preserving behavior — outputs the
  // user may still want stay on disk. Workspace BEFORE the row: the guard
  // reads the row's project binding and stored dir; deleteConversationWorkspace
  // is best-effort by contract (false on refusal/failure), so the row delete
  // always proceeds.
  ipcMain.handle(IPC_CHANNELS.CONVERSATION_DELETE, async (_event, id: string, opts?: { deleteWorkspace?: boolean }): Promise<void> => {
    try {
      if (opts?.deleteWorkspace) await deleteConversationWorkspace(id)
      deleteConversation(id)
    } catch (e) { console.error(`[DB] error ${IPC_CHANNELS.CONVERSATION_DELETE}:`, e) }
  })
  ipcMain.handle(IPC_CHANNELS.CONVERSATION_UPDATE_TITLE, voidHandler(IPC_CHANNELS.CONVERSATION_UPDATE_TITLE, updateConversationTitle))
  ipcMain.handle(IPC_CHANNELS.CONVERSATION_UPDATE_SUMMARY, voidHandler(IPC_CHANNELS.CONVERSATION_UPDATE_SUMMARY, updateConversationSummary))
  ipcMain.handle(IPC_CHANNELS.CONVERSATION_UPDATE_KEYWORDS, voidHandler(IPC_CHANNELS.CONVERSATION_UPDATE_KEYWORDS, updateConversationKeywords))
  ipcMain.handle(IPC_CHANNELS.CONVERSATION_GET_EXTRACTED_MSG_COUNT, passThrough(IPC_CHANNELS.CONVERSATION_GET_EXTRACTED_MSG_COUNT, getConversationExtractedMsgCount, 0))
  ipcMain.handle(IPC_CHANNELS.CONVERSATION_UPDATE_EXTRACTED_MSG_COUNT, voidHandler(IPC_CHANNELS.CONVERSATION_UPDATE_EXTRACTED_MSG_COUNT, updateConversationExtractedMsgCount))
  ipcMain.handle(IPC_CHANNELS.CONVERSATION_GET_EXPERIENCE_EXTRACTED_COUNT, passThrough(IPC_CHANNELS.CONVERSATION_GET_EXPERIENCE_EXTRACTED_COUNT, getConversationExperienceExtractedCount, 0))
  ipcMain.handle(IPC_CHANNELS.CONVERSATION_UPDATE_EXPERIENCE_EXTRACTED_COUNT, voidHandler(IPC_CHANNELS.CONVERSATION_UPDATE_EXPERIENCE_EXTRACTED_COUNT, updateConversationExperienceExtractedCount))
  ipcMain.handle(IPC_CHANNELS.CONVERSATION_LIST_FOR_MEMORY, passThrough(IPC_CHANNELS.CONVERSATION_LIST_FOR_MEMORY, listConversationsForMemory, []))
  ipcMain.handle(IPC_CHANNELS.CONVERSATION_SEARCH_KEYWORD, passThrough(IPC_CHANNELS.CONVERSATION_SEARCH_KEYWORD, (query: string, limit?: number, dateFilter?: Record<string, string>) => searchConversationsByKeyword(query, limit, dateFilter), []))
  ipcMain.handle(IPC_CHANNELS.CONVERSATION_SEARCH_MESSAGES, passThrough(IPC_CHANNELS.CONVERSATION_SEARCH_MESSAGES, (query: string, limit?: number) => searchMessagesByKeyword(query, limit), []))
  ipcMain.handle(IPC_CHANNELS.CONVERSATION_LAST_USER_MESSAGE, passThrough(IPC_CHANNELS.CONVERSATION_LAST_USER_MESSAGE, (id: string) => getConversationLastUserMessage(id), null))

  ipcMain.handle(IPC_CHANNELS.CONVERSATION_TOGGLE_PIN, voidHandler(IPC_CHANNELS.CONVERSATION_TOGGLE_PIN, (id: string, pinned: boolean) => updateConversationPinned(id, pinned)))
  ipcMain.handle(IPC_CHANNELS.CONVERSATION_TOUCH, voidHandler(IPC_CHANNELS.CONVERSATION_TOUCH, (id: string) => touchConversation(id)))

  ipcMain.handle(IPC_CHANNELS.CONVERSATION_SAVE, async (_event, conversation: Conversation) => {
    console.log(`[DB] save: ${conversation.id} "${conversation.title}" (${conversation.messages?.length || 0} msgs)`)
    try {
      saveConversation(conversation)
    } catch (e) {
      console.error('[DB] save error:', e)
    }
  })

  // Synchronous save for beforeunload — blocks until written
  ipcMain.on(IPC_CHANNELS.CONVERSATION_SAVE_SYNC, (_event, conversation: Conversation) => {
    try {
      saveConversation(conversation)
    } catch (e) {
      console.error('[DB] save-sync error:', e)
    }
  })

  // Incremental append (only new messages)
  ipcMain.handle(IPC_CHANNELS.CONVERSATION_APPEND_MESSAGES, voidHandler(
    IPC_CHANNELS.CONVERSATION_APPEND_MESSAGES,
    (convId: string, title: string, messages: Message[]) => appendConversationMessages(convId, title, messages)
  ))

  // Targeted metadata update (liked/favorited)
  ipcMain.handle(IPC_CHANNELS.CONVERSATION_UPDATE_MESSAGE_METADATA, voidHandler(
    IPC_CHANNELS.CONVERSATION_UPDATE_MESSAGE_METADATA,
    (msgId: string, data: { liked?: boolean; favorited?: boolean }) => updateMessageMetadata(msgId, data)
  ))

  // Plan persistence
  ipcMain.handle(IPC_CHANNELS.CONVERSATION_SAVE_PLAN, voidHandler(IPC_CHANNELS.CONVERSATION_SAVE_PLAN, (id: string, planJson: string | null) => saveConversationPlan(id, planJson)))
  ipcMain.handle(IPC_CHANNELS.CONVERSATION_GET_PLAN, passThrough(IPC_CHANNELS.CONVERSATION_GET_PLAN, (id: string) => getConversationPlan(id), null))

  // Tool result lookup (for tool_result_search)
  ipcMain.handle(IPC_CHANNELS.CONVERSATION_GET_TOOL_RESULT, passThrough(
    IPC_CHANNELS.CONVERSATION_GET_TOOL_RESULT,
    (ids: string[]) => getToolResultsByIds(ids),
    []
  ))

  // Batch persist tool_results (called before nanoCompact to prevent data loss)
  ipcMain.handle(IPC_CHANNELS.CONVERSATION_PERSIST_TOOL_RESULTS, async (_event, convId: string, results: ToolResultBatchEntry[]) => {
    try {
      persistToolResults(convId, results as never)
    } catch (e) {
      console.error('[DB] error persist-tool-results:', e)
    }
  })

  // Token Statistics
  ipcMain.handle(IPC_CHANNELS.CONVERSATION_TOKEN_STATS, async () => {
    try {
      const hourlyRows = getHourlyTokenStats()
      const dailyRows = getDailyTokenStats()
      const monthlyRows = getMonthlyTokenStats()
      return {
        hourly: fillHourlySlots(hourlyRows),
        daily: fillDailySlots(dailyRows),
        monthly: fillMonthlySlots(monthlyRows)
      }
    } catch (e) {
      console.error('[DB] token-stats error:', e)
      return { hourly: [], daily: [], monthly: [] }
    }
  })
}
