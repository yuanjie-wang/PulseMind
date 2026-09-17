import { join } from 'node:path'
import { getDb } from './database'
import type { KnowledgeListOptions, KnowledgeListResult } from '../../shared/types/knowledge'
import { chunkText } from '../../shared/knowledge/chunk'

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
    database.prepare('DELETE FROM knowledge_fts WHERE file_rowid IN (SELECT rowid FROM knowledge_files WHERE id = ?)').run(id)
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

// ── Knowledge FTS5 (chunked trigram, PLAN-knowledge-base K5) ──
// One FTS row per ~1200-char chunk (file_rowid UNINDEXED joins back to
// knowledge_files, chunk_offset keeps provenance): BM25 ranks passages, not
// whole documents, and snippet() lands inside the relevant region. Trigram
// tokenization makes CJK substring queries native — the four-layer fallback
// ladder (phrase OR → char AND → prefix stripping → LIKE) collapses to
// "trigram MATCH, with LIKE for <3-char queries" (the tokenizer's known floor).

/** Replace every chunk row for one knowledge file. The capture path (favorite)
 *  and the import indexer both funnel here. */
export function knowledgeFtsSync(fileRowid: number, content: string): void {
  const database = getDb()
  const tx = database.transaction(() => {
    database.prepare('DELETE FROM knowledge_fts WHERE file_rowid = ?').run(fileRowid)
    const insert = database.prepare('INSERT INTO knowledge_fts(content, file_rowid, chunk_offset) VALUES (?, ?, ?)')
    chunkText(content).forEach((chunk, i) => insert.run(chunk, fileRowid, i))
  })
  tx()
}

/** Historical name kept for callers that replace a whole file's rows. */
export const knowledgeFtsAdd = knowledgeFtsSync

export function knowledgeFtsRemoveByRowid(fileRowid: number): void {
  getDb().prepare('DELETE FROM knowledge_fts WHERE file_rowid = ?').run(fileRowid)
}

export interface KnowledgeFtsResult {
  id: string; filePath: string; title: string; sourceType: string; excerpt: string
}

export function searchKnowledgeFts(query: string, limit: number = 10): KnowledgeFtsResult[] {
  const database = getDb()
  const escaped = query.replace(/[^\w\s一-鿿]/g, ' ').trim()
  if (!escaped) return []

  const terms = escaped.split(/\s+/).filter(Boolean)
  // Trigram needs ≥3 characters per token — shorter queries fall back to LIKE
  // (D4: a known tokenizer floor, not a fallback ladder rung).
  const ftsTerms = terms.filter(t => [...t].length >= 3)

  // 1. Trigram MATCH over chunks — BM25 ranks passages; snippet() shows the
  //    matching region of the winning chunk. One row per file (best chunk).
  //    A long CJK term that is a QUESTION ("什么是上下文硬盘缓存") does not
  //    appear verbatim in any document, so each long term also ORs its 4-char
  //    suffix window ("硬盘缓存") — the bounded replacement for the old
  //    progressive prefix-stripping ladder.
  if (ftsTerms.length > 0) {
    const phrases: string[] = []
    for (const t of ftsTerms) {
      phrases.push(`"${t}"`)
      const chars = [...t]
      if (/[一-鿿]/.test(t) && chars.length > 4) phrases.push(`"${chars.slice(-4).join('')}"`)
    }
    const ftsQuery = phrases.join(' OR ')
    try {
      const results = database.prepare(`
        SELECT k.id, k.file_path AS filePath, k.title, k.source_type AS sourceType,
               snippet(knowledge_fts, 0, '…', '…', '…', 64) AS excerpt
        FROM knowledge_fts f
        JOIN knowledge_files k ON k.rowid = f.file_rowid
        WHERE knowledge_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery, limit) as KnowledgeFtsResult[]
      if (results.length > 0) return results
    } catch { /* FTS5 syntax error */ }
  }

  // 2. LIKE on title + file_path (empty results keep falling — the chunk
  //    content scan below can still hit)
  try {
    const likeRows = database.prepare(`
      SELECT id, file_path AS filePath, title, source_type AS sourceType, '' AS excerpt
      FROM knowledge_files WHERE title LIKE ? OR file_path LIKE ? LIMIT ?
    `).all(`%${query}%`, `%${query}%`, limit) as KnowledgeFtsResult[]
    if (likeRows.length > 0) return likeRows
  } catch {
    // fall through
  }

  // 3. Last-resort: LIKE scan over chunk content.
  try {
    return database.prepare(`
      SELECT k.id, k.file_path AS filePath, k.title, k.source_type AS sourceType,
             substr(f.content, 1, 200) AS excerpt
      FROM knowledge_fts f
      JOIN knowledge_files k ON k.rowid = f.file_rowid
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
  const insert = database.prepare('INSERT INTO knowledge_fts(content, file_rowid, chunk_offset) VALUES (?, ?, ?)')
  let count = 0
  for (const row of rows) {
    const fullPath = join(rawDir, row.file_path)
    if (!existsSync(fullPath)) continue
    try {
      const content = readFileSync(fullPath, 'utf-8')
      const tx = database.transaction(() => {
        chunkText(content).forEach((chunk, i) => insert.run(chunk, row.rowid, i))
      })
      tx()
      count++
    } catch (err) {
      console.warn(`[DB] Failed to index knowledge file ${row.file_path}:`, err)
    }
  }
  console.log(`[DB] Rebuilt knowledge_fts (chunked): ${count}/${rows.length} files indexed`)
}
