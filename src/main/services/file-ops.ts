/**
 * File-ops service layer (PLAN-0.3.5 M1.4①): the logic previously inlined in
 * file-ops.handler.ts closures, extracted so both the IPC handlers and the
 * main-process agent host call the same functions.
 */
import { readFile, writeFile, appendFile, stat, mkdir } from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { patchContent } from '../utils/patch-utils'
import { DATA_DIR } from '../storage'
import { getOrConvert } from '../storage/read-cache'
import { guardFsTarget, checkFsTarget } from '../sandbox/guard'

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

export async function svcSaveBase64Image(data: string): Promise<{ success: boolean; path: string }> {
  try {
    const tmpDir = path.join(DATA_DIR, 'tmp', 'screenshot')
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

export async function svcCopyFileToTmp(sourcePath: string): Promise<{ success: boolean; path: string }> {
  try {
    const tmpDir = path.join(DATA_DIR, 'tmp', 'screenshot')
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

export async function svcCopyFile(input: { sourceUrl?: string; destination: string }): Promise<{ success: boolean; error?: string }> {
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

export async function svcReadFile(filePath: string): Promise<string | null> {
  try {
    const guard = await checkFsTarget(filePath, 'read')
    if (!guard.ok) return null
    return await readFile(resolvePath(filePath), 'utf-8')
  } catch {
    return null
  }
}

export async function svcEditFile(input: EditFileInput): Promise<EditFileResult> {
  try {
    const guard = await guardFsTarget(input.filePath, 'write')
    if (!guard.ok) return { success: false, replacements: 0, error: guard.reason }
    const safePath = await resolveWritablePath(input.filePath)
    const content = await readFile(safePath, 'utf-8')
    // Line-ending tolerance: model-generated old_str is always LF, but files
    // on Windows may be CRLF. Normalize for matching, then restore the file's
    // original line ending on write so the whole file stays consistent.
    const isCRLF = content.includes('\r\n')
    const normalizedContent = isCRLF ? content.replace(/\r\n/g, '\n') : content
    const oldStr = input.oldStr.replace(/\r\n/g, '\n')
    const newStr = input.newStr.replace(/\r\n/g, '\n')
    const count = normalizedContent.split(oldStr).length - 1

    if (count === 0) {
      return { success: false, replacements: 0, error: `old_str not found in ${input.filePath}` }
    }

    const replaced = input.multi
      ? normalizedContent.replaceAll(oldStr, newStr)
      : normalizedContent.replace(oldStr, newStr)
    const newContent = isCRLF ? replaced.replace(/\n/g, '\r\n') : replaced

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

export async function svcPatchFile(input: PatchFileInput): Promise<PatchFileResult> {
  try {
    const guard = await guardFsTarget(input.filePath, 'write')
    if (!guard.ok) return { success: false, replacements: 0, error: guard.reason }
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

export async function svcWriteFile(input: WriteFileInput): Promise<WriteFileResult> {
  try {
    const { content, append } = input
    const guard = await guardFsTarget(input.filePath, 'write')
    if (!guard.ok) return { success: false, error: guard.reason }
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

export async function svcConvertToMarkdown(filePath: string): Promise<{ content: string; cachePath: string; hit: boolean } | null> {
  try {
    return await getOrConvert(filePath)
  } catch {
    return null
  }
}

export async function svcFileStat(filePath: string): Promise<{ size: number; birthtime: string; mtime: string } | null> {
  try {
    const guard = await checkFsTarget(filePath, 'read')
    if (!guard.ok) return null
    const s = await stat(filePath)
    return { size: s.size, birthtime: s.birthtime.toISOString(), mtime: s.mtime.toISOString() }
  } catch {
    return null
  }
}
