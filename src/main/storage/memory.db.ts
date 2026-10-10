import { getDb, withFtsRecovery } from './database'
import { memoryContentHash } from '../../shared/memory/content-hash'
import { escapeLikePattern } from '../../shared/memory/like-pattern'

export interface MemoryRow {
  id: string
  content: string
  type: string
  category: string
  source: string | null
  created_at: string
  updated_at: string
}

export function listMemories(category?: string): MemoryRow[] {
  const database = getDb()
  let sql = 'SELECT id, content, type, category, source, created_at, updated_at FROM memories'
  const params: unknown[] = []
  if (category) {
    sql += ' WHERE category = ?'
    params.push(category)
  }
  sql += ' ORDER BY created_at DESC'
  return database.prepare(sql).all(...params) as MemoryRow[]
}

export function saveMemory(id: string, content: string, type: string, category: string, source: string | null): void {
  const database = getDb()
  const now = new Date().toISOString()
  // P0 (PLAN-memory-extraction-dedup): the DB layer is the ONE point every
  // saveMemory caller passes through (engine's getHost().saveMemory bypasses
  // MemoryManager entirely; the IPC handler bypasses both) — so the literal
  // dedup gate lives HERE, not in any manager. A hash hit skips the insert
  // silently-by-log: the memory already exists and re-adding it is the exact
  // duplication this plan removes.
  const contentHash = memoryContentHash(content)
  const existing = database.prepare('SELECT id FROM memories WHERE content_hash = ? LIMIT 1').get(contentHash) as { id: string } | undefined
  if (existing) {
    console.log(`[memory] duplicate content skipped (already stored as ${existing.id})`)
    return
  }
  const save = database.transaction(() => {
    const result = database.prepare(`
      INSERT INTO memories (id, content, type, category, source, created_at, updated_at, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        content = excluded.content, type = excluded.type,
        category = excluded.category, updated_at = excluded.updated_at
    `).run(id, content, type, category, source, now, now, contentHash)

    withFtsRecovery(() => {
      const rowid = result.lastInsertRowid as number
      database.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(rowid)
      database.prepare('INSERT INTO memories_fts(rowid, content) VALUES (?, ?)').run(rowid, content)
    })
  })
  save()
}

export function updateMemory(id: string, data: { content?: string; type?: string; category?: string }): void {
  const database = getDb()
  const now = new Date().toISOString()
  const update = database.transaction(() => {
    const sets: string[] = ['updated_at = ?']
    const params: unknown[] = [now]
    if (data.content !== undefined) { sets.push('content = ?'); params.push(data.content) }
    if (data.type !== undefined) { sets.push('type = ?'); params.push(data.type) }
    if (data.category !== undefined) { sets.push('category = ?'); params.push(data.category) }
    params.push(id)
    database.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...params)

    // Sync FTS5 index when content changes
    if (data.content !== undefined) {
      withFtsRecovery(() => {
        const row = database.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as { rowid: number } | undefined
        if (row) {
          database.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(row.rowid)
          database.prepare('INSERT INTO memories_fts(rowid, content) VALUES (?, ?)').run(row.rowid, data.content!)
        }
      })
    }
  })
  update()
}

export function deleteMemory(id: string): void {
  const database = getDb()
  const del = database.transaction(() => {
    withFtsRecovery(() => {
      const row = database.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as { rowid: number } | undefined
      if (row) database.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(row.rowid)
    })
    database.prepare('DELETE FROM memories WHERE id = ?').run(id)
  })
  del()
}

export function searchMemories(query: string, limit: number = 10, category?: string): MemoryRow[] {
  const database = getDb()
  const q = query.trim()
  if (!q) return []
  // LIKE 全表扫（user 2026-10-10）：memories_fts 建表没指定分词器，默认
  // unicode61 把连续汉字串当单个 token，中文子串查询几乎必然 miss（知识库
  // FTS 同病，已迁 trigram；trigram 对 <3 字符的中文词仍落空）。记忆池封顶
  // 后不过几十行，全表扫即时返回，任意长度的中文子串都能命中。
  let sql = `
    SELECT id, content, type, category, source, created_at, updated_at
    FROM memories
    WHERE content LIKE ? ESCAPE '\\'
  `
  const params: unknown[] = [`%${escapeLikePattern(q)}%`]
  if (category) { sql += ' AND category = ?'; params.push(category) }
  sql += ' ORDER BY created_at DESC LIMIT ?'
  params.push(limit)
  return database.prepare(sql).all(...params) as MemoryRow[]
}

export function countMemoriesByType(types: string[]): number {
  const database = getDb()
  const placeholders = types.map(() => '?').join(',')
  const row = database
    .prepare(`SELECT COUNT(*) as c FROM memories WHERE type IN (${placeholders})`)
    .get(...types) as { c: number }
  return row.c
}
