import { ipcMain } from 'electron'
import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs'
import { resolve, sep, extname, join, relative, basename } from 'node:path'
import { execFile } from 'node:child_process'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { KNOWLEDGE_RAW_DIR, KNOWLEDGE_WIKI_DIR } from '../storage'
import {
  searchContent,
  rebuildWikiIndex,
  listAllFiles,
  listAllFilesAdvanced,
  getFile,
  deleteFile,
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
  clearAllKnowledge
} from '../storage/knowledge-store'
import { withErrorLogging } from './ipc-utils'

/** Resolve a relative path within a base directory, rejecting `..` traversal. */
function resolveSafeRelative(baseDir: string, relativePath: string): string {
  const resolved = resolve(baseDir, relativePath)
  if (!resolved.startsWith(baseDir + sep) && resolved !== baseDir) {
    throw new Error(`路径超出允许范围: ${relativePath}`)
  }
  return resolved
}

function withRawResponse<R>(fn: (...args: any[]) => R | Promise<R>) {
  return async (_event: Electron.IpcMainInvokeEvent, ...args: any[]): Promise<R> => {
    try { return await fn(...args) }
    catch (e) { console.error('[IPC] knowledge error:', e); throw e }
  }
}

export function registerKnowledgeHandlers(): void {
  // ── List all knowledge files (advanced: filter/sort/search/paginate) ──
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_LIST_ADVANCED, withRawResponse(async (opts: any) => {
    return listAllFilesAdvanced(opts)
  }))

  // ── List all knowledge files ──
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_LIST, withRawResponse(async (status?: string) => {
    return listAllFiles(status)
  }))

  // ── Get single file ──
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_GET, withRawResponse(async (id: string) => {
    return getFile(id)
  }))

  // ── Prepare import: split into existing + new ──
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_PREPARE_IMPORT, withRawResponse(async (filePaths: string[]) => {
    return prepareImport(filePaths)
  }))

  // ── Import local file ──
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_ADD_FILE, withRawResponse(async (filePaths: string[]) => {
    const results = []
    for (const fp of filePaths) {
      results.push(await importLocalFile(fp))
    }
    return results
  }))

  // ── Scan folder (count files without importing) ──
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_SCAN_FOLDER, withRawResponse(async (folderPath: string) => {
    const SUPPORTED = new Set([
      '.txt', '.md', '.html', '.htm', '.pdf', '.docx', '.pptx', '.xlsx',
      '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
      '.log', '.out',
      '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
      '.py', '.java', '.rs', '.go', '.rb', '.php', '.swift', '.kt',
      '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx',
      '.cs', '.sh', '.bash', '.zsh', '.css', '.scss', '.sql', '.r', '.lua', '.dart',
      '.patch', '.diff'
    ])
    const files: string[] = []
    function walk(dir: string) {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) {
          walk(full)
        } else if (SUPPORTED.has(extname(full).toLowerCase())) {
          files.push(full)
        }
      }
    }
    walk(folderPath)
    return { fileCount: files.length, filePaths: files }
  }))

  // ── Import folder ──
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_ADD_FOLDER, withRawResponse(async (folderPath: string) => {
    const SUPPORTED = new Set([
      '.txt', '.md', '.html', '.htm', '.pdf', '.docx', '.pptx', '.xlsx',
      '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
      '.log', '.out',
      '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
      '.py', '.java', '.rs', '.go', '.rb', '.php', '.swift', '.kt',
      '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx',
      '.cs', '.sh', '.bash', '.zsh', '.css', '.scss', '.sql', '.r', '.lua', '.dart',
      '.patch', '.diff'
    ])
    const files: string[] = []
    function walk(dir: string) {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) {
          walk(full)
        } else if (SUPPORTED.has(extname(full).toLowerCase())) {
          files.push(full)
        }
      }
    }
    walk(folderPath)
    const results = []
    for (const fp of files) {
      results.push(await importLocalFile(fp))
    }
    return results
  }))

  // ── Import URL ──
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_ADD_URL, withRawResponse(async (url: string) => {
    return importUrl(url)
  }))

  // ── Abort URL import ──
  ipcMain.on(IPC_CHANNELS.KNOWLEDGE_ABORT_IMPORT, () => {
    abortKnowledgeImport()
  })

  // ── Delete file ──
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_DELETE, withErrorLogging(async (id: string) => {
    deleteFile(id)
  }))

  // ── Read raw file content ──
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_GET_RAW, withRawResponse(async (relativePath: string) => {
    resolveSafeRelative(KNOWLEDGE_RAW_DIR, relativePath) // validates traversal
    return readRawContent(relativePath)
  }))

  // ── Get absolute path of a raw file ──
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_GET_RAW_PATH, withRawResponse(async (relativePath: string) => {
    return resolveSafeRelative(KNOWLEDGE_RAW_DIR, relativePath) // validates + resolves
  }))

  // ── Read wiki file content ──
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_READ_WIKI, withRawResponse(async (relativePath?: string) => {
    if (relativePath) {
      resolveSafeRelative(KNOWLEDGE_WIKI_DIR, relativePath) // validates traversal
      return { content: readWikiContent(relativePath), files: null }
    }
    // No path = return directory listing
    return { content: null, files: listWikiFiles() }
  }))

  // ── Write experience to raw ──
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_WRITE_EXPERIENCE, withRawResponse(async (data: { content: string; convId: string; title?: string }) => {
    return saveExperienceToRaw(data.content, data.convId, data.title)
  }))

  // ── Get stats ──
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_GET_STATS, withRawResponse(async () => {
    return getStats()
  }))

  // ── Apply wiki changes (batch write files) ──
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_APPLY_WIKI_CHANGES, withRawResponse(async (data: {
    actions: { filePath: string; content: string }[]
    logEntry?: string
    compiledIds?: string[]
  }) => {
    const written = applyWikiChanges(data.actions)
    if (data.logEntry) appendWikiLog(data.logEntry)
    if (data.compiledIds) {
      const wikiPaths = data.actions.map(a => a.filePath)
      for (const id of data.compiledIds) {
        markFileCompiled(id, wikiPaths)
      }
    }
    return { written, logAppended: !!data.logEntry, markedCompiled: data.compiledIds?.length ?? 0 }
  }))

  // ── Rebuild wiki index from page files ──
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_REBUILD_INDEX, withRawResponse(async () => {
    rebuildWikiIndex()
  }))

  // ── Search file content ──
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_SEARCH_CONTENT, withRawResponse(async (query: string) => {
    return searchContent(query)
  }))

  // ── Clear all knowledge ──
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_CLEAR_ALL, withRawResponse(async () => {
    return clearAllKnowledge()
  }))

  // ── Update single file status ──
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_UPDATE_STATUS, withErrorLogging(async (data: { id: string; status: 'compiled' }) => {
    // wiki_outputs intentionally not set here — used only during compile flow
    markFileCompiled(data.id)
  }))

  // ── Search wiki content via ripgrep ──
  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_SEARCH_WIKI, withRawResponse(async (query: string): Promise<WikiSearchMatch[]> => {
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
        const sepIdx = line.indexOf(':')
        if (sepIdx === -1) continue
        const absPath = line.slice(0, sepIdx)
        const rest = line.slice(sepIdx + 1)
        const lineSep = rest.indexOf(':')
        const lineNum = lineSep > -1 ? parseInt(rest.slice(0, lineSep), 10) || 0 : 0
        const content = lineSep > -1 ? rest.slice(lineSep + 1).trim() : rest.trim()
        const wikiPath = relative(KNOWLEDGE_WIKI_DIR, absPath)
        const dir = wikiPath.split(sep)[0]
        if (!results.some(r => r.wikiPath === wikiPath)) {
          results.push({ wikiPath, title: guessTitle(absPath, wikiPath), type: dir as WikiPageType, lineNum, content: content.slice(0, 200) })
        }
      }
    }

    const tryRg = (): Promise<void> => new Promise((resolve) => {
      execFile('rg', buildRgArgs(), { timeout: 10000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
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
    if (results.length === 0) await tryGrep()
    return results.slice(0, limit)
  }))
}

interface WikiSearchMatch {
  wikiPath: string
  title: string
  type: WikiPageType
  lineNum: number
  content: string
}

type WikiPageType = 'sources' | 'entities' | 'concepts' | 'syntheses' | ''

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
