// PLAN-office-export M2 — the export service (guard mocked exactly like
// docx-service.test.ts; better-sqlite3 is Electron-ABI and the guard drags the
// DB in) plus the wiring and cache-contract scans. Real bytes throughout:
// exports land in real temp files and are read back with the real parsers.

import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/main/sandbox/guard', () => ({
  guardFsTarget: async (target: string, mode: string) =>
    target.includes('deny') ? { ok: false, reason: `deny-listed (${mode})` } : { ok: true },
}))

// The docx builder is spied so the read-back-gate test can feed a corrupted
// buffer through the same seam the service uses.
vi.mock('../src/main/office-export/md-to-docx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/office-export/md-to-docx')>()
  return { ...actual, markdownToDocxBuffer: vi.fn(actual.markdownToDocxBuffer) }
})

const { svcExportDocument } = await import('../src/main/services/office-export')
const { markdownToDocxBuffer } = await import('../src/main/office-export/md-to-docx')

import AdmZip from 'adm-zip'
import ExcelJS from 'exceljs'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'pm-office-export-'))
}

const MD_TABLE = '| 名称 | 数量 |\n|---|---|\n| 甲 | 12 |\n| 乙 | 007 |'

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

    const badFormat = await svcExportDocument({ format: 'pptx' as never, content: 'x', filePath: join(dir, 'd.pptx') })
    expect(badFormat.success).toBe(false)
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
})

describe('export_document wiring (source scans; the unit halves live in their own files)', () => {
  it('usage lives in the tool manual, NEVER in the invariant system prompt core (cache contract)', () => {
    const fs = require('node:fs') as typeof import('node:fs')
    const read = (p: string) => fs.readFileSync(p, 'utf8')
    const core = read('src/renderer/src/agent/system-prompt-builder.ts')
    const manual = read('src/renderer/src/tools/tool-instructions.ts')
    expect(core.includes('export_document')).toBe(false)
    expect(manual).toContain('export_document')
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
    expect(read('src/main/services/file-ops.ts')).toContain('export_document')
  })
})
