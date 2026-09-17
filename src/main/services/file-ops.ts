/**
 * File-ops service layer (PLAN-0.3.5 M1.4①): the logic previously inlined in
 * file-ops.handler.ts closures, extracted so both the IPC handlers and the
 * main-process agent host call the same functions.
 */
import { readFile, writeFile, appendFile, stat, mkdir, readdir } from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { patchContent } from '../utils/patch-utils'
import { DATA_DIR } from '../storage'
import { getOrConvert } from '../storage/read-cache'
import { guardFsTarget, checkFsTarget } from '../sandbox/guard'
import { withPathLock } from '../sandbox/write-lock'

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

/** mtime+size fingerprint of one file, for the staleness check below. */
async function statSignature(resolved: string): Promise<string> {
  try {
    const s = await stat(resolved)
    return `${s.mtimeMs}:${s.size}`
  } catch {
    return 'missing'
  }
}

/** Returned when the file changed between the read and the write of one
 *  edit/patch — deliberately actionable: the model re-reads and retries. */
const STALE_FILE_ERROR = 'file changed on disk since it was read — re-read and retry'

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
    // Read-modify-write under the per-path lock (PLAN-parallel-experts T6):
    // two experts editing one file serialize instead of silently losing one
    // side's replacement. Staleness re-check covers writers outside this
    // process (user's editor) touching the file mid-operation.
    return await withPathLock(safePath, async (): Promise<EditFileResult> => {
      const before = await statSignature(safePath)
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

      if (await statSignature(safePath) !== before) {
        return { success: false, replacements: 0, error: STALE_FILE_ERROR }
      }
      await writeFile(safePath, newContent, 'utf-8')
      return { success: true, replacements: count }
    })
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
    return await withPathLock(safePath, async (): Promise<PatchFileResult> => {
      const before = await statSignature(safePath)
      const content = await readFile(safePath, 'utf-8')
      const result = patchContent(content, input.diff)
      if (!result.success) {
        return { success: false, replacements: 0, error: result.error }
      }
      if (await statSignature(safePath) !== before) {
        return { success: false, replacements: 0, error: STALE_FILE_ERROR }
      }
      await writeFile(safePath, result.content!, 'utf-8')
      return { success: true, replacements: result.replacements }
    })
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
    // The lock orders concurrent appends/overwrites to one file; a full
    // overwrite has no read side, so no staleness check applies.
    return await withPathLock(safePath, async (): Promise<WriteFileResult> => {
      if (append) {
        await appendFile(safePath, content, 'utf-8')
      } else {
        await writeFile(safePath, content, 'utf-8')
      }
      return { success: true }
    })
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

export interface DeletePathResult {
  success: boolean
  error?: string
}

/**
 * Delete one entry of the workbench 工作区 tree (its hover 删除 button).
 *
 * Guarded as a WRITE: a renderer-initiated op carries no agent session, so the
 * jail's *baseline* deny roots apply (guard.ts) — the tree only ever passes a
 * path it just listed, but the guard is what makes that a guarantee rather
 * than a hope. Trash first: `shell.trashItem` is the platform's own delete and
 * keeps the entry recoverable, which is what a 删除 sitting next to a 复制
 * should mean; where no trash exists it throws and a real removal takes over,
 * so the click still does what it says instead of failing silently.
 */
export async function svcDeletePath(target: string): Promise<DeletePathResult> {
  try {
    // A destructive op may not guess a base directory: `resolvePath` resolves a
    // relative input against process.cwd() (the app bundle in a packaged run),
    // which is the last place a delete should ever land. Every caller here
    // passes a path it just listed, so this only ever rejects nonsense.
    if (!path.isAbsolute(target)) return { success: false, error: `Path must be absolute: ${target}` }
    const guard = await guardFsTarget(target, 'write')
    if (!guard.ok) return { success: false, error: guard.reason }
    const safePath = await resolveWritablePath(target)
    // The filesystem root is the one path a wrong click cannot undo, and no
    // surface offers it.
    if (safePath === path.parse(safePath).root) {
      return { success: false, error: `refusing to delete ${safePath}` }
    }
    // Same per-path lock as every other write: an in-flight edit of this file
    // finishes (or fails) before the file disappears under it.
    return await withPathLock(safePath, async (): Promise<DeletePathResult> => {
      const { shell } = await import('electron')
      try {
        await shell.trashItem(safePath)
      } catch {
        const { rm } = await import('node:fs/promises')
        await rm(safePath, { recursive: true })
      }
      return { success: true }
    })
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' }
  }
}

export interface DirEntry {
  name: string
  path: string
  isDir: boolean
}

/** One directory level for the workbench's 工作区 file tree: read-only, so the
 *  path jail's free-read policy applies and only existence/permission can fail
 *  (all reported as null and surfaced as an empty state by the tree). */
export async function svcListDir(dirPath: string): Promise<{ entries: DirEntry[] } | null> {
  try {
    const guard = await checkFsTarget(dirPath, 'read')
    if (!guard.ok) return null
    const safePath = resolvePath(dirPath)
    const dirents = await readdir(safePath, { withFileTypes: true })
    const entries: DirEntry[] = dirents.map((d) => ({
      name: d.name,
      path: path.join(safePath, d.name),
      isDir: d.isDirectory(),
    }))
    // Directories first, then files, each alphabetical — the tree's reading order.
    entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
    return { entries }
  } catch {
    return null
  }
}
