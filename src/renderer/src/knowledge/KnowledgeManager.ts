import { KnowledgeCompilerAgent, WikiPlanAgent } from '../agent/one-shot-agent/KnowledgeCompilerAgent'
import type { LlmAdapter } from '../llm/adapter'
import type { KnowledgeFile, KnowledgeStats, KnowledgeImportResult, KnowledgeListOptions, KnowledgeListResult } from '../../../shared/types/knowledge'
import { getHost } from '../agent/host'

/**
 * Renderer-side manager for the Knowledge Base system.
 *
 * Wraps IPC calls to the main process store and orchestrates
 * compilation of raw files into structured wiki pages.
 */
export class KnowledgeManager {
  private compilerAgent = new KnowledgeCompilerAgent()
  private apiKey = ''
  private baseURL = ''
  private adapter: LlmAdapter | null = null
  private model = ''
  private _wikiVersion = 0
  private _consolidating = false

  /** Incremented each time compileFile() succeeds. AgentEngine
   *  checks this to decide whether its cached snapshot is stale. */
  get wikiVersion(): number { return this._wikiVersion }

  /** Store LLM config so compilation can call the API. */
  setConfig(apiKey: string, baseURL: string, adapter: LlmAdapter, model: string): void {
    this.apiKey = apiKey
    this.baseURL = baseURL
    this.adapter = adapter
    this.model = model
  }

  /** Whether the manager has enough config to compile. */
  get canCompile(): boolean {
    return !!(this.apiKey && this.baseURL && this.adapter && this.model)
  }

  // ─── File Management ────────────────────────────────────────────────

  /** List all knowledge files, optionally filtered by status. */
  async listFiles(status?: 'raw' | 'compiled'): Promise<KnowledgeFile[]> {
    return getHost().knowledgeListFiles(status)
  }

  /** List knowledge files with advanced options: filter, sort, search, pagination */
  async listFilesAdvanced(opts?: KnowledgeListOptions): Promise<KnowledgeListResult> {
    return getHost().knowledgeListAdvanced(opts)
  }

  /** Get a single knowledge file by ID. */
  async getFile(id: string): Promise<KnowledgeFile | null> {
    return getHost().knowledgeGetFile(id)
  }

  /** Delete a knowledge file by ID. */
  async deleteFile(id: string): Promise<void> {
    return getHost().knowledgeDelete(id)
  }

  /** Get aggregate stats (total / raw / compiled). */
  async getStats(): Promise<KnowledgeStats> {
    return getHost().knowledgeGetStats()
  }

  // ─── Import ─────────────────────────────────────────────────────────

  /** Import one or more local files into the knowledge base. */
  async importFiles(filePaths: string[]): Promise<KnowledgeImportResult[]> {
    return getHost().knowledgeAddFile(filePaths)
  }

  /** Check each file path against DB; returns existing + new. */
  async prepareImport(filePaths: string[]): Promise<{ existing: { id: string; filePath: string }[]; new: string[] }> {
    return getHost().knowledgePrepareImport(filePaths)
  }

  /** Scan a folder and return the count of importable files (without importing). */
  async scanFolder(folderPath: string): Promise<{ fileCount: number; filePaths: string[] }> {
    return getHost().knowledgeScanFolder(folderPath)
  }

  /** Import all supported files from a folder (recursive). */
  async importFolder(folderPath: string): Promise<KnowledgeImportResult[]> {
    return getHost().knowledgeAddFolder(folderPath)
  }

  /** Import a remote URL into the knowledge base. */
  async importUrl(url: string): Promise<KnowledgeImportResult> {
    return getHost().knowledgeAddUrl(url)
  }

  /** Get the absolute file-system path of a raw knowledge file. */
  async getRawFilePath(relativePath: string): Promise<string> {
    return getHost().knowledgeGetRawPath(relativePath)
  }

  /** Search raw file content for a query string. Returns matches with context excerpts. */
  async searchContent(query: string): Promise<Array<{ id: string; filePath: string; title: string; sourceType: string; excerpts: string[] }>> {
    return getHost().knowledgeSearchContent(query)
  }

  /** Search compiled wiki pages via ripgrep. Returns matching wiki paths with snippets. */
  async searchWiki(query: string): Promise<Array<{ wikiPath: string; title: string; type: string; lineNum: number; content: string }>> {
    return getHost().knowledgeSearchWiki(query)
  }

  /** Rebuild wiki/index.md from actual page files, grouped by type with descriptions. */
  async rebuildWikiIndex(): Promise<void> {
    return getHost().knowledgeRebuildIndex()
  }

  // ─── Content Access ────────────────────────────────────────────────

  /** Read the raw content of a knowledge file by its relative path. */
  async readRawContent(relativePath: string): Promise<string> {
    return getHost().knowledgeGetRaw(relativePath)
  }

  /** Read wiki content or list wiki directory. */
  async readWiki(relativePath?: string): Promise<{ content: string | null; files: string[] | null }> {
    return getHost().knowledgeReadWiki(relativePath)
  }

  // ─── Compilation ───────────────────────────────────────────────────

  /** Fetch the wiki schema document from disk via IPC (K2): the compiler
   *  prompt must carry the REAL convention — the two hardcoded stand-ins
   *  ("See rules in wiki/index.md frontmatter" was simply false) were why
   *  every page shipped without sources/updated frontmatter. */
  private async loadSchema(): Promise<string> {
    try {
      const schema = await getHost().knowledgeGetSchema()
      return schema.trim() || 'Standard wiki: sources/, entities/, concepts/, syntheses/.'
    } catch {
      return 'Standard wiki: sources/, entities/, concepts/, syntheses/.'
    }
  }

  /** K8 pass 1: which wiki pages should this source create or update? Small
   *  output, so the expensive merge pass only fetches the pages that matter. */
  private async planWikiPages(file: { id: string; filePath: string; title: string; content: string }, schema: string): Promise<Array<{ filePath: string }>> {
    const planAgent = new WikiPlanAgent()
    const result = await planAgent.execute(
      { schema, rawFile: { filePath: file.filePath, title: file.title, content: file.content.slice(0, 20000) } },
      {
        llmConfig: { apiKey: this.apiKey, baseURL: this.baseURL, model: this.model, adapter: this.adapter! },
        maxTokens: 800,
        onFinishReason: (reason) => {
          if (reason === 'length' || reason === 'max_tokens') throw new Error('页面规划被截断（finish=' + reason + '）')
        },
      },
    )
    return result.pages
  }

  /** Compile a single raw file by ID (the ONLY compilation path — the old
   *  batch compile() stamped every action path onto every source in the
   *  batch, so a merged page was attributed to all three sources). K8: pass 1
   *  lists the target pages, pass 2 carries the existing page bodies so the
   *  model MERGES instead of overwriting. */
  async compileFile(fileId: string): Promise<{ ok: boolean; written: number; log: string }> {
    if (!this.canCompile || !this.adapter) {
      return { ok: false, written: 0, log: 'LLM not configured' }
    }

    const file = await this.getFile(fileId)
    if (!file || file.status !== 'raw') {
      return { ok: false, written: 0, log: 'File not found or already compiled' }
    }

    const schema = await this.loadSchema()

    // Existing wiki index (context for merge decisions)
    let existingIndex = ''
    try {
      existingIndex = (await this.readWiki('index.md')).content || ''
    } catch { /* wiki may not exist */ }

    // Read raw content
    const content = await this.readRawContent(file.filePath)
    const fileContents = [{ id: file.id, filePath: file.filePath, title: file.title, content }]

    // K8 pass 1: plan the pages; fetch existing bodies for update targets.
    let existingPages: Array<{ filePath: string; content: string }> = []
    try {
      const planned = await this.planWikiPages(fileContents[0], schema)
      const bodies = await Promise.all(planned.map(async (p) => ({
        filePath: p.filePath,
        content: (await this.readWiki(p.filePath).catch(() => ({ content: null }))).content,
      })))
      existingPages = bodies.filter((b): b is { filePath: string; content: string } => !!b.content)
    } catch (err) {
      console.warn('[KnowledgeManager] page planning failed, compiling without merge context:', err)
    }

    // K8 pass 2: the merge-capable compilation call.
    let truncated = false
    const result = await this.compilerAgent.execute(
      { schema, existingIndex, rawFiles: fileContents, existingPages },
      {
        llmConfig: {
          apiKey: this.apiKey,
          baseURL: this.baseURL,
          model: this.model,
          adapter: this.adapter
        },
        maxTokens: 4000,
        // K1: a truncated completion is a FAILURE — the old code guessed and
        //固化 half a JSON blob as a "source page".
        onFinishReason: (reason) => {
          if (reason === 'length' || reason === 'max_tokens') truncated = true
        },
      }
    )

    if (truncated) {
      return { ok: false, written: 0, log: '编译被截断（模型输出超长），源保持 raw，未写入任何页面' }
    }
    if (result.failed) {
      return { ok: false, written: 0, log: result.logEntry }
    }
    if (result.actions.length === 0) {
      return { ok: false, written: 0, log: result.rejected?.length ? '全部 action 被拒绝: ' + result.rejected.join('; ') : 'No changes needed' }
    }

    // Apply wiki changes (1:1 attribution — one source, its own page set)
    const applyResult = await getHost().knowledgeApplyWikiChanges({
      actions: result.actions,
      logEntry: result.rejected?.length ? `${result.logEntry}（拒绝: ${result.rejected.join('; ')}）` : result.logEntry,
      compiledIds: [file.id]
    })

    // Rebuild structured wiki index
    await this.rebuildWikiIndex()

    this._wikiVersion++
    return {
      ok: true,
      written: applyResult.written,
      log: result.rejected?.length ? `${result.logEntry}（拒绝: ${result.rejected.join('; ')}）` : result.logEntry
    }
  }

  // ─── Experience Integration ────────────────────────────────────────

  /** Save a conversation experience directly into the knowledge raw directory. */
  async saveExperience(content: string, convId: string, title?: string): Promise<KnowledgeFile> {
    return getHost().knowledgeWriteExperience({ content, convId, title })
  }

  /** Clear all knowledge: delete all files and DB records. */
  async clearAll(): Promise<{ deletedRaw: number; deletedWiki: number }> {
    return getHost().knowledgeClearAll()
  }

}
