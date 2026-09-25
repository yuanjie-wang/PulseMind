import type {
  MemoryEntry,
  MemoryCreateInput,
  MemoryUpdateInput,
  MemorySearchInput,
  MemoryPreferences
} from './types'
import { DEFAULT_MEMORY_PREFERENCES } from './types'
import type { LlmAdapter } from '../llm/adapter'
import type { AgentMessage, TextBlock } from '../types/agent'
import { MemoryCompressionAgent, SessionReviewAgent } from '../agent/one-shot-agent'
import { getHost } from '../agent/host'
import { memoryContentHash } from '../../../shared/memory/content-hash'
import { parseExperienceMd } from '../../../shared/experience/frontmatter'
import type { ExperienceRecord } from '../../../shared/types/experience-types'

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
 * Note: experiences (workflow optimizations, pain points) live in the
 * experience pool (`~/.pulsemind/experiences/`, skill-format records) — the
 * extraction pass reads that pool for dedup/iteration context and the CALLER
 * persists the returned experience (PLAN-experience-iteration).
 */
export class MemoryManager {
  private prefs: MemoryPreferences = { ...DEFAULT_MEMORY_PREFERENCES }

  // Used for compression LLM calls
  private apiKey: string = ''
  private baseURL: string = ''
  private adapter: LlmAdapter | null = null
  private model: string = ''

  private compressionAgent = new MemoryCompressionAgent()
  private sessionReviewAgent = new SessionReviewAgent()

  /** Simple flag to prevent concurrent compression runs. */
  private _compressing = false

  // P0 (PLAN-memory-extraction-dedup): failure backoff, process-lifetime.
  // A conversation whose extraction LLM call just FAILED retried on every
  // turn end before — same delta, same failure, once a turn. 1h per failure;
  // three consecutive failures retire the conversation for this process run.
  private extractionBackoff = new Map<string, { failedAt: number; attempts: number }>()
  private static BACKOFF_MS = 60 * 60 * 1000
  private static BACKOFF_MAX_ATTEMPTS = 3

  /** True when this conversation is inside the failure backoff window. */
  isInBackoff(conversationId: string): boolean {
    const entry = this.extractionBackoff.get(conversationId)
    if (!entry) return false
    if (entry.attempts >= MemoryManager.BACKOFF_MAX_ATTEMPTS) return true
    return Date.now() - entry.failedAt < MemoryManager.BACKOFF_MS
  }

  /** P2 watermark: how many memories existed at the last merge + when it ran.
   *  Pure numbers, mirrored into settings.json by the main-process hook. */
  private mergeWatermark: { lastRunAt: number; lastCount: number } = { lastRunAt: 0, lastCount: 0 }

  setMergeWatermark(w: { lastRunAt: number; lastCount: number }): void {
    this.mergeWatermark = w
  }

  getMergeWatermark(): { lastRunAt: number; lastCount: number } {
    return { ...this.mergeWatermark }
  }

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
    return getHost().getMemoryMd()
  }

  /** Save the Manual Memories text content to disk (full overwrite). */
  async saveMemoryMd(content: string): Promise<void> {
    await getHost().saveMemoryMd(content)
  }

  // ===================================================================
  // Part B: Extracted Memories
  // DB-backed, auto-captured from sessions. Supports CRUD + compression.
  // ===================================================================

  async listMemories(category?: string): Promise<MemoryEntry[]> {
    const result = await getHost().listMemories(category)
    return Array.isArray(result) ? result : []
  }

  async saveMemory(input: MemoryCreateInput): Promise<MemoryEntry | null> {
    const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
    const entry = await getHost().saveMemory({
      id,
      content: input.content,
      type: input.type ?? 'auto',
      category: input.category ?? 'general',
      source: input.source ?? null
    })

    return entry
  }

  async updateMemory(id: string, input: MemoryUpdateInput): Promise<void> {
    await getHost().updateMemory(id, input)
  }

  async deleteMemory(id: string): Promise<void> {
    await getHost().deleteMemory(id)
  }

  async searchMemories(input: MemorySearchInput): Promise<MemoryEntry[]> {
    return getHost().searchMemories(input)
  }

  // P2 (PLAN-memory-extraction-dedup): the old "over 50 → delete-all → rewrite"
  // consolidation is GONE. It silently discarded user-edited memories and
  // re-billed every memory on every rewrite. The replacement is an INCREMENTAL
  // merge with an explicit watermark (new ≥5 since last merge, or total >50,
  // and ≥24h since the last run): merged output lands row-by-row through the
  // hash-gated saveMemory (literal repeats dedupe for free), user-edited rows
  // (updated_at > created_at) are undeletable by code no matter what the LLM
  // says, and the watermark rides settings.json via the main-process host.
  static readonly MERGE_MIN_NEW = 5
  static readonly MERGE_TOTAL_CAP = 50
  static readonly MERGE_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000

  /**
   * Incremental memory merge. Returns true when a merge actually ran.
   * Only touches extracted types; manual memories are never touched.
   */
  async ensureMemoryMerged(): Promise<boolean> {
    if (this._compressing || !this.adapter || !this.apiKey) return false
    const wm = this.getMergeWatermark()
    const now = Date.now()
    if (wm.lastRunAt !== 0 && now - wm.lastRunAt < MemoryManager.MERGE_MIN_INTERVAL_MS) return false

    const extractedTypes = ['auto', 'fact', 'decision', 'preference']
    const all = await this.listMemories()
    const extracted = all.filter((m) => extractedTypes.includes(m.type))
    const added = wm.lastRunAt === 0
      ? extracted.length
      : extracted.filter((m) => new Date(m.createdAt).getTime() > wm.lastRunAt).length
    const due = added >= MemoryManager.MERGE_MIN_NEW || extracted.length > MemoryManager.MERGE_TOTAL_CAP
    if (!due) return false

    this._compressing = true
    try {
      // Input: the FULL set (the merge must see what it consolidates into),
      // with each line marked so the model can obey the rules below.
      const memoriesText = extracted
        .map((m) => {
          const marks: string[] = [`[${m.category}]`]
          if (m.updatedAt && m.createdAt && m.updatedAt > m.createdAt) marks.push('[USER-EDITED]')
          if (wm.lastRunAt !== 0 && new Date(m.createdAt).getTime() > wm.lastRunAt) marks.push('[NEW]')
          return `- ${marks.join(' ')} ${m.content.slice(0, 300)}`
        })
        .join('\n')

      const merged = await this.compressionAgent.execute(
        { memoriesText },
        { llmConfig: { adapter: this.adapter, apiKey: this.apiKey, baseURL: this.baseURL, model: this.model }, maxTokens: 4000 }
      )
      if (merged.length === 0) return false

      const validTypes = ['auto', 'manual', 'fact', 'decision', 'preference']
      const validCategories = ['code', 'architecture', 'user_pref', 'decision', 'general']

      // Output identity = content hash (the same key the save gate uses).
      const mergedHashes = new Set<string>()
      for (const mem of merged) {
        if (!mem.content || mem.content.length < 10) continue
        mergedHashes.add(memoryContentHash(mem.content))
      }

      // Delete only what the merge truly consumed: un-edited extracted rows
      // whose content no longer exists in the merged set. A USER-EDITED row
      // survives unconditionally (the plan's hard rule — the old delete-all
      // silently destroyed exactly these).
      for (const m of extracted) {
        const userEdited = !!(m.updatedAt && m.createdAt && m.updatedAt > m.createdAt)
        if (userEdited) continue
        if (!mergedHashes.has(memoryContentHash(m.content))) {
          await this.deleteMemory(m.id)
        }
      }

      // Re-save the merged set: the saveMemory hash gate makes this an UPSERT
      // against surviving rows (same content → skipped) and an insert for
      // genuinely new consolidations.
      for (const mem of merged) {
        if (!mem.content || mem.content.length < 10) continue
        const type = validTypes.includes(mem.type) ? mem.type : 'auto'
        const category = validCategories.includes(mem.category) ? mem.category : 'general'
        await this.saveMemory({ content: mem.content, type: type as MemoryCreateInput['type'], category: category as MemoryCreateInput['category'] })
      }

      this.setMergeWatermark({ lastRunAt: now, lastCount: await getHost().countMemories(extractedTypes) })
      console.log(`[MemoryManager] merged ${extracted.length} extracted memories → ${mergedHashes.size} contents (watermark advanced)`)
      return true
    } catch (err) {
      console.warn('[MemoryManager] Memory merge error:', err)
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
      getHost().listConversationsForMemory({
        afterTime: twentyFourHAgo,
        beforeTime: oneMinAgo
      }),
      getHost().listConversationsForMemory({
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

  // ===================================================================
  // Unified Review (memories + experiences, single LLM call)
  // ===================================================================

  /**
   * Extract both memories AND experiences from a completed session in a single
   * LLM call. Saves memories to the DB and returns experience content for the
   * caller to persist to the knowledge base (raw/).
   *
   * Incremental: only messages after the stored cursor are analyzed, so a
   * growing conversation never re-extracts already-processed messages.
   * The cursor counts text-only messages (user/assistant with a text block),
   * (the backfill uses the same toTextMessages flattening — one cursor unit).
   *
   * Returns { memories count, experienceContent, experienceCategory }.
   */
  async extractAndSaveAll(
    messages: readonly AgentMessage[],
    apiKey: string,
    baseURL: string,
    adapter: LlmAdapter,
    model: string,
    conversationId?: string,
    locale?: string,
    /** Feature master switches (设置 → 记忆/经验). Absent = both on. */
    featureFlags?: { memory?: boolean; experience?: boolean },
    /** P1 (PLAN-memory-extraction-dedup): minimum TEXT-message delta before an
     *  extraction is worth one LLM call. AfterSession hosts pass 4 (a thin
     *  delta generalizes into near-duplicates; it waits and accumulates)，
     *  the startup backfill passes 1 (bounded, once per conversation). The
     *  cursor deliberately does NOT move on a skip — the delta keeps growing. */
    options?: { minDelta?: number }
  ): Promise<{
    memories: number
    experienceTitle: string | null
    experienceContent: string | null
    experienceCategory: string | null
    experienceFiles?: { path: string; content: string }[]
    /** Set when the model chose to ITERATE (action=update): the pool record
     *  `name` the content is a revision OF. Pass it to save({targetName}). */
    experienceTarget?: string
  }> {
    const memoryOn = featureFlags?.memory !== false
    const experienceOn = featureFlags?.experience !== false
    if (!apiKey || (!memoryOn && !experienceOn)) return { memories: 0, experienceTitle: null, experienceContent: null, experienceCategory: null }
    if (conversationId && this.isInBackoff(conversationId)) {
      console.log(`[MemoryManager] conversation ${conversationId} is in extraction backoff, skipping`)
      return { memories: 0, experienceTitle: null, experienceContent: null, experienceCategory: null }
    }

    // Unify on text-only messages (user/assistant with a text block) — same
    // cursor semantics as the backfill's, so every pipeline
    // agrees on what "processed" means.
    const textMessages = MemoryManager.toTextMessages(messages)
    if (textMessages.length === 0) return { memories: 0, experienceTitle: null, experienceContent: null, experienceCategory: null }

    // --- Incremental cursor: skip if conversation fully processed ---
    let cursor = 0
    if (conversationId) {
      const processedCount = await getHost().getConversationExtractedMsgCount(conversationId)
      if (processedCount >= textMessages.length) {
        console.log(`[MemoryManager] Already extracted for conversation ${conversationId} at msg count ${processedCount}, skipping`)
        return { memories: 0, experienceTitle: null, experienceContent: null, experienceCategory: null }
      }
      cursor = processedCount
      console.log(`[MemoryManager] Extracting memories+experiences for conversation ${conversationId}: ${textMessages.length - cursor} new msgs (cursor ${cursor}/${textMessages.length})`)
    }

    // Anchor = last few already-processed messages for context; delta = new messages
    const anchorStart = Math.max(0, cursor - 3)
    const anchor = textMessages.slice(anchorStart, cursor)
    const delta = textMessages.slice(cursor)

    // Minimum-increment gate: a skip leaves the cursor where it is, so the
    // next turn's delta includes everything seen here (载荷事实 4 of the plan).
    const minDelta = options?.minDelta ?? 1
    if (conversationId && delta.length < minDelta) {
      console.log(`[MemoryManager] delta ${delta.length} < minDelta ${minDelta} for conversation ${conversationId}, waiting to accumulate`)
      return { memories: 0, experienceTitle: null, experienceContent: null, experienceCategory: null }
    }

    // Build session summary: anchor (context only) + delta (to analyze)
    const summaryParts: string[] = []
    // Conversation statistics — counts tool usage for the experience qualification gate
    let toolCallCount = 0
    let toolErrorCount = 0
    for (const m of messages) {
      for (const b of m.contentBlocks ?? []) {
        if (b.type === 'tool_use') toolCallCount++
        else if (b.type === 'tool_result' && b.is_error) toolErrorCount++
      }
    }
    summaryParts.push(`(Conversation statistics: ${toolCallCount} tool call(s), ${toolErrorCount} tool error(s))`)
    if (anchor.length > 0) {
      summaryParts.push('(PREVIOUSLY EXTRACTED MESSAGES — context only, do not extract from these)')
      summaryParts.push(...anchor.map((m) => `[${m.role}]: ${m.content.slice(0, 2000)}`))
    }
    if (delta.length > 0) {
      summaryParts.push('(NEW MESSAGES — extract memories and experiences from these)')
      summaryParts.push(...delta.map((m) => `[${m.role}]: ${m.content.slice(0, 2000)}`))
    }
    const summary = summaryParts.join('\n\n').slice(0, 12000)

    // Dedup context: bounded existing experiences + existing memories
    const [existingExperiencesText, existingMemoriesText] = await Promise.all([
      this.buildExistingExperiencesText(),
      this.buildExistingMemoriesText()
    ])

    try {
      const result = await this.sessionReviewAgent.execute(
        { sessionSummary: summary, existingExperiencesText, existingMemoriesText, locale },
        { llmConfig: { adapter, apiKey, baseURL, model }, maxTokens: 4000 }
      )

      // --- Save conversation summary ---
      if (conversationId && result.summary) {
        const trimmed = result.summary.slice(0, 200)
        await getHost().updateConversationSummary(conversationId, trimmed).catch((e) => {
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
          await getHost().updateConversationKeywords(conversationId, joined).catch((e) => {
            console.warn('[MemoryManager] Failed to save conversation keywords:', e)
          })
        }
      }

      // --- Save extracted memories ---
      const validTypes = ['auto', 'manual', 'fact', 'decision', 'preference']
      const validCategories = ['code', 'architecture', 'user_pref', 'decision', 'general']

      let memoriesSaved = 0
      if (memoryOn) {
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
      }

      // --- Extract experience (don't save to memories — caller saves to the pool) ---
      let experienceTitle: string | null = null
      let experienceContent: string | null = null
      let experienceCategory: string | null = null
      let experienceFiles: { path: string; content: string }[] | undefined
      let experienceTarget: string | undefined
      if (experienceOn && result.experience && result.experience.content) {
        const title = result.experience.title
        experienceTitle = typeof title === 'string' && title ? title : null
        const cat = result.experience.category
        experienceCategory = validCategories.includes(cat) ? cat : 'general'
        experienceContent = result.experience.content
        experienceFiles = result.experience.files
        if (result.experience.action === 'update' && result.experience.target) {
          // action=update with a name the model saw in the pool section →
          // caller re-targets its save; the agent already validated/degraded.
          experienceTarget = result.experience.target
        }
      }

      // Check if memory compression is needed
      if (memoryOn) await this.ensureMemoryMerged()

      if (conversationId) this.extractionBackoff.delete(conversationId)

      // Mark conversation as processed — bump BOTH counters (memory + experience).
      // extractAndSaveAll extracts memories AND experiences together, so the
      // startup backfill must see this as done or it will re-extract the same
      // experiences from the same conversation.
      if (conversationId) {
        await getHost().updateConversationExtractedMsgCount(conversationId, textMessages.length).catch((e) => {
          console.warn('[MemoryManager] Failed to update extracted message count:', e)
        })
        await getHost().updateConversationExperienceExtractedCount(conversationId, textMessages.length).catch((e) => {
          console.warn('[MemoryManager] Failed to update experience extracted count:', e)
        })
      }

      console.log(`[MemoryManager] Saved ${memoriesSaved} memory/ies from conversation ${conversationId || 'unknown'}`)
      return { memories: memoriesSaved, experienceTitle, experienceContent, experienceCategory, experienceFiles, experienceTarget }
    } catch (err) {
      console.warn('[MemoryManager] extractAndSaveAll error:', err)
      if (conversationId) {
        const prev = this.extractionBackoff.get(conversationId)
        const attempts = (prev?.attempts ?? 0) + 1
        this.extractionBackoff.set(conversationId, { failedAt: Date.now(), attempts })
        if (attempts >= MemoryManager.BACKOFF_MAX_ATTEMPTS) {
          console.warn(`[MemoryManager] conversation ${conversationId} failed extraction ${attempts} times — retired for this process run`)
        }
      }
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
        await getHost().knowledgeWriteExperience({
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

  // ===================================================================
  // Helpers — shared by the extraction pipelines
  // ===================================================================

  /**
   * Flatten AgentMessage[] into text-only {role, content} pairs (user/assistant
   * with a text block). Used to keep the incremental extraction cursor on the
   * same unit the backfill's cursor counts (P1 #7: one flattening everywhere).
   */
  private static toTextMessages(messages: readonly AgentMessage[]): { role: string; content: string }[] {
    const out: { role: string; content: string }[] = []
    for (const m of messages) {
      if (m.role !== 'user' && m.role !== 'assistant') continue
      const texts = (m.contentBlocks ?? [])
        .filter((b): b is TextBlock => b.type === 'text')
        .map((b) => b.text)
      if (texts.length === 0) continue
      out.push({ role: m.role, content: texts.join('\n') })
    }
    return out
  }

  /**
   * Bounded reference of the LIVE experience pool (newest first) so the model
   * can judge DUPLICATES / EXTENDS / NEW against actual content — one summary
   * line per record plus the entry's body (truncated per record), with a
   * pool-wide budget so 20 full entries cannot blow the context.
   *
   * Reads `listExperiences` + `readExperienceRecord`; an absent host surface
   * (or an unreadable file) degrades to '' exactly as the old try/catch did.
   * Returns the LINES ONLY — the section header belongs to the agent's
   * buildUserMessages (the old code emitted it in both places). The previous
   * source was the KNOWLEDGE BASE (rows only the 0.3.4 one-shot migration ever
   * wrote), so live pool entries were invisible to dedup.
   */
  private async buildExistingExperiencesText(maxCount = 40, maxBodyLen = 1500, maxTotal = 30000): Promise<string> {
    let records: ExperienceRecord[]
    try {
      records = (await getHost().listExperiences()) ?? []
    } catch {
      return ''
    }
    if (records.length === 0) return ''
    const lines: string[] = []
    let total = 0
    for (const rec of records.slice(0, maxCount)) {
      let body = ''
      try {
        const raw = await getHost().readExperienceRecord(rec.name)
        if (raw) body = parseExperienceMd(raw, rec.title).content.slice(0, maxBodyLen)
      } catch {
        /* unreadable file → the summary line still lands */
      }
      const line = body
        ? `- ${rec.name} | ${rec.category} | ${rec.description}\n${body}`
        : `- ${rec.name} | ${rec.category} | ${rec.description}`
      if (total + line.length > maxTotal) break // pool-wide budget: stop, don't truncate mid-record
      total += line.length
      lines.push(line)
    }
    return lines.join('\n')
  }

  /**
   * Bounded reference of existing memories (newest first) so extraction skips
   * facts/decisions/preferences already recorded.
   */
  private async buildExistingMemoriesText(maxCount = 30, maxLen = 120): Promise<string> {
    const all = await this.listMemories()
    const recent = (all || []).slice(0, maxCount)
    if (recent.length === 0) return ''
    const lines = recent.map((m) => `- [${m.type}/${m.category}] ${m.content.slice(0, maxLen)}`)
    return 'EXISTING MEMORIES (do not extract memories that duplicate these):\n' + lines.join('\n')
  }
}
