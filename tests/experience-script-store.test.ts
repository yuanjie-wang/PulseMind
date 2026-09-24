import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The import chain pulls real stores, so point HOME at a temp dir BEFORE any
// project import — a test must never write into the user's live ~/.pulsemind.
process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-exp-scripts-'))
mkdirSync(join(process.env.HOME, '.pulsemind', 'experiences'), { recursive: true })
const EXPERIENCES_DIR = join(process.env.HOME, '.pulsemind', 'experiences')

// experience-store is better-sqlite3-backed (Electron ABI — cannot load under
// plain node vitest, see AGENTS.md). What vitest owns here is the GATE shape —
// which files land, which are rejected, what files_json does on rewrite — with
// a mock DB; the real-database half runs in scripts/probe-experience-scripts.mjs.
const rows = new Map<string, Record<string, unknown>>()

vi.mock('../src/main/storage/database', () => ({
  getDb: () => fakeDb,
  initializeDatabase: async () => {},
  ensureDbHealthy: async () => {},
}))

const fakeDb = {
  prepare(sql: string) {
    const s = sql.replace(/\s+/g, ' ')
    if (s.startsWith('SELECT * FROM experiences WHERE name')) {
      return { get: (n: string) => rows.get(n), all: () => [] }
    }
    if (s.startsWith('INSERT INTO experiences')) {
      // Faithful to the SQL TEXT: the keep-old-on-null semantics live in the
      // statement's COALESCE, so the mock applies it only when the statement
      // actually says so (a mutation that rewrites the clause goes red here).
      const keepOldOnNull = s.includes('COALESCE(excluded.files_json, experiences.files_json)')
      return {
        run: (...args: unknown[]) => {
          const name = args[1] as string
          const prev = rows.get(name)
          const newFiles = args[10] as string | null
          rows.set(name, {
            id: args[0], name, title: args[2], description: args[3], category: args[4],
            source_conversation_id: args[5], created_at: args[6], last_used_at: args[7],
            use_count: args[8], triggers: args[9],
            files_json: keepOldOnNull ? (newFiles ?? prev?.files_json ?? null) : newFiles,
          })
          return { changes: 1 }
        },
      }
    }
    if (s.startsWith('SELECT COUNT(*)')) return { get: () => ({ c: rows.size }), all: () => [] }
    if (s.startsWith('SELECT * FROM experiences ORDER BY (last_used_at IS NULL)')) {
      return { get: () => null, all: (n: number) => [...rows.values()].slice(0, n) }
    }
    if (s.startsWith('SELECT * FROM experiences')) return { get: () => null, all: () => [...rows.values()] }
    if (s.startsWith('SELECT name FROM experiences')) return { get: () => null, all: () => [...rows.values()] }
    if (s.startsWith('DELETE FROM experiences WHERE name')) return { run: (n: string) => { rows.delete(n); return { changes: 1 } } }
    if (s.startsWith('DELETE FROM experiences')) return { run: () => { rows.clear(); return { changes: rows.size } } }
    if (s.startsWith('UPDATE experiences SET last_used_at')) {
      return { run: (ts: string, n: string) => { const r = rows.get(n); if (r) { r.last_used_at = ts; r.use_count = ((r.use_count as number) ?? 0) + 1 } } }
    }
    throw new Error('unexpected SQL in test: ' + sql)
  },
  transaction<T>(fn: T) { return fn },
}

async function freshStore() {
  vi.resetModules()
  const mod = await import('../src/main/storage/experience-store')
  return mod.experienceStore
}

const VALID_SCRIPT = 'import { readFileSync } from "node:fs";\nconst p = process.argv[2] ?? ".";\nconsole.log(readFileSync(p, "utf8").length > 0)\n'
const TRUNCATED_SCRIPT = 'function broken() {\n  if ('

beforeEach(() => {
  rows.clear()
  mkdirSync(EXPERIENCES_DIR, { recursive: true })
})

afterEach(() => {
  rmSync(EXPERIENCES_DIR, { recursive: true, force: true })
})

describe('ExperienceStore.save — script payload gates (PLAN-experience-scripts)', () => {
  it('a draft with scripts writes them + files_json; dir contents match the list', async () => {
    const store = await freshStore()
    const { record } = await store.save({
      title: '聚合导出经验',
      description: '把每周数据聚合导出',
      content: '## 脚本 (Script)\nnode <dir>/scripts/agg.mjs <输入路径>',
      category: 'code',
      files: [{ path: 'scripts/agg.mjs', content: VALID_SCRIPT }],
    })
    expect(record.files).toEqual(['scripts/agg.mjs'])
    const onDisk = readFileSync(join(EXPERIENCES_DIR, record.name, 'scripts', 'agg.mjs'), 'utf-8')
    expect(onDisk).toBe(VALID_SCRIPT)
    expect(existsSync(join(EXPERIENCES_DIR, record.name, 'SKILL.md'))).toBe(true)
  })

  it('a resave WITHOUT files keeps the old files_json (the ensureTriggers rewrite must not wash the list)', async () => {
    const store = await freshStore()
    const first = await store.save({
      title: '聚合导出经验', description: 'd', content: 'c', category: 'code',
      files: [{ path: 'scripts/agg.mjs', content: VALID_SCRIPT }],
    })
    expect(first.record.files).toEqual(['scripts/agg.mjs'])
    const second = await store.save({
      title: '聚合导出经验', description: 'd2', content: 'c2 (rewritten by ensureTriggers)', category: 'code',
    })
    expect(second.record.files).toEqual(['scripts/agg.mjs'])
    expect(existsSync(join(EXPERIENCES_DIR, second.record.name, 'scripts', 'agg.mjs'))).toBe(true)
  })

  it('a truncated script is rejected by node --check, the experience itself still saves', async () => {
    const store = await freshStore()
    const { record, rejectedFiles } = await store.save({
      title: '坏脚本经验', description: 'd', content: 'c', category: 'code',
      files: [{ path: 'scripts/broken.mjs', content: TRUNCATED_SCRIPT }],
    })
    expect(rejectedFiles).toEqual(['scripts/broken.mjs'])
    expect(record.files).toBeUndefined()
    expect(existsSync(join(EXPERIENCES_DIR, record.name, 'scripts'))).toBe(false)
  })

  it('path jail: absolute paths, non-scripts prefix and .. escapes are all rejected, nothing written', async () => {
    const store = await freshStore()
    const { record, rejectedFiles } = await store.save({
      title: '越界脚本经验', description: 'd', content: 'c', category: 'code',
      files: [
        { path: '/etc/evil.mjs', content: VALID_SCRIPT },
        { path: 'notscripts/ok.mjs', content: VALID_SCRIPT },
        { path: 'scripts/../../evil.mjs', content: VALID_SCRIPT },
      ],
    })
    expect(rejectedFiles).toHaveLength(3)
    expect(record.files).toBeUndefined()
    expect(existsSync(join(EXPERIENCES_DIR, record.name, 'scripts'))).toBe(false)
  })

  it('over 8KB is rejected', async () => {
    const store = await freshStore()
    const big = '// ' + 'x'.repeat(9 * 1024) + '\n'
    const { rejectedFiles } = await store.save({
      title: '大脚本经验', description: 'd', content: 'c', category: 'code',
      files: [{ path: 'scripts/big.mjs', content: big }],
    })
    expect(rejectedFiles).toEqual(['scripts/big.mjs'])
  })

  it('readFileContent serves an existing script and refuses escapes', async () => {
    const store = await freshStore()
    await store.save({
      title: '读取经验', description: 'd', content: 'c', category: 'code',
      files: [{ path: 'scripts/agg.mjs', content: VALID_SCRIPT }],
    })
    expect(await store.readFileContent('读取经验', 'scripts/agg.mjs')).toBe(VALID_SCRIPT)
    expect(await store.readFileContent('读取经验', '../settings.json')).toBeNull()
    expect(await store.readFileContent('读取经验', '/etc/passwd')).toBeNull()
    expect(await store.readFileContent('不存在', 'scripts/agg.mjs')).toBeNull()
  })

  it('save only writes what it received — an unreferenced stray file is never cleaned', async () => {
    const store = await freshStore()
    await store.save({ title: '只写收到的', description: 'd', content: 'v1', category: 'code', files: [{ path: 'scripts/a.mjs', content: VALID_SCRIPT }] })
    const stray = join(EXPERIENCES_DIR, '只写收到的', 'scripts', 'stray.mjs')
    writeFileSync(stray, '// stray', 'utf-8')
    await store.save({ title: '只写收到的', description: 'd2', content: 'v2', category: 'code' })
    // save() must NOT clean the dir (删除权只属于 delete/clear/enforceLimit)
    expect(existsSync(stray)).toBe(true)
  })
})
