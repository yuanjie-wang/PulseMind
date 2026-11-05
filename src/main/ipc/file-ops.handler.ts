/**
 * Thin IPC registration for file operations. All logic lives in
 * services/file-ops.ts so the main-process agent host (PLAN-0.3.5 M1.4) and
 * the IPC handlers share one implementation.
 */
import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import {
  svcReadFile,
  svcReadFileBinary,
  svcWriteFile,
  svcEditFile,
  svcPatchFile,
  svcPatchFiles,
  svcConvertToMarkdown,
  svcOcrImage,
  svcSaveBase64Image,
  svcCopyFileToTmp,
  svcCopyFile,
  svcListDir,
  svcDeletePath,
  svcCreateDirectory,
  svcRenamePath,
  svcSearchWorkspace,
} from '../services/file-ops'
import { svcExportDocument } from '../services/office-export'
import { svcEditDocx } from '../services/docx-ops'
import { svcEditPptx } from '../services/pptx-ops'
import { svcEditXlsx } from '../services/xlsx-ops'
import { svcInspectOffice } from '../services/office-inspect'
import { svcReadOffice } from '../services/office-read'
import { svcSearchOffice } from '../services/office-search'
import { registerPreviewNonce } from '../preview/nonce-registry'
import { measurePreviewFrame } from '../preview/frame-measure'
import type {
  EditFileInput,
  EditFileResult,
  PatchFileInput,
  PatchFileResult,
  PatchFilesEntry,
  PatchFilesResult,
  WriteFileInput,
  WriteFileResult,
  DirEntry,
  DeletePathResult,
  WorkspaceSearchInput,
  WorkspaceSearchResult,
} from '../services/file-ops'

export type { EditFileInput, EditFileResult, PatchFileInput, PatchFileResult, WriteFileInput, WriteFileResult }

/** File-local twin of knowledge.handler's helper: wraps a service call so the
 *  raw result (or its rejection) crosses IPC unchanged. The docx/xlsx/export
 *  handlers below had been referencing this name without any definition —
 *  resolving only through esbuild's shared bundle scope, which tsc rightly
 *  rejects per-file. */
function withRawResponse<R>(fn: (...args: any[]) => R | Promise<R>) {
  return async (_event: Electron.IpcMainInvokeEvent, ...args: any[]): Promise<R> => {
    try {
      return await fn(...args)
    } catch (e) {
      console.error('[IPC] file-ops error:', e)
      throw e
    }
  }
}

export function registerFileOpsHandlers(): void {
  // ── Save base64 image to ~/.pulsemind/tmp/screenshot/ ──────────────
  ipcMain.handle(IPC_CHANNELS.UTIL_SAVE_BASE64_IMAGE, (_event, data: string) => svcSaveBase64Image(data))

  // ── Copy file to ~/.pulsemind/tmp/screenshot/ ─────────────────────
  ipcMain.handle(IPC_CHANNELS.UTIL_COPY_FILE_TO_TMP, (_event, sourcePath: string) => svcCopyFileToTmp(sourcePath))

  // ── Copy file for download (handles local-file:// + /.pulsemind/ resolution) ──
  ipcMain.handle(IPC_CHANNELS.UTIL_COPY_FILE, (_event, input: { sourceUrl?: string; destination: string }): Promise<{ success: boolean; error?: string }> =>
    svcCopyFile(input),
  )

  // ── Read file ────────────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.UTIL_READ_FILE, (_event, filePath: string) => svcReadFile(filePath))

  // ── Read file as base64 (binary formats the renderer decodes itself) ──
  ipcMain.handle(IPC_CHANNELS.UTIL_READ_FILE_BINARY, (_event, filePath: string) => svcReadFileBinary(filePath))

  // ── List one directory level (workbench 工作区 file tree) ────────
  ipcMain.handle(IPC_CHANNELS.UTIL_LIST_DIR, (_event, dirPath: string): Promise<{ entries: DirEntry[] } | null> => svcListDir(dirPath))

  // ── Delete one entry (workbench 工作区 tree hover 删除) ───────────
  ipcMain.handle(IPC_CHANNELS.UTIL_DELETE_PATH, (_event, target: string): Promise<DeletePathResult> => svcDeletePath(target))

  // ── Create a directory (workbench tree 新建文件夹, PLAN-project-ide 刀三) ──
  ipcMain.handle(IPC_CHANNELS.UTIL_CREATE_DIR, (_event, dirPath: string): Promise<DeletePathResult> => svcCreateDirectory(dirPath))

  // ── Rename one entry (workbench tree hover 重命名) ────────────────
  ipcMain.handle(IPC_CHANNELS.UTIL_RENAME_PATH, (_event, oldPath: string, newName: string): Promise<DeletePathResult> => svcRenamePath(oldPath, newName))

  // ── Workspace content search (workbench tree 内容搜索, 刀二): read-only ──
  ipcMain.handle(IPC_CHANNELS.UTIL_SEARCH_WORKSPACE, (_event, input: WorkspaceSearchInput): Promise<WorkspaceSearchResult> => svcSearchWorkspace(input))

  ipcMain.handle(IPC_CHANNELS.UTIL_EDIT_FILE, (_event, input: EditFileInput): Promise<EditFileResult> => svcEditFile(input))

  // ── Patch file (unified diff) ────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.UTIL_PATCH_FILE, (_event, input: PatchFileInput): Promise<PatchFileResult> => svcPatchFile(input))

  // ── Patch files (atomic multi-file git-style diff) ───────────────
  ipcMain.handle(IPC_CHANNELS.UTIL_PATCH_FILES, (_event, input: { entries: PatchFilesEntry[] }): Promise<PatchFilesResult> => svcPatchFiles(input))

  // ── Convert file to markdown via markitdown (cached in tmp/read-cache) ──
  ipcMain.handle(IPC_CHANNELS.UTIL_CONVERT_TO_MARKDOWN, (_event, filePath: string) => svcConvertToMarkdown(filePath))
  ipcMain.handle(IPC_CHANNELS.UTIL_OCR_IMAGE, (_event, filePath: string) => svcOcrImage(filePath))

  // ── Element-edit preview nonce (M10): per-mount secret for the served
  //    picker copy — kept in a main-process registry, never in the frame URL ──
  ipcMain.handle(IPC_CHANNELS.UTIL_REGISTER_PREVIEW_NONCE, (_event, input: { filePath: string; nonce: string }) => {
    registerPreviewNonce(input.filePath, input.nonce)
  })

  // ── Preview-frame measurement (sandboxed iframe size, optionally
  //    re-centered) — the real logic lives in main/preview/frame-measure.ts ──
  ipcMain.handle(IPC_CHANNELS.UTIL_MEASURE_PREVIEW_FRAME, (event, frameName: string, centerX?: boolean) =>
    measurePreviewFrame(event.sender, String(frameName), centerX === true),
  )

  // ── Write file (direct IPC, bypasses shell heredoc) ──────────────
  ipcMain.handle(IPC_CHANNELS.UTIL_WRITE_FILE, (_event, input: WriteFileInput): Promise<WriteFileResult> => svcWriteFile(input))
  ipcMain.handle(
    IPC_CHANNELS.UTIL_EDIT_DOCX,
    withRawResponse(async (input: { filePath: string; ops: unknown[]; workspaceDir?: string }) =>
      svcEditDocx(input as { filePath: string; ops: never[]; workspaceDir?: string }),
    ),
  )
  ipcMain.handle(
    IPC_CHANNELS.UTIL_EDIT_PPTX,
    withRawResponse(async (input: { filePath: string; ops: unknown[]; workspaceDir?: string }) =>
      svcEditPptx(input as { filePath: string; ops: never[]; workspaceDir?: string }),
    ),
  )
  ipcMain.handle(
    IPC_CHANNELS.UTIL_EDIT_XLSX,
    withRawResponse(async (input: { filePath: string; ops: unknown[]; workspaceDir?: string }) =>
      svcEditXlsx(input as { filePath: string; ops: never[]; workspaceDir?: string }),
    ),
  )
  ipcMain.handle(
    IPC_CHANNELS.UTIL_INSPECT_OFFICE,
    withRawResponse(async (input: { filePath: string }) => svcInspectOffice(input)),
  )
  ipcMain.handle(
    IPC_CHANNELS.UTIL_READ_OFFICE,
    withRawResponse(async (input: import('../../shared/office/ops').OfficeReadInput) => svcReadOffice(input)),
  )
  ipcMain.handle(
    IPC_CHANNELS.UTIL_SEARCH_OFFICE,
    withRawResponse(async (input: import('../../shared/office/ops').OfficeSearchInput) => svcSearchOffice(input)),
  )
  ipcMain.handle(
    IPC_CHANNELS.UTIL_EXPORT_DOCUMENT,
    withRawResponse(async (input: import('../services/office-export').ExportDocumentInput) => svcExportDocument(input)),
  )
}
