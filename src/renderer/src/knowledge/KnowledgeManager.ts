import { KnowledgeCompilerAgent } from '../agent/one-shot-agent/KnowledgeCompilerAgent'
import { ExperienceCompressionAgent } from '../agent/one-shot-agent/ExperienceCompressionAgent'
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
  private experienceCompressionAgent = new ExperienceCompressionAgent()
  private apiKey = ''
  private baseURL = ''
  private adapter: LlmAdapter | null = null
  private model = ''
  private _wikiVersion = 0
  private _consolidating = false

  /** Incremented each time compile() or compileFile() succeeds. AgentEngine
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

  /** Compile all un-compiled raw files into the wiki. Returns a summary. */
  async compile(): Promise<{ ok: boolean; written: number; log: string }> {
    if (!this.canCompile || !this.adapter) {
      return { ok: false, written: 0, log: 'LLM not configured' }
    }

    // 1. Get un-compiled files
    const rawFiles = await this.listFiles('raw')
    if (rawFiles.length === 0) {
      return { ok: true, written: 0, log: 'Nothing to compile' }
    }

    // 2. Read existing wiki index
    let existingIndex = ''
    try {
      const wiki = await this.readWiki('index.md')
      existingIndex = wiki.content || ''
    } catch {
      existingIndex = ''
    }

    // 3. Read schema
    let schema = ''
    try {
      // Schema is stored on disk, read it as a raw file relative path
      // We can't read schema via readRawContent since it's not in raw/. Use a dedicated path.
      schema = existingIndex.length > 0
        ? 'See rules in wiki/index.md frontmatter.'
        : 'Standard wiki: sources/, entities/, concepts/, syntheses/.'
    } catch {
      schema = 'Standard wiki structure.'
    }

    // 4. Read raw file content in batches of 3
    const BATCH_SIZE = 3
    let totalWritten = 0
    let logEntries: string[] = []

    for (let i = 0; i < rawFiles.length; i += BATCH_SIZE) {
      const batch = rawFiles.slice(i, i + BATCH_SIZE)

      const fileContents = await Promise.all(
        batch.map(async (f) => {
          const content = await this.readRawContent(f.filePath)
          return { id: f.id, filePath: f.filePath, title: f.title, content }
        })
      )

      // 5. Call compiler agent
      const result = await this.compilerAgent.execute(
        { schema, existingIndex, rawFiles: fileContents },
        {
          llmConfig: {
            apiKey: this.apiKey,
            baseURL: this.baseURL,
            model: this.model,
            adapter: this.adapter
          },
          maxTokens: 4000
        }
      )

      if (result.actions.length === 0) continue

      // 6. Apply wiki changes via IPC
      const applyResult = await getHost().knowledgeApplyWikiChanges({
        actions: result.actions,
        logEntry: result.logEntry,
        compiledIds: batch.map(f => f.id)
      })

      totalWritten += applyResult.written
      logEntries.push(result.logEntry)
    }

    // 7. Rebuild structured wiki index from page files
    if (totalWritten > 0) {
      await this.rebuildWikiIndex()
    }

    this._wikiVersion++
    return {
      ok: true,
      written: totalWritten,
      log: logEntries.join('; ') || 'Compilation complete'
    }
  }

  /** Compile a single raw file by ID. Returns the same shape as compile(). */
  async compileFile(fileId: string): Promise<{ ok: boolean; written: number; log: string }> {
    if (!this.canCompile || !this.adapter) {
      return { ok: false, written: 0, log: 'LLM not configured' }
    }

    const file = await this.getFile(fileId)
    if (!file || file.status !== 'raw') {
      return { ok: false, written: 0, log: 'File not found or already compiled' }
    }

    // Read existing wiki index
    let existingIndex = ''
    try {
      const wiki = await this.readWiki('index.md')
      existingIndex = wiki.content || ''
    } catch { /* wiki may not exist */ }

    let schema = ''
    try {
      schema = existingIndex.length > 0
        ? 'See rules in wiki/index.md frontmatter.'
        : 'Standard wiki: sources/, entities/, concepts/, syntheses/.'
    } catch { /* ignore */ }

    // Read raw content
    const content = await this.readRawContent(file.filePath)
    const fileContents = [{ id: file.id, filePath: file.filePath, title: file.title, content }]

    // Call compiler agent
    const result = await this.compilerAgent.execute(
      { schema, existingIndex, rawFiles: fileContents },
      {
        llmConfig: {
          apiKey: this.apiKey,
          baseURL: this.baseURL,
          model: this.model,
          adapter: this.adapter
        },
        maxTokens: 4000
      }
    )

    if (result.actions.length === 0) {
      return { ok: true, written: 0, log: 'No changes needed' }
    }

    // Apply wiki changes
    const applyResult = await getHost().knowledgeApplyWikiChanges({
      actions: result.actions,
      logEntry: result.logEntry,
      compiledIds: [file.id]
    })

    // Rebuild structured wiki index
    await this.rebuildWikiIndex()

    this._wikiVersion++
    return {
      ok: true,
      written: applyResult.written,
      log: result.logEntry
    }
  }

  /** Read the compiled (wiki) content of a file by its wiki path. */
  async readCompiledContent(wikiPath: string): Promise<string | null> {
    const result = await this.readWiki(wikiPath)
    return result.content
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

  /**
   * Merge and deduplicate experience files when their count exceeds the
   * threshold (lazy, non-periodic). Processes experiences in batches of 20:
   * each batch is consolidated by the LLM into at most 10 merged experiences,
   * written as new raw files and compiled into the wiki, then the source
   * files are deleted. Safe order: write new files first, delete originals
   * only after at least one replacement was written.
   */
  async consolidateExperiences(threshold = 25): Promise<{ ok: boolean; merged: number; remaining: number; log: string }> {
    if (this._consolidating) return { ok: false, merged: 0, remaining: 0, log: 'Consolidation already running' }
    if (!this.canCompile || !this.adapter) return { ok: false, merged: 0, remaining: 0, log: 'LLM not configured' }
    this._consolidating = true

    try {
      const all = await this.listFiles()
      const experiences = all.filter(f => f.sourceType === 'experience')
      if (experiences.length <= threshold) {
        return { ok: true, merged: 0, remaining: experiences.length, log: 'Under threshold, no consolidation needed' }
      }

      const BATCH_SIZE = 20
      const logs: string[] = []

      for (let i = 0; i < experiences.length; i += BATCH_SIZE) {
        const batch = experiences.slice(i, i + BATCH_SIZE)

        // Read full contents (must not be truncated — consolidation needs complete text)
        const contents = await Promise.all(batch.map(async (f) => {
          let content = ''
          try { content = await this.readRawContent(f.filePath) } catch { /* unreadable file: keep title only */ }
          return `## ${f.title}\n\n${content}`
        }))

        const result = await this.experienceCompressionAgent.execute(
          { experiencesText: contents.join('\n\n---\n\n') },
          {
            llmConfig: { adapter: this.adapter, apiKey: this.apiKey, baseURL: this.baseURL, model: this.model },
            maxTokens: 4000
          }
        )

        const valid = result.filter(exp => exp.content && exp.content.length >= 10)
        const written: string[] = []
        for (const exp of valid) {
          const title = exp.title?.slice(0, 80) || 'Consolidated experience'
          try {
            const saved = await this.saveExperience(exp.content, 'consolidation', title)
            written.push(saved.id)
            await this.compileFile(saved.id).catch(err =>
              logs.push(`compile "${title}": ${err instanceof Error ? err.message : String(err)}`)
            )
          } catch (err) {
            logs.push(`write "${title}": ${err instanceof Error ? err.message : String(err)}`)
          }
        }

        // Only delete sources after at least one replacement was written
        if (written.length > 0) {
          for (const f of batch) {
            await this.deleteFile(f.id).catch(() => {})
          }
        }
        logs.push(`Batch of ${batch.length} experiences → ${valid.length} merged (${batch.length - valid.length} duplicates removed)`)
      }

      const remaining = (await this.listFiles()).filter(f => f.sourceType === 'experience').length
      console.log(`[KnowledgeManager] Experience consolidation complete: ${experiences.length} → ${remaining}`)
      return { ok: true, merged: experiences.length - remaining, remaining, log: logs.join('; ') }
    } catch (err) {
      console.warn('[KnowledgeManager] Experience consolidation error:', err)
      return {
        ok: false,
        merged: 0,
        remaining: (await this.listFiles().catch(() => [])).filter(f => f.sourceType === 'experience').length,
        log: err instanceof Error ? err.message : String(err)
      }
    } finally {
      this._consolidating = false
    }
  }

  // ─── System Prompt Context ─────────────────────────────────────────

  /**
   * Build a concise wiki context section for the system prompt.
   * Returns wiki page listing + stats, omitting the full index.md
   * to avoid token bloat. LLM can use knowledge_search / knowledge_read
   * to find specific content.
   */
  async buildWikiContext(): Promise<string> {
    try {
      const [wikiDir, stats] = await Promise.all([
        this.readWiki(),
        this.getStats()
      ])

      if (stats.total === 0) return ''

      const parts: string[] = ['## Knowledge Base']
      parts.push(`Total sources: ${stats.total} (${stats.compiled} compiled, ${stats.raw} raw)`)

      if (wikiDir.files && wikiDir.files.length > 0) {
        parts.push('### Wiki Pages')
        parts.push(wikiDir.files.map(f => `- ${f}`).join('\n'))
      }

      parts.push('Use `knowledge_search` to find sources, `knowledge_read` to read wiki pages or raw files.')
      return parts.join('\n')
    } catch {
      return ''
    }
  }
}
