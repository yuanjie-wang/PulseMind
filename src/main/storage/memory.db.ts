import { getDb, withFtsRecovery } from './database'
import { memoryContentHash } from '../../shared/memory/content-hash'

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

/** Escape FTS5 special characters that would cause syntax errors. */
function sanitizeFtsQuery(query: string): string {
  // FTS5 treats these as syntax: ^ . * " ( ) + - ~ AND OR NOT NEAR
  // Wrap in double quotes to treat as a safe phrase search
  const hasSpecial = /[.*"()^+\-~]|(\b(AND|OR|NOT|NEAR)\b)/i.test(query)
  if (!hasSpecial) return query
  // Escape internal double quotes and wrap the whole thing in quotes
  return `"${query.replace(/"/g, '""')}"`
}

export function searchMemories(query: string, limit: number = 10, category?: string): MemoryRow[] {
  const database = getDb()
  return withFtsRecovery(() => {
    let sql = `
      SELECT m.id, m.content, m.type, m.category, m.source, m.created_at, m.updated_at
      FROM memories_fts f
      JOIN memories m ON m.rowid = f.rowid
      WHERE memories_fts MATCH ?
    `
    const params: unknown[] = [sanitizeFtsQuery(query)]
    if (category) { sql += ' AND m.category = ?'; params.push(category) }
    sql += ' ORDER BY rank LIMIT ?'
    params.push(limit)
    return database.prepare(sql).all(...params) as MemoryRow[]
  })
}

export function countMemoriesByType(types: string[]): number {
  const database = getDb()
  const placeholders = types.map(() => '?').join(',')
  const row = database
    .prepare(`SELECT COUNT(*) as c FROM memories WHERE type IN (${placeholders})`)
    .get(...types) as { c: number }
  return row.c
}
