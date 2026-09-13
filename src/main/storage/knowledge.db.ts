import { join } from 'node:path'
import { getDb } from './database'
import type { KnowledgeListOptions, KnowledgeListResult } from '../../shared/types/knowledge'

// ── Knowledge Files CRUD ──

export interface KnowledgeFileRow {
  id: string
  file_path: string
  title: string
  source_type: string
  source_url: string | null
  source_path: string | null
  conv_id: string | null
  content_hash: string | null
  status: string
  created_at: string
  compiled_at: string | null
  wiki_outputs: string | null
}

export function listKnowledgeFiles(opts?: KnowledgeListOptions): KnowledgeListResult {
  const database = getDb()
  const conditions: string[] = []
  const params: any[] = []

  if (opts?.status) { conditions.push('status = ?'); params.push(opts.status) }
  if (opts?.sourceType) { conditions.push('source_type = ?'); params.push(opts.sourceType) }
  if (opts?.search) {
    const words = opts.search.trim().split(/\s+/).filter(Boolean)
    if (words.length > 1) {
      // Multi-word: OR each word independently so "A B" matches files
      // with "A" OR "B" in title/path instead of requiring literal "A B".
      const clauses = words.map(() => '(title LIKE ? OR file_path LIKE ?)').join(' OR ')
      conditions.push(`(${clauses})`)
      for (const w of words) {
        const like = `%${w}%`
        params.push(like, like)
      }
    } else {
      conditions.push('(title LIKE ? OR file_path LIKE ?)')
      params.push(`%${opts.search}%`, `%${opts.search}%`)
    }
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const countRow = database.prepare(`SELECT COUNT(*) as c FROM knowledge_files ${where}`).get(...params) as { c: number }
  const total = countRow.c

  const sortBy = opts?.sortBy || 'createdAt'
  const sortOrder = opts?.sortOrder || 'desc'
  const sortMap: Record<string, string> = { createdAt: 'created_at', title: 'title', status: 'status' }
  const orderCol = sortMap[sortBy] || 'created_at'
  const orderClause = `ORDER BY ${orderCol} ${sortOrder === 'asc' ? 'ASC' : 'DESC'}`

  const page = opts?.page || 1
  const pageSize = opts?.pageSize || 50
  const offset = (page - 1) * pageSize

  const rows = database.prepare(`SELECT * FROM knowledge_files ${where} ${orderClause} LIMIT ? OFFSET ?`).all(...params, pageSize, offset) as KnowledgeFileRow[]

  return { items: rows, total, page, pageSize }
}

export function getKnowledgeFile(id: string): KnowledgeFileRow | null {
  const row = getDb().prepare('SELECT * FROM knowledge_files WHERE id = ?').get(id) as KnowledgeFileRow | undefined
  return row ?? null
}

/** Batch fetch by ids (expert knowledge binding): used to build the Bound
 *  Knowledge section and scope searches. Missing ids are silently skipped. */
export function getKnowledgeFilesByIds(ids: string[]): KnowledgeFileRow[] {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(',')
  return getDb()
    .prepare(`SELECT * FROM knowledge_files WHERE id IN (${placeholders})`)
    .all(...ids) as KnowledgeFileRow[]
}

export function getKnowledgeFileByPath(filePath: string): KnowledgeFileRow | null {
  const row = getDb().prepare('SELECT * FROM knowledge_files WHERE file_path = ?').get(filePath) as KnowledgeFileRow | undefined
  return row ?? null
}

export function getKnowledgeFileBySource(sourcePath: string, sourceUrl?: string): KnowledgeFileRow | null {
  if (sourcePath) {
    const row = getDb().prepare('SELECT * FROM knowledge_files WHERE source_path = ?').get(sourcePath) as KnowledgeFileRow | undefined
    if (row) return row
  }
  if (sourceUrl) {
    const row = getDb().prepare('SELECT * FROM knowledge_files WHERE source_url = ?').get(sourceUrl) as KnowledgeFileRow | undefined
    if (row) return row
  }
  return null
}

export function insertKnowledgeFile(row: {
  id: string; filePath: string; title: string; sourceType: string
  sourceUrl?: string | null; sourcePath?: string | null; convId?: string | null; contentHash?: string | null
}): void {
  const database = getDb()
  const now = new Date().toISOString()
  database.prepare(`
    INSERT INTO knowledge_files (id, file_path, title, source_type, source_url, source_path, conv_id, content_hash, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'raw', ?)
  `).run(row.id, row.filePath, row.title, row.sourceType, row.sourceUrl ?? null, row.sourcePath ?? null, row.convId ?? null, row.contentHash ?? null, now)
}

export function updateKnowledgeFileStatus(id: string, status: 'compiled', wikiOutputs?: string[]): void {
  const database = getDb()
  if (wikiOutputs) {
    database.prepare("UPDATE knowledge_files SET status = ?, compiled_at = ?, wiki_outputs = ? WHERE id = ?")
      .run(status, new Date().toISOString(), JSON.stringify(wikiOutputs), id)
  } else {
    database.prepare("UPDATE knowledge_files SET status = ?, compiled_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), id)
  }
}

export function deleteKnowledgeFile(id: string): void {
  const database = getDb()
  const del = database.transaction(() => {
    database.prepare('DELETE FROM knowledge_fts WHERE rowid IN (SELECT rowid FROM knowledge_files WHERE id = ?)').run(id)
    database.prepare('DELETE FROM knowledge_files WHERE id = ?').run(id)
  })
  del()
}

export function getKnowledgeStats(): { total: number; raw: number; compiled: number } {
  const database = getDb()
  const total = (database.prepare('SELECT COUNT(*) as c FROM knowledge_files').get() as { c: number }).c
  const raw = (database.prepare("SELECT COUNT(*) as c FROM knowledge_files WHERE status = 'raw'").get() as { c: number }).c
  const compiled = (database.prepare("SELECT COUNT(*) as c FROM knowledge_files WHERE status = 'compiled'").get() as { c: number }).c
  return { total, raw, compiled }
}

// ── Knowledge FTS5 ──

export function knowledgeFtsAdd(rowid: number, content: string): void {
  getDb().prepare('INSERT OR REPLACE INTO knowledge_fts(rowid, content) VALUES (?, ?)').run(rowid, content)
}

export function knowledgeFtsRemove(rowid: number): void {
  getDb().prepare('DELETE FROM knowledge_fts WHERE rowid = ?').run(rowid)
}

export interface KnowledgeFtsResult {
  id: string; filePath: string; title: string; sourceType: string; excerpt: string
}

export function searchKnowledgeFts(query: string, limit: number = 10): KnowledgeFtsResult[] {
  const database = getDb()
  const escaped = query.replace(/[^\w\s一-鿿]/g, ' ').trim()
  if (!escaped) return []

  const terms = escaped.split(/\s+/).filter(Boolean)
  // Use OR by default — AND is too strict for keyword search. BM25 ranking
  // handles relevance, so matching any term is fine.
  const ftsQuery = terms.map(t => `"${t}"*`).join(' OR ')

  const baseSql = `
    SELECT k.id, k.file_path, k.title, k.source_type,
           snippet(knowledge_fts, 1, '…', '…', '…', 64) AS excerpt
    FROM knowledge_fts f
    JOIN knowledge_files k ON k.rowid = f.rowid
    WHERE knowledge_fts MATCH ?
    ORDER BY rank
    LIMIT ?`

  // 1. FTS5 match (OR) — broad keyword search, BM25 ranks best matches first.
  //    Single-term queries behave the same with OR and AND.
  try {
    const results = database.prepare(baseSql).all(ftsQuery, limit) as KnowledgeFtsResult[]
    if (results.length > 0) return results
  } catch { /* FTS5 syntax error */ }

  // 2. CJK character-level fallback — try each search term independently and union.
  //    The unicode61 tokenizer indexes each CJK character as a separate token.
  //    A phrase query like "什么是上下文硬盘缓存" requires all N chars consecutively,
  //    but documents only contain "上下文硬盘缓存" without question words. By AND'ing
  //    individual character tokens of each term we match documents containing all
  //    characters of at least one term. Each term is tried independently so that
  //    "上下文硬盘缓存" and "磁盘缓存" don't both need to match in the same doc.
  const termResults: KnowledgeFtsResult[] = []
  for (const term of terms) {
    const chars = [...term]
    if (chars.length < 2) continue
    const charQuery = chars.map(c => `"${c}"*`).join(' AND ')
    if (charQuery === `"${term}"*`) continue // same as the original phrase query
    try {
      const results = database.prepare(baseSql).all(charQuery, limit) as KnowledgeFtsResult[]
      for (const r of results) {
        if (!termResults.some(existing => existing.id === r.id)) {
          termResults.push(r)
        }
      }
    } catch { /* too many terms or other FTS5 error */ }
  }
  if (termResults.length > 0) return termResults.slice(0, limit)

  // 2b. Progressive CJK shortening: if character AND fails, strip characters
  //      from the left of each term one at a time. Naturally handles CJK
  //      question-word prefixes ("什么是X" → "X") that the AND requires.
  if (termResults.length === 0) {
    for (const term of terms) {
      const chars = [...term]
      for (let start = 1; start < chars.length - 1; start++) {
        const suffix = chars.slice(start)
        const suffixQuery = suffix.map(c => `"${c}"*`).join(' AND ')
        try {
          const results = database.prepare(baseSql).all(suffixQuery, limit) as KnowledgeFtsResult[]
          for (const r of results) {
            if (!termResults.some(existing => existing.id === r.id)) {
              termResults.push(r)
            }
          }
          if (results.length > 0) break
        } catch { /* FTS5 error */ }
      }
      if (termResults.length > 0) break
    }
    if (termResults.length > 0) return termResults.slice(0, limit)
  }

  // 3. LIKE on title + file_path
  try {
    return database.prepare(`
      SELECT id, file_path, title, source_type, '' AS excerpt
      FROM knowledge_files WHERE title LIKE ? OR file_path LIKE ? LIMIT ?
    `).all(`%${query}%`, `%${query}%`, limit) as KnowledgeFtsResult[]
  } catch {
    // fall through
  }

  // 4. Last-resort: LIKE scan on raw file content from knowledge_fts.
  //    Handles long CJK queries where FTS5 character AND is too strict
  //    (e.g., "什么是X" requires all CJK chars including question words).
  //    knowledge_fts is standalone so its content column stores the raw text.
  try {
    return database.prepare(`
      SELECT k.id, k.file_path, k.title, k.source_type,
             substr(f.content, 1, 200) AS excerpt
      FROM knowledge_fts f
      JOIN knowledge_files k ON k.rowid = f.rowid
      WHERE f.content LIKE ?
      LIMIT ?
    `).all(`%${escaped}%`, limit) as KnowledgeFtsResult[]
  } catch {
    return []
  }
}

export function rebuildKnowledgeFts(rawDir: string): void {
  const database = getDb()
  const { existsSync, readFileSync } = require('node:fs') as typeof import('node:fs')

  database.exec('DELETE FROM knowledge_fts')

  const rows = database.prepare('SELECT rowid, file_path FROM knowledge_files').all() as { rowid: number; file_path: string }[]
  let count = 0
  for (const row of rows) {
    const fullPath = join(rawDir, row.file_path)
    if (!existsSync(fullPath)) continue
    try {
      const content = readFileSync(fullPath, 'utf-8')
      database.prepare('INSERT INTO knowledge_fts(rowid, content) VALUES (?, ?)').run(row.rowid, content)
      count++
    } catch (err) {
      console.warn(`[DB] Failed to index knowledge file ${row.file_path}:`, err)
    }
  }
  console.log(`[DB] Rebuilt knowledge_fts: ${count}/${rows.length} files indexed`)
}
