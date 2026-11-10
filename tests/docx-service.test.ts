// PLAN-office-editing T11/T15 — the service layer (guard mocked like
// workspace-write-lock.test.ts: better-sqlite3 is Electron-ABI, guard drags
// the DB in) and the five-point wiring + tool surface source scans.

import { describe, expect, it, beforeEach, vi } from 'vitest'

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
    guardFsTarget: async (target: string, mode: string) =>
      target.includes('deny') ? { ok: false, reason: `deny-listed (${mode})` } : { ok: true },
  }
})

const { svcEditDocx } = await import('../src/main/services/docx-ops')
const { svcEditXlsx } = await import('../src/main/services/xlsx-ops')
const { CORPUS } = await import('./docx-corpus')

const written: Array<{ path: string; content: Buffer; tmp: boolean }> = []

beforeEach(() => {
  written.length = 0
  ;(globalThis as Record<string, unknown>).WEB_CACHE = null
})

// The service writes tmp+rename through node:fs — stub promisified fs by
// intercepting the module… simplest honest seam: point the file at a REAL
// temp file (the probe covers the true fs path; here we need the logic).
// Instead of mocking node:fs, run against actual temp files.
import AdmZip from 'adm-zip'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

function tempFile(name: string, buf: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'pm-office-svc-'))
  const p = join(dir, name)
  writeFileSync(p, buf)
  return p
}

describe('docx_edit service', () => {
  it('edits a real file: content updated, backup created, tmp cleaned up', async () => {
    const path = tempFile('simple.docx', CORPUS['simple.docx']())
    const result = await svcEditDocx({ filePath: path, ops: [{ op: 'replace_text', find: 'Hello world', replace: '你好，世界' }] })
    expect(result.success).toBe(true)
    const after = new AdmZip(readFileSync(path)).readFile('word/document.xml')!.toString('utf8')
    expect(after).toContain('你好，世界')
    expect(result.backup).toBeDefined()
    expect(existsSync(result.backup!)).toBe(true)
    // tmp+rename: no leftover .pm-tmp sibling
    const siblings = readdirSync(join(path, '..'))
    expect(siblings.some((f) => f.includes('.pm-tmp'))).toBe(false)
    // Real zip write+re-parse: marginal against the 5s default under
    // full-suite parallelism — same ceiling treatment as pptx-service.
  }, 20_000)

  it('a refused op leaves the file untouched and reports per-op results', async () => {
    const path = tempFile('simple.docx', CORPUS['simple.docx']())
    const before = readFileSync(path)
    const result = await svcEditDocx({ filePath: path, ops: [{ op: 'replace_text', find: 'nope-nowhere', replace: 'x' }] })
    expect(result.success).toBe(false)
    expect(result.results?.[0]?.ok).toBe(false)
    expect(readFileSync(path).equals(before)).toBe(true)
  })

  it('the guard path short-circuits before any read', async () => {
    const result = await svcEditDocx({ filePath: '/deny/x.docx', ops: [{ op: 'outline' }] })
    expect(result.success).toBe(false)
    expect(result.error).toContain('deny')
  })

  it('outline-only does not write and returns the outline', async () => {
    const path = tempFile('styles-table.docx', CORPUS['styles-table.docx']())
    const before = readFileSync(path)
    const result = await svcEditDocx({ filePath: path, ops: [{ op: 'outline' }] })
    expect(result.success).toBe(true)
    expect(result.outline?.some((o) => o.style === 'Heading1')).toBe(true)
    expect(readFileSync(path).equals(before)).toBe(true)
  })

  it('guards the office binary family against the TEXT write tools (L11)', async () => {
    // svcWriteFile is text-only by contract; office extensions refuse.
    const { svcWriteFile } = await import('../src/main/services/file-ops')
    const result = await svcWriteFile({ filePath: '/tmp/w/report.docx', content: '<html>' })
    expect(result.success).toBe(false)
    expect((result as { error?: string }).error).toContain('office_edit')
    const patch = await import('../src/main/services/file-ops')
    const result2 = await patch.svcPatchFile({ filePath: '/tmp/w/book.xlsx', diff: '' })
    expect((result2 as { error?: string }).error).toContain('office_edit')
  })
})

describe('xlsx_edit service', () => {
  it('is wired through the same envelope (smoke via scan refusal)', async () => {
    // An OLE blob refuses at the scan with the actionable message.
    const path = tempFile('legacy.xls', Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), Buffer.alloc(32)]))
    const result = await svcEditXlsx({ filePath: path, ops: [{ op: 'inspect' }] })
    expect(result.success).toBe(false)
    expect(result.error).toContain('另存为 .xlsx')
  })
})
