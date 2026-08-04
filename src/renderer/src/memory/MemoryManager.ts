import type {
  MemoryEntry,
  MemoryCreateInput,
  MemoryUpdateInput,
  MemorySearchInput,
  MemoryPreferences
} from './types'
import { DEFAULT_MEMORY_PREFERENCES } from './types'
import type { LlmAdapter } from '../llm/adapter'
import { MemoryCompressionAgent, ExperienceAgent, SessionReviewAgent } from '../agent/one-shot-agent'

/**
 * Manages memory capture, storage, and retrieval.
 *
 * Three parts of memory context:
 *   A. Manual — user-edited text file (via Memory panel Manual Memories editor)
 *   B. Extracted — auto-captured from sessions (types: auto, fact, decision, preference)
 *      Auto-compressed to ≤20 when total exceeds 30.
 *   C. Recent Sessions — conversation id + summary from SQLite,
 *      split into 15min–24h (all) and >24h (latest 50).
 *
 * Note: experiences (workflow optimizations, pain points) are now stored in the
 * knowledge base (raw/ directory) and compiled into wiki pages, replacing the
 * old in-memory experiences section.
 */
export class MemoryManager {
  private prefs: MemoryPreferences = { ...DEFAULT_MEMORY_PREFERENCES }

  // Used for compression LLM calls
  private apiKey: string = ''
  private baseURL: string = ''
  private adapter: LlmAdapter | null = null
  private model: string = ''

  private compressionAgent = new MemoryCompressionAgent()
  private experienceAgent = new ExperienceAgent()
  private sessionReviewAgent = new SessionReviewAgent()

  /** Simple flag to prevent concurrent compression runs. */
  private _compressing = false

  // --- Preferences ---

  getPreferences(): MemoryPreferences {
    return { ...this.prefs }
  }

  setPreferences(prefs: Partial<MemoryPreferences>): void {
    this.prefs = { ...this.prefs, ...prefs }
  }

  /** Store LLM config so background tasks (compression) can call the API. */
  setConfig(apiKey: string, baseURL: string, adapter: LlmAdapter, model: string): void {
    this.apiKey = apiKey
    this.baseURL = baseURL
    this.adapter = adapter
    this.model = model
  }

  // ===================================================================
  // Part A: Manual Memories
  // File-backed, user-edited via Memory panel "Manual Memories" textarea.
  // ===================================================================

  /** Load the Manual Memories text content from disk. */
  async getMemoryMd(): Promise<string> {
    return window.electronAPI.getMemoryMd()
  }

  /** Save the Manual Memories text content to disk (full overwrite). */
  async saveMemoryMd(content: string): Promise<void> {
    await window.electronAPI.saveMemoryMd(content)
  }

  // ===================================================================
  // Part B: Extracted Memories
  // DB-backed, auto-captured from sessions. Supports CRUD + compression.
  // ===================================================================

  async listMemories(category?: string): Promise<MemoryEntry[]> {
    const result = await window.electronAPI.listMemories(category)
    return Array.isArray(result) ? result : []
  }

  async saveMemory(input: MemoryCreateInput): Promise<MemoryEntry | null> {
    const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
    const entry = await window.electronAPI.saveMemory({
      id,
      content: input.content,
      type: input.type ?? 'auto',
      category: input.category ?? 'general',
      source: input.source ?? null
    })

    return entry
  }

  async updateMemory(id: string, input: MemoryUpdateInput): Promise<void> {
    await window.electronAPI.updateMemory(id, input)
  }

  async deleteMemory(id: string): Promise<void> {
    await window.electronAPI.deleteMemory(id)
  }

  async searchMemories(input: MemorySearchInput): Promise<MemoryEntry[]> {
    return window.electronAPI.searchMemories(input)
  }

  /**
   * If extracted memories exceed 50, consolidate to ≤20 via LLM.
   * Only touches auto-type memories (auto, fact, decision, preference).
   * Manual memories are never compressed.
   */
  async ensureMemoryCompressed(): Promise<boolean> {
    if (this._compressing || !this.adapter || !this.apiKey) return false
    this._compressing = true

    try {
      const extractedTypes = ['auto', 'fact', 'decision', 'preference']
      let count: number
      try {
        count = await window.electronAPI.countMemories(extractedTypes)
      } catch (err: any) {
        // Database not yet initialized — transient startup condition, silently skip
        if (err?.message?.includes?.('Database not initialized')) return false
        throw err
      }
      if (count <= 50) return true

      // Load all extracted memories
      const all = await this.listMemories()
      const extracted = all.filter((m) => extractedTypes.includes(m.type))
      if (extracted.length <= 50) return true

      const memoriesText = extracted
        .map((m) => `- [${m.category}] ${m.content}`)
        .join('\n')

      const compressed = await this.compressionAgent.execute(
        { memoriesText },
        { llmConfig: { adapter: this.adapter, apiKey: this.apiKey, baseURL: this.baseURL, model: this.model }, maxTokens: 4000 }
      )

      if (compressed.length === 0) return false

      const validTypes = ['auto', 'manual', 'fact', 'decision', 'preference']
      const validCategories = ['code', 'architecture', 'user_pref', 'decision', 'general']

      // Delete all original extracted memories
      await Promise.all(extracted.map((m) => this.deleteMemory(m.id)))

      // Save new compressed ones
      for (const mem of compressed) {
        if (!mem.content || mem.content.length < 10) continue
        const type = validTypes.includes(mem.type) ? mem.type : 'auto'
        const category = validCategories.includes(mem.category) ? mem.category : 'general'
        await this.saveMemory({ content: mem.content, type: type as MemoryCreateInput['type'], category: category as MemoryCreateInput['category'] })
      }

      console.log(`[MemoryManager] Compressed ${extracted.length} memories to ${compressed.length}`)
      return true
    } catch (err) {
      console.warn('[MemoryManager] Compression error:', err)
      return false
    } finally {
      this._compressing = false
    }
  }

  // Experience compression removed — experiences are now stored in the knowledge
  // base (raw/ directory) rather than the memories table, so compression is
  // handled by the knowledge base compiler pipeline instead.

  // ===================================================================
  // Part C: Recent Conversations
  // Provides a summary of recent sessions for the system prompt.
  // ===================================================================

  /**
   * Build a string describing recent conversations, split into two time windows:
   *   - 15 minutes to 24 hours ago (all sessions)
   *   - Older than 24 hours (latest 50)
   */
  private async getRecentSessionContext(): Promise<string> {
    const now = Date.now()
    const oneMinAgo = new Date(now - 1 * 60 * 1000).toISOString()
    const twentyFourHAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString()

    const [recentSessions, olderSessions] = await Promise.all([
      window.electronAPI.listConversationsForMemory({
        afterTime: twentyFourHAgo,
        beforeTime: oneMinAgo
      }),
      window.electronAPI.listConversationsForMemory({
        beforeTime: twentyFourHAgo,
        limit: 50
      })
    ])

    const parts: string[] = []
    parts.push('<guide>If needed, you can use the ID to trigger conversation_search to retrieve the conversation records.</guide>')
    parts.push('<data>')
    parts.push('|id|keywords|')
    if (recentSessions.length > 0) {
      for (const s of recentSessions) {
        const label = s.keywords || s.summary || s.title
        if (!label) continue
        parts.push(`${s.id}|${label}|`)
      }
    }

    if (olderSessions.length > 0) {
      for (const s of olderSessions) {
        const label = s.keywords || s.summary || s.title
        if (!label) continue
        parts.push(`${s.id}|${label}|`)
      }
    }
    parts.push('</data>')

    return parts.join('')
  }

  // ===================================================================
  // Experience Capture
  // Extracts workflow optimizations and user pain points from sessions,
  // saves as type='experience' memories for automatic injection into
  // the system prompt.
  // ===================================================================

  /**
   * Extract experiences from a completed session.
   * Uses ExperienceAgent to identify workflow optimizations and pain points.
   * Returns the experience content and category — caller is responsible for
   * persisting it to the knowledge base (raw/).
   */
  async extractAndSaveExperiences(
    sessionMessages: readonly { role: string; content: string }[],
    apiKey: string,
    baseURL: string,
    adapter: LlmAdapter,
    model: string,
    conversationId?: string,
    locale?: string
  ): Promise<{ title: string | null; content: string | null; category: string | null }> {
    if (!this.prefs.autoCaptureEnabled || !apiKey) return { title: null, content: null, category: null }

    // --- Dedup guard: skip if conversation already processed ---
    if (conversationId) {
      const processedCount = await window.electronAPI.getConversationExperienceExtractedCount(conversationId)
      // extractAndSaveAll (afterSession) extracts memories + experiences together and
      // bumps the memory counter; a satisfied memory counter means this conversation's
      // experiences were already reviewed, so skip too (prevents the two extraction
      // paths from double-extracting the same conversation).
      const memProcessed = await window.electronAPI.getConversationExtractedMsgCount(conversationId)
      if (processedCount >= sessionMessages.length || memProcessed >= sessionMessages.length) {
        console.log(`[MemoryManager] Already extracted experiences for conversation ${conversationId} at msg count ${processedCount}, skipping`)
        return { title: null, content: null, category: null }
      }
      console.log(`[MemoryManager] Extracting experiences for conversation ${conversationId}: ${sessionMessages.length} msgs (prev processed: ${processedCount})`)
    }

    // Build conversation text (user + assistant text messages)
    const conversationText = sessionMessages
      .filter((m) => m.content.trim())
      .map((m) => `[${m.role}]: ${m.content.slice(0, 1500)}`)
      .join('\n\n')
      .slice(0, 30000)

    // Get existing experiences from knowledge base for merge/dedup reference
    const allFiles = await window.electronAPI.knowledgeListFiles()
    const expFiles = (allFiles || []).filter((f: { sourceType: string }) => f.sourceType === 'experience')
    const expContents = await Promise.all(
      expFiles.map(async (f: { filePath: string }) => {
        try {
          const c = await window.electronAPI.knowledgeGetRaw(f.filePath)
          return `- ${c.slice(0, 300)}`
        } catch { return '' }
      })
    )
    const existingExpText = expContents.filter(Boolean).length > 0
      ? 'EXISTING EXPERIENCES (check if new insight relates to or duplicates any of these):\n' + expContents.filter(Boolean).join('\n')
      : 'No existing experiences yet.'

    try {
      const result = await this.experienceAgent.execute(
        { conversationText, existingExperiencesText: existingExpText, locale },
        { llmConfig: { adapter, apiKey, baseURL, model }, maxTokens: 2000 }
      )

      if (!result) {
        console.log(`[MemoryManager] No valuable experience insights — skipping`)
        if (conversationId) {
          await window.electronAPI.updateConversationExperienceExtractedCount(conversationId, sessionMessages.length).catch((e) => {
            console.warn('[MemoryManager] Failed to update experience extracted count:', e)
          })
        }
        return { title: null, content: null, category: null }
      }

      const { title, content: bodyContent, category } = result
      if (!bodyContent) return { title: null, content: null, category: null }

      const validCategories = ['code', 'architecture', 'user_pref', 'decision', 'general']
      const experienceCategory = validCategories.includes(category) ? category : 'general'

      if (conversationId) {
        await window.electronAPI.updateConversationExperienceExtractedCount(conversationId, sessionMessages.length).catch((e) => {
          console.warn('[MemoryManager] Failed to update experience extracted count:', e)
        })
      }

      console.log(`[MemoryManager] Extracted experience (${experienceCategory}) from conversation ${conversationId}`)
      return { title, content: bodyContent, category: experienceCategory }
    } catch (err) {
      console.warn('[MemoryManager] extractAndSaveExperiences error:', err)
      return { title: null, content: null, category: null }
    }
  }

  // ===================================================================
  // Unified Review (memories + experiences, single LLM call)
  // ===================================================================

  /**
   * Extract both memories AND experiences from a completed session in a single
   * LLM call. Saves memories to the DB and returns experience content for the
   * caller to persist to the knowledge base (raw/).
   *
   * Returns { memories count, experienceContent, experienceCategory }.
   */
  async extractAndSaveAll(
    sessionMessages: readonly { role: string; content: string }[],
    apiKey: string,
    baseURL: string,
    adapter: LlmAdapter,
    model: string,
    conversationId?: string,
    locale?: string
  ): Promise<{ memories: number; experienceTitle: string | null; experienceContent: string | null; experienceCategory: string | null }> {
    if (!this.prefs.autoCaptureEnabled || !apiKey) return { memories: 0, experienceTitle: null, experienceContent: null, experienceCategory: null }

    // --- Dedup guard: skip if conversation already processed at this message count ---
    if (conversationId) {
      const processedCount = await window.electronAPI.getConversationExtractedMsgCount(conversationId)
      if (processedCount >= sessionMessages.length) {
        console.log(`[MemoryManager] Already extracted for conversation ${conversationId} at msg count ${processedCount}, skipping`)
        return { memories: 0, experienceTitle: null, experienceContent: null, experienceCategory: null }
      }
      console.log(`[MemoryManager] Extracting memories+experiences for conversation ${conversationId}: ${sessionMessages.length} msgs (prev processed: ${processedCount})`)
    }

    // Build session summary
    const summary = sessionMessages
      .map((m) => `[${m.role}]: ${m.content.slice(0, 2000)}`)
      .join('\n\n')
      .slice(0, 12000)

    // Build existing experiences context for merge/dedup from knowledge base
    const allFiles = await window.electronAPI.knowledgeListFiles()
    const expFiles = (allFiles || []).filter((f: { sourceType: string }) => f.sourceType === 'experience')
    const expContents = await Promise.all(
      expFiles.map(async (f: { filePath: string }) => {
        try {
          const c = await window.electronAPI.knowledgeGetRaw(f.filePath)
          return `- ${c.slice(0, 300)}`
        } catch { return '' }
      })
    )
    const existingExperiencesText = expContents.filter(Boolean).length > 0
      ? 'EXISTING EXPERIENCES (check if new insight relates to or duplicates any of these):\n' + expContents.filter(Boolean).join('\n')
      : ''

    try {
      const result = await this.sessionReviewAgent.execute(
        { sessionSummary: summary, existingExperiencesText, locale },
        { llmConfig: { adapter, apiKey, baseURL, model }, maxTokens: 4000 }
      )

      let memoriesSaved = 0

      // --- Save conversation summary ---
      if (conversationId && result.summary) {
        const trimmed = result.summary.slice(0, 200)
        await window.electronAPI.updateConversationSummary(conversationId, trimmed).catch((e) => {
          console.warn('[MemoryManager] Failed to save conversation summary:', e)
        })
      }

      // --- Save conversation keywords ---
      if (conversationId && result.keywords) {
        const joined = result.keywords
          .filter((k: unknown) => typeof k === 'string' && k.trim())
          .slice(0, 10)
          .join('、')
        if (joined) {
          await window.electronAPI.updateConversationKeywords(conversationId, joined).catch((e) => {
            console.warn('[MemoryManager] Failed to save conversation keywords:', e)
          })
        }
      }

      // --- Save extracted memories ---
      const validTypes = ['auto', 'manual', 'fact', 'decision', 'preference']
      const validCategories = ['code', 'architecture', 'user_pref', 'decision', 'general']

      for (const mem of result.memories) {
        if (!mem.content || mem.content.length < 10) continue
        const entry = await this.saveMemory({
          content: mem.content,
          type: validTypes.includes(mem.type) ? (mem.type as MemoryCreateInput['type']) : 'auto',
          category: validCategories.includes(mem.category)
            ? (mem.category as MemoryCreateInput['category'])
            : 'general'
        })
        if (entry) memoriesSaved++
      }

      // --- Extract experience (don't save to memories — caller saves to knowledge base) ---
      let experienceTitle: string | null = null
      let experienceContent: string | null = null
      let experienceCategory: string | null = null
      if (result.experience && result.experience.content) {
        const title = result.experience.title
        experienceTitle = typeof title === 'string' && title ? title : null
        const cat = result.experience.category
        experienceCategory = validCategories.includes(cat) ? cat : 'general'
        experienceContent = result.experience.content
      }

      // Check if memory compression is needed
      await this.ensureMemoryCompressed()

      // Mark conversation as processed — bump BOTH counters (memory + experience).
      // extractAndSaveAll extracts memories AND experiences together, so the
      // startup background task (extractAndSaveExperiences) must see this as done
      // or it will re-extract the same experiences from the same conversation.
      if (conversationId) {
        await window.electronAPI.updateConversationExtractedMsgCount(conversationId, sessionMessages.length).catch((e) => {
          console.warn('[MemoryManager] Failed to update extracted message count:', e)
        })
        await window.electronAPI.updateConversationExperienceExtractedCount(conversationId, sessionMessages.length).catch((e) => {
          console.warn('[MemoryManager] Failed to update experience extracted count:', e)
        })
      }

      console.log(`[MemoryManager] Saved ${memoriesSaved} memory/ies from conversation ${conversationId || 'unknown'}`)
      return { memories: memoriesSaved, experienceTitle, experienceContent, experienceCategory }
    } catch (err) {
      console.warn('[MemoryManager] extractAndSaveAll error:', err)
      return { memories: 0, experienceTitle: null, experienceContent: null, experienceCategory: null }
    }
  }

  // ===================================================================
  // Migration — experience memories → knowledge base raw/
  // ===================================================================

  /**
   * One-time migration: move all existing type='experience' memory entries
   * to the knowledge base raw/ directory, then delete them from memories.
   * Safe to call multiple times.
   */
  async migrateExperienceMemoriesToKnowledge(): Promise<number> {
    const all = await this.listMemories()
    const experienceMemories = all.filter((m) => m.type === 'experience')
    if (experienceMemories.length === 0) return 0

    let migrated = 0
    for (const mem of experienceMemories) {
      try {
        await window.electronAPI.knowledgeWriteExperience({
          content: mem.content,
          convId: mem.source || 'migration'
        })
        await this.deleteMemory(mem.id)
        migrated++
      } catch (err) {
        console.warn('[MemoryManager] Failed to migrate experience:', err)
      }
    }

    if (migrated > 0) {
      console.log(`[MemoryManager] Migrated ${migrated} experience memories to knowledge base`)
    }
    return migrated
  }

  // ===================================================================
  // Recall
  // Builds the # Memory Context section of the system prompt by
  // assembling the three peer parts (A, B, C).
  // ===================================================================

  /**
   * Build the memory context section for the system prompt.
   * Combines all four memory parts:
   *   A. Manual memories (user-edited)
   *   B. Extracted memories (auto-captured facts/decisions/preferences, compressed if >50)
   *   B2. Experiences (workflow optimizations, user pain points)
   *   C. Recent session summaries
   */
  /** Filter for extracted-type memories and format as markdown bullet lines. */
  private getExtractedMemoriesContent(all: MemoryEntry[]): string {
    const extracted = all.filter((m) =>
      ['auto', 'fact', 'decision', 'preference'].includes(m.type)
    )
    if (extracted.length === 0) return ''

    return extracted.map(m => `- ${m.content}`).join('\n')
  }

  async buildMemoryContext(): Promise<string> {
    if (!this.prefs.autoInjectEnabled) return ''

    // Compression is handled at extraction time — no blocking LLM calls here.
    // Load memories, recent sessions, and manual memories file in parallel — 3 IPC calls concurrently.
    const [manualMdContent, all, sessionContext] = await Promise.all([
      this.getMemoryMd(),
      this.listMemories(),
      this.getRecentSessionContext()
    ])

    const parts: string[] = ['# Memory Context']

    // Part A: Manual Memories (user-edited from Memory panel, stored in file)
    if (manualMdContent && typeof manualMdContent === 'string' && manualMdContent.trim()) {
      parts.push('## Manual Memories')
      parts.push(manualMdContent)
    }

    // Part B: Extracted Memories (facts, decisions, preferences)
    const extractedContent = this.getExtractedMemoriesContent(all)
    if (extractedContent) {
      parts.push('## Extracted Memories')
      parts.push(extractedContent)
    }

    // Part B2: Experiences — removed. Experiences are now stored in the knowledge
    // base (raw/ directory) and compiled into wiki pages, replacing the old
    // in-memory experiences section.

    // Part C: Recent sessions
    if (sessionContext) {
      parts.push('## Recent Conversations')
      parts.push(sessionContext)
    }

    const result = parts.join('\n')
    return result === '# Memory Context' ? '' : result
  }
}
