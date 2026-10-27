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
import { MemoryPageCompileAgent, SessionReviewAgent } from '../agent/one-shot-agent'
import { getHost } from '../agent/host'
import { buildExtractionCatalog, isLivePage, type PageOp } from '../../../shared/memory-pages'
import { parseExperienceMd } from '../../../shared/experience/frontmatter'
import type { ExperienceRecord } from '../../../shared/types/experience-types'

/**
 * Manages memory capture, storage, and retrieval.
 *
 * Three parts of memory context:
 *   A. Manual — user-edited text file (via Memory panel Manual Memories editor)
 *   B. Extracted — auto-captured from sessions (types: auto, fact, decision, preference)
 *      Resident slimming (user 2026-10-10): only entries ≤100 chars render, newest 20;
 *      the pool merges when total exceeds 20. Longer/older entries stay searchable
 *      via recall — the render filter is a view, never a deletion.
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
  private modelMaxTokens: number | undefined = undefined

  private compileAgent = new MemoryPageCompileAgent()
  private sessionReviewAgent = new SessionReviewAgent()

  /** 防并发编译（单飞）。 */
  private _compiling = false

  // P0 (PLAN-memory-extraction-dedup): failure backoff, process-lifetime.
  // A conversation whose extraction LLM call just FAILED retried on every
  // turn end before — same delta, same failure, once a turn. 1h per failure;
  // three consecutive failures retire the conversation for this process run.
  private extractionBackoff = new Map<string, { failedAt: number; attempts: number }>()
  private static BACKOFF_MS = 60 * 60 * 1000
  private static BACKOFF_MAX_ATTEMPTS = 3

  /** Per-run harvest cap (user 2026-10-10: 低价值的内容不用进记忆) — the
   *  structural backstop to the prompt's yield bar (at most 3). A model that
   *  ignores it floods the pool, and every entry rides the system prompt, so
   *  the cap holds even when the prompt fails. */
  static readonly MAX_EXTRACT_PER_RUN = 5

  /** True when this conversation is inside the failure backoff window. */
  isInBackoff(conversationId: string): boolean {
    const entry = this.extractionBackoff.get(conversationId)
    if (!entry) return false
    if (entry.attempts >= MemoryManager.BACKOFF_MAX_ATTEMPTS) return true
    return Date.now() - entry.failedAt < MemoryManager.BACKOFF_MS
  }

  /** P2 watermark: how many memories existed at the last merge + when it ran,
   *  plus when the last ATTEMPT ran. Only a successful merge advances
   *  lastRunAt (the 24h clock and the [NEW] marks); a failed or empty attempt
   *  advances only lastAttemptAt (the retry clock). Mirrored into
   *  settings.json by the main-process hook so both survive a restart.
   *  lastCursorAt（2026-10-27 分区整理）：选页游标（ms）——下轮从 createdAt 晚于
   *  它的页起转；是位置不是成绩，失败也推进（毒切片不反复重试，绕圈回访）。 */
  private compileWatermark: {
    lastRunAt: number
    lastCount: number
    lastAttemptAt: number
    lastCursorAt: number
  } = {
    lastRunAt: 0,
    lastCount: 0,
    lastAttemptAt: 0,
    lastCursorAt: 0,
  }

  seedCompileWatermark(w: { lastRunAt: number; lastCount: number; lastAttemptAt?: number; lastCursorAt?: number }): void {
    this.compileWatermark = { lastAttemptAt: 0, lastCursorAt: 0, ...w }
  }

  getCompileWatermark(): { lastRunAt: number; lastCount: number; lastAttemptAt: number; lastCursorAt: number } {
    return { ...this.compileWatermark }
  }

  /** 手动记忆（MEMORY.md）注入文——唯一残余的动态节（PLAN-memory-wiki M4）。
   *  直读不缓存（每请求一次小文件 IPC，代价可忽略）：字节仅在用户编辑时
   *  变化，跨请求/跨会话天然稳定；master switch off 立即生效。取代 v1 的
   *  双钟 TTL 快照（2026-09-26 裁定随动态注入退役：提取产物已全部转 JIT）。 */
  async getManualMemoryContext(conversationId?: string): Promise<string> {
    void conversationId // 保留签名位：调用方（builder）透传，未来按需细分
    if (!this.prefs.autoInjectEnabled) return ''
    const content = await this.getMemoryMd()
    if (!content || !content.trim()) return ''
    return `# Manual Memories\n\n${content.trim()}`
  }

  // --- Preferences ---

  getPreferences(): MemoryPreferences {
    return { ...this.prefs }
  }

  setPreferences(prefs: Partial<MemoryPreferences>): void {
    this.prefs = { ...this.prefs, ...prefs }
  }

  /** Store LLM config so background tasks (compression) can call the API.
   *  Refused while a merge is in flight: the manager is a process-wide
   *  singleton and every sweep seeds it fire-and-forget (each session end
   *  carries that session's profile, the startup sweep the active one) — a
   *  seed landing mid-merge would swap the LLM config under the running call
   *  (review 2026-10-10 中5). the compile pass early-returns on the same
   *  flag, so the sweeping caller is a merge no-op too; its next sweep
   *  re-seeds. */
  setConfig(apiKey: string, baseURL: string, adapter: LlmAdapter, model: string, modelMaxTokens?: number): void {
    if (this._compiling) return
    this.apiKey = apiKey
    this.baseURL = baseURL
    this.adapter = adapter
    this.model = model
    this.modelMaxTokens = modelMaxTokens
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
  // ── 页面编译层（PLAN-memory-wiki M6，2026-10-25；分区整理 + retire 2026-10-27）──
  // 取代旧扁平记忆归并（随旧表冻结退役，记录见 _review/review_20261025-memory-wiki.md）：
  // 低频整理活页——合并近似页（迁移兜底臂的 per-row 页在此归并）、别名卫生、
  // links 补全、过时页退役（retire op：软态、理由留档、UI 可恢复）。
  // 只经 supersede/alias/update/retire，不删不建，谱系可回溯。
  /** 页数增长阈值：活页较上次编译 +N 即到期。 */
  static readonly COMPILE_MIN_NEW = 8
  static readonly COMPILE_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000
  /** 失败/空产出后的短重试钟（一次瞬时 LLM 失败不该冻结整理一天；也是空转帽）。 */
  static readonly COMPILE_RETRY_MS = 2 * 60 * 60 * 1000
  /** 编译输入预算（页 title+正文+别名的总字符）。单轮按游标分区选页装预算为止
   *  ——取代旧的「超预算全体降级 titles-only 且禁 merge」：分桶让合并（唯一减员
   *  手段）恰好在大池子时停摆，越需要整理的池子越整理不动。 */
  static readonly COMPILE_BODY_BUDGET = 30_000
  /** 维护钟：池子装不进单轮预算（分区真正生效）时，无增长也每 7 天整理一轮——
   *  静止的大池子否则永远等不到园丁，retire 出口随之失灵。 */
  static readonly COMPILE_MAINTENANCE_MS = 7 * 24 * 60 * 60 * 1000
  /** 整理视图里单页正文的截断点：超长页标「正文被截断」→ agent 不可 update
   * （截断防丢由 apply 层执法）；截断同时把单页输入成本钉住。 */
  private static readonly COMPILE_PAGE_BODY = 600

  /** 页面编译 pass。返回 true 当一轮编译真的跑成（见下——满目视图下的空产出
   *  就是「池子干净」，算跑成）。两级门：成功持 24h 钟（lastRunAt），失败/全废
   *  尝试只持 2h 重试钟（lastAttemptAt）——门必须读 ATTEMPT：不推进的尝试若不
   *  落钟，每个触发点都会重开火（旧合并层的已付学费，语义原样移植）。
   *
   *  分区整理（2026-10-27）：选页按 createdAt 升序从 lastCursorAt 起装预算，
   *  单轮输入由此保证 ≤ 预算；游标之后没有更新的页 → 回落全量从头再轮（每一页
   *  周期性获得园丁到访）。游标是位置不是成绩：异常也推进——毒切片不该每 2h
   *  重试同一批，绕一圈自然回访。 */
  async ensurePagesCompiled(): Promise<boolean> {
    if (this._compiling || !this.adapter || !this.apiKey) return false
    const wm = this.getCompileWatermark()
    const now = Date.now()
    const gap = wm.lastRunAt >= wm.lastAttemptAt ? MemoryManager.COMPILE_MIN_INTERVAL_MS : MemoryManager.COMPILE_RETRY_MS
    const since = wm.lastRunAt >= wm.lastAttemptAt ? wm.lastRunAt : wm.lastAttemptAt
    if (since > 0 && now - since < gap) return false

    const all = await getHost().listMemoryPages()
    // SOP 页排除（PLAN-experience-sop 刀一）：整理是园丁，不修电器——compile agent
    // 只看正文做近似合并，理解不了脚本；带 files 的页进来就会被无脚本的 supersede
    // 丢掉脚本（apply 层护栏也会拒，这里不让它进输入省一趟 op）。退役页同排除。
    const live = all.filter((p) => isLivePage(p) && p.maturity !== 'sop')
    if (live.length < 2) return false // 无可整理
    let poolSize = 0
    for (const p of live) poolSize += p.title.length + p.body.length + p.aliases.join('').length
    const growthDue =
      live.length - wm.lastCount >= MemoryManager.COMPILE_MIN_NEW || (wm.lastCount === 0 && live.length >= MemoryManager.COMPILE_MIN_NEW)
    const maintenanceDue =
      poolSize > MemoryManager.COMPILE_BODY_BUDGET && wm.lastRunAt > 0 && now - wm.lastRunAt >= MemoryManager.COMPILE_MAINTENANCE_MS
    if (!growthDue && !maintenanceDue) return false

    // 分区选页：createdAt 升序（并列按 id 定序）从游标起装预算，末页永远入批
    //（超大页靠 COMPILE_PAGE_BODY 截断钉住成本）。ISO 串同构，字典序即可比较。
    const ordered = [...live].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    const cursorIso = wm.lastCursorAt > 0 ? new Date(wm.lastCursorAt).toISOString() : ''
    const pending = cursorIso ? ordered.filter((p) => p.createdAt > cursorIso) : ordered
    const batch: typeof live = []
    let budget = 0
    for (const p of pending.length > 0 ? pending : ordered) {
      const size = p.title.length + p.body.length + p.aliases.join('').length
      if (batch.length > 0 && budget + size > MemoryManager.COMPILE_BODY_BUDGET) break
      batch.push(p)
      budget += size
    }
    const cursorMs = new Date(batch[batch.length - 1].createdAt).getTime()

    this._compiling = true
    try {
      // 页面视图：行尾带 使用/重现 计数——退役判断的价值信号（高价值页禁 retire
      // 的判断依据在 agent 侧，数据从这里来）。
      const lines = batch.map((p) => {
        const alias = p.aliases.length > 0 ? ` 别名: ${p.aliases.join(', ')}` : ''
        const usage = p.useCount > 0 ? ` 使用${p.useCount}次` : ''
        const recurrence = p.recurrence > 0 ? ` 重现${p.recurrence}次` : ''
        const body = p.body.length <= MemoryManager.COMPILE_PAGE_BODY
          ? p.body
          : `${p.body.slice(0, MemoryManager.COMPILE_PAGE_BODY)} 「正文被截断」`
        const missingSummary = p.summary ? '' : ' 〔summary 缺失——update 时补一句结论〕'
        return `- ${p.title} (${p.type})${alias}${usage}${recurrence}${missingSummary}\n  正文: ${body.replace(/\n/g, ' ')}`
      })
      const result = await this.compileAgent.execute(
        { pagesText: lines.join('\n'), mode: 'full', pageIndex: batch.map((p) => ({ id: p.id, title: p.title, type: p.type, aliases: p.aliases })), locale: undefined },
        { llmConfig: { adapter: this.adapter, apiKey: this.apiKey, baseURL: this.baseURL, model: this.model, modelMaxTokens: this.modelMaxTokens }, maxOutputTokens: 4000 },
      )
      const ops = result.pages
      let applied = 0
      if (ops.length > 0) {
        const results = await getHost().applyMemoryPageOps(ops)
        applied = results.filter((r) => r.ok).length
        for (const r of results.filter((x) => !x.ok)) {
          console.warn(`[MemoryManager] compile op failed (${r.op.action} ${r.op.target ?? ''}):`, r.error)
        }
      }
      // 成功 = 无异常且（无产出 或 至少一个 op 落库）：满目视图下空产出 = 池子
      // 干净，是真成功（维护钟臂靠它停转，否则干净的大池子每 2h 空转一轮）；
      // 全废产出（ops>0 且 applied=0）按旧纪律只推重试钟。游标无论如何推进。
      const after = (await getHost().listMemoryPages()).filter(isLivePage).length
      const success = ops.length === 0 || applied > 0
      this.compileWatermark = success
        ? { lastRunAt: now, lastCount: after, lastAttemptAt: now, lastCursorAt: cursorMs }
        : { ...this.compileWatermark, lastAttemptAt: now, lastCursorAt: cursorMs }
      console.log(`[MemoryManager] compile pass: ${applied}/${ops.length} op(s) applied over ${batch.length}/${live.length} live pages, pool → ${after}`)
      return success
    } catch (err) {
      console.warn('[MemoryManager] compile pass error:', err)
      this.compileWatermark = { ...this.compileWatermark, lastAttemptAt: Date.now(), lastCursorAt: cursorMs }
      return false
    } finally {
      this._compiling = false
    }
  }

  // Experience compression removed — experiences are now stored in the knowledge
  // base (raw/ directory) rather than the memories table, so compression is
  // handled by the knowledge base compiler pipeline instead.

  // ===================================================================
  // Part C: Recent Conversations
  // Provides a summary of recent sessions for the system prompt.
  // ===================================================================

  
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
    /** v2：成功落库的页面 op 数（含经验页）。 */
    pages: number
    /** v1 兼容残影（恒 null；M2c 拆除调用方后删除）。 */
    experienceTitle: string | null
    experienceContent: string | null
    experienceCategory: string | null
  }> {
    const memoryOn = featureFlags?.memory !== false
    const experienceOn = featureFlags?.experience !== false
    if (!apiKey || (!memoryOn && !experienceOn)) return { memories: 0, pages: 0, experienceTitle: null, experienceContent: null, experienceCategory: null }
    if (conversationId && this.isInBackoff(conversationId)) {
      console.log(`[MemoryManager] conversation ${conversationId} is in extraction backoff, skipping`)
      return { memories: 0, pages: 0, experienceTitle: null, experienceContent: null, experienceCategory: null }
    }

    // Unify on text-only messages (user/assistant with a text block) — same
    // cursor semantics as the backfill's, so every pipeline
    // agrees on what "processed" means.
    const textMessages = MemoryManager.toTextMessages(messages)
    if (textMessages.length === 0) return { memories: 0, pages: 0, experienceTitle: null, experienceContent: null, experienceCategory: null }

    // --- Incremental cursor: skip if conversation fully processed ---
    let cursor = 0
    if (conversationId) {
      const processedCount = await getHost().getConversationExtractedMsgCount(conversationId)
      if (processedCount >= textMessages.length) {
        console.log(`[MemoryManager] Already extracted for conversation ${conversationId} at msg count ${processedCount}, skipping`)
        return { memories: 0, pages: 0, experienceTitle: null, experienceContent: null, experienceCategory: null }
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
      return { memories: 0, pages: 0, experienceTitle: null, experienceContent: null, experienceCategory: null }
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

    // 写时归页的承重面：全量页面目录（title+别名；经验页带全文摘录）。
    // 记忆与经验在这次调用里同时产出（PLAN-memory-wiki v2 统一协议）。
    const allPages = await getHost().listMemoryPages()
    const live = allPages.filter(isLivePage)
    const catalog = buildExtractionCatalog(live.map((p) => ({ title: p.title, type: p.type, aliases: p.aliases, body: p.body })))

    try {
      const result = await this.sessionReviewAgent.execute(
        {
          sessionSummary: summary,
          catalogText: catalog.text,
          catalogMode: catalog.mode,
          pageIndex: live.map((p) => ({ id: p.id, title: p.title, type: p.type, aliases: p.aliases })),
          revisableTitles: catalog.revisableTitles,
          locale,
        },
        { llmConfig: { adapter, apiKey, baseURL, model, modelMaxTokens: this.modelMaxTokens }, maxOutputTokens: 4000 }
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

      // --- Apply page ops（op 级隔离：坏 op 不拖垮同批）---
      // 开关按类型过滤：记忆关 → 只放行经验页 op；经验关 → 只放行非经验 op。
      // update/alias 无 type 字段（它们修订既有页），仅在双开时放行；
      // reinforce 只对经验页成立，归经验开关管。
      const ops: PageOp[] = result.pages.filter((op) => {
        if (memoryOn && experienceOn) return true
        if (op.action === 'reinforce') return experienceOn
        if (op.type === 'experience') return experienceOn
        if (op.action === 'create' || op.action === 'supersede') return memoryOn
        return false
      })
      const opResults = ops.length > 0 ? await getHost().applyMemoryPageOps(ops) : []
      const pagesApplied = opResults.filter((r) => r.ok).length
      const memoriesSaved = opResults.filter((r) => r.ok && r.op.type !== 'experience').length
      for (const r of opResults.filter((x) => !x.ok)) {
        console.warn(`[MemoryManager] page op failed (${r.op.action} ${r.op.target ?? r.op.title ?? ''}):`, r.error)
      }

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

      console.log(`[MemoryManager] Applied ${pagesApplied} page op(s) from conversation ${conversationId || 'unknown'}`)
      // experience* 字段是 v1 调用方的兼容残影（M2c 拆除调用方后删除）
      return { memories: memoriesSaved, pages: pagesApplied, experienceTitle: null, experienceContent: null, experienceCategory: null }
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
      return { memories: 0, pages: 0, experienceTitle: null, experienceContent: null, experienceCategory: null }
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
   *   B. Extracted memories (resident view: ≤100-char entries, newest 20)
   *   B2. Experiences (workflow optimizations, user pain points)
   *   C. Recent session summaries
   */
  
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
      let truncatedAt = 0
      try {
        const raw = await getHost().readExperienceRecord(rec.name)
        if (raw) {
          const content = parseExperienceMd(raw, rec.title).content
          if (content.length > maxBodyLen) {
            body = content.slice(0, maxBodyLen)
            truncatedAt = content.length
          } else {
            body = content
          }
        }
      } catch {
        /* unreadable file → the summary line still lands */
      }
      // An explicit 截断 marker, not a silent slice (review 2026-09-26 中5):
      // the revision prompt asks for the FULL document, so the model must be
      // able to tell a complete entry from a partial one — and the store's
      // loss guard rejects a revision that would drop the unseen tail.
      const bodyText = body
        ? truncatedAt
          ? `${body}\n（……本条正文在提炼视图中被截断，完整正文共 ${truncatedAt} 字符——不要以这份节选为唯一事实来源去修订该条）`
          : body
        : ''
      const line = bodyText
        ? `- ${rec.name} | ${rec.category} | ${rec.description}\n${bodyText}`
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
