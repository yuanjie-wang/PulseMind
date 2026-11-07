import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── full_20261011 X7 batch: three one-gate-per-channel data-consistency fixes.
//
// getDb must never be reached by the memory paths below EXCEPT through the
// real database module — which needs better-sqlite3 (Electron ABI), so the
// memory assertions run through a sqlite-free level: the hash recomputation
// is pinned on the SOURCE wiring, and json-store is driven against real disk.

vi.mock('../src/main/storage/database', () => ({
  getDb: () => { throw new Error('getDb must not be reached in data-consistency tests') },
}))

import { readJson, writeJson } from '../src/main/storage/json-store'
import { memoryContentHash } from '../src/shared/memory/content-hash'
import { MEMORY_ENTRY_MAX_CHARS } from '../src/shared/memory/limits'
import { readFileSync } from 'node:fs'

const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8')

describe('json-store — corrupt file keeps its bytes (M9-P1-2)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pm-jsonstore-'))

  it('a corrupt file is NOT overwritten with the default; only ENOENT seeds it', async () => {
    const bad = join(dir, 'mcp-servers.json')
    writeFileSync(bad, '[{"id":"x",]', 'utf-8')
    const v = await readJson(bad, [] as unknown[])
    expect(v).toEqual([])
    expect(readFileSync(bad, 'utf-8')).toBe('[{"id":"x",]')
  })

  it('a missing file is seeded with the default (first-launch shape kept)', async () => {
    const fresh = join(dir, 'fresh.json')
    expect(existsSync(fresh)).toBe(false)
    await readJson(fresh, { a: 1 })
    expect(existsSync(fresh)).toBe(true)
    expect(JSON.parse(readFileSync(fresh, 'utf-8'))).toEqual({ a: 1 })
  })

  it('writeJson publishes atomically — no tmp litter, valid JSON on disk', async () => {
    const target = join(dir, 'atomic.json')
    await writeJson(target, { list: [1, 2] })
    expect(JSON.parse(readFileSync(target, 'utf-8'))).toEqual({ list: [1, 2] })
    const litter = join(dir, 'atomic.json')
    expect(existsSync(`${litter}.${process.pid}.tmp`)).toBe(false)
  })
})

describe('memory content_hash stays attached to the CURRENT content (M9-P1-1)', () => {
  it('updateMemory writes content_hash next to content; the upsert refreshes it too', () => {
    const db = read('src/main/storage/memory.db.ts')
    // The edit path must recompute — the stale-hash shape was: content=B,
    // hash=h(A) → h(B) misses (duplicate insert) and h(A) hits (real content
    // dropped as a "duplicate").
    expect(db).toContain("sets.push('content_hash = ?'); params.push(memoryContentHash(data.content))")
    // The same-id upsert must refresh the hash as well (self-healing path).
    expect(db).toContain('content_hash = excluded.content_hash')
    // And the hash function is the one the dedup gate queries with:
    expect(db).toContain("SELECT id FROM memories WHERE content_hash = ? LIMIT 1")
  })

  it('the hash contract is content-derived (same lib as the renderer merge dedup)', () => {
    expect(memoryContentHash('A')).not.toBe(memoryContentHash('B'))
    expect(memoryContentHash('A')).toBe(memoryContentHash('A'))
  })
})

describe('memory_save cannot silently save what the resident section will never show (M7-P1-2)', () => {
  it('the executor refuses over-limit content with an honest error', () => {
    const src = read('src/renderer/src/agent/executors/domain-tools.ts')
    expect(src).toContain('MEMORY_ENTRY_MAX_CHARS')
    expect(src).toContain('characters. Distill the conclusion')  // v2 拒绝话术（页面协议）
  })
  it('the contract reaches the model: manual + schema description carry the limit', () => {
    const manual = read('src/renderer/src/tools/tool-instructions.ts')
    expect(manual).toContain('at most 100 characters')
    const defs = read('src/renderer/src/tools/built-in-tools.ts')
    expect(defs).toContain('at most 100 characters')
  })
  it("the limit constant is the renderer filter's own", () => {
    expect(MEMORY_ENTRY_MAX_CHARS).toBe(100)
  })
})
