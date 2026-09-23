import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, basename, dirname, relative } from 'node:path'
import { fork, execFile } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { fetchRenderedHtml } from '../browser/rendered-fetcher'
import {
  listKnowledgeFiles,
  getKnowledgeFile,
  getKnowledgeFileByPath,
  getKnowledgeFileByPathAndBase,
  getKnowledgeFileBySource,
  insertKnowledgeFile,
  deleteKnowledgeFile,
  updateKnowledgeFileStatus,
  getKnowledgeStats,
  knowledgeFtsAdd,
  searchKnowledgeFts,
  listKnowledgeBases,
  getKnowledgeBase,
  getKnowledgeBaseByName,
  insertKnowledgeBase,
  renameKnowledgeBase,
  deleteKnowledgeBase,
  setKnowledgeFileBase,
  type KnowledgeFileRow,
  type KnowledgeBaseRow
} from './knowledge.db'
import { getDb } from './database'
import { ripgrepBinary, parseRgLine } from '../utils/ripgrep'
import {
  KNOWLEDGE_DIR,
  KNOWLEDGE_SCHEMA_DIR,
  KNOWLEDGE_RAW_DIR,
  KNOWLEDGE_WIKI_DIR,
  getBaseRawDir,
  getBaseWikiDir
} from './index'
import type { KnowledgeFile, KnowledgeBase, KnowledgeStats, KnowledgeImportResult, KnowledgeListOptions, KnowledgeListResult } from '../../shared/types/knowledge'
import { stringToHue } from '../../shared/hash-color'
import { wikiPageSources, wikiPageIsOrphan } from '../../shared/knowledge/wiki'
export { wikiPageSources, wikiPageIsOrphan }

export interface ContentMatch {
  id: string
  filePath: string
  title: string
  sourceType: string
  excerpts: string[]
}

function toKnowledgeFile(row: KnowledgeFileRow): KnowledgeFile {
  return {
    id: row.id,
    filePath: row.file_path,
    title: row.title,
    sourceType: row.source_type as KnowledgeFile['sourceType'],
    sourceUrl: row.source_url,
    sourcePath: row.source_path,
    convId: row.conv_id,
    contentHash: row.content_hash,
    status: row.status as KnowledgeFile['status'],
    createdAt: row.created_at,
    compiledAt: row.compiled_at,
    wikiOutputs: row.wiki_outputs ? JSON.parse(row.wiki_outputs) : null,
    baseId: row.base_id
  }
}

/** Read a raw knowledge file from disk and add its content to the FTS5 index. */
export function syncKnowledgeFileToFts(id: string): void {
  const row = getDb().prepare('SELECT rowid, file_path, base_id FROM knowledge_files WHERE id = ?').get(id) as { rowid: number; file_path: string; base_id: string } | undefined
  if (!row) return
  const rawDir = getBaseRawDir(row.base_id)
  const fullPath = join(rawDir, row.file_path)
  if (!existsSync(fullPath)) return
  try {
    const content = readFileSync(fullPath, 'utf-8')
    knowledgeFtsAdd(row.rowid, content)
  } catch (err) {
    console.warn(`[knowledge] Failed to index FTS for ${row.file_path}:`, err)
  }
}

function generateId(): string {
  return `kf_${Date.now()}_${randomBytes(4).toString('hex')}`
}

/** Sanitize a string for use as a filename */
function sanitizeName(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_').slice(0, 100)
}

/** Format current time as "2026-07-18 09:47:12.366" (local time, no timezone) */
function localTimestamp(): string {
  const d = new Date()
  const pad = (n: number, len = 2) => n.toString().padStart(len, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

/** Strip leading YAML frontmatter (---...---) from markdown content */
function stripFrontmatter(content: string): string {
  const trimmed = content.trimStart()
  if (trimmed.startsWith('---')) {
    const end = trimmed.indexOf('---', 3)
    if (end !== -1) {
      return trimmed.slice(end + 3).trimStart()
    }
  }
  return content
}
function generateRawFilePath(originalName: string, rawDir: string): string {
  const date = new Date().toISOString().slice(0, 10)
  const base = sanitizeName(basename(originalName).replace(/\.[^.]+$/, ''))
  const name = `${date}_${base}`.slice(0, 180)
  let candidate = `${name}.md`
  let counter = 1
  while (existsSync(join(rawDir, candidate))) {
    candidate = `${name}_${counter}.md`
    counter++
  }
  return candidate
}

/** Build consistent YAML frontmatter for raw knowledge files */
function buildFrontmatter(fields: Record<string, string>): string {
  const lines = ['---']
  for (const [key, value] of Object.entries(fields)) {
    // Escape double quotes in values
    const escaped = value.replace(/"/g, '\\"')
    lines.push(`${key}: "${escaped}"`)
  }
  lines.push('---\n')
  return lines.join('\n') + '\n'
}

// ─── Public API ────────────────────────────────────────────────────────

export function listAllFiles(status?: string): KnowledgeFile[] {
  const result = listKnowledgeFiles(status ? { status: status as 'raw' | 'compiled' } : undefined)
  return result.items.map(toKnowledgeFile)
}

export function listAllFilesAdvanced(opts: KnowledgeListOptions): KnowledgeListResult {
  const result = listKnowledgeFiles(opts)
  return { ...result, items: result.items.map(toKnowledgeFile) }
}

// ─── Knowledge Bases ──────────────────────────────────────────────────

function generateBaseId(): string {
  return `kb_${Date.now()}_${randomBytes(4).toString('hex')}`
}

export function listAllBases(): KnowledgeBase[] {
  return listKnowledgeBases().map((b) => ({
    id: b.id,
    name: b.name,
    colorHue: b.color_hue,
    createdAt: b.created_at,
    fileCount: b.file_count
  }))
}

export function createKnowledgeBase(name: string): KnowledgeBase {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('知识库名不能为空')
  if (trimmed.length > 40) throw new Error('知识库名过长（最多 40 字）')
  if (getKnowledgeBaseByName(trimmed)) throw new Error(`知识库已存在: ${trimmed}`)
  const id = generateBaseId()
  insertKnowledgeBase({ id, name: trimmed, colorHue: stringToHue(trimmed) })
  // Create physical directories for the new base
  const rawDir = getBaseRawDir(id)
  const wikiDir = getBaseWikiDir(id)
  mkdirSync(rawDir, { recursive: true })
  mkdirSync(wikiDir, { recursive: true })
  return { id, name: trimmed, colorHue: stringToHue(trimmed), createdAt: new Date().toISOString(), fileCount: 0 }
}

export function renameKnowledgeBaseById(id: string, name: string): KnowledgeBase {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('知识库名不能为空')
  if (trimmed.length > 40) throw new Error('知识库名过长（最多 40 字）')
  const clash = getKnowledgeBaseByName(trimmed)
  if (clash && clash.id !== id) throw new Error(`知识库已存在: ${trimmed}`)
  if (!getKnowledgeBase(id)) throw new Error(`知识库不存在: ${id}`)
  renameKnowledgeBase(id, trimmed)
  const row = getKnowledgeBase(id)!
  return { id: row.id, name: row.name, colorHue: row.color_hue, createdAt: row.created_at }
}

/** Deleting a base removes its physical dirs and all files. Default base cannot be deleted. */
export function removeKnowledgeBase(id: string): void {
  if (!getKnowledgeBase(id)) throw new Error(`知识库不存在: ${id}`)
  deleteKnowledgeBase(id)
  // Remove physical directories
  const { rmSync } = require('node:fs') as typeof import('node:fs')
  try { rmSync(getBaseRawDir(id), { recursive: true, force: true }) } catch { /* ignore */ }
  try { rmSync(getBaseWikiDir(id), { recursive: true, force: true }) } catch { /* ignore */ }
}

/** Move one file between bases — the DB row AND its bytes (H3): the raw file
 *  is what every read path resolves through bases/<id>/raw, so a row-only
 *  move made the file unfindable (delete orphaned it, FTS froze, and deleting
 *  the OLD base later destroyed the bytes outright). Wiki outputs move with
 *  it when the destination has no page of the same name. */
export function moveKnowledgeFileToBase(id: string, baseId: string): KnowledgeFile {
  if (!getKnowledgeBase(baseId)) {
    throw new Error(`知识库不存在: ${baseId}`)
  }
  const row = getKnowledgeFile(id)
  if (!row) throw new Error(`Knowledge file not found: ${id}`)
  if (row.base_id === baseId) return toKnowledgeFile(row)

  const { renameSync } = require('node:fs') as typeof import('node:fs')
  const srcRaw = join(getBaseRawDir(row.base_id), row.file_path)
  if (existsSync(srcRaw)) {
    mkdirSync(getBaseRawDir(baseId), { recursive: true })
    const destRaw = join(getBaseRawDir(baseId), row.file_path)
    if (existsSync(destRaw)) {
      // Name collision: keep both by regenerating the raw file name (the
      // relative path is row-owned and self-contained, unlike wiki pages).
      const newPath = generateRawFilePath(row.file_path, getBaseRawDir(baseId))
      renameSync(srcRaw, join(getBaseRawDir(baseId), newPath))
      getDb().prepare('UPDATE knowledge_files SET file_path = ? WHERE id = ?').run(newPath, id)
    } else {
      renameSync(srcRaw, destRaw)
    }
  }

  const wikiOutputs: string[] = JSON.parse(row.wiki_outputs || '[]')
  const srcWikiDir = getBaseWikiDir(row.base_id)
  const destWikiDir = getBaseWikiDir(baseId)
  const movedWiki: string[] = []
  for (const wikiPath of wikiOutputs) {
    const src = join(srcWikiDir, wikiPath)
    if (!existsSync(src)) continue
    mkdirSync(destWikiDir, { recursive: true })
    const dest = join(destWikiDir, wikiPath)
    if (existsSync(dest)) continue // destination already has this page — leave the source copy alone
    renameSync(src, dest)
    movedWiki.push(wikiPath)
  }

  setKnowledgeFileBase(id, baseId)
  // Re-key the moved pages' wiki FTS rows so scoped wiki search follows.
  for (const wikiPath of movedWiki) {
    try {
      getDb().prepare('UPDATE knowledge_wiki_fts SET base_id = ? WHERE path = ? AND base_id = ?').run(baseId, wikiPath, row.base_id)
    } catch { /* table may not exist */ }
  }
  const updated = getKnowledgeFile(id)
  return updated ? toKnowledgeFile(updated) : toKnowledgeFile(row)
}

export function moveKnowledgeFilesToBase(ids: string[], baseId: string): number {
  let moved = 0
  for (const id of ids) {
    try {
      moveKnowledgeFileToBase(id, baseId)
      moved++
    } catch { /* a missing row/base must not strand the rest of the batch */ }
  }
  return moved
}

export function getFile(id: string): KnowledgeFile | null {
  const row = getKnowledgeFile(id)
  return row ? toKnowledgeFile(row) : null
}


export function deleteFile(id: string): void {
  const row = getKnowledgeFile(id)
  if (!row) return
  const wikiOutputs: string[] = JSON.parse(row.wiki_outputs || '[]')
  const wikiDir = getBaseWikiDir(row.base_id)
  const rawDir = getBaseRawDir(row.base_id)

  for (const wikiPath of wikiOutputs) {
    const fullPath = join(wikiDir, wikiPath)
    let content: string | null = null
    try { content = existsSync(fullPath) ? readFileSync(fullPath, 'utf-8') : null } catch { content = null }
    const survivors = listAllFiles().filter((f) => f.id !== id)
    const others = survivors.map((f) => f.wikiOutputs ?? [])
    const existingRawPaths = survivors.map((f) => f.filePath)
    if (!wikiPageIsOrphan(content, wikiPath, row.file_path, others, existingRawPaths)) {
      console.log(`[knowledge] Wiki page ${wikiPath} is still referenced — kept`)
      continue
    }
    try { unlinkSync(fullPath) } catch { /* already gone */ }
    wikiFtsRemove(wikiPath, row.base_id)
  }

  const rawPath = join(rawDir, row.file_path)
  try { unlinkSync(rawPath) } catch { /* ignore */ }
  deleteKnowledgeFile(id)

  try { rebuildWikiIndex(row.base_id) } catch { /* index rebuild is best-effort */ }
}

export function getStats(baseId?: string): KnowledgeStats {
  const base = getKnowledgeStats(baseId)
  let wikiFileCount = 0
  try {
    const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs')
    const countFiles = (dir: string) => {
      if (!existsSync(dir)) return
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) countFiles(full)
        else if (entry.endsWith('.md')) wikiFileCount++
      }
    }
    if (baseId !== undefined) {
      countFiles(getBaseWikiDir(baseId))
    } else {
      // Count across all bases
      try {
        for (const b of listKnowledgeBases()) countFiles(getBaseWikiDir(b.id))
      } catch { /* bases dir may not exist */ }
    }
  } catch { /* wiki dir may not exist */ }
  return { ...base, wikiFileCount }
}

/** Update a knowledge file's status to compiled, optionally storing generated wiki paths */
export function markFileCompiled(id: string, wikiOutputs?: string[]): void {
  updateKnowledgeFileStatus(id, 'compiled', wikiOutputs)
}

/** Wiki pages live in exactly four directories — anything else is refused,
 *  not sanitized (K1: rewriting `../` away let a model-issued path land where
 *  it should not; refusing surfaces the problem instead). Mirrors the
 *  compiler-side validator in KnowledgeCompilerAgent. */
const WIKI_PAGE_PATH_RE = /^(sources|entities|concepts|syntheses)\/[A-Za-z0-9._-]+\.md$/

export function isValidWikiPagePath(filePath: string): boolean {
  return WIKI_PAGE_PATH_RE.test(filePath) && !/(^|\/)(index|log)\.md$/.test(filePath)
}

/** Apply a batch of wiki changes: write files, update index, update log.
 *  K1: invalid paths throw (the whole batch is suspect) instead of being
 *  silently rewritten. */
export function applyWikiChanges(actions: { filePath: string; content: string }[], baseId: string = 'default'): number {
  const wikiDir = getBaseWikiDir(baseId)
  let count = 0
  for (const action of actions) {
    if (!isValidWikiPagePath(action.filePath)) {
      throw new Error(`非法的 wiki 页面路径，已拒绝写入: ${action.filePath.slice(0, 100)}`)
    }
    const fullPath = join(wikiDir, action.filePath)
    const dir = dirname(fullPath)
    try {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      writeFileSync(fullPath, action.content, 'utf-8')
      count++
      wikiFtsUpsert(action.filePath, action.content, '', baseId)
    } catch (err) {
      console.error(`[knowledge] Failed to write wiki file ${action.filePath}:`, err)
    }
  }
  return count
}

// ── Wiki page FTS (PLAN-knowledge-base K4) ──

/** Insert/replace one wiki page's row, keyed by (base, wiki-relative path). */
export function wikiFtsUpsert(wikiPath: string, content: string, title = '', baseId: string = 'default'): void {
  const db = getDb()
  db.prepare('DELETE FROM knowledge_wiki_fts WHERE path = ? AND base_id = ?').run(wikiPath, baseId)
  db.prepare('INSERT INTO knowledge_wiki_fts(title, content, path, base_id) VALUES (?, ?, ?, ?)').run(title, content, wikiPath, baseId)
}

export function wikiFtsRemove(wikiPath: string, baseId: string = 'default'): void {
  try { getDb().prepare('DELETE FROM knowledge_wiki_fts WHERE path = ? AND base_id = ?').run(wikiPath, baseId) } catch { /* table may not exist yet */ }
}

export function wikiFtsCount(baseId?: string): number {
  try {
    if (baseId === undefined) {
      return (getDb().prepare('SELECT COUNT(*) as c FROM knowledge_wiki_fts').get() as { c: number }).c
    }
    return (getDb().prepare('SELECT COUNT(*) as c FROM knowledge_wiki_fts WHERE base_id = ?').get(baseId) as { c: number }).c
  } catch { return 0 }
}

/** Full rebuild of the wiki FTS table from all bases' page files on disk. */
export function rebuildWikiFts(): void {
  const db = getDb()
  db.exec('DELETE FROM knowledge_wiki_fts')
  const subdirs = ['sources', 'entities', 'concepts', 'syntheses']
  let count = 0
  for (const b of listKnowledgeBases()) {
    const wikiDir = getBaseWikiDir(b.id)
    if (!existsSync(wikiDir)) continue
    for (const subdir of subdirs) {
      const dirPath = join(wikiDir, subdir)
      if (!existsSync(dirPath)) continue
      for (const entry of readdirSync(dirPath)) {
        if (!entry.endsWith('.md')) continue
        const full = join(dirPath, entry)
        if (!statSync(full).isFile()) continue
        try {
          const content = readFileSync(full, 'utf-8')
          const wikiPath = `${subdir}/${entry}`
          const titleMatch = content.match(/^title:\s*"?(.+?)"?\s*$/m)
          wikiFtsUpsert(wikiPath, content, titleMatch?.[1] ?? '', b.id)
          count++
        } catch { /* unreadable page: skip */ }
      }
    }
  }
  console.log(`[knowledge] Rebuilt knowledge_wiki_fts: ${count} pages indexed`)
}

/** Wiki page files across every base (the four page dirs, K4's sync baseline). */
export function countWikiPageFiles(): number {
  const subdirs = ['sources', 'entities', 'concepts', 'syntheses']
  let count = 0
  for (const b of listKnowledgeBases()) {
    for (const subdir of subdirs) {
      const dirPath = join(getBaseWikiDir(b.id), subdir)
      if (!existsSync(dirPath)) continue
      for (const entry of readdirSync(dirPath)) {
        if (entry.endsWith('.md') && statSync(join(dirPath, entry)).isFile()) count++
      }
    }
  }
  return count
}

/** Append an entry to a base's wiki/log.md */
export function appendWikiLog(entry: string, baseId: string = 'default'): void {
  const wikiDir = getBaseWikiDir(baseId)
  if (!existsSync(wikiDir)) mkdirSync(wikiDir, { recursive: true })
  const logPath = join(wikiDir, 'log.md')
  const timestamp = new Date().toISOString()
  const line = `- ${timestamp} — ${entry}\n`
  if (!existsSync(logPath)) {
    writeFileSync(logPath, `# Wiki Operation Log\n\n${line}`, 'utf-8')
  } else {
    writeFileSync(logPath, readFileSync(logPath, 'utf-8') + line, 'utf-8')
  }
}

/** Read raw file content by its relative path within a knowledge base. */
export function readRawContent(relativePath: string, baseId: string = 'default'): string {
  const fullPath = join(getBaseRawDir(baseId), relativePath)
  if (!existsSync(fullPath)) throw new Error(`Raw file not found: ${relativePath}`)
  return readFileSync(fullPath, 'utf-8')
}

/** Read wiki file content by its relative path within a knowledge base. Returns null when file doesn't exist. */
export function readWikiContent(relativePath: string, baseId: string = 'default'): string | null {
  const fullPath = join(getBaseWikiDir(baseId), relativePath)
  if (!existsSync(fullPath)) return null
  return readFileSync(fullPath, 'utf-8')
}

/** Search raw file content — ripgrep first, fallback to FTS5. */
export async function searchContent(query: string, baseId?: string): Promise<ContentMatch[]> {
  if (!query) return ftsContentSearch(query, baseId)

  // When searching a specific base, only rg that base's raw dir
  if (baseId !== undefined) {
    const rawDir = getBaseRawDir(baseId)
    if (existsSync(rawDir)) {
      const rgResults = await searchContentViaRipgrep(query, rawDir, baseId)
      if (rgResults.length > 0) return rgResults
    }
    return ftsContentSearch(query, baseId)
  }

  // Search all bases
  let allResults: ContentMatch[] = []
  for (const b of listKnowledgeBases()) {
    const rawDir = getBaseRawDir(b.id)
    if (!existsSync(rawDir)) continue
    const rgResults = await searchContentViaRipgrep(query, rawDir, b.id)
    allResults.push(...rgResults)
  }
  if (allResults.length > 0) return allResults
  return ftsContentSearch(query, baseId)
}

function ftsContentSearch(query: string, baseId?: string): ContentMatch[] {
  const ftsResults = searchKnowledgeFts(query, 10, baseId)
  return ftsResults.map(r => ({
    id: r.id,
    filePath: r.filePath,
    title: r.title,
    sourceType: r.sourceType,
    excerpts: r.excerpt ? [r.excerpt] : []
  }))
}

/** Run ripgrep on raw knowledge files. Multi-keyword queries use -F -e for OR.
 *  `baseId` is the dir's owning base — relative paths repeat per base, so the
 *  DB row must be resolved against the SAME base the scan ran in (M15). */
async function searchContentViaRipgrep(query: string, rawDir: string, baseId: string): Promise<ContentMatch[]> {
  return new Promise((resolve) => {
    const terms = query.trim().split(/\s+/).filter(Boolean)
    if (terms.length === 0) { resolve([]); return }

    const args = ['-n', '--no-heading', '-i', '--max-columns', '300', '--max-count', '5']
    if (terms.length > 1) {
      args.push('-F')
      for (const t of terms) args.push('-e', t)
    } else {
      args.push(query)
    }
    args.push(rawDir)

    execFile(ripgrepBinary(), args, { timeout: 10000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) { resolve([]); return }

      const fileMap = new Map<string, string[]>()
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue
        const parsed = parseRgLine(line)
        if (!parsed) continue
        const relPath = relative(rawDir, parsed.absPath)
        if (!relPath) continue
        const excerpts = fileMap.get(relPath) || []
        if (excerpts.length < 3) excerpts.push(parsed.content.slice(0, 200))
        fileMap.set(relPath, excerpts)
      }

      const results: ContentMatch[] = []
      for (const [relPath, excerpts] of fileMap) {
        const file = getKnowledgeFileByPathAndBase(relPath, baseId)
        if (file) {
          results.push({ id: file.id, filePath: relPath, title: file.title, sourceType: file.source_type, excerpts })
        }
      }
      resolve(results)
    })
  })
}

/** List wiki directory structure (for browsing) */
export function listWikiFiles(subdir?: string, baseId: string = 'default'): string[] {
  const wikiDir = getBaseWikiDir(baseId)
  const root = subdir ? join(wikiDir, subdir) : wikiDir
  if (!existsSync(root)) return []
  const results: string[] = []
  const entries = readdirSync(root)
  for (const entry of entries) {
    const full = join(root, entry)
    if (statSync(full).isFile()) {
      results.push(subdir ? `${subdir}/${entry}` : entry)
    }
  }
  return results.sort()
}

// ─── Extract in child process ─────────────────────────────────────────

/** Resolve the worker path relative to the main process build output */
function getWorkerPath(): string {
  return join(__dirname, 'extract-worker.js')
}

/** Run extractFile in a forked child process so the main process isn't blocked */
function extractInWorker(filePath: string): Promise<{ title: string; content: string }> {
  return new Promise((resolve, reject) => {
    const workerPath = getWorkerPath()
    if (!existsSync(workerPath)) {
      reject(new Error(`Extraction worker not found at ${workerPath}. Run build first.`))
      return
    }

    const child = fork(workerPath, [], { stdio: 'pipe', silent: true })
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error('Extraction timed out after 300s'))
    }, 300_000)

    child.on('message', (msg: any) => {
      clearTimeout(timeout)
      child.kill() // ensure child process doesn't accumulate
      if (msg.success) {
        resolve({ title: msg.title, content: msg.content })
      } else {
        reject(new Error(msg.error || 'Unknown extraction error'))
      }
    })

    child.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })

    child.on('exit', (code) => {
      clearTimeout(timeout)
      if (code !== 0) reject(new Error(`Extraction worker exited with code ${code}`))
    })

    child.send({ type: 'extract', filePath })
  })
}

// ─── Batch extraction (K11①): one worker, many files ───────────────────

/** Extract several files through ONE forked worker: the protocol accepts
 *  repeated {type:'extract'} messages, so a folder import no longer pays one
 *  process spawn per file (measured: the dominant cost of large imports).
 *  Results keep input order; a failed extraction yields its error entry. */
export async function extractManyInWorker(filePaths: string[]): Promise<Array<{ ok: true; title: string; content: string } | { ok: false; error: string }>> {
  if (filePaths.length === 0) return []
  const workerPath = getWorkerPath()
  if (!existsSync(workerPath)) {
    throw new Error(`Extraction worker not found at ${workerPath}. Run build first.`)
  }
  return new Promise((resolve) => {
    const child = fork(workerPath, [], { stdio: 'pipe', silent: true })
    const results: Array<{ ok: true; title: string; content: string } | { ok: false; error: string }> = []
    const timeout = setTimeout(() => {
      child.kill()
      resolve(filePaths.map(() => ({ ok: false, error: 'Extraction timed out after 300s' })))
    }, 300_000)
    child.on('message', (msg: any) => {
      results.push(msg.success
        ? { ok: true, title: msg.title, content: msg.content }
        : { ok: false, error: msg.error || 'Unknown extraction error' })
      if (results.length === filePaths.length) {
        clearTimeout(timeout)
        child.kill()
        resolve(results)
        return
      }
      child.send({ type: 'extract', filePath: filePaths[results.length] })
    })
    child.on('error', (err) => {
      clearTimeout(timeout)
      resolve(filePaths.map(() => ({ ok: false, error: err.message })))
    })
    child.on('exit', (code) => {
      clearTimeout(timeout)
      if (results.length < filePaths.length) {
        while (results.length < filePaths.length) results.push({ ok: false, error: `Extraction worker exited with code ${code}` })
        resolve(results)
      }
    })
    child.send({ type: 'extract', filePath: filePaths[0] })
  })
}

// ─── Prepare Import ──────────────────────────────────────────────────

/** SQLite's default SQLITE_MAX_VARIABLE_NUMBER is 999 — chunk well under it so
 *  a 10k-path scan stays a couple dozen statements, not 10k prepared queries. */
const PREPARE_IMPORT_CHUNK = 500

/** Check each file path against the DB; return paths sorted into existing and new.
 *  `baseId` scopes the check (M16) — the same file may legally live in two bases.
 *
 *  One `WHERE source_path IN (…)` per 500-path chunk instead of one query per
 *  path: preparing and running a statement per file is the second freeze source
 *  in 「导入大批量文件时会卡死」 (every statement is synchronous main-process
 *  work). Semantics are unchanged: output follows input order, a duplicate
 *  input still appears once per occurrence, and the predicate is exactly the
 *  per-path one (`source_path = ? [AND base_id = ?]`, no `source_url` — that
 *  caller passed `undefined`), with the first row per path winning as `.get()`
 *  would have. */
export function prepareImport(filePaths: string[], baseId?: string): { existing: { id: string; filePath: string }[]; new: string[] } {
  const existing: { id: string; filePath: string }[] = []
  const newFiles: string[] = []
  const found = new Map<string, string>()
  const clause = baseId !== undefined ? ' AND base_id = ?' : ''
  for (let i = 0; i < filePaths.length; i += PREPARE_IMPORT_CHUNK) {
    const chunk = filePaths.slice(i, i + PREPARE_IMPORT_CHUNK)
    const placeholders = chunk.map(() => '?').join(', ')
    const params: unknown[] = [...chunk]
    if (baseId !== undefined) params.push(baseId)
    const rows = getDb()
      .prepare(`SELECT id, source_path FROM knowledge_files WHERE source_path IN (${placeholders})${clause}`)
      .all(...params) as { id: string; source_path: string | null }[]
    for (const row of rows) {
      if (row.source_path !== null && !found.has(row.source_path)) found.set(row.source_path, row.id)
    }
  }
  for (const fp of filePaths) {
    const id = found.get(fp)
    if (id !== undefined) {
      existing.push({ id, filePath: fp })
    } else {
      newFiles.push(fp)
    }
  }
  return { existing, new: newFiles }
}

// ─── Base64 image extraction ──────────────────────────────────────────

const MIME_TO_EXT: Record<string, string> = {
  'png': '.png', 'jpeg': '.jpg', 'jpg': '.jpg', 'gif': '.gif',
  'webp': '.webp', 'svg+xml': '.svg', 'bmp': '.bmp', 'tiff': '.tiff'
}

/**
 * Extract base64-embedded images from markdown content and save them locally.
 * Images are deduplicated by content hash so repeated imports don't create duplicates.
 * Replaces data URIs with local-file:// references so images remain viewable without
 * bloating the wiki compilation. The reference names the file's OWN base (M17):
 * the bytes land in bases/<id>/raw/images/, so a reference to the legacy flat
 * dir was a broken link for every import after the multi-base move.
 */
function extractBase64Images(content: string, rawDir: string, baseId: string): string {
  const imgDir = join(rawDir, 'images')
  mkdirSync(imgDir, { recursive: true })
  const refBase = baseId || 'default'
  return content.replace(/!\[.*?\]\(data:image\/([a-zA-Z+]+);base64,([^)]+)\)/g, (_match, mime: string, b64: string) => {
    const ext = MIME_TO_EXT[mime] || '.bin'
    let buf: Buffer
    try {
      const clean = b64.replace(/\s/g, '')
      buf = Buffer.from(clean, 'base64')
    } catch {
      return _match
    }
    const hash = createHash('sha256').update(buf).digest('hex').slice(0, 16)
    const filename = `${hash}${ext}`
    const destPath = join(imgDir, filename)
    try {
      writeFileSync(destPath, buf)
    } catch {
      // File may already exist from a previous import — that's fine
    }
    return `![image](local-file:///.pulsemind/knowledge/bases/${refBase}/raw/images/${filename})`
  })
}

// ─── Import ────────────────────────────────────────────────────────────

/** Import a local file: extract → normalize to MD → write to raw/ */
export async function importLocalFile(filePath: string): Promise<KnowledgeImportResult> {
  const [result] = await importLocalFiles([filePath])
  return result
}

/** K11: folder import through ONE worker session, content-hashed on the
 *  extracted body. G4: `baseId` lands every imported file in that base. */
export async function importLocalFiles(filePaths: string[], baseId?: string): Promise<KnowledgeImportResult[]> {
  const extractions = await extractManyInWorker(filePaths)
  const results: KnowledgeImportResult[] = []
  for (let i = 0; i < filePaths.length; i++) {
    const filePath = filePaths[i]
    const extraction = extractions[i]
    if (!extraction.ok) {
      results.push({ success: false, error: extraction.error })
      continue
    }
    results.push(ingestExtractedFile(filePath, extraction, baseId))
  }
  return results
}

function ingestExtractedFile(filePath: string, extraction: { title: string; content: string }, baseId?: string): KnowledgeImportResult {
  try {
    if (!existsSync(filePath)) {
      return { success: false, error: `File not found: ${filePath}` }
    }
    const targetBaseId = baseId ?? 'default'
    if (getKnowledgeFileBySource(filePath, undefined, targetBaseId)) {
      return { success: false, duplicate: true, error: `Already exists in this base: ${filePath}` }
    }

    let cleanContent = stripFrontmatter(extraction.content)
    const contentHash = createHash('sha256').update(cleanContent).digest('hex')
    const byContent = getDb().prepare('SELECT id, source_path, base_id FROM knowledge_files WHERE content_hash = ? AND base_id = ? LIMIT 1').get(contentHash, targetBaseId) as { id: string; source_path: string | null; base_id: string } | undefined
    if (byContent) {
      return { success: false, duplicate: true, error: `内容重复：与知识库「${byContent.base_id}」中已导入的 ${byContent.source_path ?? byContent.id} 内容相同` }
    }
    const rawDir = getBaseRawDir(targetBaseId)
    mkdirSync(rawDir, { recursive: true })
    const relativePath = generateRawFilePath(filePath, rawDir)
    const destPath = join(rawDir, relativePath)
    const displayTitle = basename(filePath).replace(/\.[^.]+$/, '')
    const id = generateId()

    cleanContent = extractBase64Images(cleanContent, rawDir, targetBaseId)

    const frontmatter = buildFrontmatter({
      title: displayTitle,
      source_type: 'file',
      source_path: filePath,
      extracted: localTimestamp()
    })
    writeFileSync(destPath, frontmatter + cleanContent, 'utf-8')
    insertKnowledgeFile({
      id,
      filePath: relativePath,
      title: displayTitle,
      sourceType: 'file',
      sourcePath: filePath,
      contentHash,
      baseId: targetBaseId
    })

    syncKnowledgeFileToFts(id)
    return { success: true, file: getFile(id)! }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { success: false, error: message }
  }
}

/** K11③: re-run extraction for an existing source — the raw file is
 *  overwritten, the row returns to `raw` (wiki_outputs cleared), and the FTS
 *  is re-synced. The compile queue picks it up from the status. */
export async function reextractKnowledge(id: string): Promise<KnowledgeImportResult> {
  const row = getKnowledgeFile(id)
  if (!row) return { success: false, error: `Knowledge file not found: ${id}` }
  if (!row.source_path) return { success: false, error: '该源没有本地文件路径（URL/收藏/经验源请删除后重新导入）' }
  if (!existsSync(row.source_path)) return { success: false, error: `源文件不存在: ${row.source_path}` }
  const extraction = await extractInWorker(row.source_path)
  let cleanContent = stripFrontmatter(extraction.content)
  const rawDir = getBaseRawDir(row.base_id)
  cleanContent = extractBase64Images(cleanContent, rawDir, row.base_id)
  const contentHash = createHash('sha256').update(cleanContent).digest('hex')
  const fullPath = join(rawDir, row.file_path)
  writeFileSync(fullPath, cleanContent, 'utf-8')
  getDb().prepare("UPDATE knowledge_files SET content_hash = ?, status = 'raw', wiki_outputs = NULL, compiled_at = NULL WHERE id = ?").run(contentHash, id)
  syncKnowledgeFileToFts(id)
  return { success: true, file: getFile(id)! }
}

// ── URL import cancellation ──
let _importAbortController: AbortController | null = null

export function abortKnowledgeImport(): void {
  _importAbortController?.abort()
}

/** Import a remote URL: rendered fetch → Readability → turndown → write to base raw/ */
export async function importUrl(url: string, baseId?: string): Promise<KnowledgeImportResult> {
  // Validate URL format — only http/https allowed
  if (!/^https?:\/\/.+/.test(url)) {
    return { success: false, error: `不支持的链接格式: ${url.slice(0, 100)}。仅支持 http/https 链接。` }
  }

  // Create new AbortController for this import
  _importAbortController?.abort() // cancel any previous in-flight import
  _importAbortController = new AbortController()
  const signal = _importAbortController.signal

  try {
    if (signal.aborted) return { success: false, error: 'cancelled' }
    // Render through the native browser for full JS-rendered content
    const html = await fetchRenderedHtml(url, signal)
    if (signal.aborted) return { success: false, error: 'cancelled' }
    if (!html) return { success: false, error: 'Failed to fetch rendered URL' }

    const existingRow = getKnowledgeFileBySource('', url, baseId ?? 'default')
    if (existingRow) {
      return { success: false, duplicate: true, file: toKnowledgeFile(existingRow), error: `Already exists: ${url}` }
    }

    // Use jsdom + Readability + turndown (same as html-extractor)
    const { JSDOM } = await import('jsdom')
    const { Readability } = await import('@mozilla/readability')
    const TurndownService = (await import('turndown')).default

    const dom = new JSDOM(html, { url })
    const document = dom.window.document
    document.querySelectorAll('script, style').forEach(function(el) { (el as Element).parentNode && (el as Element).parentNode!.removeChild(el as Element) })

    // Extract text from SVG <text>/<tspan> nodes and inject as regular HTML
    // (Word Online and similar tools render document content in SVG, which
    // Readability doesn't handle — making text invisible to extraction)
    const svgTexts: string[] = []
    document.querySelectorAll('svg text, svg tspan').forEach(el => {
      const t = el.textContent?.trim()
      if (t) svgTexts.push(t)
    })
    if (svgTexts.length > 0) {
      const container = document.createElement('div')
      container.innerHTML = svgTexts.map(t => `<p>${t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`).join('')
      document.body.appendChild(container)
    }

    const reader = new Readability(document)
    const article = reader.parse()

    let contentHtml: string
    if (article?.content && article.content.length >= 500) {
      contentHtml = article.content
    } else {
      // Readability extracted too little — try raw textContent
      // (handles SVG-heavy pages like online editors where content is in <text> nodes)
      contentHtml = document.body?.textContent?.trim() || html
    }
    const turndownService = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
    const markdown = turndownService.turndown(contentHtml)
    let cleanMarkdown = stripFrontmatter(markdown)

    const title = article?.title || url
    const slug = sanitizeName(title).slice(0, 60)
    const relativePath = `url_${slug}.md`
    const targetBaseId = baseId ?? 'default'
    const rawDir = getBaseRawDir(targetBaseId)
    mkdirSync(rawDir, { recursive: true })
    const destPath = join(rawDir, relativePath)
    const id = generateId()

    // Extract base64 images to local files before writing
    cleanMarkdown = extractBase64Images(cleanMarkdown, rawDir, targetBaseId)

    const frontmatter = buildFrontmatter({
      title,
      source_type: 'url',
      source_url: url,
      extracted: localTimestamp()
    })
    writeFileSync(destPath, frontmatter + cleanMarkdown, 'utf-8')

    insertKnowledgeFile({
      id,
      filePath: relativePath,
      title,
      sourceType: 'url',
      sourceUrl: url,
      baseId: targetBaseId
    })

    syncKnowledgeFileToFts(id)
    return { success: true, file: getFile(id)! }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { success: false, error: message }
  } finally {
    if (_importAbortController?.signal === signal) {
      _importAbortController = null
    }
  }
}

/** Save an extracted experience as a raw knowledge file */
export function saveExperienceToRaw(content: string, convId: string, title?: string, baseId?: string): KnowledgeFile {
  const date = new Date().toISOString().slice(0, 10)
  const displayTitle = title || `Experience from ${convId.slice(0, 8)}`
  const slug = sanitizeName(displayTitle).slice(0, 60)
  const relativePath = `experience_${slug}_${date}.md`
  const targetBaseId = baseId ?? 'default'
  // Scoped to the target base (M16): a same-named file in ANOTHER base is not
  // this experience, and returning it would hand the caller a foreign row.
  const existing = getKnowledgeFileByPathAndBase(relativePath, targetBaseId)
  if (existing) {
    console.log(`[knowledge-store] Experience already exists: ${relativePath}, skipping duplicate`)
    return toKnowledgeFile(existing)
  }
  const rawDir = getBaseRawDir(targetBaseId)
  mkdirSync(rawDir, { recursive: true })
  const destPath = join(rawDir, relativePath)

  const frontmatter = buildFrontmatter({
    title: displayTitle,
    source_type: 'experience',
    source_conv_id: convId,
    extracted: localTimestamp()
  })
  writeFileSync(destPath, frontmatter + stripFrontmatter(content), 'utf-8')

  const id = generateId()
  insertKnowledgeFile({
    id,
    filePath: relativePath,
    title: displayTitle,
    sourceType: 'experience',
    convId,
    baseId: targetBaseId
  })

  syncKnowledgeFileToFts(id)
  return getFile(id)!
}

// ─── Favorite capture (PLAN-settings-restructure P2) ──────────────────────

export interface FavoriteSaveInput {
  content: string
  messageId: string
  conversationId: string
  title?: string
}

/** Pure: validate the renderer's payload. Throws with a user-facing message. */
export function validateFavoriteInput(input: FavoriteSaveInput): void {
  if (!input || typeof input !== 'object') throw new Error('收藏内容不能为空')
  for (const [key, min] of [['content', 1], ['messageId', 1], ['conversationId', 1]] as const) {
    const value = (input as unknown as Record<string, unknown>)[key]
    if (typeof value !== 'string' || value.trim().length < min) {
      throw new Error(`收藏缺少 ${key}，无法录入知识库`)
    }
  }
  if (input.title !== undefined && typeof input.title !== 'string') {
    throw new Error('收藏标题格式不正确')
  }
}

/** Pure: the raw filename for a favorite. Hashed over conversation+message —
 *  a message id is app-generated but never trust it as path material, and the
 *  hash keeps double-click / replay / restart idempotent on exactly one file. */
export function favoriteRawFileName(conversationId: string, messageId: string): string {
  const hash = createHash('sha256')
    .update(`${conversationId}\u0000${messageId}`)
    .digest('hex')
    .slice(0, 24)
  return `favorite_${hash}.md`
}

/** Pure: the YAML frontmatter block (including its trailing newline) for a favorite raw file. */
export function buildFavoriteFrontmatter(input: { title: string; conversationId: string; messageId: string; savedAt: string }): string {
  return buildFrontmatter({
    title: input.title,
    source_type: 'favorite',
    source_conv_id: input.conversationId,
    source_msg_id: input.messageId,
    saved: input.savedAt
  })
}

/** Pure: display title for a favorite (falls back to a snippet of the content). */
export function favoriteDisplayTitle(content: string, title?: string): string {
  const clean = sanitizeName(title ?? '').trim()
  if (clean) return clean.slice(0, 100)
  return content.replace(/\s+/g, ' ').trim().slice(0, 60) || '收藏'
}

/**
 * Save a starred message into the knowledge base as `raw/favorite_<hash>.md`.
 * Idempotent per (conversationId, messageId): a second save returns the existing
 * row without rewriting anything. The DB row, its FTS index, and the message's
 * favorited marker are stamped inside one IMMEDIATE transaction, and the raw
 * file only stays written when that whole transaction commits — so a failed
 * capture never leaves a marker, an orphan file, or a half-index behind, and a
 * retry replays cleanly (re-reading the file repairs an incomplete FTS row).
 */
export function saveFavoriteToRaw(content: string, opts: { conversationId: string; messageId: string; title?: string; baseId?: string }): KnowledgeFile {
  const input = { content, ...opts }
  validateFavoriteInput(input)

  const targetBaseId = opts.baseId ?? 'default'
  const rawDir = getBaseRawDir(targetBaseId)
  mkdirSync(rawDir, { recursive: true })

  const relativePath = favoriteRawFileName(opts.conversationId, opts.messageId)
  const fullPath = join(rawDir, relativePath)
  const database = getDb()
  let createdRaw = false
  try {
    // IMMEDIATE serializes the lookup + insert across connections as well as
    // double clicks. No await occurs while this transaction owns the write lock.
    return database.transaction(() => {
      const message = database.prepare(
        'SELECT 1 FROM messages WHERE id = ? AND conversation_id = ?'
      ).get(opts.messageId, opts.conversationId)
      if (!message) throw new Error('消息尚未保存或不属于此会话，请稍后重试')

      const existing = getKnowledgeFileByPath(relativePath)
      const displayTitle = existing?.title ?? favoriteDisplayTitle(content, opts.title)
      if (!existing || !existsSync(fullPath)) {
        const frontmatter = buildFavoriteFrontmatter({
          title: displayTitle,
          conversationId: opts.conversationId,
          messageId: opts.messageId,
          savedAt: localTimestamp()
        })
        // Mark before writing so even a partial filesystem write is cleaned up.
        createdRaw = !existsSync(fullPath)
        writeFileSync(fullPath, frontmatter + stripFrontmatter(content), 'utf-8')
      }
      const id = existing?.id ?? generateId()
      if (!existing) insertKnowledgeFile({
        id,
        filePath: relativePath,
        title: displayTitle,
        sourceType: 'favorite',
        convId: opts.conversationId,
        contentHash: createHash('sha256').update(content).digest('hex')
      })

      // Unlike the best-effort import indexer, capture MUST propagate failures.
      // A replay verifies the raw file and repairs any incomplete old index.
      const row = database.prepare('SELECT rowid FROM knowledge_files WHERE id = ?').get(id) as { rowid: number }
      knowledgeFtsAdd(row.rowid, readFileSync(fullPath, 'utf-8'))
      database.prepare('UPDATE messages SET favorited = 1 WHERE id = ? AND conversation_id = ?')
        .run(opts.messageId, opts.conversationId)
      const file = getFile(id)
      if (!file) throw new Error('收藏已写入但无法读回知识库记录')
      return file
    }).immediate()
  } catch (error) {
    if (createdRaw) {
      try { unlinkSync(fullPath) } catch { /* an orphan is safe to overwrite on retry */ }
    }
    throw error
  }
}

/** Remove every file under `dir`, returning how many were unlinked. */
function removeDirContents(dir: string): number {
  const { rmSync } = require('node:fs') as typeof import('node:fs')
  if (!existsSync(dir)) return 0
  let removed = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      removed += removeDirContents(full)
      try { rmSync(full, { recursive: true, force: true }) } catch { /* ignore */ }
    } else {
      try { unlinkSync(full); removed++ } catch { /* ignore */ }
    }
  }
  return removed
}

/** Clear all knowledge: delete every base's files, the pre-refactor flat dirs,
 *  and all DB records. */
export function clearAllKnowledge(): { deletedRaw: number; deletedWiki: number } {
  let deletedRaw = 0
  let deletedWiki = 0

  // Every base's own raw + wiki files
  for (const b of listKnowledgeBases()) {
    deletedRaw += removeDirContents(getBaseRawDir(b.id))
    deletedWiki += removeDirContents(getBaseWikiDir(b.id))
  }

  // Pre-refactor installs kept files in flat knowledge/raw and knowledge/wiki.
  // The current pipeline never reads them, so reset removes them (and the dirs,
  // which ensureDataDir no longer recreates).
  deletedRaw += removeDirContents(KNOWLEDGE_RAW_DIR)
  deletedWiki += removeDirContents(KNOWLEDGE_WIKI_DIR)
  const { rmSync } = require('node:fs') as typeof import('node:fs')
  for (const dir of [KNOWLEDGE_RAW_DIR, KNOWLEDGE_WIKI_DIR]) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }

  const { getDb } = require('./database') as typeof import('./database')
  getDb().prepare('DELETE FROM knowledge_files').run()
  getDb().prepare('DELETE FROM knowledge_fts').run()
  try { getDb().prepare('DELETE FROM knowledge_wiki_fts').run() } catch { /* table may not exist */ }

  return { deletedRaw, deletedWiki }
}

/** R4: wipe every compiled page in a base and return its sources to raw. */
export function rebuildWiki(baseId?: string): { clearedPages: number; resetSources: number } {
  let clearedPages = 0
  const bases = baseId ? [listKnowledgeBases().find(b => b.id === baseId)].filter(Boolean) as KnowledgeBaseRow[] : listKnowledgeBases()
  for (const b of bases) {
    const wikiDir = getBaseWikiDir(b.id)
    if (!existsSync(wikiDir)) continue
    for (const subdir of ['sources', 'entities', 'concepts', 'syntheses']) {
      const dir = join(wikiDir, subdir)
      if (!existsSync(dir)) continue
      for (const entry of readdirSync(dir)) {
        if (!entry.endsWith('.md')) continue
        try { unlinkSync(join(dir, entry)); clearedPages++ } catch { /* ignore */ }
      }
    }
    for (const f of ['index.md', 'log.md']) {
      try { unlinkSync(join(wikiDir, f)) } catch { /* already gone */ }
    }
  }
  // M14: only the rebuilt scope loses its FTS rows — wiping every base's wiki
  // index degraded all the OTHER bases' searches to the unranked rg fallback
  // until the next startup.
  try {
    if (baseId !== undefined) {
      getDb().prepare('DELETE FROM knowledge_wiki_fts WHERE base_id = ?').run(baseId)
    } else {
      getDb().prepare('DELETE FROM knowledge_wiki_fts').run()
    }
  } catch { /* table may not exist */ }

  const clause = baseId !== undefined ? "WHERE status = 'compiled' AND base_id = ?" : "WHERE status = 'compiled'"
  const params = baseId !== undefined ? [baseId] : []
  const resetSources = getDb()
    .prepare(`UPDATE knowledge_files SET status = 'raw', wiki_outputs = NULL, compiled_at = NULL ${clause}`)
    .run(...params).changes
  console.log(`[knowledge] Rebuilt wiki: ${clearedPages} pages cleared, ${resetSources} sources back to raw`)
  return { clearedPages, resetSources }
}

// ─── Wiki Index Rebuild ────────────────────────────────────────────────

/** Parse YAML frontmatter (between --- markers) from wiki page content */
function parseFrontmatter(content: string): { meta: Record<string, any>; body: string } {
  const trimmed = content.trimStart()
  if (!trimmed.startsWith('---')) return { meta: {}, body: content }
  const end = trimmed.indexOf('---', 3)
  if (end === -1) return { meta: {}, body: content }

  const fmStr = trimmed.slice(3, end).trim()
  const body = trimmed.slice(end + 3).trimStart()
  let meta: Record<string, any> = {}
  try {
    const yaml = require('js-yaml')
    meta = yaml.load(fmStr) || {}
  } catch {
    // Invalid YAML — return empty meta, body is still valid
  }
  return { meta, body }
}

/** Rebuild wiki/index.md from actual wiki page files for a knowledge base. */
export function rebuildWikiIndex(baseId: string = 'default'): void {
  const wikiDir = getBaseWikiDir(baseId)
  if (!existsSync(wikiDir)) return

  const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs')

  const pages: Array<{ filePath: string; title: string; type: string; description: string }> = []
  const subdirs = ['sources', 'entities', 'concepts', 'syntheses']

  for (const subdir of subdirs) {
    const dirPath = join(wikiDir, subdir)
    if (!existsSync(dirPath)) continue
    const entries = readdirSync(dirPath)
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue
      const fullPath = join(dirPath, entry)
      if (!statSync(fullPath).isFile()) continue

      const content = readFileSync(fullPath, 'utf-8')
      const { meta, body } = parseFrontmatter(content)
      const title = meta.title || entry.replace(/\.md$/, '')
      const type = meta.type || subdir.slice(0, -1)

      let description = meta.description || ''
      if (!description) {
        const firstLine = body.trim().split('\n').find(l => l.trim().length > 0 && !l.trimStart().startsWith('#'))
        if (firstLine) description = firstLine.trim().slice(0, 200)
      }

      pages.push({ filePath: `${subdir}/${entry}`, title, type, description })
    }
  }

  if (pages.length === 0) return

  // Group by type with consistent ordering
  const grouped: Record<string, typeof pages> = {}
  for (const page of pages) {
    if (!grouped[page.type]) grouped[page.type] = []
    grouped[page.type].push(page)
  }

  const now = new Date().toISOString()
  const typeOrder = ['source', 'entity', 'concept', 'synthesis']
  const typeLabels: Record<string, string> = {
    source: 'Sources',
    entity: 'Entities',
    concept: 'Concepts',
    synthesis: 'Syntheses'
  }

  const lines: string[] = [
    '---',
    `title: "Knowledge Wiki Index"`,
    `type: index`,
    `updated: "${now}"`,
    `total_pages: ${pages.length}`,
    '---',
    '',
    '# Knowledge Wiki Index',
    ''
  ]

  for (const type of typeOrder) {
    const group = grouped[type]
    if (!group) continue
    const label = typeLabels[type] || type
    lines.push(`## ${label} (${group.length})`)
    lines.push('')
    for (const page of group) {
      const desc = page.description ? ` — ${page.description}` : ''
      lines.push(`- [${page.title}](${page.filePath})${desc}`)
    }
    lines.push('')
  }

  lines.push('---')
  lines.push('')
  lines.push(`*Total: ${pages.length} pages — Last updated: ${new Date().toLocaleDateString('en-CA')}*`)
  lines.push('')

  const indexPath = join(wikiDir, 'index.md')
  writeFileSync(indexPath, lines.join('\n'), 'utf-8')
}

// ─── Schema ────────────────────────────────────────────────────────────

/** Read the schema file from disk. Templates are copied on first launch by ensureDataDir(). */
export function getSchemaContent(): string {
  const schemaPath = join(KNOWLEDGE_SCHEMA_DIR, 'KNOWLEDGE.md')
  return existsSync(schemaPath) ? readFileSync(schemaPath, 'utf-8') : ''
}
