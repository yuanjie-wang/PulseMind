import { ipcMain } from 'electron'
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { patchContent } from '../utils/patch-utils'
import { DATA_DIR } from '../storage'
import { extractWithMarkitdown } from '../storage/extractors/markitdown-extractor'

async function getSharp(): Promise<any> {
  const mod = await import('sharp')
  return mod.default || mod
}

async function compressImage(sourcePath: string, destPath: string): Promise<void> {
  const s = await getSharp()
  await s(sourcePath)
    .jpeg({ quality: 65 })
    .toFile(destPath)
}

async function compressBase64(data: string, destPath: string): Promise<void> {
  const s = await getSharp()
  const buffer = Buffer.from(data, 'base64')
  await s(buffer)
    .jpeg({ quality: 65 })
    .toFile(destPath)
}

export interface EditFileInput {
  filePath: string
  oldStr: string
  newStr: string
  multi: boolean
}

export interface EditFileResult {
  success: boolean
  replacements: number
  error?: string
}

export interface PatchFileInput {
  filePath: string
  diff: string
}

export interface PatchFileResult {
  success: boolean
  replacements: number
  error?: string
}

export interface WriteFileInput {
  filePath: string
  content: string
  append?: boolean
}

export interface WriteFileResult {
  success: boolean
  error?: string
}

/** Resolve user-supplied path to an absolute, normalized path (no `..` traversal). */
function resolvePath(input: string): string {
  // Expand ~ to home directory (path.resolve does NOT handle ~)
  const normalized = input.startsWith('~') ? path.join(os.homedir(), input.slice(1)) : input
  const resolved = path.resolve(normalized)
  // Reject paths that resolve outside the filesystem root (impossible case, but safe)
  if (!resolved.startsWith('/') && !resolved.match(/^[A-Z]:\\/i)) {
    throw new Error('Path must be absolute')
  }
  return resolved
}

/** For write operations: resolve to an absolute, normalized path. */
async function resolveWritablePath(input: string): Promise<string> {
  return resolvePath(input)
}

export function registerFileOpsHandlers(): void {
  // ── Save base64 image to ~/.pulsemind/tmp/ ─────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.UTIL_SAVE_BASE64_IMAGE,
    async (_event, data: string): Promise<{ success: boolean; path: string }> => {
      try {
        const tmpDir = path.join(DATA_DIR, 'tmp')
        await mkdir(tmpDir, { recursive: true })
        const timestamp = Date.now()
        const rand = Math.random().toString(36).slice(2, 8)
        const filename = `screenshot_${timestamp}_${rand}.jpg`
        const filePath = path.join(tmpDir, filename)
        await compressBase64(data, filePath)
        return { success: true, path: filePath }
      } catch (err) {
        return {
          success: false,
          path: `Error: ${err instanceof Error ? err.message : 'Unknown'}`
        }
      }
    }
  )

  // ── Copy file to ~/.pulsemind/tmp/ ────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.UTIL_COPY_FILE_TO_TMP,
    async (_event, sourcePath: string): Promise<{ success: boolean; path: string }> => {
      try {
        const tmpDir = path.join(DATA_DIR, 'tmp')
        await mkdir(tmpDir, { recursive: true })
        const timestamp = Date.now()
        const rand = Math.random().toString(36).slice(2, 8)
        const filename = `screenshot_${timestamp}_${rand}.jpg`
        const destPath = path.join(tmpDir, filename)
        await compressImage(sourcePath, destPath)
        return { success: true, path: destPath }
      } catch (err) {
        return {
          success: false,
          path: `Error: ${err instanceof Error ? err.message : 'Unknown'}`
        }
      }
    }
  )

  // ── Copy file for download (handles local-file:// + /.pulsemind/ resolution) ──
  ipcMain.handle(
    IPC_CHANNELS.UTIL_COPY_FILE,
    async (_event, input: { sourceUrl?: string; destination: string }): Promise<{ success: boolean; error?: string }> => {
      try {
        const { copyFile: cf } = await import('node:fs/promises')
        const { homedir } = await import('node:os')
        const { join } = await import('node:path')
        let sourcePath = input.sourceUrl || ''
        // Strip local-file:// protocol
        sourcePath = sourcePath.replace(/^local-file:/, 'file:')
        // Resolve /.pulsemind/ to ~/.pulsemind/
        if (sourcePath.startsWith('file:///.pulsemind/')) {
          const rest = sourcePath.slice('file:///.pulsemind/'.length)
          const fullPath = join(homedir(), '.pulsemind', rest)
          sourcePath = process.platform === 'win32'
            ? 'file:///' + fullPath.replace(/\\/g, '/')
            : 'file://' + fullPath
        }
        // Strip file:// prefix for fs.
        // Windows file: URIs use file:///C:/path (strip 8 chars → C:/path)
        // Unix file: URIs use file:///path (strip 7 chars → /path)
        if (sourcePath.startsWith('file://')) {
          sourcePath = sourcePath.slice(process.platform === 'win32' ? 8 : 7)
        }
        const safeDest = await resolveWritablePath(input.destination)
        await cf(sourcePath, safeDest)
        return { success: true }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Unknown' }
      }
    }
  )

  // ── Read file ────────────────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.UTIL_READ_FILE,
    async (_event, filePath: string): Promise<string | null> => {
      try {
        return await readFile(resolvePath(filePath), 'utf-8')
      } catch {
        return null
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.UTIL_EDIT_FILE,
    async (_event, input: EditFileInput): Promise<EditFileResult> => {
      try {
        const safePath = await resolveWritablePath(input.filePath)
        const content = await readFile(safePath, 'utf-8')
        const count = content.split(input.oldStr).length - 1

        if (count === 0) {
          return {
            success: false,
            replacements: 0,
            error: `old_str not found in ${input.filePath}`
          }
        }

        const newContent = input.multi
          ? content.replaceAll(input.oldStr, input.newStr)
          : content.replace(input.oldStr, input.newStr)

        await writeFile(safePath, newContent, 'utf-8')
        return { success: true, replacements: count }
      } catch (err) {
        return {
          success: false,
          replacements: 0,
          error: err instanceof Error ? err.message : 'Unknown error'
        }
      }
    }
  )

  // ── Patch file (unified diff) ────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.UTIL_PATCH_FILE,
    async (_event, input: PatchFileInput): Promise<PatchFileResult> => {
      try {
        const safePath = await resolveWritablePath(input.filePath)
        const content = await readFile(safePath, 'utf-8')
        const result = patchContent(content, input.diff)
        if (!result.success) {
          return { success: false, replacements: 0, error: result.error }
        }
        await writeFile(safePath, result.content!, 'utf-8')
        return { success: true, replacements: result.replacements }
      } catch (err) {
        return {
          success: false,
          replacements: 0,
          error: err instanceof Error ? err.message : 'Unknown error'
        }
      }
    }
  )

  // ── Convert file to markdown via markitdown ──────────────────────
  ipcMain.handle(
    IPC_CHANNELS.UTIL_CONVERT_TO_MARKDOWN,
    async (_event, filePath: string, includeFrontmatter?: boolean): Promise<string | null> => {
      try {
        const result = await extractWithMarkitdown(filePath, includeFrontmatter)
        return result?.content || null
      } catch {
        return null
      }
    }
  )

  // ── Write file (direct IPC, bypasses shell heredoc) ──────────────
  ipcMain.handle(
    IPC_CHANNELS.UTIL_WRITE_FILE,
    async (_event, input: WriteFileInput): Promise<WriteFileResult> => {
      try {
        const { content, append } = input
        const safePath = await resolveWritablePath(input.filePath)
        if (append) {
          await appendFile(safePath, content, 'utf-8')
        } else {
          await writeFile(safePath, content, 'utf-8')
        }
        return { success: true }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Unknown error'
        }
      }
    }
  )
}
