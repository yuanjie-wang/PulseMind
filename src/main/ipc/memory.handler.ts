import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { listMemories, saveMemory, deleteMemory, searchMemories, updateMemory, countMemoriesByType, type MemoryRow } from '../storage/memory.db'
import {
  applyPageOps,
  touchMemoryPage,
  setMemoryPageEnabled,
  countMemoryPages,
  deleteMemoryPage,
  clearMemoryPagesByTypes,
  getMemoryPageById,
  listMemoryPages,
  pageCatalog,
  searchMemoryPages,
  type MemoryPageSearchHit,
} from '../storage/memory-pages-store'
import { listExperienceRecords } from '../storage/experience-records'
import type { MemoryPageType, PageOp, PageOpResult } from '../../shared/memory-pages'
import { MEMORY_MD_PATH } from '../storage/index'
import { withErrorLogging } from './ipc-utils'

/**
 * Wraps an IPC handler with try-catch but returns the RAW value (no {success, data} wrapper).
 * The preload bridge expects raw return values, matching the pattern used by all other handler files.
 */
function withRawResponse<R>(fn: (...args: any[]) => R | Promise<R>) {
  return async (_event: IpcMainInvokeEvent, ...args: any[]): Promise<R> => {
    try { return await fn(...args) }
    catch (e) { console.error(`[IPC] error:`, e); throw e }
  }
}

export function registerMemoryHandlers(): void {
  // ── List memories ──────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.MEMORY_LIST, withRawResponse(async (category?: string) => {
    const t0 = Date.now()
    const rows = listMemories(category)
    console.log(`[MemoryPanel] listMemories: ${Date.now() - t0}ms, ${rows.length} rows`)
    return rows.map(toMemoryEntry)
  }))

  // ── Save memory ────────────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.MEMORY_SAVE,
    withRawResponse(async (data: {
      id: string
      content: string
      type: string
      category: string
      source?: string | null
    }) => {
      saveMemory(data.id, data.content, data.type, data.category, data.source ?? null)
      return toMemoryEntry({
        id: data.id,
        content: data.content,
        type: data.type,
        category: data.category,
        source: data.source ?? null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
    })
  )

  // ── Count memories by type ─────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.MEMORY_COUNT, withRawResponse(async (types: string[]) => {
    return countMemoriesByType(types)
  }))

  // ── Update memory ──────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.MEMORY_UPDATE, withErrorLogging(async (id: string, data: { content?: string; type?: string; category?: string }) => {
    updateMemory(id, data)
  }))

  // ── Delete memory ──────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.MEMORY_DELETE, withErrorLogging(async (id: string) => {
    deleteMemory(id)
  }))

  // ── Search memories (FTS5) ─────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.MEMORY_SEARCH,
    withRawResponse(async (data: { query: string; category?: string; limit?: number }): Promise<ReturnType<typeof toMemoryEntry>[]> => {
      const rows = searchMemories(data.query, data.limit ?? 10, data.category)
      return rows.map(toMemoryEntry)
    })
  )

  // ── Get MEMORY.md content ──────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.MEMORY_GET_MD, withRawResponse(async (): Promise<string> => {
    const t0 = Date.now()
    const content = existsSync(MEMORY_MD_PATH) ? readFileSync(MEMORY_MD_PATH, 'utf-8') : ''
    console.log(`[MemoryPanel] getMemoryMd: ${Date.now() - t0}ms, ${content.length} chars`)
    return content
  }))

  // ── Save MEMORY.md (full overwrite) ────────────────────────────
  ipcMain.handle(IPC_CHANNELS.MEMORY_SAVE_MD, withErrorLogging(async (content: string): Promise<void> => {
    writeFileSync(MEMORY_MD_PATH, content, 'utf-8')
  }))

  // ── Append to MEMORY.md under a specific section heading ───────
  // The `sectionHeading` is a markdown heading like "## Facts" or "## Decisions".
  // If the heading doesn't exist, it's created before the first existing heading
  // at the same level, or appended to the end.
  ipcMain.handle(
    IPC_CHANNELS.MEMORY_APPEND_MD,
    async (_event, data: { sectionHeading: string; entry: string }): Promise<void> => {
      const { sectionHeading, entry } = data
      const indent = '  '

      if (!existsSync(MEMORY_MD_PATH)) {
        // Create new file with the section
        writeFileSync(MEMORY_MD_PATH, `${sectionHeading}\n\n${indent}- ${entry}\n`, 'utf-8')
        return
      }

      const current = readFileSync(MEMORY_MD_PATH, 'utf-8')
      const lines = current.split('\n')
      const headingPattern = new RegExp(`^${sectionHeading.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\s*$`)
      const anyHeadingPattern = /^#{1,6}\s+\S/

      let insertAt = -1

      for (let i = 0; i < lines.length; i++) {
        if (headingPattern.test(lines[i])) {
          // Found target heading — find the end of its content block
          insertAt = i + 1
          // Skip empty lines and indented list items
          while (
            insertAt < lines.length &&
            (lines[insertAt].trim() === '' || lines[insertAt].startsWith(indent) || lines[insertAt].startsWith('- '))
          ) {
            insertAt++
          }
          break
        }
      }

      if (insertAt === -1) {
        // Section heading not found — find the insertion point
        // If there are existing sections, insert before the last heading
        let lastHeadingIndex = -1
        for (let i = 0; i < lines.length; i++) {
          if (anyHeadingPattern.test(lines[i])) {
            lastHeadingIndex = i
          }
        }
        if (lastHeadingIndex >= 0) {
          // Insert before the last heading (or after the one before it)
          insertAt = lastHeadingIndex
        } else {
          // No headings at all — append to end
          insertAt = lines.length
        }
        // Insert the new section heading + entry
        const newSection = lines[insertAt] === '' ? '' : '\n'
        lines.splice(insertAt, 0, newSection, sectionHeading, '', `${indent}- ${entry}`)
      } else {
        // Insert entry at the found position
        lines.splice(insertAt, 0, `${indent}- ${entry}`)
      }

      writeFileSync(MEMORY_MD_PATH, lines.join('\n'), 'utf-8')
    }
  )
}

// --- Helper ---

interface MemoryApiEntry {
  id: string
  content: string
  type: string
  category: string
  source: string | null
  createdAt: string
  updatedAt: string
}

function toMemoryEntry(row: MemoryRow): MemoryApiEntry {
  return {
    id: row.id,
    content: row.content,
    type: row.type,
    category: row.category,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

// ── Memory pages（PLAN-memory-wiki，2026-10-25）──────────────────────

/** 检索命中（脱壳为可序列化形状；record 为完整页记录）。 */
function toSearchHit(hit: MemoryPageSearchHit) {
  return { ...hit.record, viaFts: hit.viaFts }
}

export function registerMemoryPageHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.MEMORY_PAGE_LIST, withRawResponse(async (type?: MemoryPageType) => listMemoryPages(type)))

  // 经验的真源在磁盘（~/.pulsemind/experience/），与上面的 LIST 同形不同源。
  ipcMain.handle(IPC_CHANNELS.EXPERIENCE_FILE_LIST, withRawResponse(async () => listExperienceRecords()))

  ipcMain.handle(IPC_CHANNELS.MEMORY_PAGE_GET, withRawResponse(async (id: string) => getMemoryPageById(id)))

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_PAGE_SEARCH,
    withRawResponse(async (data: { query: string; type?: MemoryPageType; limit?: number }) =>
      searchMemoryPages(data).map(toSearchHit)
    )
  )

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_PAGE_APPLY_OPS,
    withRawResponse(async (ops: PageOp[]): Promise<PageOpResult[]> => applyPageOps(ops))
  )

  ipcMain.handle(IPC_CHANNELS.MEMORY_PAGE_TOUCH, withErrorLogging(async (pageId: string) => touchMemoryPage(pageId)))

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_PAGE_SET_ENABLED,
    withErrorLogging(async (pageId: string, enabled: boolean) => setMemoryPageEnabled(pageId, enabled === true))
  )

  ipcMain.handle(IPC_CHANNELS.MEMORY_PAGE_DELETE, withErrorLogging(async (id: string) => deleteMemoryPage(id)))

  // 清空提取记忆（2026-11-12 用户裁定）：按类型整族删。
  // 经验页由调用方刻意排除在 types 之外——经验归技能中心，不随「清空记忆」消失。
  ipcMain.handle(IPC_CHANNELS.MEMORY_PAGE_CLEAR, withRawResponse(async (types: MemoryPageType[]) => clearMemoryPagesByTypes(types)))

  ipcMain.handle(IPC_CHANNELS.MEMORY_PAGE_COUNT, withRawResponse(async (type?: MemoryPageType) => countMemoryPages(type)))

  ipcMain.handle(IPC_CHANNELS.MEMORY_PAGE_CATALOG, withRawResponse(async () => pageCatalog()))
}


// ── SOP 固化（PLAN-experience-sop 刀三）：按钮 → session-manager 托管运行 ──
let sopDistillTrigger: ((pageId: string) => Promise<{ conversationId?: string; error?: string }>) | null = null
export function setSopDistillTrigger(fn: (pageId: string) => Promise<{ conversationId?: string; error?: string }>): void {
  sopDistillTrigger = fn
}
try {
  ipcMain.handle(IPC_CHANNELS.MEMORY_PAGE_DISTILL_SOP, async (_e, pageId: string): Promise<{ conversationId?: string; error?: string }> => {
    if (!sopDistillTrigger) return { error: '固化服务未就绪' }
    try { return await sopDistillTrigger(pageId) }
    catch (e) { return { error: e instanceof Error ? e.message : String(e) } }
  })
} catch { /* 模块级重复加载（探针 bundle）时静默 */ }

// ── 「立即提取」：定时清扫的手动旁路（PLAN-memory-wiki M2c）──
// 调度器宿主是 session-manager（有 managers/profile），handler 经注册的
// 回调触发；未注册（session-manager 未初始化）时如实报错。
let memorySweepTrigger: (() => Promise<number>) | null = null
export function setMemorySweepTrigger(fn: () => Promise<number>): void {
  memorySweepTrigger = fn
}
try {
  ipcMain.handle(IPC_CHANNELS.MEMORY_SWEEP_RUN, async (): Promise<{ extracted: number; error?: string }> => {
    if (!memorySweepTrigger) return { extracted: 0, error: 'sweep not ready' }
    try { return { extracted: await memorySweepTrigger() } }
    catch (e) { return { extracted: 0, error: e instanceof Error ? e.message : String(e) } }
  })
} catch { /* 模块级重复加载（探针 bundle）时静默 */ }
