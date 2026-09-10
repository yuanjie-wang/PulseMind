/**
 * Context compaction pipeline (PLAN-0.3.5 refactor): extracted from AgentEngine
 * so the state machine stays under the class-size budget. Owns the history
 * summary cache and the three-layer compaction (nano → light → hard truncate).
 * Operates on API-copy message arrays only — never touches the engine's live
 * messages (deps.getMessages supplies the live list for token estimation).
 */
import type { AgentMessage, ContentBlock, ToolResultBlock, TextBlock, ToolUseBlock, ThinkingBlock } from '../../types/agent'

const HARD_TRUNCATE_MIN_REMAINING = 10_000
const LIGHT_COMPACT_MIN_REMAINING = 30_000
const SUMMARY_TEXT_CAP = 2000
const SUMMARY_INPUT_CAP = 40000
const SUMMARY_RESULT_CAP = 400

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


export interface ContextCompactorDeps {
  runHistorySummary(regionText: string): Promise<string>
  getMessages(): AgentMessage[]
}

export class ContextCompactor {
  static readonly HARD_TRUNCATE_MIN_REMAINING = 10_000

  private _compressedToolUseIds = new Set<string>()
  private historySummary: { firstKeptId: string; text: string } | null = null

  constructor(private deps: ContextCompactorDeps) {}

  contextTokens(messages?: AgentMessage[], fixedOverhead = 0): number {
    const msgs = messages ?? this.deps.getMessages()
    for (let i = msgs.length - 1; i >= 0; i--) {
      const t = msgs[i].inputTokens
      if (t && t > 0) {
        // The reported inputTokens only covers the context up to this message.
        // Anything appended after it (e.g. the tool_result for a just-run tool,
        // or a new user turn) is not counted by that report yet — estimate just
        // that tail so a recent tool cycle doesn't get undercounted and slip
        // past the compaction threshold.
        const tail = this.estimateTokens(msgs.slice(i + 1))
        // An inputTokens report can itself be a post-compaction size (the report
        // records what was actually SENT, which may already have been truncated).
        // Since this.messages keeps the full history (compaction only rewrites
        // the API copy), that stale baseline can read far too small — so guard
        // with the full char heuristic to guarantee we never undercount.
        return Math.max(t + tail, this.estimateTokens(msgs))
      }
    }
    return this.estimateTokens(msgs) + fixedOverhead
  }

  hardTruncate(messages: AgentMessage[], contextLength: number, fixedOverhead = 0): AgentMessage[] {
    const THRESHOLD = contextLength * 0.9
    const MIN_KEEP = 10
    const MIN_USER_TURNS = 2

    if (messages.length <= MIN_KEEP) return messages

    const estimatedTokens = this.contextTokens(messages, fixedOverhead)
    // Trigger on remaining window, not usage ratio: when the model window is
    // small (e.g. 26K), 10% of it is only ~2.6K of headroom — too tight to be
    // useful. Floor the remaining headroom at a fixed 10K so truncation still
    // kicks in early enough on small windows.
    const remainingWindow = contextLength - estimatedTokens
    if (remainingWindow >= Math.max(contextLength * 0.1, ContextCompactor.HARD_TRUNCATE_MIN_REMAINING)) return messages

    // The walk below estimates the remaining content in char-heuristic units,
    // which never counts the fixed overhead (system prompt + tool schemas).
    // Re-add that overhead so the kept window actually lands under the
    // real-token threshold instead of over-retaining.
    const heuristicTotal = this.estimateTokens(messages)
    const overhead = Math.max(0, estimatedTokens - heuristicTotal)

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
      if (this.estimateTokens(remaining) + overhead <= THRESHOLD) break
      keepStart--
    }

    if (keepStart === 0) return messages

    // ── Fix: preserve tool_use↔tool_result pairing ────────────────
    // If the first kept message is a user with tool_results, walk backward
    // to include the preceding assistant with matching tool_calls.
    // Without this, the OpenAI API rejects the request with
    // "insufficient tool messages following tool_calls message".
    const firstKept = messages[keepStart]
    if (firstKept.role === 'user' && firstKept.contentBlocks.some(b => b.type === 'tool_result')) {
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
          keepStart = i
          break
        }
      }
    }

    const truncated = messages.slice(keepStart)
    const dropped = messages.length - truncated.length
    console.log(
      `[AgentEngine] hardTruncate: dropped ${dropped}/${messages.length} oldest messages ` +
      `(context ${estimatedTokens} → keep under ${THRESHOLD} of ${contextLength})`
    )
    return truncated
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
    truncated: AgentMessage[]
  ): Promise<AgentMessage[]> {
    const droppedCount = lightCompacted.length - truncated.length
    if (droppedCount <= 0) return truncated

    const firstKeptId = truncated[0]?.id
    if (!firstKeptId) return truncated

    // Slice the pre-compaction copy so the summarizer sees real tool results
    // (success AND error content), not [tool_result_id:] placeholders.
    // nanoCompact is a 1:1 map (no add/drop), so index alignment holds.
    const dropped = original.slice(0, droppedCount)
    const cache = this.historySummary

    // 1. Stable frontier → reuse verbatim.
    if (cache?.firstKeptId === firstKeptId) {
      return [makeHistorySummaryMessage(cache.text), ...truncated]
    }

    // 2. Old frontier message still kept (dropped less) → cached summary covers a
    //    superset of the dropped region. Reuse and re-key to the new frontier.
    if (cache && truncated.some((m) => m.id === cache.firstKeptId)) {
      this.historySummary = { firstKeptId, text: cache.text }
      return [makeHistorySummaryMessage(cache.text), ...truncated]
    }

    // 3. Old frontier message now dropped (frontier advanced) → summarize only the
    //    newly-dropped slice after the old frontier and extend the cached text.
    if (cache) {
      const j = dropped.findIndex((m) => m.id === cache.firstKeptId)
      if (j >= 0) {
        const extraText = buildDroppedRegionText(dropped.slice(j))
        if (extraText.trim()) {
          const extra = await this.deps.runHistorySummary(extraText)
          if (extra) {
            const text = cache.text + '\n\n' + extra
            this.historySummary = { firstKeptId, text }
            return [makeHistorySummaryMessage(text), ...truncated]
          }
        }
      }
    }

    // 4. No usable cache → summarize the full dropped region.
    const regionText = buildDroppedRegionText(dropped)
    if (!regionText.trim()) return truncated
    const summary = await this.deps.runHistorySummary(regionText)
    if (!summary) {
      console.warn('[AgentEngine] history summary empty, using plain truncation')
      return truncated
    }
    this.historySummary = { firstKeptId, text: summary }
    console.log(`[AgentEngine] injected history summary (${summary.length} chars) for ${droppedCount} dropped messages`)
    return [makeHistorySummaryMessage(summary), ...truncated]
  }

  estimateTokens(messages?: AgentMessage[]): number {
    const msgs = messages ?? this.deps.getMessages()
    let total = 0
    for (const msg of msgs) {
      // LLM-reported outputTokens cover the assistant's text output (and
      // usually tool_use input), but providers often exclude thinking/reasoning
      // from completion_tokens. Count thinking + tool_use blocks explicitly so
      // the estimate doesn't undercount — an undercount makes compaction fire
      // late and then drop a huge chunk of context at once.
      if (msg.outputTokens) {
        total += msg.outputTokens * 3.5
        for (const block of msg.contentBlocks) {
          if (block.type === 'text') continue // outputTokens already covers text
          if (block.type === 'tool_use') total += JSON.stringify(block.input).length + block.name.length
          else if (block.type === 'thinking') total += (block as ThinkingBlock).thinking.length
        }
        continue
      }
      for (const block of msg.contentBlocks) {
        if (block.type === 'text') total += block.text.length
        else if (block.type === 'tool_use') total += JSON.stringify(block.input).length + block.name.length
        else if (block.type === 'tool_result') total += (block as ToolResultBlock).content.length
        else if (block.type === 'thinking') total += (block as any).thinking.length
      }
    }
    return Math.ceil(total / 3.5)
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

  lightCompact(messages: AgentMessage[], contextLength: number, fixedOverhead = 0): AgentMessage[] {
    if (!contextLength) return messages

    const estimatedTokens = this.contextTokens(messages, fixedOverhead)
    // Trigger on remaining window, not usage ratio: floor the headroom at 30K so
    // light compaction still fires early on small model windows.
    const remainingWindow = contextLength - estimatedTokens
    if (remainingWindow >= Math.max(contextLength * 0.3, LIGHT_COMPACT_MIN_REMAINING)) return messages

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

}
