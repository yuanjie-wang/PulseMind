/**
 * Thin IPC registration for file operations. All logic lives in
 * services/file-ops.ts so the main-process agent host (PLAN-0.3.5 M1.4) and
 * the IPC handlers share one implementation.
 */
import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import {
  svcReadFile,
  svcWriteFile,
  svcEditFile,
  svcPatchFile,
  svcConvertToMarkdown,
  svcSaveBase64Image,
  svcCopyFileToTmp,
  svcCopyFile,
} from '../services/file-ops'
import type {
  EditFileInput,
  EditFileResult,
  PatchFileInput,
  PatchFileResult,
  WriteFileInput,
  WriteFileResult,
} from '../services/file-ops'

export type { EditFileInput, EditFileResult, PatchFileInput, PatchFileResult, WriteFileInput, WriteFileResult }

export function registerFileOpsHandlers(): void {
  // ── Save base64 image to ~/.pulsemind/tmp/screenshot/ ──────────────
  ipcMain.handle(IPC_CHANNELS.UTIL_SAVE_BASE64_IMAGE, (_event, data: string) => svcSaveBase64Image(data))

  // ── Copy file to ~/.pulsemind/tmp/screenshot/ ─────────────────────
  ipcMain.handle(IPC_CHANNELS.UTIL_COPY_FILE_TO_TMP, (_event, sourcePath: string) => svcCopyFileToTmp(sourcePath))

  // ── Copy file for download (handles local-file:// + /.pulsemind/ resolution) ──
  ipcMain.handle(
    IPC_CHANNELS.UTIL_COPY_FILE,
    (_event, input: { sourceUrl?: string; destination: string }): Promise<{ success: boolean; error?: string }> => svcCopyFile(input),
  )

  // ── Read file ────────────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.UTIL_READ_FILE, (_event, filePath: string) => svcReadFile(filePath))

  ipcMain.handle(IPC_CHANNELS.UTIL_EDIT_FILE, (_event, input: EditFileInput): Promise<EditFileResult> => svcEditFile(input))

  // ── Patch file (unified diff) ────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.UTIL_PATCH_FILE, (_event, input: PatchFileInput): Promise<PatchFileResult> => svcPatchFile(input))

  // ── Convert file to markdown via markitdown (cached in tmp/read-cache) ──
  ipcMain.handle(IPC_CHANNELS.UTIL_CONVERT_TO_MARKDOWN, (_event, filePath: string) => svcConvertToMarkdown(filePath))

  // ── Write file (direct IPC, bypasses shell heredoc) ──────────────
  ipcMain.handle(IPC_CHANNELS.UTIL_WRITE_FILE, (_event, input: WriteFileInput): Promise<WriteFileResult> => svcWriteFile(input))
}
