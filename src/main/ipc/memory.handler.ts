import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { listMemories, saveMemory, deleteMemory, searchMemories, updateMemory, countMemoriesByType, type MemoryRow } from '../storage/memory.db'
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
