// ── export_document service (PLAN-office-export M2) ──
// The SAME security sequence svcEditDocx uses, minus the backup step: sandbox
// guard → writable path → per-path FIFO lock → in-memory build → read-back
// gate → D6 conflict suffix → atomic tmp+rename. No backup because the backup
// protects an EXISTING file from being corrupted by an edit; an export only
// ever creates a new name (the suffix guarantees no overwrite), and a failure
// before the rename leaves zero bytes on disk by construction.

import { readFile, writeFile, rename, readdir, mkdir } from 'node:fs'
import { basename, dirname, join, extname } from 'node:path'
import { promisify } from 'node:util'
import { guardFsTarget } from '../sandbox/guard'
import { withPathLock } from '../sandbox/write-lock'
import { resolveWritablePath } from './file-ops'
import type { SheetModel } from '../office-export/md-tables'

// Every generator and read-back parser is loaded on demand: this module is
// reached at launch (ipc → file-ops → here), while the engines behind it are the
// heavy requires (exceljs ~187ms of the lot) and only a tool call needs them.
// Loading inside each branch means one export pays for its own format, not five.

const pReadFile = promisify(readFile)
const pWriteFile = promisify(writeFile)
const pRename = promisify(rename)
const pReaddir = promisify(readdir)
const pMkdir = promisify(mkdir)

export const EXPORT_FORMATS = ['docx', 'xlsx', 'csv', 'pptx', 'pdf'] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]

/** D7: inline content soft cap — beyond this the model is told to write the
 *  content to a file first and export via sourcePath instead. */
const CONTENT_LIMIT = 100 * 1024

const SOURCE_TEXT_EXTS = ['.md', '.markdown', '.mdx', '.csv', '.tsv']

export interface ExportDocumentInput {
  format: ExportFormat
  content?: string
  sourcePath?: string
  filePath: string
}

export interface ExportDocumentResult {
  success: boolean
  error?: string
  /** The absolute path the export landed on (post-suffix). */
  path?: string
  bytes?: number
}

export async function svcExportDocument(input: ExportDocumentInput): Promise<ExportDocumentResult> {
  try {
    if (!EXPORT_FORMATS.includes(input.format)) {
      return { success: false, error: `format 必须是 ${EXPORT_FORMATS.join(' / ')} 之一，收到「${input.format}」` }
    }
    const hasContent = typeof input.content === 'string' && input.content.trim() !== ''
    const hasSource = typeof input.sourcePath === 'string' && input.sourcePath.trim() !== ''
    if (hasContent === hasSource) {
      return { success: false, error: 'content 与 sourcePath 二选一：内联内容直接给 content；导出工作区已有文件给 sourcePath，不要同时给或都不给' }
    }
    if (hasContent && (input.content as string).length > CONTENT_LIMIT) {
      return { success: false, error: `内联 content 超过 100KB（${Math.round((input.content as string).length / 1024)}KB）——请先用 write 把内容写入工作区文件，再通过 sourcePath 导出` }
    }

    const guard = await guardFsTarget(input.filePath, 'write')
    if (!guard.ok) return { success: false, error: guard.reason }
    const safePath = await resolveWritablePath(input.filePath)

    return await withPathLock(safePath, async (): Promise<ExportDocumentResult> => {
      // Source input (D3): md/csv text for the generators; a real .docx when
      // the target is pdf (conversion, not generation).
      let md: string | undefined
      let csv: string | undefined
      let docxBytes: Buffer | undefined
      if (hasSource) {
        const rawSource = String(input.sourcePath)
        const ext = extname(rawSource).toLowerCase()
        if (input.format === 'pdf') {
          if (ext !== '.docx') {
            return { success: false, error: `format pdf 的 sourcePath 目前只支持 .docx（docx→PDF 转换），收到「${ext || '无扩展名'}」——markdown 内容请直接给 content` }
          }
          const docxGuard = await guardFsTarget(rawSource, 'read')
          if (!docxGuard.ok) return { success: false, error: docxGuard.reason }
          docxBytes = await pReadFile(await resolveWritablePath(rawSource))
        } else {
          if (!SOURCE_TEXT_EXTS.includes(ext)) {
            return { success: false, error: `sourcePath 仅支持文本族（${SOURCE_TEXT_EXTS.join(' / ')}），收到「${ext || '无扩展名'}」——二进制格式请直接用 read 工具转 markdown 后给 content` }
          }
          const sourceGuard = await guardFsTarget(rawSource, 'read')
          if (!sourceGuard.ok) return { success: false, error: sourceGuard.reason }
          const text = await pReadFile(await resolveWritablePath(rawSource), 'utf8')
          if (ext === '.csv' || ext === '.tsv') csv = text
          else md = text
        }
      } else {
        md = input.content
      }

      // Build entirely in memory — a failure here has written nothing.
      let buffer: Buffer
      try {
        buffer = await buildBuffer(input.format, { md, csv, docx: docxBytes })
      } catch (err) {
        return { success: false, error: `导出内容构建失败：${err instanceof Error ? err.message : String(err)}` }
      }

      // Read-back gate: the generated bytes must parse before they land.
      const gate = await readBackGate(input.format, buffer)
      if (!gate.ok) return { success: false, error: `读回门未通过（生成内容无效，未写入磁盘）：${gate.reason}` }

      // D6: never overwrite — suffix -2, -3… while the name exists.
      const finalPath = await resolveConflict(safePath)
      // Unlike edit (which implies an existing file), an export may target a
      // brand-new subdirectory — create it, same as the write tool does.
      await pMkdir(dirname(finalPath), { recursive: true })
      const tmpPath = join(dirname(finalPath), `.${basename(finalPath)}.pm-tmp`)
      await pWriteFile(tmpPath, buffer)
      await pRename(tmpPath, finalPath)
      return { success: true, path: finalPath, bytes: buffer.length }
    })
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' }
  }
}

async function buildBuffer(
  format: ExportFormat,
  source: { md?: string; csv?: string; docx?: Buffer }
): Promise<Buffer> {
  if (format === 'pdf') {
    // pdf is a CONVERSION, not a native layout: an existing docx, or markdown
    // through the docx generator first. Everything the docx format degrades
    // (images, math, footnotes) degrades identically on this path.
    const { markdownToDocxBuffer } = await import('../office-export/md-to-docx')
    const { docxToPdfBuffer } = await import('../office-export/docx-to-pdf')
    const docx = source.docx ?? (await markdownToDocxBuffer(source.md ?? source.csv ?? ''))
    return docxToPdfBuffer(docx)
  }
  if (format === 'docx') {
    const { markdownToDocxBuffer } = await import('../office-export/md-to-docx')
    return markdownToDocxBuffer(source.md ?? source.csv ?? '')
  }
  if (format === 'pptx') {
    if (source.md === undefined) throw new Error('pptx 需要 markdown 内容；CSV 数据请导出 xlsx 或 csv')
    const { markdownToPptxBuffer } = await import('../office-export/md-to-pptx')
    return markdownToPptxBuffer(source.md)
  }
  const { markdownToSheets, sheetsToXlsxBuffer } = await import('../office-export/md-tables')
  const sheets =
    source.csv !== undefined
      ? [await (await import('../office-export/csv-io')).csvToSheet(source.csv)]
      : markdownToSheets(source.md ?? '')
  if (format === 'xlsx') return sheetsToXlsxBuffer(sheets)
  // csv: CSV carries exactly one grid — the first sheet exports.
  const first: SheetModel | undefined = sheets[0]
  if (!first || first.rows.length === 0) throw new Error('没有可导出的表格（markdown 里需要至少一个表格，或给 CSV 数据）')
  return Buffer.from((await import('../office-export/csv-io')).csvFromSheet(first), 'utf8')
}

/** The generation-side counterpart of editing's structural re-tokenize: the
 *  bytes we are about to write must parse back as the format they claim. */
async function readBackGate(format: ExportFormat, buffer: Buffer): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (buffer.length === 0) return { ok: false, reason: '产物为空' }
  if (format === 'docx') {
    try {
      const AdmZip = (await import('adm-zip')).default
      const xml = new AdmZip(buffer).readAsText('word/document.xml')
      if (!xml || xml.length < 60) return { ok: false, reason: 'word/document.xml 缺失或为空' }
      return { ok: true }
    } catch (err) {
      return { ok: false, reason: `docx 解包失败：${err instanceof Error ? err.message : String(err)}` }
    }
  }
  if (format === 'xlsx') {
    try {
      const ExcelJS = (await import('exceljs')).default
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load(buffer as unknown as ArrayBuffer)
      if (wb.worksheets.length === 0) return { ok: false, reason: '工作簿没有任何 sheet' }
      return { ok: true }
    } catch (err) {
      return { ok: false, reason: `xlsx 回读失败：${err instanceof Error ? err.message : String(err)}` }
    }
  }
  if (format === 'pptx') {
    try {
      const AdmZip = (await import('adm-zip')).default
      const xml = new AdmZip(buffer).readAsText('ppt/presentation.xml')
      if (!xml || xml.length < 60) return { ok: false, reason: 'ppt/presentation.xml 缺失或为空' }
      return { ok: true }
    } catch (err) {
      return { ok: false, reason: `pptx 解包失败：${err instanceof Error ? err.message : String(err)}` }
    }
  }
  if (format === 'pdf') {
    // printToPDF's product is structurally trustworthy; the gate's job here is
    // to refuse a truncated/empty stream with a readable reason.
    const head = buffer.subarray(0, 5).toString('latin1')
    if (!head.startsWith('%PDF-')) return { ok: false, reason: `PDF 头缺失（读到「${head}」）` }
    const tail = buffer.subarray(Math.max(0, buffer.length - 1024)).toString('latin1')
    if (!tail.includes('%%EOF')) return { ok: false, reason: 'PDF 结尾缺少 %%EOF——产物不完整' }
    return { ok: true }
  }
  return { ok: true }
}

/** `报告.xlsx` exists → `报告-2.xlsx`, `-3`… — shared/workspace-naming's
 *  convention, applied to a file name. */
async function resolveConflict(target: string): Promise<string> {
  let dir: string[]
  try {
    dir = await pReaddir(dirname(target))
  } catch {
    return target
  }
  const ext = extname(target)
  const stem = basename(target).slice(0, basename(target).length - ext.length)
  const taken = new Set(dir)
  if (!taken.has(basename(target))) return target
  let n = 2
  while (taken.has(`${stem}-${n}${ext}`)) n++
  return join(dirname(target), `${stem}-${n}${ext}`)
}
