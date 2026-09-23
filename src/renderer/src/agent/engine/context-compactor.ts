/**
 * Context compaction pipeline (PLAN-0.3.5 refactor): extracted from AgentEngine
 * so the state machine stays under the class-size budget. Owns the history
 * summary cache and the three-layer compaction (nano → light → hard truncate).
 * Operates on API-copy message arrays only — never touches the engine's live
 * messages (deps.getMessages supplies the live list for token estimation).
 */
import type { AgentMessage, ContentBlock, ToolResultBlock, TextBlock, ToolUseBlock } from '../../types/agent'
import type { CompactionEvent } from '../../../../shared/agent-protocol/payloads'
import { contextTokensOf, estimateMessagesTokens, estimateTextTokens } from './context-estimate'

const HARD_TRUNCATE_MIN_REMAINING = 10_000
const LIGHT_COMPACT_MIN_REMAINING = 30_000
const SUMMARY_TEXT_CAP = 2000
const SUMMARY_INPUT_CAP = 40000
const SUMMARY_RESULT_CAP = 400
// Shared by hardTruncate and emergencyTruncate's keep-window walk.
const MIN_KEEP = 10
const MIN_USER_TURNS = 2
// emergencyTruncate's phase-2 trim: tool_result bodies become this many chars
// plus a tool_result_search pointer, oldest first, until the estimate fits.
const OVERFLOW_STRIP_PREFIX = 1500
// Token budget for replaying the dropped region's USER messages verbatim into
// the compacted copy (P0 of the 2026-09-23 gap analysis). The summary is a
// 500-token paraphrase; the user's own words are the intent record and used to
// survive only inside it. Codex replays real user messages wholesale
// (COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000) and Claude Code's compact prompt
// reserves a dedicated "All User Messages" section — same judgement: user
// intent is the one thing a lossy summary must not own alone.
const USER_REPLAY_BUDGET_TOKENS = 10_000
// Post-turn prewarm trigger: usage at/above this share of the window warms the
// history summary at turn end, so the expensive LLM summary runs while the
// engine is idle instead of blocking the next turn's first request.
export const POST_TURN_COMPACT_USED_RATIO = 0.75

export function summarizeToolCall(name: string, input: Record<string, unknown>): string {
  const i = input || {}
  const short = (v: unknown): string => { const s = String(v ?? '').trim(); return s ? s.slice(0, 60) : '' }
  switch (name) {
    case 'read': case 'write': case 'edit': {
      const p = short(i.file_path)
      return p ? `${name} ${p}` : name
    }
    case 'exec': {
      const c = short(i.command)
      return c ? `exec ${c}` : name
    }
    case 'search': {
      const q = short(i.query)
      return q ? `search "${q}"` : name
    }
    case 'list_dir': {
      const d = short(i.dir_path)
      return d ? `list_dir ${d}` : name
    }
    case 'find': {
      const p = short(i.pattern)
      return p ? `find ${p}` : name
    }
    default: return name
  }
}

function buildDroppedRegionText(region: AgentMessage[]): string {
  const parts: string[] = []
  let budget = SUMMARY_INPUT_CAP
  for (const msg of region) {
    if (budget <= 0) break
    if (!msg.contentBlocks || msg.contentBlocks.length === 0) continue
    const roleLabel = msg.role === 'user' ? '用户' : '助手'
    const lines: string[] = []
    for (const block of msg.contentBlocks) {
      if (budget <= 0) break
      if (block.type === 'text') {
        const t = (block as TextBlock).text
        if (t) lines.push(t.slice(0, SUMMARY_TEXT_CAP))
      } else if (block.type === 'tool_use') {
        const tu = block as ToolUseBlock
        lines.push(`[工具 ${summarizeToolCall(tu.name, tu.input)}]`)
      } else if (block.type === 'tool_result') {
        const c = ((block as ToolResultBlock).content || '').slice(0, SUMMARY_RESULT_CAP)
        if (c) lines.push(`[工具结果] ${c}`)
      }
      // thinking / redacted_thinking: skip — internal reasoning, no summary value
    }
    if (lines.length === 0) continue
    const text = `${roleLabel}: ${lines.join('\n')}`
    parts.push(text)
    budget -= text.length
  }
  return parts.join('\n\n')
}

function makeHistorySummaryMessage(text: string): AgentMessage {
  return {
    id: `summary_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    contentBlocks: [{ type: 'text', text: `【历史对话摘要】\n${text}` }],
    createdAt: new Date().toISOString()
  }
}

/** The user's own words from the dropped region, replayed verbatim into the
 *  compacted copy. Filled newest-first (the most recent intent survives
 *  whole), then returned in chronological order so the copy still reads
 *  top-down; the one message that overflows the remaining budget is truncated
 *  with a marker rather than skipped — a pasted spec at conversation start is
 *  exactly the content worth keeping the head of. Tool-result collector
 *  messages carry no text and never match. */
export function collectUserReplays(dropped: AgentMessage[], budgetTokens = USER_REPLAY_BUDGET_TOKENS): AgentMessage[] {
  const picked: AgentMessage[] = []
  let remaining = budgetTokens
  for (let i = dropped.length - 1; i >= 0 && remaining > 0; i--) {
    const msg = dropped[i]
    if (msg.role !== 'user') continue
    const text = msg.contentBlocks
      .filter((b): b is TextBlock => b.type === 'text')
      .map(b => b.text)
      .filter(t => t && t.trim())
      .join('\n')
    if (!text) continue
    const tokens = estimateTextTokens(text)
    let kept = text
    if (tokens > remaining) {
      // Scale the char cut by the same per-char rate the estimator used, so
      // the kept head lands inside the remaining token budget for CJK and
      // latin text alike.
      const perChar = tokens / text.length
      kept = `${text.slice(0, Math.max(1, Math.floor(remaining / perChar)))}\n…[已截断]`
      remaining = 0
    } else {
      remaining -= tokens
    }
    // The original message object stays out of the copy (its slot was
    // truncated away); the replay is a fresh shell carrying the original id
    // and text, so identity in the live history is untouched.
    picked.push({ ...msg, contentBlocks: [{ type: 'text', text: kept }] })
  }
  return picked.reverse()
}


export interface ContextCompactorDeps {
  runHistorySummary(regionText: string, instruction?: string): Promise<string>
  getMessages(): AgentMessage[]
}

export class ContextCompactor {
  static readonly HARD_TRUNCATE_MIN_REMAINING = 10_000

  private _compressedToolUseIds = new Set<string>()
  private historySummary: { firstKeptId: string; text: string } | null = null
  /** User messages the last injectHistorySummary pass replayed verbatim —
   *  read by the engine to populate the compaction event's counter. */
  lastInjectReplayCount = 0
  /** Guards overlapping prewarm runs (post-turn / manual): two concurrent LLM
   *  summaries for the same frontier are pure waste. */
  private prewarmInFlight = false

  constructor(private deps: ContextCompactorDeps) {}

  contextTokens(messages?: AgentMessage[], fixedOverhead = 0): number {
    // The shared estimator (engine/context-estimate.ts) carries the contract:
    // a real inputTokens report anchors the number, the tail appended since is
    // estimated CJK-aware, and the full heuristic guards a stale baseline.
    return contextTokensOf(messages ?? this.deps.getMessages(), fixedOverhead)
  }

  /** Earliest index whose kept tail fits `thresholdTokens` under the estimate
   *  plus fixed overhead, respecting the minimum user-turn / message-count
   *  guards. Shared by hardTruncate (threshold 0.9× the window) and
   *  emergencyTruncate (threshold 0.6× the provider's named limit). */
  private fitKeepStart(messages: AgentMessage[], thresholdTokens: number, overhead: number): number {
    // Scan from the end to find the earliest index that satisfies both guarantees
    let keepStart = messages.length

    // Count user turns from the end
    let userTurnsFound = 0
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        userTurnsFound++
        if (userTurnsFound >= MIN_USER_TURNS) {
          keepStart = i
          break
        }
      }
    }
    // Apply MIN_KEEP as a lower bound on the start index
    keepStart = Math.max(keepStart, messages.length - MIN_KEEP)

    // Walk forward from keepStart — estimate what remains to see if we fit
    while (keepStart > 0) {
      const remaining = messages.slice(keepStart - 1)
      if (this.estimateTokens(remaining) + overhead <= thresholdTokens) break
      keepStart--
    }

    return keepStart
  }

  /** Include the assistant message a kept leading tool_result block pairs with.
   *  Without this, the OpenAI API rejects the request with "insufficient tool
   *  messages following tool_calls". */
  private includePairedToolUses(messages: AgentMessage[], keepStart: number): number {
    const firstKept = messages[keepStart]
    if (firstKept?.role === 'user' && firstKept.contentBlocks.some(b => b.type === 'tool_result')) {
      const orphanedResultIds = new Set(
        firstKept.contentBlocks
          .filter((b): b is ToolResultBlock => b.type === 'tool_result')
          .map(b => (b as ToolResultBlock).tool_use_id)
      )
      for (let i = keepStart - 1; i >= 0; i--) {
        if (messages[i].role !== 'assistant') continue
        const hasMatchingToolUse = messages[i].contentBlocks.some(
          b => b.type === 'tool_use' && orphanedResultIds.has(b.id)
        )
        if (hasMatchingToolUse) {
          return i
        }
      }
    }
    return keepStart
  }

  hardTruncate(messages: AgentMessage[], contextLength: number, fixedOverhead = 0, force = false): AgentMessage[] {
    // A forced cut (explicit /compact) targets a slimmer window than the
    // passive 0.9× — the user asked for headroom, not for barely passing the
    // next trigger.
    const THRESHOLD = contextLength * (force ? 0.6 : 0.9)

    if (messages.length <= MIN_KEEP) return messages

    const estimatedTokens = this.contextTokens(messages, fixedOverhead)
    // Trigger on remaining window, not usage ratio: when the model window is
    // small (e.g. 26K), 10% of it is only ~2.6K of headroom — too tight to be
    // useful. Floor the remaining headroom at a fixed 10K so truncation still
    // kicks in early enough on small windows.
    const remainingWindow = contextLength - estimatedTokens
    if (!force && remainingWindow >= Math.max(contextLength * 0.1, ContextCompactor.HARD_TRUNCATE_MIN_REMAINING)) return messages

    // The walk below estimates the remaining content in char-heuristic units,
    // which never counts the fixed overhead (system prompt + tool schemas).
    // Re-add that overhead so the kept window actually lands under the
    // real-token threshold instead of over-retaining.
    const heuristicTotal = this.estimateTokens(messages)
    const overhead = Math.max(0, estimatedTokens - heuristicTotal)

    const keepStart = this.fitKeepStart(messages, THRESHOLD, overhead)
    if (keepStart === 0) return messages

    const pairedStart = this.includePairedToolUses(messages, keepStart)

    const truncated = messages.slice(pairedStart)
    const dropped = messages.length - truncated.length
    console.log(
      `[AgentEngine] hardTruncate: dropped ${dropped}/${messages.length} oldest messages ` +
      `(context ${estimatedTokens} → keep under ${THRESHOLD} of ${contextLength})`
    )
    return truncated
  }

  /** Forced cut for a provider "context length exceeded" rejection (the 0.4.1
   *  report: the ring said 35% while the model refused the request). The
   *  trigger estimates above missed the overflow — that is WHY the request
   *  went out oversized — so their thresholds are ignored here: drop the
   *  oldest whole messages, and if the unsplittable tail still overshoots (a
   *  collector message holding a whole spawn batch, say), strip the OLDEST
   *  tool_result bodies to a short prefix + tool_result_search pointer until
   *  the estimate fits. Pairing is untouched — the placeholder keeps the
   *  tool_use_id, so the request stays well-formed. Operates on the API copy
   *  only; this.messages is never touched. */
  emergencyTruncate(messages: AgentMessage[], hardLimit: number, fixedOverhead = 0): AgentMessage[] {
    if (hardLimit <= 0) return messages
    const target = Math.floor(hardLimit * 0.6)
    const estimated = this.contextTokens(messages, fixedOverhead)
    if (estimated <= target) return messages

    const heuristicTotal = this.estimateTokens(messages)
    const overhead = Math.max(0, estimated - heuristicTotal)

    let working = messages
    const keepStart = this.includePairedToolUses(working, this.fitKeepStart(working, target, overhead))
    if (keepStart > 0) working = working.slice(keepStart)

    // Phase 2, oldest first so the newest results — the ones the turn still
    // needs verbatim — survive longest. Deltas are tracked at text level to
    // avoid re-walking the whole list per strip.
    let total = this.contextTokens(working, fixedOverhead)
    const trimmed = (tr: ToolResultBlock): string =>
      `${tr.content.slice(0, OVERFLOW_STRIP_PREFIX)}\n\n… [上下文超限，正文已裁剪 — 用 tool_result_search 按 tool_result_id=${tr.tool_result_id ?? tr.tool_use_id} 取回全文] …`
    let strippedAny = false
    const stripped = working.map((msg) => msg)
    for (let i = 0; i < stripped.length && total > target; i++) {
      const msg = stripped[i]
      let modified = false
      const blocks = msg.contentBlocks.map((block) => {
        if (block.type !== 'tool_result') return block
        const tr = block as ToolResultBlock
        if (!tr.content || tr.content.length <= OVERFLOW_STRIP_PREFIX) return block
        if (total <= target) return block
        total -= estimateTextTokens(tr.content) - estimateTextTokens(trimmed(tr))
        modified = true
        return { ...tr, content: trimmed(tr) }
      })
      if (modified) {
        stripped[i] = { ...msg, contentBlocks: blocks }
        strippedAny = true
      }
    }

    if (strippedAny) {
      console.log(`[AgentEngine] emergencyTruncate: stripped oldest tool_result bodies for a ${hardLimit}-token provider limit (context now ~${Math.max(0, Math.round(total))})`)
      return stripped
    }
    return working
  }

  getHistorySummary(): { firstKeptId: string; text: string } | null {
    return this.historySummary
  }

  seedHistorySummary(text?: string, frontierId?: string): void {
    this.historySummary = text && frontierId ? { firstKeptId: frontierId, text } : null
  }

  async injectHistorySummary(
    original: AgentMessage[],
    lightCompacted: AgentMessage[],
    truncated: AgentMessage[],
    instruction?: string
  ): Promise<AgentMessage[]> {
    const droppedCount = lightCompacted.length - truncated.length
    this.lastInjectReplayCount = 0
    if (droppedCount <= 0) return truncated

    const firstKeptId = truncated[0]?.id
    if (!firstKeptId) return truncated

    // Slice the pre-compaction copy so the summarizer sees real tool results
    // (success AND error content), not [tool_result_id:] placeholders.
    // nanoCompact is a 1:1 map (no add/drop), so index alignment holds.
    const dropped = original.slice(0, droppedCount)
    // The dropped region's user words ride the copy verbatim (budget-capped) —
    // the summary paraphrases, the intent stays quotable.
    const replays = collectUserReplays(dropped)
    this.lastInjectReplayCount = replays.length
    const withReplays = (summaryText: string | null): AgentMessage[] => [
      ...replays,
      ...(summaryText !== null ? [makeHistorySummaryMessage(summaryText)] : []),
      ...truncated,
    ]
    const cache = this.historySummary

    // 1. Stable frontier → reuse verbatim.
    if (cache?.firstKeptId === firstKeptId) {
      return withReplays(cache.text)
    }

    // 2. Old frontier message still kept (dropped less) → cached summary covers a
    //    superset of the dropped region. Reuse and re-key to the new frontier.
    if (cache && truncated.some((m) => m.id === cache.firstKeptId)) {
      this.historySummary = { firstKeptId, text: cache.text }
      return withReplays(cache.text)
    }

    // 3. Old frontier message now dropped (frontier advanced) → summarize only the
    //    newly-dropped slice after the old frontier and extend the cached text.
    if (cache) {
      const j = dropped.findIndex((m) => m.id === cache.firstKeptId)
      if (j >= 0) {
        const extraText = buildDroppedRegionText(dropped.slice(j))
        if (extraText.trim()) {
          const extra = await this.deps.runHistorySummary(extraText, instruction)
          if (extra) {
            const text = cache.text + '\n\n' + extra
            this.historySummary = { firstKeptId, text }
            return withReplays(text)
          }
        }
      }
    }

    // 4. No usable cache → summarize the full dropped region.
    const regionText = buildDroppedRegionText(dropped)
    if (!regionText.trim()) return withReplays(null)
    const summary = await this.deps.runHistorySummary(regionText, instruction)
    if (!summary) {
      console.warn('[AgentEngine] history summary empty, using plain truncation')
      return withReplays(null)
    }
    this.historySummary = { firstKeptId, text: summary }
    console.log(`[AgentEngine] injected history summary (${summary.length} chars) for ${droppedCount} dropped messages`)
    return withReplays(summary)
  }

  estimateTokens(messages?: AgentMessage[]): number {
    // CJK-aware shared estimator (engine/context-estimate.ts). The old flat
    // chars/3.5 undercounted Chinese text ~3x, which delayed every compaction
    // trigger past the point where the provider rejects the request.
    return estimateMessagesTokens(messages ?? this.deps.getMessages())
  }

  nanoCompact(messages: AgentMessage[]): AgentMessage[] {
    const TIER_MAP: Record<string, number> = {
      exec: 1, search: 1, find: 1, list_dir: 1,
      read: 2, knowledge_read: 2, knowledge_search: 2, experience_read: 2,
      memory_search: 2, memory_save: 2, conversation_search: 2, tool_result_search: 2,
      spawn_agent: 2, edit: 2, write: 2, install: 2, pick_skill: 2, pick_tool: 2, webfetch: 2
    }
    const TIER_SIZES: Record<number, number> = { 1: 10, 2: 20 }
    const TIER3_NAMES = new Set(['ask_user', 'create_plan', 'advance_plan'])
    const PROTECTION_WINDOW = 4

    // Protect last N user messages with tool_results
    const protectedMsgIds = new Set<string>()
    {
      let found = 0
      for (let i = messages.length - 1; i >= 0 && found < PROTECTION_WINDOW; i--) {
        const msg = messages[i]
        if (msg.role !== 'user') continue
        if (msg.contentBlocks.some(b => b.type === 'tool_result')) {
          protectedMsgIds.add(msg.id)
          found++
        }
      }
    }

    // Count tool_uses by tier
    const toolUseToName = new Map<string, string>()
    const counts: Record<number, number> = {}
    for (const msg of messages) {
      if (msg.role !== 'assistant') continue
      for (const block of msg.contentBlocks) {
        if (block.type !== 'tool_use') continue
        if (TIER3_NAMES.has(block.name)) continue
        const tier = TIER_MAP[block.name] ?? 2
        counts[tier] = (counts[tier] || 0) + 1
        toolUseToName.set(block.id, block.name)
      }
    }

    // Calculate compression targets: only compress when >= 2 full tiers exist
    const compressTargets: Record<number, number> = {}
    for (const [tierStr, count] of Object.entries(counts)) {
      const tier = Number(tierStr)
      const size = TIER_SIZES[tier]
      if (!size) continue
      const fullTiers = Math.floor(count / size)
      if (fullTiers >= 2) compressTargets[tier] = (fullTiers - 1) * size
    }

    if (Object.keys(compressTargets).length === 0) return messages

    // Build compressed copy
    const compressed: Record<number, number> = {}
    return messages.map(msg => {
      if (msg.role !== 'user') return msg
      if (protectedMsgIds.has(msg.id)) return msg

      let modified = false
      const newBlocks = msg.contentBlocks.map(block => {
        if (block.type !== 'tool_result') return block
        const name = toolUseToName.get(block.tool_use_id)
        if (!name) return block
        if (TIER3_NAMES.has(name)) return block
        // Skip already-compressed blocks from previous iterations
        if (this._compressedToolUseIds.has(block.tool_use_id)) return block
        const tier = TIER_MAP[name] ?? 2
        const target = compressTargets[tier]
        if (!target || target <= 0) return block
        if ((compressed[tier] || 0) >= target) return block
        const tr = block as ToolResultBlock
        if (tr.content.startsWith('[tool_result_id:') || tr.content.startsWith('[Tool Result:')) return block
        if (!tr.tool_result_id) tr.tool_result_id = crypto.randomUUID()
        compressed[tier] = (compressed[tier] || 0) + 1
        modified = true
        this._compressedToolUseIds.add(tr.tool_use_id)
        return { ...tr, content: `[tool_result_id: ${tr.tool_result_id}]` }
      })
      return modified ? { ...msg, contentBlocks: newBlocks } : msg
    })
  }

  lightCompact(messages: AgentMessage[], contextLength: number, fixedOverhead = 0, force = false): AgentMessage[] {
    if (!contextLength) return messages

    const estimatedTokens = this.contextTokens(messages, fixedOverhead)
    // Trigger on remaining window, not usage ratio: floor the headroom at 30K so
    // light compaction still fires early on small model windows.
    const remainingWindow = contextLength - estimatedTokens
    if (!force && remainingWindow >= Math.max(contextLength * 0.3, LIGHT_COMPACT_MIN_REMAINING)) return messages

    // Find the last text-containing user message (protected)
    let lastTextUserMsgId: string | null = null
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role === 'user' && m.contentBlocks.some(b => b.type === 'text')) {
        lastTextUserMsgId = m.id
        break
      }
    }

    // Walk forward from oldest to find complete tool cycles.
    // A "tool cycle" = assistant message with tool_uses → subsequent user
    // message(s) with the matching tool_results.
    const toDelete = new Set<number>()
    const toStrip: Map<number, ContentBlock[]> = new Map()

    let roundsDeleted = 0
    for (let i = 0; i < messages.length - 1; i++) {
      const current = messages[i]
      const next = messages[i + 1]

      if (toDelete.has(i)) continue

      if (current.role !== 'assistant' || next.role !== 'user') continue
      const hasToolUses = current.contentBlocks.some(b => b.type === 'tool_use')
      const hasToolResults = next.contentBlocks.some(b => b.type === 'tool_result')
      if (!hasToolUses || !hasToolResults) continue

      // Protection 1: is this the last text user message?
      if (next.id === lastTextUserMsgId) continue

      // Protection 2: keep at least 3 most recent rounds
      const remainingAfter = messages.length - i - 2
      if (remainingAfter < 3) continue

      // Protection 3: keep 8K token hot zone
      let remainingChars = 0
      for (let j = i + 2; j < messages.length; j++) {
        if (toDelete.has(j)) continue
        for (const b of messages[j].contentBlocks) {
          if (b.type === 'text') remainingChars += b.text.length
          else if (b.type === 'tool_result') remainingChars += b.content.length
          else if (b.type === 'thinking') remainingChars += (b as any).thinking.length
        }
      }
      if (remainingChars < 8000 * 3.5) continue

      const userHasText = next.contentBlocks.some(b => b.type === 'text')

      if (!userHasText) {
        toDelete.add(i)
        toDelete.add(i + 1)
        roundsDeleted++
      } else {
        toDelete.add(i)
        toStrip.set(i + 1, next.contentBlocks.filter(b => b.type === 'text'))
        roundsDeleted++
      }
    }

    if (roundsDeleted === 0) return messages

    const newMessages: AgentMessage[] = []
    for (let i = 0; i < messages.length; i++) {
      if (toDelete.has(i)) continue
      const msg = messages[i]
      if (toStrip.has(i)) {
        newMessages.push({ ...msg, contentBlocks: toStrip.get(i)! })
      } else {
        newMessages.push(msg)
      }
    }

    console.log(`[AgentEngine] lightCompact: removed ${roundsDeleted} tool cycles (context tokens: ~${estimatedTokens})`)
    return newMessages
  }

  /**
   * Run the compaction pipeline OUTSIDE a request to warm the history-summary
   * cache (PLAN context-management P0: the LLM summary is the expensive part
   * of compaction, and at request time it blocks the turn's next round — the
   * post-turn idle window is where it belongs). Mirrors prepareLoopRequest's
   * nano → light → hard order so the seeded frontier is the one the real
   * request will ask for; hard is FORCED in both sources because the summary
   * only exists when hard actually drops, and the cache's re-key branch
   * absorbs the frontier drifting to a less aggressive natural cut later.
   * Operates on the live list only through the same read-only pipeline the
   * request path uses — this.messages is never replaced, the prewarmed copy is
   * discarded, and nanoCompact's compression marks are restored so they cannot
   * suppress a real request's nano pass.
   * Returns the compaction event for the caller to emit, or null when there
   * was nothing to drop (conversation too small, another prewarm in flight).
   */
  async prewarm(options: {
    contextLength: number
    source: 'post-turn' | 'manual'
    instruction?: string
  }): Promise<CompactionEvent | null> {
    const { contextLength, source, instruction } = options
    if (!contextLength || this.prewarmInFlight) return null
    const original = this.deps.getMessages()
    if (original.length <= MIN_KEEP) return null
    this.prewarmInFlight = true
    const savedMarks = new Set(this._compressedToolUseIds)
    try {
      const tokensBefore = contextTokensOf(original)
      const nano = this.nanoCompact(original)
      const light = this.lightCompact(nano, contextLength, 0, source === 'manual')
      const truncated = this.hardTruncate(light, contextLength, 0, true)
      const droppedCount = light.length - truncated.length
      if (droppedCount <= 0) return null
      const summaryBefore = this.historySummary ? { ...this.historySummary } : null
      const final = await this.injectHistorySummary(original, light, truncated, instruction)
      const summary = this.historySummary
      const summaryChanged =
        !summary || !summaryBefore ||
        summary.firstKeptId !== summaryBefore.firstKeptId ||
        summary.text !== summaryBefore.text
      const strategies: string[] = []
      if (nano.some((m, i) => m !== original[i])) strategies.push('nano')
      if (light.length !== nano.length) strategies.push('light')
      strategies.push('hard')
      if (summary) strategies.push('summary')
      console.log(
        `[AgentEngine] prewarm (${source}): dropped ${droppedCount}, replays ${this.lastInjectReplayCount}, ` +
        `tokens ~${tokensBefore} → ~${Math.round(contextTokensOf(final))}`
      )
      return {
        ts: Date.now(),
        source,
        strategies,
        droppedMessages: original.length - final.length,
        replayedUserMessages: this.lastInjectReplayCount,
        tokensBefore,
        tokensAfter: contextTokensOf(final),
        summary: summaryChanged ? (summary ? { ...summary } : null) : undefined,
      }
    } finally {
      this._compressedToolUseIds = savedMarks
      this.prewarmInFlight = false
    }
  }

}
