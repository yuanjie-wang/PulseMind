/**
 * File-ops service layer (PLAN-0.3.5 M1.4①): the logic previously inlined in
 * file-ops.handler.ts closures, extracted so both the IPC handlers and the
 * main-process agent host call the same functions.
 */
import { readFile, writeFile, appendFile, stat, mkdir, readdir, type Dirent } from 'node:fs/promises'
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
  /** 写前新鲜度校验（review 2026-09-18 M6）：调用方最后一次读到的全文。
   *  提供且文件已存在时，磁盘内容与之不等 → 拒绝写入（外部修改被保住），
   *  错误以 STALE_FILE_ERROR 开头。文件不存在时视为通过（首次创建）。 */
  expectContent?: string
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
export async function resolveWritablePath(input: string): Promise<string> {
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
    // Copy is a write: create the destination's parents (the conversation
    // workspace itself is minted, not created, until the first write lands).
    await mkdir(path.dirname(safeDest), { recursive: true })
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

/** Binary twin of svcReadFile: the renderer preview pane needs raw bytes for
 *  formats it renders itself (docx via docx-preview) — a utf-8 read would
 *  mangle them. Base64 because that is what survives the IPC structured clone
 *  as a plain string (Uint8Array would too, but base64 is the established
 *  shape for saveBase64Image / read-cache). Same read guard as svcReadFile.
 *  Stat-gated BEFORE reading (M9): a multi-GB file used to materialize a
 *  full Buffer + a base64 string in this process and again across the IPC
 *  boundary before any renderer-side gate could object. 256MB is a process
 *  guard, deliberately above the per-kind renderer gates (pdfjs 64MB), so
 *  those still deliver their own honest oversized cards for realistic files. */
const MAX_BINARY_READ_BYTES = 256 * 1024 * 1024

export async function svcReadFileBinary(filePath: string): Promise<string | null> {
  try {
    const guard = await checkFsTarget(filePath, 'read')
    if (!guard.ok) return null
    const resolved = resolvePath(filePath)
    const s = await stat(resolved)
    if (s.size > MAX_BINARY_READ_BYTES) return null
    return (await readFile(resolved)).toString('base64')
  } catch {
    return null
  }
}


/** L11 (PLAN-office-editing): text write tools must not pour text into an
 *  office binary — that corrupts it. The dedicated docx_edit / xlsx_edit
 *  tools are the only writers for these formats. .pdf joins with pdf 导出:
 *  a PDF is produced by export_document (format pdf), never by text write. */
const OFFICE_BINARY_EXTS = ['.docx', '.xlsx', '.pptx', '.doc', '.xls', '.ppt', '.pdf']

function officeBinaryReject(filePath: string): string | null {
  const lower = filePath.toLowerCase()
  const ext = OFFICE_BINARY_EXTS.find((e) => lower.endsWith(e))
  if (!ext) return null
  const tool = ext === '.docx' || ext === '.doc' ? 'docx_edit' : ext === '.xlsx' || ext === '.xls' ? 'xlsx_edit' : null
  return tool
    ? `「${ext}」是 Office 二进制格式，write/edit 会损坏它——编辑用 ${tool} 工具，从内容生成新文件用 export_document 工具`
    : ext === '.pptx'
      ? `「${ext}」是 Office 二进制格式，write/edit 会损坏它——请用 pptx_edit 编辑`
      : ext === '.pdf'
        ? `「${ext}」是二进制格式，write/edit 会损坏它——从内容生成 PDF 用 export_document 工具（format pdf）`
        : `「${ext}」是 Office 二进制格式，write/edit 会损坏它（用 docx_edit/xlsx_edit 编辑）`
}

export async function svcEditFile(input: EditFileInput): Promise<EditFileResult> {
  const officeReject = officeBinaryReject(input.filePath)
  if (officeReject) return { success: false, error: officeReject } as never as never
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
  const officeReject = officeBinaryReject(input.filePath)
  if (officeReject) return { success: false, error: officeReject } as never
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
  const officeReject = officeBinaryReject(input.filePath)
  if (officeReject) return { success: false, error: officeReject } as never
  try {

    const { content, append, expectContent } = input
    const guard = await guardFsTarget(input.filePath, 'write')
    if (!guard.ok) return { success: false, error: guard.reason }
    const safePath = await resolveWritablePath(input.filePath)
    // The lock orders concurrent appends/overwrites to one file. A full
    // overwrite carries no old_str, so staleness is opt-in: expectContent is
    // the caller's last-read text, verified INSIDE the lock (read-compare-
    // write is atomic against every writer that also goes through this lock)
    // — the preview's draft save and the element-edit patches chain from a
    // text snapshot that can be minutes old (review 2026-09-18 M6).
    return await withPathLock(safePath, async (): Promise<WriteFileResult> => {
      if (!append && expectContent !== undefined) {
        let disk: string | null = null
        try {
          disk = await readFile(safePath, 'utf-8')
        } catch {
          disk = null // file gone → first creation, nothing to clobber
        }
        if (disk !== null && disk !== expectContent) {
          return { success: false, error: `${STALE_FILE_ERROR}（文件已被外部修改，请刷新后重试）` }
        }
      }
      // A write materializes the conversation's lazily-minted workspace (and
      // any nested subdir — writeFile alone fails ENOENT on a missing parent).
      await mkdir(path.dirname(safePath), { recursive: true })
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

export async function svcFileStat(filePath: string): Promise<{ size: number; birthtime: string; mtime: string; isDirectory: boolean } | null> {
  try {
    const guard = await checkFsTarget(filePath, 'read')
    if (!guard.ok) return null
    const s = await stat(filePath)
    return { size: s.size, birthtime: s.birthtime.toISOString(), mtime: s.mtime.toISOString(), isDirectory: s.isDirectory() }
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
 *  path jail's free-read policy applies. A MISSING directory reads as empty —
 *  the conversation workspace is minted (named, persisted) at first session and
 *  only materializes at the first write, and the tree must show 工作目录为空
 *  rather than 无法读取该目录 for that normal state. Other failures (permission,
 *  EIO) are null and surface as the tree's failure hint. */
export async function svcListDir(dirPath: string): Promise<{ entries: DirEntry[] } | null> {
  try {
    const guard = await checkFsTarget(dirPath, 'read')
    if (!guard.ok) return null
    const safePath = resolvePath(dirPath)
    let dirents: Dirent[]
    try {
      dirents = await readdir(safePath, { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { entries: [] }
      throw err
    }
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
