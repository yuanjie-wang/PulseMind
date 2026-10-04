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
import { parseDeckSpec, deckImagePaths, DECK_IMAGE_EXTS, type DeckSpec } from '../../shared/deck/spec'

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
  /** format pptx alternative to content: a structured deck spec
   *  (shared/deck/spec) — the model picks layouts, the engine draws. */
  deck?: unknown
  /** docx/pdf only: the body font size in 磅 (6–72, .5 steps). Headings and
   *  the code block scale with it; a pdf converted from an EXISTING .docx
   *  refuses it (nothing re-generates on that path). */
  fontSize?: number
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
    const hasDeck = input.deck !== undefined && input.deck !== null
    if (hasDeck && input.format !== 'pptx') {
      return { success: false, error: `deck 仅支持 format pptx，收到「${input.format}」——其他格式请给 content 或 sourcePath` }
    }
    if (hasContent && hasDeck) {
      return { success: false, error: 'deck 与 content 二选一：结构化幻灯片给 deck，markdown 大纲给 content，不要同时给' }
    }
    if (hasSource && hasDeck) {
      return { success: false, error: 'deck 与 sourcePath 二选一：结构化幻灯片直接内联给 deck，不要同时给文件路径' }
    }
    if (hasContent === hasSource && !hasDeck) {
      return { success: false, error: 'content 与 sourcePath 二选一：内联内容直接给 content；导出工作区已有文件给 sourcePath，不要同时给或都不给' }
    }
    // fontSize: docx/pdf generation only. The pdf target fed an EXISTING
    // .docx through sourcePath is a byte conversion — nothing re-generates,
    // so there is no size to set there either (say so, don't drop it silently).
    if (input.fontSize !== undefined) {
      if (input.format !== 'docx' && input.format !== 'pdf') {
        return { success: false, error: `fontSize 仅支持 format docx / pdf，收到「${input.format}」——xlsx 用 set_style、pptx 用 deck 或 office_edit 的 format_text 调字号` }
      }
      if (typeof input.fontSize !== 'number' || !Number.isFinite(input.fontSize) || input.fontSize < 6 || input.fontSize > 72) {
        return { success: false, error: `fontSize 需是 6–72 的数字（磅，可带 0.5，如 10.5=五号、12=小四、16=三号），收到「${input.fontSize}」` }
      }
      if (hasSource && extname(String(input.sourcePath)).toLowerCase() === '.docx') {
        return { success: false, error: 'format pdf 的 sourcePath 是既有 .docx 的转换，不重新生成，字号改不了——先用 office_edit 的 format_text（docx）调字号，再转 PDF' }
      }
    }
    if (hasContent && (input.content as string).length > CONTENT_LIMIT) {
      return { success: false, error: `内联 content 超过 100KB（${Math.round((input.content as string).length / 1024)}KB）——请先用 write 把内容写入工作区文件，再通过 sourcePath 导出` }
    }
    // Deck path: validate the spec and resolve every referenced image up
    // front — a deck export either lands complete or refuses with the slide
    // number that caused the refusal.
    let deckSpec: DeckSpec | undefined
    let deckImages: Map<string, Buffer> | undefined
    if (hasDeck) {
      const parsed = parseDeckSpec(input.deck)
      if (!parsed.ok) return { success: false, error: parsed.error }
      deckSpec = parsed.spec
      const deckJson = JSON.stringify(input.deck)
      if (deckJson.length > CONTENT_LIMIT) {
        return { success: false, error: `deck 序列化后超过 100KB（${Math.round(deckJson.length / 1024)}KB）——slides 太多了，拆成多份导出` }
      }
      deckImages = new Map()
      for (const { slide, path } of deckImagePaths(deckSpec)) {
        if (deckImages.has(path)) continue
        const ext = extname(path).toLowerCase()
        if (!(DECK_IMAGE_EXTS as readonly string[]).includes(ext)) {
          return { success: false, error: `deck.slides[${slide}].image：不支持的图片格式「${ext || '无扩展名'}」（支持 ${DECK_IMAGE_EXTS.join(' / ')}）` }
        }
        const imgGuard = await guardFsTarget(path, 'read')
        if (!imgGuard.ok) return { success: false, error: `deck.slides[${slide}].image：${imgGuard.reason}` }
        try {
          deckImages.set(path, await pReadFile(await resolveWritablePath(path)))
        } catch (err) {
          return { success: false, error: `deck.slides[${slide}].image：读取失败（${err instanceof Error ? err.message : String(err)}）——先确认文件在工作区里` }
        }
      }
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

      // M2 (PLAN-office-expressiveness): resolve the markdown's ![](href)
      // workspace images up front — an export either lands complete (with
      // embedded images) or refuses naming the missing file. http(s)/data:
      // refs are NOT fetched (v1); they keep the generation-side degradation.
      let mdImages: Map<string, Buffer> | undefined
      if ((input.format === 'docx' || input.format === 'pdf') && md && /!\[[^\]]*\]\(/.test(md)) {
        const { mdImagePaths } = await import('../office-export/md-to-docx')
        const paths = mdImagePaths(md)
        const httpish = paths.filter((p) => /^(https?:|data:)/i.test(p.href))
        if (httpish.length > 0) {
          return { success: false, error: `content 中的图片「${httpish[0].href}」是网络/内联地址——v1 只嵌入工作区里的图片文件（png/jpg/jpeg/gif）` }
        }
        if (paths.length > 0) {
          mdImages = new Map()
          for (const { href } of paths) {
            if (mdImages.has(href)) continue
            const ext = extname(href).toLowerCase()
            if (!(DECK_IMAGE_EXTS as readonly string[]).includes(ext)) {
              return { success: false, error: `content 中的图片「${href}」：不支持的图片格式「${ext || '无扩展名'}」（支持 ${DECK_IMAGE_EXTS.join(' / ')}）` }
            }
            const imgGuard = await guardFsTarget(href, 'read')
            if (!imgGuard.ok) return { success: false, error: `content 中的图片「${href}」：${imgGuard.reason}` }
            try {
              mdImages.set(href, await pReadFile(await resolveWritablePath(href)))
            } catch (err) {
              return { success: false, error: `content 中的图片「${href}」读取失败（${err instanceof Error ? err.message : String(err)}）——先确认文件在工作区里` }
            }
          }
        }
      }

      // Build entirely in memory — a failure here has written nothing.
      let buffer: Buffer
      try {
        buffer = await buildBuffer(input.format, { md, csv, docx: docxBytes, deck: deckSpec, deckImages, mdImages, fontSize: input.fontSize })
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
  source: { md?: string; csv?: string; docx?: Buffer; deck?: DeckSpec; deckImages?: Map<string, Buffer>; mdImages?: Map<string, Buffer>; fontSize?: number }
): Promise<Buffer> {
  if (format === 'pdf') {
    // pdf is a CONVERSION, not a native layout: an existing docx, or markdown
    // through the docx generator first. Everything the docx format degrades
    // (images, math, footnotes) degrades identically on this path.
    const { markdownToDocxBuffer } = await import('../office-export/md-to-docx')
    const { docxToPdfBuffer } = await import('../office-export/docx-to-pdf')
    const docx = source.docx ?? (await markdownToDocxBuffer(source.md ?? source.csv ?? '', source.mdImages, { fontSize: source.fontSize }))
    return docxToPdfBuffer(docx)
  }
  if (format === 'docx') {
    const { markdownToDocxBuffer } = await import('../office-export/md-to-docx')
    return markdownToDocxBuffer(source.md ?? source.csv ?? '', source.mdImages, { fontSize: source.fontSize })
  }
  if (format === 'pptx') {
    if (source.deck) {
      const { deckToPptxBuffer } = await import('../office-export/deck-to-pptx')
      return deckToPptxBuffer(source.deck, source.deckImages ?? new Map())
    }
    if (source.md === undefined) throw new Error('pptx 需要 deck 或 markdown 内容；CSV 数据请导出 xlsx 或 csv')
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
