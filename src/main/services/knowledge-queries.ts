/**
 * Knowledge query/import service (PLAN-0.3.5 M1.4①): logic previously inlined
 * in knowledge.handler.ts closures, extracted so the IPC handlers and the
 * main-process agent host share one implementation.
 */
import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs'
import { resolve, sep, extname, join, relative, basename } from 'node:path'
import { execFile } from 'node:child_process'
import { KNOWLEDGE_RAW_DIR, KNOWLEDGE_WIKI_DIR } from '../storage'
import {
  importLocalFile,
  importUrl,
  abortKnowledgeImport,
  prepareImport,
  readRawContent,
  readWikiContent,
  listWikiFiles,
  saveExperienceToRaw,
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
} from '../storage/knowledge-store'
import { ripgrepBinary, parseRgLine } from '../utils/ripgrep'

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

function collectSupportedFiles(folderPath: string): string[] {
  const files: string[] = []
  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
      } else if (SUPPORTED_EXTENSIONS.has(extname(full).toLowerCase())) {
        files.push(full)
      }
    }
  }
  walk(folderPath)
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

export function svcPrepareImport(filePaths: string[]) {
  return prepareImport(filePaths)
}

export async function svcAddFile(filePaths: string[]) {
  const results = []
  for (const fp of filePaths) {
    results.push(await importLocalFile(fp))
  }
  return results
}

export async function svcScanFolder(folderPath: string): Promise<string[]> {
  return collectSupportedFiles(folderPath)
}

export async function svcAddFolder(folderPath: string) {
  const results = []
  for (const fp of collectSupportedFiles(folderPath)) {
    results.push(await importLocalFile(fp))
  }
  return results
}

export function svcAddUrl(url: string) {
  return importUrl(url)
}

export function svcAbortImport(): void {
  abortKnowledgeImport()
}

export function svcDelete(id: string): void {
  deleteFile(id)
}

export function svcGetRaw(relativePath: string): string {
  resolveSafeRelative(KNOWLEDGE_RAW_DIR, relativePath) // validates traversal
  return readRawContent(relativePath)
}

export function svcGetRawPath(relativePath: string): string {
  return resolveSafeRelative(KNOWLEDGE_RAW_DIR, relativePath) // validates + resolves
}

export function svcReadWiki(relativePath?: string): { content: string | null; files: unknown } {
  if (relativePath) {
    resolveSafeRelative(KNOWLEDGE_WIKI_DIR, relativePath) // validates traversal
    return { content: readWikiContent(relativePath), files: null }
  }
  // No path = return directory listing
  return { content: null, files: listWikiFiles() }
}

export function svcWriteExperience(data: { content: string; convId: string; title?: string }) {
  return saveExperienceToRaw(data.content, data.convId, data.title)
}

export function svcGetStats() {
  return getStats()
}

export function svcApplyWikiChanges(data: {
  actions: { filePath: string; content: string }[]
  logEntry?: string
  compiledIds?: string[]
}): { written: number; logAppended: boolean; markedCompiled: number } {
  const written = applyWikiChanges(data.actions)
  if (data.logEntry) appendWikiLog(data.logEntry)
  if (data.compiledIds) {
    const wikiPaths = data.actions.map(a => a.filePath)
    for (const id of data.compiledIds) {
      markFileCompiled(id, wikiPaths)
    }
  }
  return { written, logAppended: !!data.logEntry, markedCompiled: data.compiledIds?.length ?? 0 }
}

export function svcRebuildIndex(): void {
  rebuildWikiIndex()
}

export function svcSearchContent(query: string) {
  return searchContent(query)
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
export async function svcSearchWiki(query: string): Promise<WikiSearchMatch[]> {
  if (!query || !existsSync(KNOWLEDGE_WIKI_DIR)) return []

  const results: WikiSearchMatch[] = []
  const limit = 30

  const terms = query.split(/\s+/).filter(Boolean)

  // Build ripgrep/grep args with OR semantics for multi-keyword queries.
  // Multiple terms use `-F -e t1 -e t2` (literal OR), single term uses the
  // raw query string directly (same behavior as before).
  const buildRgArgs = (): string[] => {
    const args = ['-n', '--no-heading', '-i', '--max-columns', '300', '--max-count', '5']
    if (terms.length > 1) {
      args.push('-F')
      for (const t of terms) args.push('-e', t)
    } else {
      args.push(query)
    }
    args.push(KNOWLEDGE_WIKI_DIR)
    return args
  }
  const buildGrepArgs = (): string[] => {
    const args = ['-rn', '-i', '--max-count', '5']
    if (terms.length > 1) {
      args.push('-F')
      for (const t of terms) args.push('-e', t)
    } else {
      args.push(query)
    }
    args.push(KNOWLEDGE_WIKI_DIR)
    return args
  }

  const parseOutput = (stdout: string): void => {
    for (const line of stdout.split('\n')) {
      if (!line.trim() || results.length >= limit) break
      const parsed = parseRgLine(line)
      if (!parsed) continue
      const wikiPath = relative(KNOWLEDGE_WIKI_DIR, parsed.absPath)
      const dir = wikiPath.split(sep)[0]
      if (!results.some(r => r.wikiPath === wikiPath)) {
        results.push({ wikiPath, title: guessTitle(parsed.absPath, wikiPath), type: dir as WikiPageType, lineNum: parsed.lineNum, content: parsed.content.slice(0, 200) })
      }
    }
  }

  const tryRg = (): Promise<void> => new Promise((resolve) => {
    execFile(ripgrepBinary(), buildRgArgs(), { timeout: 10000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) { resolve(); return }
      parseOutput(stdout)
      resolve()
    })
  })

  const tryGrep = (): Promise<void> => new Promise((resolve) => {
    execFile('grep', buildGrepArgs(), { timeout: 10000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) { resolve(); return }
      parseOutput(stdout)
      resolve()
    })
  })

  await tryRg()
  if (results.length === 0 && terms.length > 1) {
    // OR returned nothing — retry with full query as a single string
    terms.length = 0; terms.push(query)
    await tryRg()
  }
  // grep exists only on Unix; on Windows the bundled rg above is the only
  // searcher (execFile('grep') would ENOENT and silently yield nothing).
  if (results.length === 0 && process.platform !== 'win32') await tryGrep()
  return results.slice(0, limit)
}
