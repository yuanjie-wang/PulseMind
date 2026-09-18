import { join } from 'node:path'
import { getDb } from './database'
import { getBaseRawDir, KNOWLEDGE_RAW_DIR } from './index'
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
  base_id: string
}

export function listKnowledgeFiles(opts?: KnowledgeListOptions): KnowledgeListResult {
  const database = getDb()
  const conditions: string[] = []
  const params: any[] = []

  if (opts?.status) { conditions.push('status = ?'); params.push(opts.status) }
  if (opts?.sourceType) { conditions.push('source_type = ?'); params.push(opts.sourceType) }
  if (opts?.baseId !== undefined) { conditions.push('base_id = ?'); params.push(opts.baseId) }
  if (opts?.search) {
    const words = opts.search.trim().split(/\s+/).filter(Boolean)
    if (words.length > 1) {
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

/** Same relative paths exist per base (M15): resolving an rg hit needs the
 *  owning base, or the first global row wins and attributes the match to the
 *  wrong file. */
export function getKnowledgeFileByPathAndBase(filePath: string, baseId: string): KnowledgeFileRow | null {
  const row = getDb().prepare('SELECT * FROM knowledge_files WHERE file_path = ? AND base_id = ?').get(filePath, baseId) as KnowledgeFileRow | undefined
  return row ?? null
}

/** Source-duplicate check. `baseId` scopes it (M16): the rail's isolation
 *  contract means the SAME url/file may live in two bases — a global check
 *  silently refused every re-import into a second base. */
export function getKnowledgeFileBySource(sourcePath: string, sourceUrl?: string, baseId?: string): KnowledgeFileRow | null {
  const clause = baseId !== undefined ? ' AND base_id = ?' : ''
  const baseParams = baseId !== undefined ? [baseId] : []
  if (sourcePath) {
    const row = getDb().prepare(`SELECT * FROM knowledge_files WHERE source_path = ?${clause}`).get(sourcePath, ...baseParams) as KnowledgeFileRow | undefined
    if (row) return row
  }
  if (sourceUrl) {
    const row = getDb().prepare(`SELECT * FROM knowledge_files WHERE source_url = ?${clause}`).get(sourceUrl, ...baseParams) as KnowledgeFileRow | undefined
    if (row) return row
  }
  return null
}

export function insertKnowledgeFile(row: {
  id: string; filePath: string; title: string; sourceType: string
  sourceUrl?: string | null; sourcePath?: string | null; convId?: string | null; contentHash?: string | null
  baseId?: string
}): void {
  const database = getDb()
  const now = new Date().toISOString()
  database.prepare(`
    INSERT INTO knowledge_files (id, file_path, title, source_type, source_url, source_path, conv_id, content_hash, status, created_at, base_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'raw', ?, ?)
  `).run(row.id, row.filePath, row.title, row.sourceType, row.sourceUrl ?? null, row.sourcePath ?? null, row.convId ?? null, row.contentHash ?? null, now, row.baseId ?? 'default')
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

// ── Knowledge Bases ──

export interface KnowledgeBaseRow {
  id: string
  name: string
  color_hue: number | null
  created_at: string
  file_count?: number
}

/** All bases, oldest first, each with its live file count. */
export function listKnowledgeBases(): KnowledgeBaseRow[] {
  return getDb().prepare(`
    SELECT b.id, b.name, b.color_hue, b.created_at,
           (SELECT COUNT(*) FROM knowledge_files f WHERE f.base_id = b.id) AS file_count
    FROM knowledge_bases b ORDER BY b.created_at ASC, b.name ASC
  `).all() as KnowledgeBaseRow[]
}

export function getKnowledgeBase(id: string): KnowledgeBaseRow | null {
  const row = getDb().prepare('SELECT id, name, color_hue, created_at FROM knowledge_bases WHERE id = ?').get(id) as KnowledgeBaseRow | undefined
  return row ?? null
}

export function getKnowledgeBaseByName(name: string): KnowledgeBaseRow | null {
  const row = getDb().prepare('SELECT id, name, color_hue, created_at FROM knowledge_bases WHERE name = ?').get(name) as KnowledgeBaseRow | undefined
  return row ?? null
}

export function insertKnowledgeBase(row: { id: string; name: string; colorHue?: number | null }): void {
  getDb().prepare('INSERT INTO knowledge_bases (id, name, color_hue, created_at) VALUES (?, ?, ?, ?)')
    .run(row.id, row.name, row.colorHue ?? null, new Date().toISOString())
}

export function renameKnowledgeBase(id: string, name: string): void {
  getDb().prepare('UPDATE knowledge_bases SET name = ? WHERE id = ?').run(name, id)
}

/** Delete a base and all its files. The 'default' base cannot be deleted. */
export function deleteKnowledgeBase(id: string): void {
  if (id === 'default') throw new Error('默认知识库不可删除')
  const tx = getDb().transaction(() => {
    getDb().prepare('DELETE FROM knowledge_fts WHERE file_rowid IN (SELECT rowid FROM knowledge_files WHERE base_id = ?)').run(id)
    // M13: the wiki FTS is keyed by base too — a base deleted without this
    // left its pages searchable until the next startup's sync check converged.
    getDb().prepare('DELETE FROM knowledge_wiki_fts WHERE base_id = ?').run(id)
    getDb().prepare('DELETE FROM knowledge_files WHERE base_id = ?').run(id)
    getDb().prepare('DELETE FROM knowledge_bases WHERE id = ?').run(id)
  })
  tx()
}

/** Move one file between bases. The base's existence is checked so a stale
 *  renderer id cannot strand the file in a dangling base. */
export function setKnowledgeFileBase(id: string, baseId: string): void {
  if (!getKnowledgeBase(baseId)) {
    throw new Error(`知识库不存在: ${baseId}`)
  }
  getDb().prepare('UPDATE knowledge_files SET base_id = ? WHERE id = ?').run(baseId, id)
}

export function getKnowledgeStats(baseId?: string): { total: number; raw: number; compiled: number } {
  const database = getDb()
  const clause = baseId !== undefined ? 'WHERE base_id = ?' : ''
  const params = baseId !== undefined ? [baseId] : []
  const total = (database.prepare(`SELECT COUNT(*) as c FROM knowledge_files ${clause}`).get(...params) as { c: number }).c
  const raw = (database.prepare(`SELECT COUNT(*) as c FROM knowledge_files ${clause ? `${clause} AND ` : 'WHERE '}status = 'raw'`).get(...params) as { c: number }).c
  const compiled = (database.prepare(`SELECT COUNT(*) as c FROM knowledge_files ${clause ? `${clause} AND ` : 'WHERE '}status = 'compiled'`).get(...params) as { c: number }).c
  return { total, raw, compiled }
}

// ── Knowledge FTS5 (chunked trigram, PLAN-knowledge-base K5) ──

/** Replace every chunk row for one knowledge file. */
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

export function searchKnowledgeFts(query: string, limit: number = 10, baseId?: string): KnowledgeFtsResult[] {
  const database = getDb()
  const escaped = query.replace(/[^\w\s一-鿿]/g, ' ').trim()
  if (!escaped) return []
  const baseClause = baseId !== undefined ? 'AND k.base_id = ?' : ''
  const baseParams = baseId !== undefined ? [baseId] : []

  const terms = escaped.split(/\s+/).filter(Boolean)
  const ftsTerms = terms.filter(t => [...t].length >= 3)

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
        WHERE knowledge_fts MATCH ? ${baseClause}
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery, ...baseParams, limit) as KnowledgeFtsResult[]
      if (results.length > 0) return results
    } catch { /* FTS5 syntax error */ }
  }

  try {
    const likeRows = database.prepare(`
      SELECT id, file_path AS filePath, title, source_type AS sourceType, '' AS excerpt
      FROM knowledge_files WHERE (title LIKE ? OR file_path LIKE ?) ${baseClause} LIMIT ?
    `).all(`%${query}%`, `%${query}%`, ...baseParams, limit) as KnowledgeFtsResult[]
    if (likeRows.length > 0) return likeRows
  } catch {
    // fall through
  }

  try {
    return database.prepare(`
      SELECT k.id, k.file_path AS filePath, k.title, k.source_type AS sourceType,
             substr(f.content, 1, 200) AS excerpt
      FROM knowledge_fts f
      JOIN knowledge_files k ON k.rowid = f.file_rowid
      WHERE f.content LIKE ? ${baseClause}
      LIMIT ?
    `).all(`%${escaped}%`, ...baseParams, limit) as KnowledgeFtsResult[]
  } catch {
    return []
  }
}

export function rebuildKnowledgeFts(): void {
  const database = getDb()
  const { existsSync, readFileSync } = require('node:fs') as typeof import('node:fs')

  database.exec('DELETE FROM knowledge_fts')

  const rows = database.prepare('SELECT rowid, file_path, base_id FROM knowledge_files').all() as { rowid: number; file_path: string; base_id: string }[]
  const insert = database.prepare('INSERT INTO knowledge_fts(content, file_rowid, chunk_offset) VALUES (?, ?, ?)')
  let count = 0
  for (const row of rows) {
    const basePath = join(getBaseRawDir(row.base_id ?? 'default'), row.file_path)
    // Existing installs predate base isolation and still hold their raw files
    // in the legacy flat dir; fall back so a rebuild does not silently drop
    // every row on disk. `clearAllKnowledge` clears both locations.
    const fullPath = existsSync(basePath) ? basePath : join(KNOWLEDGE_RAW_DIR, row.file_path)
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
