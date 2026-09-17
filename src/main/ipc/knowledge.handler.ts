/**
 * Thin IPC registration for knowledge operations. All logic lives in
 * services/knowledge-queries.ts so the main-process agent host (PLAN-0.3.5
 * M1.4) and the IPC handlers share one implementation.
 */
import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import {
  svcListAdvanced,
  svcListFiles,
  svcGetFile,
  svcPrepareImport,
  svcAddFile,
  svcScanFolder,
  svcAddFolder,
  svcAddUrl,
  svcAbortImport,
  svcDelete,
  svcGetRaw,
  svcGetRawPath,
  svcReadWiki,
  svcWriteExperience,
  svcWriteFavorite,
  svcGetStats,
  svcApplyWikiChanges,
  svcRebuildIndex,
  svcSearchContent,
  svcClearAll,
  svcUpdateStatus,
  svcSearchWiki,
  svcGetSchema,
  svcGetWikiDir,
  svcReextract,
} from '../services/knowledge-queries'

function withRawResponse<R>(fn: (...args: any[]) => R | Promise<R>) {
  return async (_event: Electron.IpcMainInvokeEvent, ...args: any[]): Promise<R> => {
    try { return await fn(...args) }
    catch (e) { console.error('[IPC] knowledge error:', e); throw e }
  }
}

export function registerKnowledgeHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_LIST_ADVANCED, withRawResponse(async (opts: unknown) => svcListAdvanced(opts)))
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_LIST, withRawResponse(async (status?: string) => svcListFiles(status)))
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_GET, withRawResponse(async (id: string) => svcGetFile(id)))
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_PREPARE_IMPORT, withRawResponse(async (filePaths: string[]) => svcPrepareImport(filePaths)))
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_ADD_FILE, withRawResponse(async (filePaths: string[]) => svcAddFile(filePaths)))
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_SCAN_FOLDER, withRawResponse(async (folderPath: string) => svcScanFolder(folderPath)))
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_ADD_FOLDER, withRawResponse(async (folderPath: string) => svcAddFolder(folderPath)))
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_ADD_URL, withRawResponse(async (url: string) => svcAddUrl(url)))
  ipcMain.on(IPC_CHANNELS.KNOWLEDGE_ABORT_IMPORT, () => svcAbortImport())
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_DELETE, withRawResponse(async (id: string) => svcDelete(id)))
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_REEXTRACT, withRawResponse(async (id: string) => svcReextract(id)))
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_GET_RAW, withRawResponse(async (relativePath: string) => svcGetRaw(relativePath)))
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_GET_RAW_PATH, withRawResponse(async (relativePath: string) => svcGetRawPath(relativePath)))
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_READ_WIKI, withRawResponse(async (relativePath?: string) => svcReadWiki(relativePath)))
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_WRITE_EXPERIENCE, withRawResponse(async (data: { content: string; convId: string; title?: string }) => svcWriteExperience(data)))
  // Favorites capture: rejects on failure (no {success:false} envelope) so the
  // renderer's star stays retryable and the marker is only stamped on success.
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_WRITE_FAVORITE, withRawResponse(async (data: {
    content: string
    messageId: string
    conversationId: string
    title?: string
  }) => svcWriteFavorite(data)))
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_GET_STATS, withRawResponse(async () => svcGetStats()))
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_APPLY_WIKI_CHANGES, withRawResponse(async (data: {
    actions: { filePath: string; content: string }[]
    logEntry?: string
    compiledIds?: string[]
  }) => svcApplyWikiChanges(data)))
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_REBUILD_INDEX, withRawResponse(async () => svcRebuildIndex()))
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_SEARCH_CONTENT, withRawResponse(async (query: string) => svcSearchContent(query)))
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_CLEAR_ALL, withRawResponse(async () => svcClearAll()))
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_UPDATE_STATUS, withRawResponse(async (data: { id: string; status: 'compiled' }) => svcUpdateStatus(data)))
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_SEARCH_WIKI, withRawResponse(async (query: string) => svcSearchWiki(query)))
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_GET_SCHEMA, withRawResponse(async () => svcGetSchema()))
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_GET_WIKI_DIR, withRawResponse(async () => svcGetWikiDir()))
}
