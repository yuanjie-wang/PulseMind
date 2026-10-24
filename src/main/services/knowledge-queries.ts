/**
 * Knowledge query/import service (PLAN-0.3.5 M1.4①): logic previously inlined
 * in knowledge.handler.ts closures, extracted so the IPC handlers and the
 * main-process agent host share one implementation.
 */
import { existsSync, readFileSync } from 'node:fs'
import { readdir as readdirAsync, stat as statAsync } from 'node:fs/promises'
import { resolve, sep, extname, join, relative, basename } from 'node:path'
import { execFile } from 'node:child_process'
import { getBaseRawDir, getBaseWikiDir } from '../storage'
import {
  importLocalFiles,
  importUrl,
  reextractKnowledge,
  abortKnowledgeImport,
  prepareImport,
  readRawContent,
  readWikiContent,
  listWikiFiles,
  saveExperienceToRaw,
  saveFavoriteToRaw,
  getStats,
  markFileCompiled,
  applyWikiChanges,
  appendWikiLog,
  clearAllKnowledge,
  rebuildWikiIndex,
  searchContent,
  listAllFiles,
  listAllFilesAdvanced,
  getFile,
  deleteFile,
  getSchemaContent,
  isValidWikiPagePath,
  wikiFtsCount,
  rebuildWiki,
  listAllBases,
  createKnowledgeBase,
  renameKnowledgeBaseById,
  removeKnowledgeBase,
  moveKnowledgeFileToBase,
  moveKnowledgeFilesToBase,
} from '../storage/knowledge-store'
import { ripgrepBinary, parseRgLine, buildRgSearchArgs } from '../utils/ripgrep'
import { getDb } from '../storage/database'
import type { KnowledgeFile, KnowledgeBase } from '../../shared/types/knowledge'

export interface WikiSearchMatch {
  wikiPath: string
  title: string
  type: WikiPageType
  lineNum: number
  content: string
}

type WikiPageType = 'sources' | 'entities' | 'concepts' | 'syntheses' | ''

/** Resolve a relative path within a base directory, rejecting `..` traversal. */
export function resolveSafeRelative(baseDir: string, relativePath: string): string {
  const resolved = resolve(baseDir, relativePath)
  if (!resolved.startsWith(baseDir + sep) && resolved !== baseDir) {
    throw new Error(`路径超出允许范围: ${relativePath}`)
  }
  return resolved
}

const SUPPORTED_EXTENSIONS = new Set([
  '.txt', '.md', '.html', '.htm', '.pdf', '.docx', '.pptx', '.xlsx',
  '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.log', '.out',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.py', '.java', '.rs', '.go', '.rb', '.php', '.swift', '.kt',
  '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx',
  '.cs', '.sh', '.bash', '.zsh', '.css', '.scss', '.sql', '.r', '.lua', '.dart',
  '.patch', '.diff'
])

/** Directory names that are never knowledge: dependency and VCS trees are the
 *  bulk of a code folder (node_modules alone routinely exceeds 100k files), so
 *  walking them cost seconds of blocked main process AND would import the
 *  world. Skip them by name at every depth. */
const SKIP_DIRS = new Set(['node_modules', '.git'])

/** Unreadable entries (permission, broken symlink, dead mount) are skipped —
 *  one bad entry must not abort the whole folder import, which reads to the
 *  user as 「导入文件夹无效」. Directory symlinks are NOT followed: a link back
 *  to an ancestor recurses forever.
 *
 *  AWAITS, never the sync fs API: this walk runs inside an ipcMain handler on
 *  the MAIN process, so `readdirSync` over a 50k-file tree beachballs the whole
 *  app (「导入大批量文件时会卡死」) — every await yields the event loop and the
 *  UI keeps scrolling. Measured in `probe-knowledge-base.mjs` section ⑫, where
 *  a synchronous control walk drives the tick counter to zero. */
async function collectSupportedFiles(folderPath: string): Promise<string[]> {
  const files: string[] = []
  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdirAsync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        // File symlinks are followed (stat), directory ones are not: a link
        // back to an ancestor would recurse forever.
        try {
          if ((await statAsync(full)).isDirectory()) continue
        } catch {
          continue // broken link
        }
      } else if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full)
        continue
      } else if (!entry.isFile()) {
        continue
      }
      if (SUPPORTED_EXTENSIONS.has(extname(full).toLowerCase())) {
        files.push(full)
      }
    }
  }
  await walk(folderPath)
  return files
}

export function svcListAdvanced(opts: unknown) {
  return listAllFilesAdvanced(opts as any)
}

export function svcListFiles(status?: string) {
  return listAllFiles(status)
}

export function svcGetFile(id: string) {
  return getFile(id)
}

export function svcPrepareImport(filePaths: string[], baseId?: string) {
  return prepareImport(filePaths, baseId)
}

export async function svcAddFile(filePaths: string[], baseId?: string) {
  return importLocalFiles(filePaths, baseId)
}

/** The shape the preload bridge declares (`ElectronAPI['knowledgeScanFolder']`)
 *  and the renderer destructure (`const { fileCount, filePaths } = …`).
 *  Returning the bare array here made every desktop folder import throw in
 *  `prepareImport(undefined)` and die silently — the agent host wrapped it,
 *  the IPC handler did not, so only the UI path was broken. */
export async function svcScanFolder(folderPath: string): Promise<{ fileCount: number; filePaths: string[] }> {
  const filePaths = await collectSupportedFiles(folderPath)
  return { fileCount: filePaths.length, filePaths }
}

export async function svcAddFolder(folderPath: string, baseId?: string) {
  return importLocalFiles(await collectSupportedFiles(folderPath), baseId)
}

export function svcAddUrl(url: string, baseId?: string) {
  return importUrl(url, baseId)
}

export function svcAbortImport(): void {
  abortKnowledgeImport()
}

export function svcDelete(id: string): void {
  deleteFile(id)
}

export function svcReextract(id: string) {
  return reextractKnowledge(id)
}

export function svcGetRaw(relativePath: string, baseId: string = 'default'): string {
  const rawDir = getBaseRawDir(baseId)
  resolveSafeRelative(rawDir, relativePath) // validates traversal
  return readRawContent(relativePath, baseId)
}

export function svcGetRawPath(relativePath: string, baseId: string = 'default'): string {
  return resolveSafeRelative(getBaseRawDir(baseId), relativePath) // validates + resolves
}

export function svcReadWiki(relativePath?: string, baseId: string = 'default'): { content: string | null; files: unknown } {
  if (relativePath) {
    resolveSafeRelative(getBaseWikiDir(baseId), relativePath) // validates traversal
    return { content: readWikiContent(relativePath, baseId), files: null }
  }
  return { content: null, files: listWikiFiles(undefined, baseId) }
}

export function svcWriteExperience(data: { content: string; convId: string; title?: string }) {
  return saveExperienceToRaw(data.content, data.convId, data.title)
}

/** DB row, FTS and marker commit together after the raw write succeeds.
 *  Reject rather than returning a success envelope, so capture stays retryable. */
export async function svcWriteFavorite(data: {
  content: string
  messageId: string
  conversationId: string
  title?: string
}): Promise<KnowledgeFile> {
  return saveFavoriteToRaw(data.content, {
    conversationId: data.conversationId,
    messageId: data.messageId,
    title: data.title
  })
}

export function svcGetStats(baseId?: string) {
  return getStats(baseId)
}

export function svcApplyWikiChanges(data: {
  actions: { filePath: string; content: string }[]
  logEntry?: string
  compiledIds?: string[]
  baseId?: string
}): { written: number; logAppended: boolean; markedCompiled: number } {
  const baseId = data.baseId ?? 'default'
  for (const action of data.actions) {
    if (!isValidWikiPagePath(action.filePath)) {
      throw new Error(`非法的 wiki 页面路径，已拒绝写入: ${action.filePath.slice(0, 100)}`)
    }
  }
  if (data.compiledIds && data.compiledIds.length > 1) {
    throw new Error('compiledIds 必须逐文件传递（一次一个源），拒绝整批归因')
  }
  const written = applyWikiChanges(data.actions, baseId)
  if (data.logEntry) appendWikiLog(data.logEntry, baseId)
  if (data.compiledIds && data.compiledIds.length === 1) {
    markFileCompiled(data.compiledIds[0], data.actions.map(a => a.filePath))
  }
  return { written, logAppended: !!data.logEntry, markedCompiled: data.compiledIds?.length ?? 0 }
}

export function svcRebuildIndex(baseId: string = 'default'): void {
  rebuildWikiIndex(baseId)
}

/** The wiki schema document the compiler prompt must carry (K2): the file
 *  existed on disk all along; no reader did. */
export function svcGetSchema(): string {
  return getSchemaContent()
}

/** Wiki page count vs FTS rows — K7's panel entry and startup sync read it. */
export function svcWikiFtsCount(): number {
  return wikiFtsCount()
}

/** Absolute wiki dir so the renderer can open compiled pages in the workbench
 *  file tab (K7①): they are ordinary markdown files to that surface. */
export function svcGetWikiDir(baseId: string = 'default'): string {
  return getBaseWikiDir(baseId)
}

export function svcRebuildWiki(baseId?: string): { clearedPages: number; resetSources: number } {
  return rebuildWiki(baseId)
}

// ── Knowledge bases ──

export function svcListBases(): KnowledgeBase[] {
  return listAllBases()
}

export function svcCreateBase(name: string): KnowledgeBase {
  return createKnowledgeBase(name)
}

export function svcRenameBase(id: string, name: string): KnowledgeBase {
  return renameKnowledgeBaseById(id, name)
}

export function svcDeleteBase(id: string): void {
  removeKnowledgeBase(id)
}

export function svcSetFileBase(id: string, baseId: string): KnowledgeFile {
  return moveKnowledgeFileToBase(id, baseId)
}

export function svcSetFilesBase(ids: string[], baseId: string): number {
  return moveKnowledgeFilesToBase(ids, baseId)
}

export function svcSearchContent(query: string, baseId?: string) {
  return searchContent(query, baseId)
}

export function svcClearAll() {
  return clearAllKnowledge()
}

export function svcUpdateStatus(data: { id: string; status: 'compiled' }): void {
  // wiki_outputs intentionally not set here — used only during compile flow
  markFileCompiled(data.id)
}

function guessTitle(absPath: string, wikiPath: string): string {
  try {
    const content = readFileSync(absPath, 'utf-8')
    const match = content.match(/^title:\s*"(.+?)"/m)
    if (match) return match[1]
    // Try unquoted title
    const match2 = content.match(/^title:\s*(.+)/m)
    if (match2) return match2[1].trim()
  } catch { /* ignore */ }
  return basename(wikiPath, '.md').replace(/[-_]/g, ' ')
}

/** Search wiki content via ripgrep (grep fallback, Unix only). */
export async function svcSearchWiki(query: string, baseId?: string): Promise<WikiSearchMatch[]> {
  const wikiDir = baseId !== undefined ? getBaseWikiDir(baseId) : undefined
  // trim（review_20261015 中1）：`'   '` 为真值曾穿过旧守卫——FTS 前置返回
  // 空后，rg 臂带着零 `-e` 的 argv 起跑，`--` 后的目录被 rg 当成 PATTERN、
  // 静默扫描主进程 CWD。空白 query 在这里与 builder（返回 null）两处收口。
  if (!query.trim()) return []

  const ftsResults = searchWikiFts(query, 30, baseId)
  if (ftsResults.length > 0) return ftsResults

  const results: WikiSearchMatch[] = []
  const limit = 30

  const terms = query.split(/\s+/).filter(Boolean)

  // 共享 builder（utils/ripgrep.ts）：两通道一个形状才不会再次漂移——
  // M10-P0-1 修 wiki 漏 content 兄弟（review_20261013 高2）的教训。
  const buildRgArgs = (dir: string): string[] | null => buildRgSearchArgs(query, dir)
  const buildGrepArgs = (dir: string): string[] => {
    const args = ['-rn', '-i', '--max-count', '5']
    if (terms.length > 1) {
      args.push('-F')
      for (const t of terms) args.push('-e', t)
    } else {
      args.push('-F', '-e', query)
    }
    args.push('--')
    args.push(dir)
    return args
  }

  const parseOutput = (stdout: string, dir: string): void => {
    for (const line of stdout.split('\n')) {
      if (!line.trim() || results.length >= limit) break
      const parsed = parseRgLine(line)
      if (!parsed) continue
      const wikiPath = relative(dir, parsed.absPath)
      const dirName = wikiPath.split(sep)[0]
      if (results.some(r => r.wikiPath === wikiPath)) continue
      results.push({ wikiPath, title: guessTitle(parsed.absPath, wikiPath), type: dirName as WikiPageType, lineNum: parsed.lineNum, content: parsed.content.slice(0, 200) })
    }
  }

  // Search one directory
  const searchDir = async (dir: string) => {
    if (!existsSync(dir)) return
    // null（空白 query）= 不发起 rg，走无命中——危险 argv 不出门。
    const rgArgs = buildRgArgs(dir)
    if (!rgArgs) return
    await new Promise<void>((resolve) => {
      execFile(ripgrepBinary(), rgArgs, { timeout: 10000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        if (err && !stdout) { resolve(); return }
        parseOutput(stdout, dir)
        resolve()
      })
    })
    if (results.length === 0 && terms.length > 1) {
      terms.length = 0; terms.push(query)
      await new Promise<void>((resolve) => {
        execFile(ripgrepBinary(), rgArgs, { timeout: 10000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
          if (err && !stdout) { resolve(); return }
          parseOutput(stdout, dir)
          resolve()
        })
      })
    }
    if (results.length === 0 && process.platform !== 'win32') {
      await new Promise<void>((resolve) => {
        execFile('grep', buildGrepArgs(dir), { timeout: 10000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
          if (err && !stdout) { resolve(); return }
          parseOutput(stdout, dir)
          resolve()
        })
      })
    }
  }

  if (wikiDir) {
    await searchDir(wikiDir)
  } else {
    // Search all bases
    const { listKnowledgeBases } = require('../storage/knowledge.db') as typeof import('../storage/knowledge.db')
    for (const b of listKnowledgeBases()) {
      await searchDir(getBaseWikiDir(b.id))
      if (results.length >= limit) break
    }
  }

  return results.slice(0, limit)
}


/** FTS search over wiki pages (K4): bm25-ranked, one result per page. */
function searchWikiFts(query: string, limit: number, baseId?: string): WikiSearchMatch[] {
  const terms = query.trim().split(/\s+/).filter(Boolean).filter((t) => [...t].length >= 3)
  if (terms.length === 0 || wikiFtsCount(baseId) === 0) return []
  const ftsQuery = terms.map((t) => `"${t}"`).join(' OR ')
  const scoped = baseId !== undefined
  try {
    const rows = getDb().prepare(`
      SELECT path, title,
             snippet(knowledge_wiki_fts, 1, '…', '…', '…', 48) AS excerpt,
             snippet(knowledge_wiki_fts, 1, '', '', '', 1) AS marker
      FROM knowledge_wiki_fts
      WHERE knowledge_wiki_fts MATCH ?${scoped ? ' AND base_id = ?' : ''}
      ORDER BY rank
      LIMIT ?
    `).all(...(scoped ? [ftsQuery, baseId, limit] : [ftsQuery, limit])) as { path: string; title: string; excerpt: string; marker: string }[]
    return rows.map((r) => ({
      wikiPath: r.path,
      title: r.title || guessTitleFromPath(r.path),
      type: r.path.split('/')[0] as WikiPageType,
      lineNum: 0,
      content: r.excerpt.slice(0, 200),
    }))
  } catch {
    return []
  }
}

function guessTitleFromPath(wikiPath: string): string {
  return basename(wikiPath, '.md').replace(/[-_]/g, ' ')
}
