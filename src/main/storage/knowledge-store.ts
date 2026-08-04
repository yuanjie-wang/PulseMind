import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { join, basename, dirname, relative } from 'node:path'
import { fork, execFile } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { fetchUrlViaChromeMCP } from '../mcp/chrome-fetcher'
import {
  listKnowledgeFiles,
  getKnowledgeFile,
  getKnowledgeFileByPath,
  getKnowledgeFileBySource,
  insertKnowledgeFile,
  deleteKnowledgeFile,
  updateKnowledgeFileStatus,
  getKnowledgeStats,
  knowledgeFtsAdd,
  searchKnowledgeFts,
  type KnowledgeFileRow
} from './knowledge.db'
import { getDb } from './database'
import {
  KNOWLEDGE_RAW_DIR,
  KNOWLEDGE_WIKI_DIR,
  KNOWLEDGE_SCHEMA_DIR
} from './index'
import type { KnowledgeFile, KnowledgeStats, KnowledgeImportResult, KnowledgeListOptions, KnowledgeListResult } from '../../shared/types/knowledge'

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
    wikiOutputs: row.wiki_outputs ? JSON.parse(row.wiki_outputs) : null
  }
}

/** Read a raw knowledge file from disk and add its content to the FTS5 index. */
function syncKnowledgeFileToFts(id: string): void {
  const row = getDb().prepare('SELECT rowid, file_path FROM knowledge_files WHERE id = ?').get(id) as { rowid: number; file_path: string } | undefined
  if (!row) return
  const fullPath = join(KNOWLEDGE_RAW_DIR, row.file_path)
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
function generateRawFilePath(originalName: string): string {
  const date = new Date().toISOString().slice(0, 10)
  const base = sanitizeName(basename(originalName).replace(/\.[^.]+$/, ''))
  // Truncate to avoid overly long filenames
  const name = `${date}_${base}`.slice(0, 180)
  let candidate = `${name}.md`
  let counter = 1
  while (existsSync(join(KNOWLEDGE_RAW_DIR, candidate))) {
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

export function getFile(id: string): KnowledgeFile | null {
  const row = getKnowledgeFile(id)
  return row ? toKnowledgeFile(row) : null
}

export function deleteFile(id: string): void {
  const row = getKnowledgeFile(id)
  if (row) {
    // Delete raw file
    const rawPath = join(KNOWLEDGE_RAW_DIR, row.file_path)
    try { unlinkSync(rawPath) } catch { /* ignore */ }

    // Delete compiled wiki pages that were generated from this file
    const wikiOutputs: string[] = JSON.parse(row.wiki_outputs || '[]')
    for (const wikiPath of wikiOutputs) {
      const fullPath = join(KNOWLEDGE_WIKI_DIR, wikiPath)
      try { unlinkSync(fullPath) } catch { /* ignore if shared with other sources */ }
    }

    // Remove reference from wiki/index.md
    try {
      const indexPath = join(KNOWLEDGE_WIKI_DIR, 'index.md')
      if (existsSync(indexPath)) {
        const content = readFileSync(indexPath, 'utf-8')
        const lines = content.split('\n').filter(line => !line.includes(row.file_path))
        writeFileSync(indexPath, lines.join('\n'), 'utf-8')
      }
    } catch { /* index may not exist */ }

    deleteKnowledgeFile(id)
  }
}

export function getStats(): KnowledgeStats {
  const base = getKnowledgeStats()
  // Count actual wiki page files on disk
  let wikiFileCount = 0
  try {
    const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs')
    function countFiles(dir: string) {
      if (!existsSync(dir)) return
      const entries = readdirSync(dir)
      for (const entry of entries) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) {
          countFiles(full)
        } else if (entry.endsWith('.md')) {
          wikiFileCount++
        }
      }
    }
    countFiles(KNOWLEDGE_WIKI_DIR)
  } catch { /* wiki dir may not exist */ }
  return { ...base, wikiFileCount }
}

/** Update a knowledge file's status to compiled, optionally storing generated wiki paths */
export function markFileCompiled(id: string, wikiOutputs?: string[]): void {
  updateKnowledgeFileStatus(id, 'compiled', wikiOutputs)
}

/** Apply a batch of wiki changes: write files, update index, update log */
export function applyWikiChanges(actions: { filePath: string; content: string }[]): number {
  let count = 0
  for (const action of actions) {
    const safePath = action.filePath.replace(/\.\./g, '')
    const fullPath = join(KNOWLEDGE_WIKI_DIR, safePath)
    const dir = dirname(fullPath)
    try {
      if (!existsSync(dir)) {
        const { mkdirSync } = require('node:fs')
        mkdirSync(dir, { recursive: true })
      }
      writeFileSync(fullPath, action.content, 'utf-8')
      count++
    } catch (err) {
      console.error(`[knowledge] Failed to write wiki file ${safePath}:`, err)
    }
  }
  return count
}

/** Append an entry to wiki/log.md */
export function appendWikiLog(entry: string): void {
  const logPath = join(KNOWLEDGE_WIKI_DIR, 'log.md')
  const timestamp = new Date().toISOString()
  const line = `- ${timestamp} — ${entry}\n`
  if (!existsSync(logPath)) {
    writeFileSync(logPath, `# Wiki Operation Log\n\n${line}`, 'utf-8')
  } else {
    writeFileSync(logPath, readFileSync(logPath, 'utf-8') + line, 'utf-8')
  }
}

/** Read raw file content by its relative path */
export function readRawContent(relativePath: string): string {
  const fullPath = join(KNOWLEDGE_RAW_DIR, relativePath)
  if (!existsSync(fullPath)) throw new Error(`Raw file not found: ${relativePath}`)
  return readFileSync(fullPath, 'utf-8')
}

/** Read wiki file content by its relative path. Returns null (not throws) when the file doesn't exist. */
export function readWikiContent(relativePath: string): string | null {
  const fullPath = join(KNOWLEDGE_WIKI_DIR, relativePath)
  if (!existsSync(fullPath)) return null
  return readFileSync(fullPath, 'utf-8')
}

/** Search raw file content — ripgrep first, fallback to FTS5. */
export async function searchContent(query: string): Promise<ContentMatch[]> {
  if (!query || !existsSync(KNOWLEDGE_RAW_DIR)) return ftsContentSearch(query)

  const rgResults = await searchContentViaRipgrep(query)
  if (rgResults.length > 0) return rgResults

  return ftsContentSearch(query)
}

function ftsContentSearch(query: string): ContentMatch[] {
  const ftsResults = searchKnowledgeFts(query)
  return ftsResults.map(r => ({
    id: r.id,
    filePath: r.filePath,
    title: r.title,
    sourceType: r.sourceType,
    excerpts: r.excerpt ? [r.excerpt] : []
  }))
}

/** Run ripgrep on raw knowledge files. Multi-keyword queries use -F -e for OR. */
async function searchContentViaRipgrep(query: string): Promise<ContentMatch[]> {
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
    args.push(KNOWLEDGE_RAW_DIR)

    execFile('rg', args, { timeout: 10000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) { resolve([]); return }

      // Group excerpts by file path (relative to raw dir)
      const fileMap = new Map<string, string[]>()
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue
        const absPath = line.slice(0, line.indexOf(':'))
        if (!absPath) continue
        const rest = line.slice(absPath.length + 1)
        const lineSep = rest.indexOf(':')
        const content = lineSep > -1 ? rest.slice(lineSep + 1).trim() : rest.trim()
        const relPath = relative(KNOWLEDGE_RAW_DIR, absPath)
        if (!relPath) continue

        const excerpts = fileMap.get(relPath) || []
        if (excerpts.length < 3) excerpts.push(content.slice(0, 200))
        fileMap.set(relPath, excerpts)
      }

      // Map to ContentMatch by looking up the knowledge file row
      const results: ContentMatch[] = []
      for (const [relPath, excerpts] of fileMap) {
        const file = getKnowledgeFileByPath(relPath)
        if (file) {
          results.push({ id: file.id, filePath: relPath, title: file.title, sourceType: file.source_type, excerpts })
        }
      }
      resolve(results)
    })
  })
}

/** List wiki directory structure (for browsing) */
export function listWikiFiles(subdir?: string): string[] {
  const root = subdir ? join(KNOWLEDGE_WIKI_DIR, subdir) : KNOWLEDGE_WIKI_DIR
  if (!existsSync(root)) return []
  const { readdirSync, statSync } = require('node:fs')
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

// ─── Prepare Import ──────────────────────────────────────────────────

/** Check each file path against the DB; return paths sorted into existing and new */
export function prepareImport(filePaths: string[]): { existing: { id: string; filePath: string }[]; new: string[] } {
  const existing: { id: string; filePath: string }[] = []
  const newFiles: string[] = []
  for (const fp of filePaths) {
    const row = getKnowledgeFileBySource(fp)
    if (row) {
      existing.push({ id: row.id, filePath: fp })
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
 * bloating the wiki compilation.
 */
function extractBase64Images(content: string): string {
  const imgDir = join(KNOWLEDGE_RAW_DIR, 'images')
  mkdirSync(imgDir, { recursive: true })
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
    return `![image](local-file:///.pulsemind/knowledge/raw/images/${filename})`
  })
}

// ─── Import ────────────────────────────────────────────────────────────

/** Import a local file: extract → normalize to MD → write to raw/ */
export async function importLocalFile(filePath: string): Promise<KnowledgeImportResult> {
  try {
    if (!existsSync(filePath)) {
      return { success: false, error: `File not found: ${filePath}` }
    }

    if (getKnowledgeFileBySource(filePath)) {
      return { success: false, duplicate: true, error: `Already exists: ${filePath}` }
    }

    const { content } = await extractInWorker(filePath)
    let cleanContent = stripFrontmatter(content)
    const relativePath = generateRawFilePath(filePath)
    const destPath = join(KNOWLEDGE_RAW_DIR, relativePath)
    const displayTitle = basename(filePath).replace(/\.[^.]+$/, '')
    const id = generateId()

    // Extract base64 images to local files before writing
    cleanContent = extractBase64Images(cleanContent)

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
      sourcePath: filePath
    })

    syncKnowledgeFileToFts(id)
    return { success: true, file: getFile(id)! }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { success: false, error: message }
  }
}

// ── URL import cancellation ──
let _importAbortController: AbortController | null = null

export function abortKnowledgeImport(): void {
  _importAbortController?.abort()
}

/** Import a remote URL: Chrome MCP → Readability → turndown → write to raw/ */
export async function importUrl(url: string, preFetchedHtml?: string): Promise<KnowledgeImportResult> {
  // Validate URL format — only http/https allowed
  if (!/^https?:\/\/.+/.test(url)) {
    return { success: false, error: `不支持的链接格式: ${url.slice(0, 100)}。仅支持 http/https 链接。` }
  }

  // Create new AbortController for this import
  _importAbortController?.abort() // cancel any previous in-flight import
  _importAbortController = new AbortController()
  const signal = _importAbortController.signal

  try {
    let html: string

    if (preFetchedHtml) {
      html = preFetchedHtml
    } else {
      if (signal.aborted) return { success: false, error: 'cancelled' }
      // Use Chrome DevTools MCP for full JS-rendered content
      const fetched = await fetchUrlViaChromeMCP(url, 0, signal)
      if (signal.aborted) return { success: false, error: 'cancelled' }
      if (!fetched) return { success: false, error: 'Failed to fetch URL via Chrome MCP' }
      html = fetched
    }

    const existingRow = getKnowledgeFileBySource('', url)
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
    const destPath = join(KNOWLEDGE_RAW_DIR, relativePath)
    const id = generateId()

    // Extract base64 images to local files before writing
    cleanMarkdown = extractBase64Images(cleanMarkdown)

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
      sourceUrl: url
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
export function saveExperienceToRaw(content: string, convId: string, title?: string): KnowledgeFile {
  const date = new Date().toISOString().slice(0, 10)
  const displayTitle = title || `Experience from ${convId.slice(0, 8)}`
  const slug = sanitizeName(displayTitle).slice(0, 60)
  const relativePath = `experience_${slug}_${date}.md`
  // Dedup: the same title saved on the same day collides on this file path. Check
  // before writing — otherwise a second save overwrites the file on disk while
  // inserting another DB row pointing at the same path (orphaned duplicate).
  // importLocalFile/importUrl guard the same way via getKnowledgeFileBySource.
  const existing = getKnowledgeFileByPath(relativePath)
  if (existing) {
    console.log(`[knowledge-store] Experience already exists: ${relativePath}, skipping duplicate`)
    return toKnowledgeFile(existing)
  }
  const destPath = join(KNOWLEDGE_RAW_DIR, relativePath)

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
    convId
  })

  syncKnowledgeFileToFts(id)
  return getFile(id)!
}

/** Clear all knowledge: delete all DB records, raw files, wiki files, schema, and wiki index */
export function clearAllKnowledge(): { deletedRaw: number; deletedWiki: number } {
  const { readdirSync, rmSync } = require('node:fs') as typeof import('node:fs')
  let deletedRaw = 0
  let deletedWiki = 0

  // Delete all raw files
  try {
    const rawFiles = readdirSync(KNOWLEDGE_RAW_DIR)
    for (const f of rawFiles) {
      try { unlinkSync(join(KNOWLEDGE_RAW_DIR, f)); deletedRaw++ } catch { /* ignore */ }
    }
  } catch { /* dir may not exist */ }

  // Delete all wiki files (including subdirectories)
  try {
    function removeContents(dir: string) {
      const entries = readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          removeContents(full)
          try { rmSync(full, { recursive: true, force: true }) } catch { /* ignore */ }
        } else {
          try { unlinkSync(full); deletedWiki++ } catch { /* ignore */ }
        }
      }
    }
    removeContents(KNOWLEDGE_WIKI_DIR)
  } catch { /* dir may not exist */ }

  // Delete all DB records (knowledge_fts must be cleaned too — it's a standalone FTS5 table)
  const { getDb } = require('./database') as typeof import('./database')
  getDb().prepare('DELETE FROM knowledge_files').run()
  getDb().prepare('DELETE FROM knowledge_fts').run()

  return { deletedRaw, deletedWiki }
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

/** Rebuild wiki/index.md from actual wiki page files.
 *  Scans sources/, entities/, concepts/, syntheses/ subdirectories,
 *  reads YAML frontmatter, and generates a structured index grouped by type. */
export function rebuildWikiIndex(): void {
  if (!existsSync(KNOWLEDGE_WIKI_DIR)) return

  const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs')

  const pages: Array<{ filePath: string; title: string; type: string; description: string }> = []
  const subdirs = ['sources', 'entities', 'concepts', 'syntheses']

  for (const subdir of subdirs) {
    const dirPath = join(KNOWLEDGE_WIKI_DIR, subdir)
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

  const indexPath = join(KNOWLEDGE_WIKI_DIR, 'index.md')
  writeFileSync(indexPath, lines.join('\n'), 'utf-8')
}

// ─── Schema ────────────────────────────────────────────────────────────

/** Read the schema file from disk. Templates are copied on first launch by ensureDataDir(). */
export function getSchemaContent(): string {
  const schemaPath = join(KNOWLEDGE_SCHEMA_DIR, 'KNOWLEDGE.md')
  return existsSync(schemaPath) ? readFileSync(schemaPath, 'utf-8') : ''
}
