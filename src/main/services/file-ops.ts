/**
 * File-ops service layer (PLAN-0.3.5 M1.4①): the logic previously inlined in
 * file-ops.handler.ts closures, extracted so both the IPC handlers and the
 * main-process agent host call the same functions.
 */
import { readFile, writeFile, appendFile, stat, mkdir, readdir, unlink } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { patchContent, parseUnifiedDiff } from '../../shared/diff/patch-utils'
import { editAmbiguousError, editMissError } from '../../shared/diff/edit-similarity'
import { DATA_DIR } from '../storage'
import { getOrConvert } from '../storage/read-cache'
import { guardFsTarget, checkFsTarget, expandTilde } from '../sandbox/guard'
import { currentSessionSandbox } from '../sandbox/session-context'
import { withPathLock } from '../sandbox/write-lock'
import { getBundledRipgrepPath } from './platform-info'

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

/** One pre-split section of a multi-file diff (the renderer's parseMultiFileDiff
 *  output): each entry carries its own file and its own single-file diff text.
 *  isNew marks a `--- /dev/null` section — the file must not exist. */
export interface PatchFilesEntry {
  filePath: string
  diff: string
  isNew?: boolean
}

export interface PatchFilesResult {
  success: boolean
  /** Total hunks applied across every file. */
  replacements: number
  error?: string
  /** Per-file manifest of what the SUCCESSFUL call landed. */
  files?: Array<{ path: string; isNew: boolean }>
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
  await s(sourcePath).jpeg({ quality: 65 }).toFile(destPath)
}

async function compressBase64(data: string, destPath: string): Promise<void> {
  const s = await getSharp()
  const buffer = Buffer.from(data, 'base64')
  await s(buffer).jpeg({ quality: 65 }).toFile(destPath)
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
      path: `Error: ${err instanceof Error ? err.message : 'Unknown'}`,
    }
  }
}

export async function svcCopyFileToTmp(sourcePath: string): Promise<{ success: boolean; path: string }> {
  try {
    // The source is an arbitrary read, exactly like svcCopyFile's (review
    // 2026-09-26 中2): deny-roots apply, or a compromised renderer could
    // transcode any sharp-decodable image (private photos included) into
    // tmp/ and read the copy back over its IPC channel.
    const guard = await checkFsTarget(sourcePath, 'read')
    if (!guard.ok) return { success: false, path: `Error: ${guard.reason}` }
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
      path: `Error: ${err instanceof Error ? err.message : 'Unknown'}`,
    }
  }
}

/** Resolve user-supplied path to an absolute, normalized path (no `..` traversal). */
function resolvePath(input: string): string {
  // Same rule the guard applies (expandTilde in sandbox/guard) — the guard
  // judges THIS spelling, so the operation must land on it.
  const normalized = expandTilde(input)
  // Relative paths hang off the session workspace, in the same coordinate the
  // guard's resolveTarget judges them in (workspace-relative is the documented
  // meaning of a relative path for an agent); without a session they resolve
  // against the cwd, as before. Judgment and landing spot cannot diverge.
  const ws = currentSessionSandbox()?.workspaceDir
  const resolved = ws && !path.isAbsolute(normalized) ? path.resolve(ws, normalized) : path.resolve(normalized)
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
      sourcePath = process.platform === 'win32' ? 'file:///' + fullPath.replace(/\\/g, '/') : 'file://' + fullPath
    }
    // Strip file:// prefix for fs.
    // Windows file: URIs use file:///C:/path (strip 8 chars → C:/path)
    // Unix file: URIs use file:///path (strip 7 chars → /path)
    if (sourcePath.startsWith('file://')) {
      sourcePath = sourcePath.slice(process.platform === 'win32' ? 8 : 7)
    }
    if (!sourcePath) return { success: false, error: 'copy source is empty' }
    // Both ends are guarded, like every sibling entry in this file (review
    // 2026-09-25): the SOURCE is an arbitrary read (deny-roots apply — ~/.ssh
    // etc. must not be copyable into a workspace the model can read), and the
    // DESTINATION is an arbitrary write (baseline deny-roots for renderer
    // origins; the workspace jail when an agent session context is active).
    const srcGuard = await checkFsTarget(sourcePath, 'read')
    if (!srcGuard.ok) return { success: false, error: srcGuard.reason }
    const destGuard = await guardFsTarget(input.destination, 'write')
    if (!destGuard.ok) return { success: false, error: destGuard.reason }
    const safeDest = await resolveWritablePath(input.destination)
    // Copy is a write: create the destination's parents (the conversation
    // workspace itself is minted, not created, until the first write lands).
    await mkdir(path.dirname(safeDest), { recursive: true })
    // Read the GUARD'S resolved source, not the raw spelling: `~` expansion
    // and workspace-relative joins happen inside the guard, and the bytes must
    // come from exactly the file it judged.
    await cf(srcGuard.resolved, safeDest)
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
 *  office binary — that corrupts it. office_edit (the three editors merged)
 *  is the only writer for these formats. .pdf joins with pdf 导出:
 *  a PDF is produced by office_export (format pdf), never by text write. */
const OFFICE_BINARY_EXTS = ['.docx', '.xlsx', '.pptx', '.doc', '.xls', '.ppt', '.pdf']

function officeBinaryReject(filePath: string): string | null {
  const lower = filePath.toLowerCase()
  const ext = OFFICE_BINARY_EXTS.find((e) => lower.endsWith(e))
  if (!ext) return null
  if (ext === '.pdf') {
    return `「${ext}」是二进制格式，write/edit 会损坏它——从内容生成 PDF 用 office_export 工具（format pdf）`
  }
  return `「${ext}」是 Office 二进制格式，write/edit 会损坏它——编辑用 office_edit 工具，从内容生成新文件用 office_export 工具`
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
        // editMissError carries the closest matching region (line numbers +
        // verbatim text) so a failed edit does not cost a fresh full read —
        // a whitespace-only mismatch, the most common miss, is named as such.
        return { success: false, replacements: 0, error: editMissError(input.filePath, normalizedContent, oldStr) }
      }

      // Uniqueness gate (2026-11-01): the schema promises "must match uniquely
      // (or set multi: true)" — enforce it. This used to fall through to
      // replace(), which silently rewrote the FIRST occurrence with a
      // success-shaped result, possibly editing the wrong block.
      if (count > 1 && !input.multi) {
        return { success: false, replacements: 0, error: editAmbiguousError(input.filePath, normalizedContent, oldStr) }
      }

      const replaced = input.multi ? normalizedContent.replaceAll(oldStr, newStr) : normalizedContent.replace(oldStr, newStr)
      const newContent = isCRLF ? replaced.replace(/\n/g, '\r\n') : replaced

      if ((await statSignature(safePath)) !== before) {
        return { success: false, replacements: 0, error: STALE_FILE_ERROR }
      }
      await writeFile(safePath, newContent, 'utf-8')
      return { success: true, replacements: count }
    })
  } catch (err) {
    return {
      success: false,
      replacements: 0,
      error: err instanceof Error ? err.message : 'Unknown error',
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
      if ((await statSignature(safePath)) !== before) {
        return { success: false, replacements: 0, error: STALE_FILE_ERROR }
      }
      await writeFile(safePath, result.content!, 'utf-8')
      return { success: true, replacements: result.replacements }
    })
  } catch (err) {
    return {
      success: false,
      replacements: 0,
      error: err instanceof Error ? err.message : 'Unknown error',
    }
  }
}

/** Every hunk of a `--- /dev/null` section must be a pure addition — there is
 *  no old content to match context or removals against. Built from the + lines
 *  directly rather than patchContent('', …): applyPatch splits '' into [''],
 *  and its append-at-end splice would leave a phantom leading empty line. */
function newFileContentFromDiff(diff: string): { success: boolean; content?: string; hunks?: number; error?: string } {
  const hunks = parseUnifiedDiff(diff.replace(/\r\n/g, '\n'))
  if (hunks.length === 0) return { success: false, error: 'No valid hunks found in diff' }
  const out: string[] = []
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.startsWith('+')) out.push(l.slice(1))
      else if (l.startsWith('-') || l.startsWith(' ')) {
        return { success: false, error: 'a --- /dev/null (new file) section must contain only + lines' }
      }
    }
  }
  return { success: true, content: out.join('\n'), hunks: hunks.length }
}

/**
 * Atomic multi-file patch: apply every entry's diff or touch NOTHING.
 * Each entry is validated up front (office reject, sandbox, duplicate
 * resolution), all locks are taken in sorted order before any read (the only
 * multi-lock holder in the codebase, so sorting cannot deadlock), every patch
 * is applied in memory first, and only then are files written — a write
 * failure rolls back the entries already written from the in-memory originals.
 * One mismatching hunk anywhere rejects the whole call with the named file.
 */
export async function svcPatchFiles(input: { entries: PatchFilesEntry[] }): Promise<PatchFilesResult> {
  try {
    const entries = input.entries
    if (!Array.isArray(entries) || entries.length === 0) {
      return { success: false, replacements: 0, error: 'no file entries in the multi-file patch' }
    }
    // ── Validate every entry before anything touches disk ──
    const resolved: Array<{ safePath: string; filePath: string; diff: string; isNew: boolean }> = []
    for (const e of entries) {
      const officeReject = officeBinaryReject(e.filePath)
      if (officeReject) return { success: false, replacements: 0, error: `${e.filePath}: ${officeReject}` }
      const guard = await guardFsTarget(e.filePath, 'write')
      if (!guard.ok) return { success: false, replacements: 0, error: `${e.filePath}: ${guard.reason}` }
      const safePath = await resolveWritablePath(e.filePath)
      if (resolved.some((r) => r.safePath === safePath)) {
        return { success: false, replacements: 0, error: `duplicate file section: ${e.filePath} — one section per file in a multi-file diff` }
      }
      resolved.push({ safePath, filePath: e.filePath, diff: e.diff, isNew: e.isNew === true })
    }
    // ── Lock every path, sorted, before the first read ──
    const ordered = [...resolved].sort((a, b) => (a.safePath < b.safePath ? -1 : a.safePath > b.safePath ? 1 : 0))
    const acquire = async (i: number, fn: () => Promise<PatchFilesResult>): Promise<PatchFilesResult> =>
      i >= ordered.length ? fn() : withPathLock(ordered[i].safePath, () => acquire(i + 1, fn))
    return await acquire(0, async (): Promise<PatchFilesResult> => {
      // ── Read all originals, checking existence against isNew ──
      const originals: string[] = []
      const beforeStats: string[] = []
      for (const r of ordered) {
        if (r.isNew) {
          let exists = false
          try {
            exists = (await stat(r.safePath)).isFile()
          } catch {
            exists = false
          }
          if (exists) {
            return {
              success: false,
              replacements: 0,
              error: `${r.filePath} already exists — a --- /dev/null section only creates new files; send a normal update section for it instead`,
            }
          }
          originals.push('')
          beforeStats.push('missing')
          continue
        }
        const before = await statSignature(r.safePath)
        beforeStats.push(before)
        let content: string | null = null
        try {
          content = await readFile(r.safePath, 'utf-8')
        } catch {
          content = null
        }
        if (content === null) {
          return {
            success: false,
            replacements: 0,
            error: `${r.filePath}: file not found — an update section needs an existing file (create one with a --- /dev/null section)`,
          }
        }
        originals.push(content)
      }
      // ── Patch all in memory ──
      const patched: string[] = []
      let totalHunks = 0
      // One bad hunk holds back every other section (nothing is written); when
      // those files did not need to land together, the atomic form only turned
      // one miss into N — say so, so the retry can split instead of resending.
      const heldBack =
        ordered.length > 1
          ? ` — nothing was written: the other ${ordered.length - 1} section(s) of this diff are held back by this one (all-or-nothing). If these files need not land together, send them as separate single-file search/replace edits so one bad hunk cannot block the rest.`
          : ''
      for (let i = 0; i < ordered.length; i++) {
        const r = ordered[i]
        if (r.isNew) {
          const made = newFileContentFromDiff(r.diff)
          if (!made.success) return { success: false, replacements: 0, error: `${r.filePath}: ${made.error}${heldBack}` }
          patched.push(made.content!)
          totalHunks += made.hunks!
        } else {
          const result = patchContent(originals[i], r.diff)
          if (!result.success) return { success: false, replacements: 0, error: `${r.filePath}: ${result.error}${heldBack}` }
          patched.push(result.content!)
          totalHunks += result.replacements
        }
      }
      // ── Staleness re-check: the file each read licensed must still be the
      // same file at write time (svcPatchFile's read-modify-write window,
      // widened to the whole entry set) ──
      for (let i = 0; i < ordered.length; i++) {
        if (ordered[i].isNew) continue
        if ((await statSignature(ordered[i].safePath)) !== beforeStats[i]) {
          return { success: false, replacements: 0, error: `${ordered[i].filePath}: ${STALE_FILE_ERROR}` }
        }
      }
      // ── Write all, rolling back on the first write failure ──
      const written: number[] = []
      for (let i = 0; i < ordered.length; i++) {
        const r = ordered[i]
        try {
          if (r.isNew) await mkdir(path.dirname(r.safePath), { recursive: true })
          await writeFile(r.safePath, patched[i], 'utf-8')
          written.push(i)
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unknown error'
          for (const j of written) {
            try {
              if (ordered[j].isNew) await unlink(ordered[j].safePath)
              else await writeFile(ordered[j].safePath, originals[j], 'utf-8')
            } catch {
              /* best effort — report the original failure either way */
            }
          }
          return { success: false, replacements: 0, error: `${r.filePath}: write failed (${msg}) — files written earlier in this call were restored` }
        }
      }
      return {
        success: true,
        replacements: totalHunks,
        files: ordered.map((r) => ({ path: r.filePath, isNew: r.isNew })),
      }
    })
  } catch (err) {
    return {
      success: false,
      replacements: 0,
      error: err instanceof Error ? err.message : 'Unknown error',
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
      error: err instanceof Error ? err.message : 'Unknown error',
    }
  }
}

export async function svcConvertToMarkdown(filePath: string): Promise<{ content: string; cachePath: string; hit: boolean } | null> {
  // deny-roots 同门（full_20261011 M10-P1-2）：这是 file-ops 里唯一没有
  // checkFsTarget 的读入口——`~/.pulsemind/settings.json` 的文本可经渲染层
  // 一次 convertFileToMarkdown 读出（第一轮 UTIL_COPY_FILE 无门那条的同类
  // 残余，当时按调用点修了 copy/tmp、漏了 convert）。null 不区分「被拒」与
  // 「转换失败」维持既有返回形状，拒绝侧留一行日志可诊断。
  const guard = await checkFsTarget(filePath, 'read')
  if (!guard.ok) {
    console.warn(`[file-ops] convertToMarkdown denied: ${guard.reason}`)
    return null
  }
  try {
    return await getOrConvert(filePath)
  } catch {
    return null
  }
}

/**
 * 图片文字识别（PP-OCRv4 本地模型，无网络）。
 *
 * 与 convertToMarkdown 同过 deny-roots 门，但**不返回 null**：这个入口的调用方
 * 是 LLM，它必须能分清「路径被拒」「不是图片」「模型没装」「识别失败」——一律
 * 抛出可读原因，让 ocr 工具的 is_error 携带真实话术。
 *
 * 模型目录与扩展名判断复用提取链那一份（storage/extractors/ocr-extractor），
 * 免得工具与提取器对「什么算图片」出现两套答案。
 */
export async function svcOcrImage(filePath: string): Promise<{ text: string; lines: Array<{ text: string; score: number }>; dropped: Array<{ text: string; score: number }>; width: number; height: number; ms: number }> {
  const guard = await checkFsTarget(filePath, 'read')
  if (!guard.ok) throw new Error(`ocr denied: ${guard.reason}`)

  const { IMAGE_EXTENSIONS, MAX_OCR_BYTES } = await import('../storage/extractors/ocr-extractor')
  const ext = path.extname(guard.resolved).toLowerCase()
  if (!IMAGE_EXTENSIONS.includes(ext)) {
    throw new Error(`ocr 只接受图片（${IMAGE_EXTENSIONS.join(' / ')}），收到 "${ext || path.basename(guard.resolved)}"。文本 PDF 请用 read，扫描件 PDF 请先转成图片。`)
  }
  const size = (await stat(guard.resolved)).size
  if (size > MAX_OCR_BYTES) {
    throw new Error(`图片 ${(size / 1024 / 1024).toFixed(1)}MB，超过 OCR 上限 ${MAX_OCR_BYTES / 1024 / 1024}MB`)
  }

  const ocr = await import('./ocr')
  if (!ocr.isOcrSupported()) {
    // 开发态常见：仓库 resources/ocr-models 缺失。点名路径，别让模型去猜。
    throw new Error(`OCR 模型未安装：${ocr.resolveModelsDir()} 下缺少 det.onnx / rec.onnx / cls.onnx / keys.txt`)
  }
  const result = await ocr.recognizeImage(guard.resolved)
  return {
    text: result.text,
    lines: result.lines,
    dropped: result.dropped,
    width: result.width,
    height: result.height,
    ms: result.ms,
  }
}

export async function svcFileStat(filePath: string): Promise<{ size: number; birthtime: string; mtime: string; isDirectory: boolean } | null> {
  try {
    const guard = await checkFsTarget(filePath, 'read')
    if (!guard.ok) return null
    // Stat the guard's resolved spelling, not the raw one: a `~/…` path is not
    // a real fs path (the guard expands it; fs.stat does not, and the shell
    // read path only works because the shell does) — it used to report 0 B.
    const s = await stat(guard.resolved)
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

/** Create a directory for the workbench tree's 新建文件夹 (PLAN-project-ide
 *  刀三). Guarded as a WRITE, same baseline-deny-root semantics as the delete
 *  above — the renderer has no session jail to answer to, so the guard is the
 *  control. `recursive` lets one click materialize a nested path. */
export async function svcCreateDirectory(dirPath: string): Promise<DeletePathResult> {
  try {
    if (!path.isAbsolute(dirPath)) return { success: false, error: `Path must be absolute: ${dirPath}` }
    const guard = await guardFsTarget(dirPath, 'write')
    if (!guard.ok) return { success: false, error: guard.reason }
    const safePath = await resolveWritablePath(dirPath)
    await mkdir(safePath, { recursive: true })
    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' }
  }
}

/** Rename one entry of the workbench tree's 重命名 hover action. The name is a
 *  single segment by definition — separators and dot-names are rejected before
 *  anything touches the guard. Both endpoints are write-guarded (a rename IS a
 *  write to two paths), the new name must be free, and the old must exist. */
export async function svcRenamePath(oldPath: string, newName: string): Promise<DeletePathResult> {
  try {
    if (!path.isAbsolute(oldPath)) return { success: false, error: `Path must be absolute: ${oldPath}` }
    const name = newName.trim()
    if (!name) return { success: false, error: '名称不能为空' }
    if (name.includes('/') || name.includes('\\')) return { success: false, error: '名称不能包含路径分隔符' }
    if (name === '.' || name === '..') return { success: false, error: `非法名称：${name}` }
    const guardOld = await guardFsTarget(oldPath, 'write')
    if (!guardOld.ok) return { success: false, error: guardOld.reason }
    const safeOld = await resolveWritablePath(oldPath)
    const st = await stat(safeOld).catch(() => null)
    if (!st) return { success: false, error: '原路径不存在' }
    const safeNew = path.join(path.dirname(safeOld), name)
    if (safeNew === safeOld) return { success: true } // same name — nothing to do
    const guardNew = await guardFsTarget(safeNew, 'write')
    if (!guardNew.ok) return { success: false, error: guardNew.reason }
    const existing = await stat(safeNew).catch(() => null)
    if (existing) return { success: false, error: `同名${existing.isDirectory() ? '文件夹' : '文件'}已存在：${name}` }
    return await withPathLock(safeOld, async (): Promise<DeletePathResult> => {
      const { rename } = await import('node:fs/promises')
      await rename(safeOld, safeNew)
      return { success: true }
    })
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' }
  }
}

// ── Workspace content search (PLAN-project-ide 刀二) ────────────────────────

export interface WorkspaceSearchInput {
  query: string
  /** Absolute directory to search (the workbench passes the workspace root). */
  dir: string
  /** Default: case-insensitive (rg -i). */
  caseSensitive?: boolean
  /** Row cap — the child is KILLED once reached; rg is fast enough that the
   *  cap is what bounds both memory and latency. Default 200. */
  maxResults?: number
  /** Test seam: the rg binary path (production resolves the bundled one). */
  rgPath?: string
}

export interface WorkspaceSearchResult {
  ok: boolean
  /** rg --no-heading lines: `path:line:text` (the renderer parses them). */
  lines?: string[]
  /** True when the cap (or the timeout) cut the search short — the panel says
   *  so instead of letting a full-looking list claim completeness. */
  truncated?: boolean
  error?: string
}

/** Content search across a workspace, read-only. Reads are free in the sandbox
 *  semantics (the git service's read stance) — this is `readFile`'s class, not
 *  exec's: no confirmation dialog, because a search-as-you-type panel behind
 *  one would be unusable, and the channel spawns a FIXED argument array (the
 *  query is a single argv element, `-F` fixed-string so regex metacharacters
 *  search literally — never a shell string). rg's own defaults give the right
 *  scope for free: .gitignore respected inside repos, hidden files skipped.
 *  `.pulsemind/` (the scratch namespace) is excluded explicitly — its contents
 *  are throwaway tool offload, not project source. */
export async function svcSearchWorkspace(input: WorkspaceSearchInput): Promise<WorkspaceSearchResult> {
  const query = String(input.query ?? '')
  if (!query.trim()) return { ok: true, lines: [], truncated: false }
  if (query.length > 500) return { ok: false, error: '搜索词过长（上限 500 字符）' }
  const dir = expandTilde(String(input.dir ?? ''))
  const st = await stat(dir).catch(() => null)
  if (!st || !st.isDirectory()) return { ok: false, error: `搜索目录不存在或不是目录：${dir}` }
  const maxResults = Math.min(Math.max(Number(input.maxResults) || 200, 1), 1000)
  const rg = input.rgPath ?? getBundledRipgrepPath() ?? 'rg'
  const args = [
    '-n',
    '--no-heading',
    '-F',
    '--max-columns',
    '200',
    '--max-columns-preview',
    '--sort',
    'path',
    ...(input.caseSensitive ? [] : ['-i']),
    '-g',
    '!.pulsemind/**',
    '--',
    query,
    dir,
  ]
  return await new Promise<WorkspaceSearchResult>((resolvePromise) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(rg, args, { windowsHide: true })
    } catch (err) {
      resolvePromise({ ok: false, error: err instanceof Error ? err.message : 'rg 启动失败' })
      return
    }
    const lines: string[] = []
    let truncated = false
    let buffer = ''
    let settled = false
    const finish = (result: WorkspaceSearchResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      resolvePromise(result)
    }
    const timer = setTimeout(() => {
      truncated = true
      finish({ ok: true, lines, truncated })
    }, 15_000)
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8')
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        if (line) lines.push(line)
        if (lines.length >= maxResults) {
          truncated = true
          finish({ ok: true, lines, truncated })
          return
        }
      }
    })
    child.stderr?.on('data', () => {
      /* rg diagnostics — the rows are the truth */
    })
    child.on('error', (err: NodeJS.ErrnoException) => {
      // ENOENT = neither the bundled rg nor a PATH rg exists; say so honestly.
      finish({ ok: false, error: err.code === 'ENOENT' ? '未找到 ripgrep（rg）二进制' : err.message })
    })
    child.on('close', () => {
      if (buffer) lines.push(buffer) // final line without a trailing newline
      finish({ ok: true, lines: lines.slice(0, maxResults), truncated: truncated || lines.length >= maxResults })
    })
  })
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
