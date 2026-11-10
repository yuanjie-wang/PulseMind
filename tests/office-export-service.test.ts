// PLAN-office-export M2 — the export service (guard mocked exactly like
// docx-service.test.ts; better-sqlite3 is Electron-ABI and the guard drags the
// DB in) plus the wiring and cache-contract scans. Real bytes throughout:
// exports land in real temp files and are read back with the real parsers.

import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/main/sandbox/guard', async () => {
  const { normalizePathInput } = await import('../src/shared/path-input')
  return {
    // The one real rule file-ops still imports from this module: mirror
    // src/main/sandbox/guard's normalizeUserPath (URI strip + `~` → home).
    // Identity for the absolute paths these tests use.
    normalizeUserPath: (t: string) => {
      const p = normalizePathInput(t)
      return p.startsWith('~') ? join(homedir(), p.slice(1)) : p
    },
    guardFsTarget: async (target: string, mode: string) => (target.includes('deny') ? { ok: false, reason: `deny-listed (${mode})` } : { ok: true }),
  }
})

// The docx builder is spied so the read-back-gate test can feed a corrupted
// buffer through the same seam the service uses.
vi.mock('../src/main/office-export/md-to-docx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/office-export/md-to-docx')>()
  return { ...actual, markdownToDocxBuffer: vi.fn(actual.markdownToDocxBuffer) }
})

vi.mock('../src/main/office-export/docx-charts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/office-export/docx-charts')>()
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
  return { ...actual, renderChartsToPng: vi.fn(async () => [png]) }
})

// The pdf converter needs a real BrowserWindow (printToPDF) — replaced here so
// the vitest half pins the SERVICE contract (byte flow, refusals, gate,
// suffix); the real conversion is the probe's job (scripts/probe-docx-pdf.mjs).
vi.mock('../src/main/office-export/docx-to-pdf', () => ({
  docxToPdfBuffer: vi.fn(async (docx: Buffer) => Buffer.from(`%PDF-1.4\nmock-of-${docx.length}-bytes\n%%EOF\n`)),
}))

const { svcExportDocument } = await import('../src/main/services/office-export')
const { markdownToDocxBuffer } = await import('../src/main/office-export/md-to-docx')
const { docxToPdfBuffer } = await import('../src/main/office-export/docx-to-pdf')

import AdmZip from 'adm-zip'
import ExcelJS from 'exceljs'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'pm-office-export-'))
}

const MD_TABLE = '| 名称 | 数量 |\n|---|---|\n| 甲 | 12 |\n| 乙 | 007 |'

/** A real 1×1 PNG for the deck image-layout tests. */
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

describe('svcExportDocument', () => {
  it('exports a real xlsx into the workspace; numbers typed, leading zeros kept', async () => {
    const dir = tempDir()
    const result = await svcExportDocument({ format: 'xlsx', content: MD_TABLE, filePath: join(dir, '库存.xlsx') })
    expect(result.success).toBe(true)
    expect(result.bytes).toBeGreaterThan(1000)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(readFileSync(result.path!) as unknown as ArrayBuffer)
    const ws = wb.worksheets[0]
    expect(ws.getRow(2).getCell(1).value).toBe('甲')
    expect(ws.getRow(2).getCell(2).value).toBe(12)
    expect(ws.getRow(3).getCell(1).value).toBe('乙')
    expect(ws.getRow(3).getCell(2).value).toBe('007') // 前导零 → 文本
  })

  it('exports a real docx that unzips with the content in word/document.xml', async () => {
    const dir = tempDir()
    const result = await svcExportDocument({ format: 'docx', content: '# 报告\n\n中文正文。', filePath: join(dir, '报告.docx') })
    expect(result.success).toBe(true)
    const xml = new AdmZip(readFileSync(result.path!)).readAsText('word/document.xml')
    expect(xml).toContain('报告')
    expect(xml).toContain('中文正文。')
  })

  it('exports a csv whose first byte is the BOM', async () => {
    const dir = tempDir()
    const result = await svcExportDocument({ format: 'csv', content: MD_TABLE, filePath: join(dir, '库存.csv') })
    expect(result.success).toBe(true)
    const raw = readFileSync(result.path!)
    expect(raw[0]).toBe(0xef) // UTF-8 BOM lead byte
    expect(raw.toString('utf8').charCodeAt(0)).toBe(0xfeff)
  })

  it('exports via sourcePath (md → xlsx) and rejects binary-source extensions readably', async () => {
    const dir = tempDir()
    const src = join(dir, 'source.md')
    writeFileSync(src, MD_TABLE, 'utf8')
    const result = await svcExportDocument({ format: 'xlsx', sourcePath: src, filePath: join(dir, 'out.xlsx') })
    expect(result.success).toBe(true)

    const bad = await svcExportDocument({ format: 'xlsx', sourcePath: join(dir, 'image.png'), filePath: join(dir, 'out2.xlsx') })
    expect(bad.success).toBe(false)
    expect(bad.error).toContain('sourcePath')
  })

  it('input contract: both/neither content+sourcePath rejected; >100KB content redirects to sourcePath; bad format rejected', async () => {
    const dir = tempDir()
    const both = await svcExportDocument({ format: 'xlsx', content: MD_TABLE, sourcePath: join(dir, 'x.md'), filePath: join(dir, 'a.xlsx') })
    expect(both.success).toBe(false)
    expect(both.error).toContain('二选一')

    const neither = await svcExportDocument({ format: 'xlsx', filePath: join(dir, 'b.xlsx') })
    expect(neither.success).toBe(false)

    const huge = await svcExportDocument({ format: 'docx', content: 'x'.repeat(101 * 1024), filePath: join(dir, 'c.docx') })
    expect(huge.success).toBe(false)
    expect(huge.error).toContain('sourcePath')

    const badFormat = await svcExportDocument({ format: 'doc' as never, content: 'x', filePath: join(dir, 'd.doc') })
    expect(badFormat.success).toBe(false)
  })

  it('pptx: markdown becomes a real deck through the full guard chain', async () => {
    const dir = tempDir()
    const result = await svcExportDocument({
      format: 'pptx',
      content: '# 季度汇报\n\n2026 Q3\n\n## 要点\n\n- 甲\n- 乙',
      filePath: join(dir, '汇报.pptx'),
    })
    expect(result.success).toBe(true)
    const stat = statSync(result.path!)
    expect(stat.size).toBeGreaterThan(1000)
    // the read-back gate's own criterion: the bytes must unzip to a deck
    const xml = new AdmZip(readFileSync(result.path!)).readAsText('ppt/presentation.xml')
    expect(xml).toContain('sldSz')
    // conflict suffix: exporting again never overwrites
    const again = await svcExportDocument({ format: 'pptx', content: '# 另一份', filePath: join(dir, '汇报.pptx') })
    expect(again.success).toBe(true)
    expect(again.path).not.toBe(result.path)
    expect(again.path).toContain('汇报-2.pptx')
  })

  it('pptx: csv input refuses with a pointer to the right format', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 't.csv'), 'a,b\n1,2')
    const retried = await svcExportDocument({ format: 'pptx', sourcePath: join(dir, 't.csv'), filePath: join(dir, 'x.pptx') })
    expect(retried.success).toBe(false)
    expect(retried.error).toContain('xlsx')
  })

  it('a guard denial surfaces the readable reason, nothing written', async () => {
    const dir = tempDir()
    const result = await svcExportDocument({ format: 'xlsx', content: MD_TABLE, filePath: join(dir, 'deny-me.xlsx') })
    expect(result.success).toBe(false)
    expect(result.error).toContain('deny-listed')
    expect(existsSync(join(dir, 'deny-me.xlsx'))).toBe(false)
  })

  it('D6: a second export never overwrites — it lands on 报告-2.xlsx', async () => {
    const dir = tempDir()
    const first = await svcExportDocument({ format: 'xlsx', content: MD_TABLE, filePath: join(dir, '报告.xlsx') })
    expect(first.success).toBe(true)
    const firstBytes = readFileSync(first.path!)
    const second = await svcExportDocument({ format: 'xlsx', content: MD_TABLE, filePath: join(dir, '报告.xlsx') })
    expect(second.success).toBe(true)
    expect(second.path).toBe(join(dir, '报告-2.xlsx'))
    expect(existsSync(join(dir, '报告.xlsx'))).toBe(true)
    expect(readFileSync(join(dir, '报告.xlsx')).equals(firstBytes)).toBe(true)
    // no tmp litter
    expect(readdirSync(dir).some((f) => f.includes('.pm-tmp'))).toBe(false)
  })

  it('read-back gate: corrupted bytes refuse with zero disk writes', async () => {
    const dir = tempDir()
    vi.mocked(markdownToDocxBuffer).mockResolvedValueOnce(Buffer.from('this is not a zip'))
    const result = await svcExportDocument({ format: 'docx', content: '# x', filePath: join(dir, '坏.docx') })
    expect(result.success).toBe(false)
    expect(result.error).toContain('读回门')
    expect(existsSync(join(dir, '坏.docx'))).toBe(false)
  })

  it('docx embeds a workspace image the service resolved (the M2 promise — docx call site too)', async () => {
    const dir = tempDir()
    const png = join(dir, 'shot.png')
    writeFileSync(png, PNG_1PX)
    const result = await svcExportDocument({ format: 'docx', content: `![截图](${png})`, filePath: join(dir, '带图.docx') })
    expect(result.success).toBe(true)
    const zip = new AdmZip(readFileSync(result.path!))
    expect(zip.getEntries().some((e) => e.entryName.startsWith('word/media/'))).toBe(true)
  })
})

describe('svcExportDocument fontSize contract (docx/pdf generation only)', () => {
  it('a docx export lands with the requested body size; the pdf (markdown path) rides the same options', async () => {
    const dir = tempDir()
    const result = await svcExportDocument({ format: 'docx', content: '# 标题\n\n正文内容。', fontSize: 14, filePath: join(dir, '字号.docx') })
    expect(result.success).toBe(true)
    const styles = new AdmZip(readFileSync(result.path!)).readAsText('word/styles.xml')
    const docDefaults = styles.slice(styles.indexOf('<w:docDefaults>'), styles.indexOf('</w:docDefaults>'))
    expect(docDefaults).toContain('<w:sz w:val="28"/>')

    const pdf = await svcExportDocument({ format: 'pdf', content: '# 标题', fontSize: 16, filePath: join(dir, '字号.pdf') })
    expect(pdf.success).toBe(true)
    expect(vi.mocked(markdownToDocxBuffer).mock.calls.at(-1)?.[2]).toEqual({ fontSize: 16 })
  })

  it('refuses fontSize where it cannot apply (other formats) and out of range', async () => {
    const dir = tempDir()
    const xlsx = await svcExportDocument({ format: 'xlsx', content: MD_TABLE, fontSize: 14, filePath: join(dir, 'a.xlsx') })
    expect(xlsx.success).toBe(false)
    expect(xlsx.error).toContain('fontSize 仅支持 format docx / pdf')

    const huge = await svcExportDocument({ format: 'docx', content: '# x', fontSize: 500, filePath: join(dir, 'b.docx') })
    expect(huge.success).toBe(false)
    expect(huge.error).toContain('6–72')

    const notNum = await svcExportDocument({ format: 'docx', content: '# x', fontSize: '14' as unknown as number, filePath: join(dir, 'c.docx') })
    expect(notNum.success).toBe(false)
    expect(notNum.error).toContain('6–72')
  })

  it('pdf from an EXISTING .docx refuses fontSize — that path never re-generates', async () => {
    const dir = tempDir()
    const src = join(dir, '合同.docx')
    writeFileSync(src, 'not a real docx — the refusal must come before any read')
    const before = vi.mocked(docxToPdfBuffer).mock.calls.length
    const result = await svcExportDocument({ format: 'pdf', sourcePath: src, fontSize: 14, filePath: join(dir, 'out.pdf') })
    expect(result.success).toBe(false)
    expect(result.error).toContain('office_edit')
    expect(vi.mocked(docxToPdfBuffer).mock.calls.length).toBe(before)
  })
})

describe('svcExportDocument pptx generation (design route only)', () => {
  const DECK = { title: '旧调用', slides: [{ layout: 'kpi', title: '指标', items: [{ value: '1', label: 'x' }] }] }

  it('the retired deck parameter refuses with the design-route pointer, nothing written', async () => {
    const dir = tempDir()
    const result = await svcExportDocument({ format: 'pptx', deck: DECK, filePath: join(dir, 'a.pptx') })
    expect(result.success).toBe(false)
    expect(result.error).toContain('deck 参数已退役')
    expect(result.error).toContain('htmlPath')
    expect(existsSync(join(dir, 'a.pptx'))).toBe(false)
  })

  it('htmlPath is pptx-only and exclusive of content/sourcePath', async () => {
    const dir = tempDir()
    const html = join(dir, 'deck.html')
    writeFileSync(html, '<div class="slide"></div>')
    const wrongFormat = await svcExportDocument({ format: 'docx', htmlPath: html, filePath: join(dir, 'a.docx') })
    expect(wrongFormat.success).toBe(false)
    expect(wrongFormat.error).toContain('htmlPath 仅支持 format pptx')
    const withContent = await svcExportDocument({ format: 'pptx', htmlPath: html, content: '# 冲突', filePath: join(dir, 'b.pptx') })
    expect(withContent.success).toBe(false)
    expect(withContent.error).toContain('htmlPath 与 content 二选一')
    writeFileSync(join(dir, 'x.md'), '# 大纲')
    const withSource = await svcExportDocument({ format: 'pptx', htmlPath: html, sourcePath: join(dir, 'x.md'), filePath: join(dir, 'c.pptx') })
    expect(withSource.success).toBe(false)
    expect(withSource.error).toContain('htmlPath 与 sourcePath 二选一')
  })
})

describe('svcExportDocument pdf target (converter mocked; real conversion in the probe)', () => {
  it('content → markdown rides the real docx generator into the converter', async () => {
    const dir = tempDir()
    const result = await svcExportDocument({ format: 'pdf', content: '# 合同\n\n甲方：某公司。', filePath: join(dir, '合同.pdf') })
    expect(result.success).toBe(true, result.error)
    // the bytes on disk are exactly what the converter returned, gate-checked
    expect(readFileSync(result.path!).toString('latin1')).toContain('%PDF-1.4')
    // and what the converter RECEIVED was a real docx carrying the markdown
    const received = vi.mocked(docxToPdfBuffer).mock.calls.at(-1)![0] as Buffer
    const xml = new AdmZip(received).readAsText('word/document.xml')
    expect(xml).toContain('合同')
    expect(xml).toContain('甲方：某公司。')
    // PDF metadata Title fallback rides the same call: the export filename's
    // stem (the conversion page prefers the document's own first heading).
    expect(vi.mocked(docxToPdfBuffer).mock.calls.at(-1)![1]).toEqual({ title: '合同' })
  })

  it('sourcePath → an existing .docx converts byte-for-byte, not re-generated', async () => {
    const dir = tempDir()
    const docx = await svcExportDocument({ format: 'docx', content: '# 协议\n\n条款正文。', filePath: join(dir, '协议.docx') })
    expect(docx.success).toBe(true)
    vi.mocked(docxToPdfBuffer).mockClear()
    const result = await svcExportDocument({ format: 'pdf', sourcePath: docx.path!, filePath: join(dir, '协议.pdf') })
    expect(result.success).toBe(true, result.error)
    const received = vi.mocked(docxToPdfBuffer).mock.calls[0][0] as Buffer
    expect(received.equals(readFileSync(docx.path!))).toBe(true)
  })

  it('sourcePath refuses non-docx binaries with a pointer, not a corrupt attempt', async () => {
    const dir = tempDir()
    vi.mocked(docxToPdfBuffer).mockClear()
    const bad = await svcExportDocument({ format: 'pdf', sourcePath: join(dir, '表.xlsx'), filePath: join(dir, 'x.pdf') })
    expect(bad.success).toBe(false)
    expect(bad.error).toContain('.docx')
    expect(vi.mocked(docxToPdfBuffer)).not.toHaveBeenCalled()
  })

  it('read-back gate: converter garbage refuses with zero disk writes', async () => {
    const dir = tempDir()
    vi.mocked(docxToPdfBuffer).mockResolvedValueOnce(Buffer.from('not a pdf at all'))
    const result = await svcExportDocument({ format: 'pdf', content: '# x', filePath: join(dir, '坏.pdf') })
    expect(result.success).toBe(false)
    expect(result.error).toContain('读回门')
    expect(existsSync(join(dir, '坏.pdf'))).toBe(false)
  })

  it('D6 applies to pdf too: a second export lands on 合同-2.pdf', async () => {
    const dir = tempDir()
    const first = await svcExportDocument({ format: 'pdf', content: '# 一', filePath: join(dir, '合同.pdf') })
    const second = await svcExportDocument({ format: 'pdf', content: '# 二', filePath: join(dir, '合同.pdf') })
    expect(first.success).toBe(true)
    expect(second.success).toBe(true)
    expect(second.path).toBe(join(dir, '合同-2.pdf'))
    expect(readdirSync(dir).some((f) => f.includes('.pm-tmp'))).toBe(false)
  })
})

describe('export_document wiring (source scans; the unit halves live in their own files)', () => {
  it('usage lives in the tool manual, NEVER in the invariant system prompt core (cache contract)', () => {
    const fs = require('node:fs') as typeof import('node:fs')
    const read = (p: string) => fs.readFileSync(p, 'utf8')
    const core = read('src/renderer/src/agent/system-prompt-builder.ts')
    const manual = read('src/renderer/src/tools/tool-instructions.ts')
    expect(core.includes('office_export')).toBe(false)
    expect(manual).toContain('office_export')
  })

  it('the full routing chain exists: channel → handler → preload → bridge → host → main-host', () => {
    const fs = require('node:fs') as typeof import('node:fs')
    const read = (p: string) => fs.readFileSync(p, 'utf8')
    expect(read('src/shared/ipc-channels.ts')).toContain("UTIL_EXPORT_DOCUMENT: 'util:export-document'")
    const handler = read('src/main/ipc/file-ops.handler.ts')
    expect(handler).toContain('IPC_CHANNELS.UTIL_EXPORT_DOCUMENT')
    expect(handler).toContain('svcExportDocument')
    expect(read('src/preload/index.ts')).toContain('exportDocument: (input')
    expect(read('src/shared/types/electron-bridge.ts')).toContain('exportDocument: (input')
    expect(read('src/renderer/src/agent/host/types.ts')).toContain("'exportDocument'")
    expect(read('src/main/agent/main-host.ts')).toContain('exportDocument: async')
    // the text-write tools point at the dedicated tool for generation too
    expect(read('src/main/services/file-ops.ts')).toContain('office_export')
  })

  it('the design route is wired end to end and the deck route stays retired', () => {
    const fs = require('node:fs') as typeof import('node:fs')
    const read = (p: string) => fs.readFileSync(p, 'utf8')
    // the tool schema carries htmlPath (a model that never sees it never sends it)
    expect(read('src/renderer/src/tools/built-in-tools.ts')).toMatch(/htmlPath: \{ type: 'string'/)
    // the executor pre-validates the mutex BEFORE the IPC roundtrip
    const executor = read('src/renderer/src/agent/tool-executors.ts')
    expect(executor).toContain('content / sourcePath / htmlPath 三选一')
    expect(executor).toContain('htmlPath, fontSize')
    // the payload crosses preload + bridge untouched
    expect(read('src/preload/index.ts')).toMatch(/exportDocument: \(input: \{ format: string; content\?: string; sourcePath\?: string; htmlPath\?: string/)
    expect(read('src/shared/types/electron-bridge.ts')).toContain('htmlPath?: string')
    // the service refuses the retired parameter and carries no deck engine
    const service = read('src/main/services/office-export.ts')
    expect(service).toContain('deck 参数已退役')
    expect(service).not.toContain('deck-to-pptx')
    expect(service).toContain('htmlDeckToPptxBuffer')
  })

  it('fontSize is wired end to end: schema → manual → executor → bridges → service → generator', () => {
    const fs = require('node:fs') as typeof import('node:fs')
    const read = (p: string) => fs.readFileSync(p, 'utf8')
    // a model that never sees the parameter never sends it
    expect(read('src/renderer/src/tools/built-in-tools.ts')).toContain("fontSize: { type: 'number'")
    expect(read('src/renderer/src/tools/tool-instructions.ts')).toContain('fontSize: (docx/pdf only)')
    // the executor refuses before the IPC roundtrip, and passes the value through
    const executor = read('src/renderer/src/agent/tool-executors.ts')
    expect(executor).toContain('fontSize 仅支持 format docx / pdf')
    expect(executor).toMatch(/sourcePath, htmlPath, fontSize, filePath: fp/)
    // the payload crosses preload + bridge + host with the same field
    expect(read('src/preload/index.ts')).toContain('fontSize?: number')
    expect(read('src/shared/types/electron-bridge.ts')).toContain('fontSize?: number')
    expect(read('src/main/agent/main-host.ts')).toContain('fontSize?: number')
    // the service validates + threads it; the generator holds the scaling rule
    expect(read('src/main/services/office-export.ts')).toContain('input.fontSize')
    expect(read('src/main/office-export/md-to-docx.ts')).toContain('BODY_BASE_PT')
  })

  it('the pdf target is wired end to end: enum, executor, bridge, manual, converter page', () => {
    const fs = require('node:fs') as typeof import('node:fs')
    const read = (p: string) => fs.readFileSync(p, 'utf8')
    expect(read('src/renderer/src/tools/built-in-tools.ts')).toMatch(/enum: \['docx', 'xlsx', 'csv', 'pptx', 'pdf'\]/)
    expect(read('src/renderer/src/agent/tool-executors.ts')).toMatch(/\['docx', 'xlsx', 'csv', 'pptx', 'pdf'\]/)
    expect(read('src/shared/types/electron-bridge.ts')).toMatch(/'docx' \| 'xlsx' \| 'csv' \| 'pptx' \| 'pdf'/)
    expect(read('src/main/services/office-export.ts')).toMatch(/\['docx', 'xlsx', 'csv', 'pptx', 'pdf'\]/)
    const manual = read('src/renderer/src/tools/tool-instructions.ts')
    expect(manual).toContain('format pdf')
    expect(manual).toContain('libreoffice')
    // the text-write refusal points .pdf at the export tool (L11)
    expect(read('src/main/services/file-ops.ts')).toContain("'.pdf'")
  })

  it('the docx2pdf converter page is built and its handshake matches the main converter', () => {
    const fs = require('node:fs') as typeof import('node:fs')
    const read = (p: string) => fs.readFileSync(p, 'utf8')
    // build pipeline: the page is a build target and its html is copied
    const buildScript = read('scripts/build.js')
    expect(buildScript).toContain("'src/renderer/docx2pdf/index.ts'")
    expect(buildScript).toContain("copyFileSync('src/renderer/docx2pdf/index.html'")
    expect(fs.existsSync('src/renderer/docx2pdf/index.html')).toBe(true)
    expect(read('src/renderer/docx2pdf/index.html')).toContain('./index.js')
    // the handshake keys must exist on BOTH ends — a rename on one side only
    // would leave the main process polling a global the page never writes
    for (const key of ['__pmDocxSource', '__pmDocx2Pdf']) {
      expect(read('src/renderer/docx2pdf/index.ts')).toContain(key)
      expect(read('src/main/office-export/docx-to-pdf.ts')).toContain(key)
    }
  })

  it('the converter page runs the shared preview passes, then the print-only ones', () => {
    const fs = require('node:fs') as typeof import('node:fs')
    const page = fs.readFileSync('src/renderer/docx2pdf/index.ts', 'utf8')
    // The in-app preview and the PDF must paginate the same way: both import
    // the SAME passes (a local re-implementation is how they drift apart).
    expect(page).toContain('docxFontCss')
    expect(page).toContain('paginateDocxPages')
    expect(fs.readFileSync('src/renderer/src/components/preview/DocxPreview.tsx', 'utf8')).toContain('paginateDocxPages')
    // Print-only passes: real headings feed Chromium's PDF outline, folios are
    // the page numbers docx-preview never draws, title feeds the metadata.
    for (const fn of ['promoteHeadings', 'addPageNumbers', 'applyDocumentTitle', '__pmDocxTitle']) {
      expect(page).toContain(fn)
    }
    // Running order is load-bearing: promote renames `p.docx_headingN` and
    // rewrites the generated selectors, so pagination must measure AFTER it.
    const promoteAt = page.indexOf('promoteHeadings(root)')
    const paginateAt = page.indexOf('paginateDocxPages(root')
    expect(promoteAt).toBeGreaterThan(-1)
    expect(paginateAt).toBeGreaterThan(promoteAt)
    expect(page).toContain('@page { size:')
    const main = fs.readFileSync('src/main/office-export/docx-to-pdf.ts', 'utf8')
    expect(main).toContain('generateDocumentOutline: true')
    expect(main).toContain('generateTaggedPDF: true')
    // The service threads the filename stem in as the Title fallback.
    expect(fs.readFileSync('src/main/services/office-export.ts', 'utf8')).toContain('title: basename(safePath, extname(safePath))')
  })
})

describe('svcExportDocument — docx frontmatter rides content (PLAN-docx-native-styles)', () => {
  it('frontmatter passes through the service untouched: cover/header/footer land in the real file', async () => {
    const dir = tempDir()
    const result = await svcExportDocument({
      format: 'docx',
      content: '---\ntitle: 服务层直通\nheader: 内部资料\nfooter: page\n---\n\n# 服务层直通\n\n正文。',
      filePath: join(dir, '设计.docx'),
    })
    expect(result.success).toBe(true)
    const zip = new AdmZip(readFileSync(result.path!))
    expect(zip.readAsText('word/header1.xml')).toContain('内部资料')
    expect(zip.readAsText('word/footer1.xml')).toContain('PAGE')
    expect(zip.readAsText('word/document.xml')).toContain('服务层直通')
  })
})

describe('svcExportDocument — ```chart fences (M9)', () => {
  const FENCE = (body: string) => '```chart\n' + body + '\n```'
  const GOOD = FENCE('{"type": "column", "categories": ["一月", "二月"], "series": [{"name": "营收", "values": [12, 30]}]}')

  it('a valid chart fence embeds the rasterized PNG (renderChartsToPng at the DI seam)', async () => {
    const dir = tempDir()
    const result = await svcExportDocument({ format: 'docx', content: '图：\n\n' + GOOD, filePath: join(dir, '图表.docx') })
    expect(result.success).toBe(true)
    const zip = new AdmZip(readFileSync(result.path!))
    expect(zip.readAsText('word/document.xml')).toContain('<w:drawing>')
    // docx 库按内容哈希命名媒体（word/media/<hash>.png），断言「有一张 png」而非具体名
    expect(zip.getEntries().some((e) => e.entryName.startsWith('word/media/') && e.entryName.endsWith('.png'))).toBe(true)
  })

  it('bad JSON refuses naming the fence; spec violations carry the validator message', async () => {
    const dir = tempDir()
    const badJson = await svcExportDocument({ format: 'docx', content: FENCE('{not json'), filePath: join(dir, '坏.json.docx') })
    expect(badJson.success).toBe(false)
    expect(badJson.error).toContain('第 1 个 chart 围栏')
    expect(badJson.error).toContain('JSON 解析失败')
    const badSpec = await svcExportDocument({
      format: 'docx',
      content: FENCE('{"type": "pie", "categories": ["甲", "乙"], "series": [{"name": "s", "values": [1]}, {"name": "t", "values": [2]}]}'),
      filePath: join(dir, '坏spec.docx'),
    })
    expect(badSpec.success).toBe(false)
    expect(badSpec.error).toContain('pie 只吃一组 series')
    // nothing landed
    expect(readdirSync(dir).filter((f) => f.endsWith('.docx'))).toEqual([])
  })

  it('xlsx ignores chart fences (docx/pdf-only enhancement)', async () => {
    const dir = tempDir()
    const result = await svcExportDocument({ format: 'xlsx', content: '| 甲 | 乙 |\n|---|---|\n| 1 | ' + GOOD + ' |', filePath: join(dir, '表.xlsx') })
    expect(result.success).toBe(true)
  })
})
