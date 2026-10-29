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

const LIGHT_COMPACT_MIN_REMAINING = 30_000
const SUMMARY_TEXT_CAP = 2000
const SUMMARY_INPUT_CAP = 40000
const SUMMARY_RESULT_CAP = 400
// The dropped-read reminder (PLAN-context-zcode-benchmarks P0): at most this
// many archived reads ride one reminder line-list — a pointer message costs
// ~1.5K chars, where re-reading the files from disk costs a full tool round
// each and ZCode's inline re-injection (5 files / 50K tokens) spends window.
const DROPPED_READ_REMINDER_CAP = 10
// nano's placeholder prefixes — a result already carrying one IS its own
// retrieval pointer, so reminding about it would be pure duplication. The
// ⟨archived: …⟩ glyph (2026-10-26) is deliberately OUTSIDE the [tool_result_…]
// family: the old `[tool_result_id:` prefix sat one character family away from
// the `[tool_result_error]` failure marker, and a model reading a batch of
// placeholders misread them as eight failed calls (conv_20261026154702). The
// two bracket forms are kept as LEGACY prefixes so a placeholder minted by an
// older build still reads as archived after an upgrade mid-session.
const TOOL_RESULT_PLACEHOLDER_PREFIXES = ['⟨archived:', '[tool_result_id:', '[Tool Result:']
// Frontier-advance accrual line for the history-summary cache: a frontier that
// moved forward re-summarizes only once the pending slice behind the cached
// frontier is worth an LLM call. A fit-based lightCompact advances the frontier
// on essentially every request of a long tool loop (the copy is re-derived from
// the live transcript each time), so without this line the request path would
// fire one summary call per request. Below the line the cached text is reused
// as-is and the slice keeps accruing behind the cached frontier — an uncovered
// hole bounded by the line itself, closed by the next crossing (the post-turn
// prewarm absorbs most of them at idle).
const SUMMARY_EXTEND_MIN_CHARS = 12_000
// The accumulated history-summary text is CAPPED, and past the cap it is
// ROLLED (re-summarized) rather than concatenated forever: the summary message
// is injected AFTER hardTruncate, so no pipeline layer ever compresses it and
// an uncapped cache linearly eats the window over a marathon session
// (review_20260929 低3). Sized to the same order as USER_REPLAY_BUDGET_TOKENS
// (10K tokens ≈ 20K CJK chars), so the whole compensation region (summary +
// replays) stays a few percent of a 200K window; a roll's input (cap + one
// extension) stays well under SUMMARY_INPUT_CAP. A roll that still comes back
// over the cap is accepted — looping would burn calls on a model that will
// not compress.
const HISTORY_SUMMARY_MAX_CHARS = 20_000
// Shared by hardTruncate and emergencyTruncate's keep-window walk.
const MIN_KEEP = 10
const MIN_USER_TURNS = 2
// emergencyTruncate's phase-2 trim: tool_result bodies become this many chars
// plus a tool_result_search pointer, oldest first, until the estimate fits.
const OVERFLOW_STRIP_PREFIX = 1500
// emergencyTruncate's phase-2c trigger (review_20261028 中4): a tool_use STRING
// parameter over this many chars is a candidate for elision. TOOL_PARAM_LIMITS
// lets write.content ride 500K chars into history — far past small windows —
// and once such a block sits in the protection window nothing below can touch
// it. Below the line the param is not the culprit and stays verbatim.
const OVERFLOW_TOOL_PARAM_CHARS = 20_000
// Token budget for replaying the dropped region's USER messages verbatim into
// the compacted copy (P0 of the 2026-09-23 gap analysis). The summary is a
// ~900-token structured paraphrase; the user's own words are the intent record
// and used to survive only inside it. Codex replays real user messages wholesale
// (COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000) and Claude Code's compact prompt
// reserves a dedicated "All User Messages" section — same judgement: user
// intent is the one thing a lossy summary must not own alone.
const USER_REPLAY_BUDGET_TOKENS = 10_000
// Post-turn prewarm trigger: usage at/above this share of the window warms the
// history summary at turn end, so the expensive LLM summary runs while the
// engine is idle instead of blocking the next turn's first request.
export const POST_TURN_COMPACT_USED_RATIO = 0.75
// Stale-thinking strip (2026-10-25, conv_20261025172138 「飞行棋」 88% 复盘): the
// OpenAI adapter maps EVERY thinking block in history back onto the wire as
// reasoning_content and the gateway bills it as input — one 18.6K-token
// reasoning turn re-entered the next request as +19.7K prompt tokens and
// rode every request of the conversation from then on. Both providers' own
// contracts only need the CURRENT turn's reasoning (DeepSeek's thinking-mode
// tool loop; Anthropic's signed blocks inside the live loop), so thinking
// behind the last text user message is dead weight. Gated on usage: below the
// line a short conversation never pays the once-per-turn prefix re-bill the
// strip costs at a turn boundary (the previous turn's residual content
// changes bytes, so the cache breaks there once, then stabilizes).
export const THINKING_STRIP_USED_RATIO = 0.5

// ── Refill breaker (PLAN-context-zcode-benchmarks P1) ───────────────────
// The fit-based layers (light/hard) drop on the pass that crosses the line;
// if the copy re-crosses within fewer than this many tool rounds, something
// is refilling it faster than the turn consumes it (a large file or tool
// output being re-read whole every round). REFILL_BREAKER_LIMIT consecutive
// refills trip the breaker: summary absorption pauses until a request enters
// with the rhythm normalized again. Deliberately NOT a hard error (ZCode's
// ModelContextExceeded shape): nano/light/hard/emergency are zero-LLM and
// keep every request fitted — the churn the breaker owns is the summary LLM
// call and the byte-churn it injects, not overflow safety.
export const REFILL_TOOL_TURN_THRESHOLD = 3
export const REFILL_BREAKER_LIMIT = 3

export interface CompactTracking {
  /** Completed tool batches since the last compaction drop. */
  toolRoundsSinceDrop: number
  /** Consecutive drops that landed within REFILL_TOOL_TURN_THRESHOLD rounds
   *  of the previous one. */
  consecutiveRefills: number
  /** Breaker state: the history-summary absorption (first build AND
   *  extension) is paused while true; nano/light/hard/emergency keep running. */
  summarySuspended: boolean
}

export function makeCompactTracking(): CompactTracking {
  return { toolRoundsSinceDrop: 0, consecutiveRefills: 0, summarySuspended: false }
}

// ── Display-side nano pricing (ContextRing projection, 2026-10-24) ──────
// The ring's mid-batch over-read: its tail is priced RAW (every tool_result
// whole) while the next request's nano pass replaces old results with
// placeholders before anything ships — tool-heavy turns pinned the ring at
// 79–96% while the wire carried ~60% (conv_20261021155951). This helper
// mirrors nanoCompact's DECISION deterministically (protection window + tier
// quotas + placeholder pricing) without touching the compactor's marks or
// mandates, which only the live engine knows. Tail-only callers pass a
// slice: quotas/protection are computed over exactly that slice, so a young
// tail prices whole (yesterday's behavior — nano compresses nothing below
// the quota anyway) and only a marathon tail compresses. The approximation
// errs toward OVER-reading the shipped copy, never under it.
const NANO_PLACEHOLDER_COST = 45 // '⟨archived: <uuid>⟩' ≈ 45 latin chars + the two multibyte glyphs
/** nano tier quotas, shared by nanoCompact and the ring-side projection
 *  (estimateAfterNanoTokens) — ONE constant: a drifted copy in the projection
 *  would silently misprice every ring reading. */
const NANO_TIER_SIZES: Record<number, number> = { 1: 10, 2: 20 }

export function estimateAfterNanoTokens(messages: AgentMessage[]): number {
  const protectedMsgIds = new Set<string>()
  {
    let found = 0
    for (let i = messages.length - 1; i >= 0 && found < NANO_PROTECTION_WINDOW; i--) {
      const msg = messages[i]
      if (msg.role !== 'user') continue
      if (msg.contentBlocks.some(b => b.type === 'tool_result')) { protectedMsgIds.add(msg.id); found++ }
    }
  }
  const toolUseToName = new Map<string, string>()
  const counts: Record<number, number> = {}
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    for (const block of msg.contentBlocks) {
      if (block.type !== 'tool_use') continue
      if (NANO_TIER3_NAMES.has(block.name)) continue
      const tier = NANO_TIER_MAP[block.name] ?? 2
      counts[tier] = (counts[tier] || 0) + 1
      toolUseToName.set(block.id, block.name)
    }
  }
  const compressTargets: Record<number, number> = {}
  for (const [tierStr, count] of Object.entries(counts)) {
    const tier = Number(tierStr)
    const size = NANO_TIER_SIZES[tier]
    if (!size) continue
    const fullTiers = Math.floor(count / size)
    if (fullTiers >= 2) compressTargets[tier] = (fullTiers - 1) * size
  }
  const compressed: Record<number, number> = {}
  let total = 0
  for (const msg of messages) {
    for (const block of msg.contentBlocks) {
      if (block.type === 'tool_result') {
        const content = (block as ToolResultBlock).content || ''
        const name = toolUseToName.get((block as ToolResultBlock).tool_use_id)
        const tier = name ? (NANO_TIER_MAP[name] ?? 2) : undefined
        // Same skip rules as nanoCompact: user messages only, not protected,
        // not already a placeholder; quota budget burns oldest-first.
        if (msg.role === 'user' && name && tier != null && !NANO_TIER3_NAMES.has(name)
          && !protectedMsgIds.has(msg.id)
          && !TOOL_RESULT_PLACEHOLDER_PREFIXES.some(p => content.startsWith(p))) {
          const target = compressTargets[tier]
          if (target && target > 0 && (compressed[tier] || 0) < target) {
            compressed[tier] = (compressed[tier] || 0) + 1
            total += NANO_PLACEHOLDER_COST
            continue
          }
        }
        total += estimateTextTokens(content)
      } else if (block.type === 'text') {
        total += estimateTextTokens((block as TextBlock).text)
      } else if (block.type === 'tool_use') {
        total += estimateTextTokens(JSON.stringify((block as ToolUseBlock).input) + (block as ToolUseBlock).name)
      } else if (block.type === 'thinking') {
        total += estimateTextTokens((block as { thinking: string }).thinking)
      }
    }
  }
  return total
}

// ── nanoCompact's shared classification (PLAN-context-compact-tool D3b) ──
// Exported so the engine's free_results resolution applies the SAME rules at
// mandate time that nanoCompact applies at compress time — a pick the model
// makes must not be accepted here and silently skipped there (or vice versa).
const NANO_TIER_MAP: Record<string, number> = {
  exec: 1, search: 1, find: 1, list_dir: 1,
  read: 2, experience_read: 2, experience_save: 2,
  recall: 2, memory_save: 2, tool_result_search: 2,
  spawn_agent: 2, edit: 2, write: 2, install: 2, pick_skill: 2, pick_tool: 2, webfetch: 2
}
/** Never compressed — not by the quota walk, not even by an explicit
 *  `context_compact` free_results pick. Their results ARE the interaction. */
export const NANO_TIER3_NAMES = new Set(['ask_user', 'create_plan', 'advance_plan'])
/** The newest N user messages carrying tool_results keep those results whole —
 *  the current turn's batch may still need to read them verbatim. Beats even a
 *  mandated pick. */
export const NANO_PROTECTION_WINDOW = 4

/** Pure transition of the refill breaker, run once per request build after
 *  the compaction strategies are known. `droppedFit` = the fit-based layers
 *  dropped this pass — nano never counts (1:1) and emergency never counts
 *  (reactive overflow backstop, not the churning fit). `droppedAny` (an
 *  emergency-only pass included) still restarts the round clock: any message
 *  loss re-bases "within N rounds". Mutates `tracking` in place; returns
 *  whether THIS call tripped the breaker so the caller emits exactly one
 *  event per transition. */
export function evaluateRefillBreaker(
  tracking: CompactTracking,
  roundsAtEntry: number,
  droppedFit: boolean,
  droppedAny: boolean = droppedFit
): { transitionedToSuspended: boolean } {
  let transitionedToSuspended = false
  if (droppedFit) {
    if (roundsAtEntry < REFILL_TOOL_TURN_THRESHOLD) {
      tracking.consecutiveRefills++
      if (tracking.consecutiveRefills >= REFILL_BREAKER_LIMIT && !tracking.summarySuspended) {
        tracking.summarySuspended = true
        transitionedToSuspended = true
      }
    } else {
      // Enough tool rounds elapsed since the last drop — the rhythm has
      // normalized, whether or not this pass dropped.
      tracking.consecutiveRefills = 0
      tracking.summarySuspended = false
    }
  }
  if (droppedAny) {
    // A drop restarts the round clock (ZCode's recordCompactSuccess shape):
    // "within N rounds" is measured from the most recent compaction.
    tracking.toolRoundsSinceDrop = 0
  } else if (roundsAtEntry >= REFILL_TOOL_TURN_THRESHOLD) {
    tracking.consecutiveRefills = 0
    tracking.summarySuspended = false
  }
  return { transitionedToSuspended }
}

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

/** The dropped region as summarizer input, oldest first, capped at
 *  SUMMARY_INPUT_CAP chars. Also returns the ids ACTUALLY built into the
 *  text: the coverage ledger may only absorb what the summary really saw —
 *  stamping the capped-away tail as covered would permanently skip it
 *  (the hot, nearest-the-tail content exactly, review_20260929 中3). A
 *  message whose blocks hit the budget mid-way stays covered: its kept head
 *  IS in the text, the same partial shape as the per-block caps. */
function buildDroppedRegionText(region: AgentMessage[]): { text: string; coveredIds: string[] } {
  const parts: string[] = []
  const coveredIds: string[] = []
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
    coveredIds.push(msg.id)
    budget -= text.length
  }
  return { text: parts.join('\n\n'), coveredIds }
}

function makeHistorySummaryMessage(text: string, coverageLine?: string | null): AgentMessage {
  const body = coverageLine ? `${coverageLine}\n${text}` : text
  return {
    id: `summary_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    contentBlocks: [{ type: 'text', text: `【历史对话摘要】\n${body}` }],
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


/** The dropped region's successful `read` calls whose results are no longer
 *  visible in the kept tail, as ONE synthetic reminder text (null = nothing
 *  to remind). The summary prices tool results at SUMMARY_RESULT_CAP and the
 *  replays carry only user words, so without this the model loses track of
 *  which files it already read and re-probes them from disk (the
 *  conv_20260927170026 re-probe). PulseMind's shape is pointer-only, NOT
 *  ZCode's inline content replay: every production tool_result carries a
 *  `tool_result_id` minted at creation (addToolResult) and the full text is
 *  persisted to the tool_results table (persistUnsavedToolResults runs before
 *  this pipeline), so `tool_result_search` resolves any id advertised here.
 *  Newest first (the freshest reads are the ones the live work still needs);
 *  deduped by file path with the newest read winning; results in the kept
 *  tail — full or nano-placeholder form — are skipped, the placeholder being
 *  its own pointer. */
export function buildDroppedReadReminder(
  dropped: AgentMessage[],
  truncated: AgentMessage[],
  cap = DROPPED_READ_REMINDER_CAP
): string | null {
  const visibleInTail = new Set<string>()
  for (const msg of truncated) {
    for (const block of msg.contentBlocks) {
      if (block.type === 'tool_result') visibleInTail.add((block as ToolResultBlock).tool_use_id)
    }
  }
  const resultsById = new Map<string, ToolResultBlock>()
  for (const msg of dropped) {
    if (msg.role !== 'user') continue
    for (const block of msg.contentBlocks) {
      if (block.type === 'tool_result') {
        const tr = block as ToolResultBlock
        resultsById.set(tr.tool_use_id, tr)
      }
    }
  }
  const picked = new Map<string, { path: string; resultId: string }>()
  const seenPaths = new Set<string>()
  let overflow = 0
  for (let i = dropped.length - 1; i >= 0; i--) {
    const msg = dropped[i]
    if (msg.role !== 'assistant') continue
    for (const block of msg.contentBlocks) {
      if (block.type !== 'tool_use') continue
      const tu = block as ToolUseBlock
      if (tu.name !== 'read') continue
      const tr = resultsById.get(tu.id)
      if (!tr || tr.is_error) continue
      if (TOOL_RESULT_PLACEHOLDER_PREFIXES.some((p) => tr.content.startsWith(p))) continue
      if (!tr.tool_result_id) continue // no persisted key → the id would not resolve
      if (visibleInTail.has(tu.id)) continue
      const path = String(tu.input?.file_path || '').trim()
      if (!path) continue
      // Distinct reads only: a re-read of the same path is covered by the
      // newest one's id and must not inflate the overflow note.
      if (seenPaths.has(path)) continue
      seenPaths.add(path)
      if (picked.size >= cap) {
        overflow++
        continue
      }
      picked.set(path, { path, resultId: tr.tool_result_id })
    }
  }
  if (picked.size === 0) return null
  const lines = [...picked.values()].map((e) => `- ${e.path}（tool_result_id: ${e.resultId}）`)
  if (overflow > 0) lines.push(`（另有 ${overflow} 个更早的已归档读取未列出）`)
  return [
    '【已归档读取提醒】以下文件此前读取成功，原文已随旧上下文归档。需要内容时用 tool_result_search 按 tool_result_id 取回，不要重新 read 整个文件：',
    ...lines,
  ].join('\n')
}

function makeDroppedReadReminderMessage(text: string): AgentMessage {
  return {
    id: `read_reminder_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    contentBlocks: [{ type: 'text', text }],
    createdAt: new Date().toISOString()
  }
}

/** MM-DD HH:mm in local time — the shape the rest of the app speaks. */
function formatStamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** The mechanical coverage line for the history-summary message
 *  (PLAN-context-summary-structure): the covered span's first/last timestamp
 *  plus message / user-turn counts — facts computed in code, never trusted to
 *  the summarizer LLM. Rendered per-pass from the covered set and injected
 *  into the summary MESSAGE only, never into the cached text: the cache stays
 *  pure LLM output (the 20K cap, the roll input, the persisted shape and
 *  event.summary.text are untouched), and a line frozen inside it would go
 *  stale as coverage grows. Cache-stable by construction: covered growth is
 *  exactly what already breaks the request prefix at the user replays, which
 *  sit BEFORE the summary message; passes with an unchanged covered set
 *  render the identical line. `covered` is always a subset of `dropped` (it
 *  is the ledger of what was dropped and summarized); ids outside it are
 *  ignored, so an empty or foreign set renders no line (the notes-only
 *  landing). */
export function buildSummaryCoverageHeader(dropped: AgentMessage[], covered: Set<string>): string | null {
  if (covered.size === 0) return null
  const msgs = dropped.filter((m) => covered.has(m.id))
  if (msgs.length === 0) return null
  // 用户发言 = 带正文的用户消息——与 collectUserReplays 的口径一致。
  // addToolResult 给每个工具批铸造 role:'user'、只含 tool_result 块的收集
  // 消息，按 role 计数会把它们全算成发言：压实最重的会话收集消息落得最多，
  // 虚报可达 10 倍（review_20261006 中5）——这一行的存在意义是机械事实，
  // 口径必须与转写其他地方对齐。
  const userTurns = msgs.filter((m) => m.role === 'user' && m.contentBlocks.some((b) => b.type === 'text')).length
  const start = formatStamp(msgs[0].createdAt)
  const end = formatStamp(msgs[msgs.length - 1].createdAt)
  const span = start === end ? start : `${start} – ${end}`
  return `〔覆盖〕${span} · 已压缩 ${msgs.length} 条消息（用户发言 ${userTurns} 条）`
}

/** The turn anchor every boundary rule hangs off: the newest user message
 *  that carries text. Tool-result collector messages (role user, tool_result
 *  blocks only) do not count, so a mid-turn ask_user answer never ends the
 *  turn — the same reading lightCompact's Protection 1 uses. −1 when the
 *  history holds no such message (a routine's tool stream): callers then strip
 *  nothing, since without an anchor every block could be the live loop's. */
export function lastTextUserMessageIndex(messages: AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'user' && m.contentBlocks.some((b) => b.type === 'text')) return i
  }
  return -1
}

function isThinkingBlock(b: ContentBlock): boolean {
  return b.type === 'thinking' || b.type === 'redacted_thinking'
}

function thinkingTextOf(b: ContentBlock): string {
  return b.type === 'thinking' ? (b as { thinking: string }).thinking : (b as { data?: string }).data ?? ''
}

/** apiMessages-layer elision, sibling of elideTodoWritePairs: an assistant
 *  message behind the turn anchor carrying ONLY thinking — the shape a
 *  max_tokens-truncated reasoning turn leaves (49,152 reasoning tokens, zero
 *  body) — has nothing left to ship once its turn is over, and stripped of its
 *  thinking it would be an empty assistant message the gateway rejects. It is
 *  removed here, before the copy is fixed, so it never enters the dropped-
 *  region summary arithmetic (there is nothing in it to summarize).
 *  Unconditional: no usage level justifies shipping it. The current turn's own
 *  thinking-only message (the thinking-only retry's shape) sits behind no
 *  anchor and stays. Identity-preserving when nothing is dropped. */
export function dropStaleThinkingOnlyTurns(messages: AgentMessage[]): AgentMessage[] {
  const anchor = lastTextUserMessageIndex(messages)
  if (anchor < 0) return messages
  let changed = false
  const kept: AgentMessage[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (i < anchor && m.role === 'assistant' && m.contentBlocks.length > 0 && m.contentBlocks.every(isThinkingBlock)) {
      changed = true
      continue
    }
    kept.push(m)
  }
  return changed ? kept : messages
}


export interface ContextCompactorDeps {
  /** mode: 'region' = first build / extension (the input is a raw conversation
   *  region); 'roll' = the accumulated text past the 20K cap is being
   *  consolidated (PLAN-context-summary-structure). */
  runHistorySummary(regionText: string, instruction?: string, mode?: 'region' | 'roll'): Promise<string>
  getMessages(): AgentMessage[]
  /** The refill breaker's state, read live per pass (the engine owns the
   *  tracking object; the compactor only consumes the flag). While true the
   *  summary absorption — first build AND extension — is skipped and the
   *  cached text rides as-is; nano/light/hard/emergency are unaffected. */
  isSummarySuspended?(): boolean
}

export class ContextCompactor {
  static readonly HARD_TRUNCATE_MIN_REMAINING = 10_000

  private _compressedToolUseIds = new Set<string>()
  /** The model's own nano picks (context_compact's `free_results`,
   *  PLAN-context-compact-tool D3b). Independently persistent — a mandated id
   *  compresses EVERY request regardless of the tier quotas, so the placeholder
   *  the model asked for is stable. Deliberately NOT the marks set below: marks
   *  mean "compressed once → allowed to re-inflate"; a mandated id entering it
   *  would pop back to full text on the very next request. Cleared with the
   *  conversation (engine reset). */
  private mandatedCompressIds = new Set<string>()
  /** Record the model's picks (already validated by the engine against TIER3 /
   *  protection window / existence — see AgentEngine.compactForTool). */
  mandateToolResultIds(ids: string[]): void {
    for (const id of ids) this.mandatedCompressIds.add(id)
  }
  /** Conversation reset — new history has no old ids to name. */
  clearMandatedToolResultIds(): void {
    this.mandatedCompressIds.clear()
  }
  /** History-summary cache. `firstKeptId` is the persisted COVERAGE FRONTIER
   *  (the newest message the text covers — historical field name, opaque to
   *  every consumer). `covered` is the in-memory id set the text actually
   *  covers: light drops HOLES (whole tool cycles) and protection releases
   *  drop messages BEHIND the frontier later, so a position slice cannot tell
   *  covered from new — only the set can. Not persisted (the frontier id is);
   *  a rehydrate rebuilds it positionally from the frontier. */
  private historySummary: { firstKeptId: string; text: string; covered?: Set<string> } | null = null
  /** User messages the last injectHistorySummary pass replayed verbatim —
   *  read by the engine to populate the compaction event's counter. */
  lastInjectReplayCount = 0
  /** 1 when the last pass produced a dropped-read reminder message, 0
   *  otherwise — the request path reads it to tag the compaction event's
   *  strategies without re-derving the composition from array lengths. */
  lastReminderCount = 0
  /** Whether the last inject pass landed the model's handover note
   *  (context_compact's `notes`) — read by the engine for the tool envelope's
   *  notesKept. Reset at every inject; a `notes`-less pass always reads false. */
  lastNotesLanded = false
  /** Guards overlapping prewarm runs (post-turn / manual): two concurrent LLM
   *  summaries for the same frontier are pure waste. */
  private prewarmInFlight = false

  constructor(private deps: ContextCompactorDeps) {}

  /** The fixed overhead (system prompt + tool schemas + state block) the last
   *  real request build priced. prewarmBody's simulation must truncate in the
   *  SAME units the next build will: the fit walks are overhead-sensitive, so
   *  a 0-overhead simulation promises drops the request never materializes
   *  (or covers fewer ids than the request sheds) — the old bimodal walk
   *  landed on the guard floor either way and hid the divergence. Set by
   *  prepareLoopRequest on every build; 0 until the first request (manual
   *  /compact on a fresh session), where the cache-hit branch absorbs the
   *  drift. */
  lastRequestOverhead = 0

  contextTokens(messages?: AgentMessage[], fixedOverhead = 0): number {
    // The shared estimator (engine/context-estimate.ts) carries the contract:
    // a real inputTokens report anchors the number, the tail appended since is
    // estimated CJK-aware, and the full heuristic guards a stale baseline.
    return contextTokensOf(messages ?? this.deps.getMessages(), fixedOverhead)
  }

  /** Largest keepStart whose kept tail fits `thresholdTokens` under the
   *  estimate plus fixed overhead — i.e. the cut retains as MUCH history as
   *  the threshold allows — bounded by the minimum-retention guards: the kept
   *  tail never holds fewer than the last MIN_USER_TURNS user turns and
   *  MIN_KEEP messages, and when even that floor cannot fit the threshold the
   *  floor still wins (cut to it anyway; whatever remains over the line is the
   *  emergency strip's problem, never a reason to no-op the whole pass).
   *  Shared by hardTruncate (threshold 0.9× the window) and emergencyTruncate
   *  (threshold 0.6× the provider's named limit). */
  private fitKeepStart(messages: AgentMessage[], thresholdTokens: number, overhead: number): number {
    // Guards are a MINIMUM retention, so the LARGEST keepStart they permit is
    // the more restrictive of the two floors. The old Math.max made MIN_KEEP a
    // maximum retention and let a long tool tail evict both last user turns.
    let guardMax = messages.length - MIN_KEEP
    let userTurnsFound = 0
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        userTurnsFound++
        if (userTurnsFound >= MIN_USER_TURNS) {
          guardMax = Math.min(guardMax, i)
          break
        }
      }
    }
    if (guardMax <= 0) return 0

    // Walk from "keep everything" up to the first fitting tail. Contributions
    // are per-message additive (the same rule estimateMessagesTokens applies),
    // so a running suffix sum prices each candidate in O(1) — O(n) total. The
    // old loop broke on the first fit and DECREMENTED on a miss; since a
    // smaller keepStart only grows the tail, that walk was bimodal: the guard
    // floor fitting → cut to the floor (~10 messages against a 0.9× window of
    // headroom, a utilization cliff); it not fitting → keepStart ran to 0 and
    // the caller no-opped the entire pass.
    const contributions = messages.map((m) => this.contributionOf(m))
    let tail = contributions.reduce((a, b) => a + b, 0)
    let keepStart = 0
    while (keepStart < guardMax && tail + overhead > thresholdTokens) {
      tail -= contributions[keepStart]
      keepStart++
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
   *  oldest whole messages, then strip, oldest first and in this order:
   *  tool_result bodies to a short prefix + tool_result_search pointer
   *  (phase 2), whole thinking blocks (2b), giant tool_use string params
   *  (2c, review_20261028 中4) — until the estimate fits. Pairing is
   *  untouched — the placeholder keeps the tool_use_id, so the request stays
   *  well-formed. Operates on the API copy only; this.messages is never
   *  touched. */
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

    // Phase 2b — thinking blocks, oldest first (2026-10-24 harness review): in
    // a reasoning marathon the CoT is the single biggest block kind, and phase
    // 2 only touches tool_results — a small-window session whose last MIN_KEEP
    // messages carry big thinking blocks could NEVER be forced under the
    // limit, 400-looping on every retry. Whole-BLOCK removal (never a head
    // cut: Anthropic validates a thinking block's signature against its exact
    // bytes, so a truncated thinking text 400s the request — omitting the
    // block entirely is the legal shape) and only when the message keeps at
    // least one other block, so no message is ever emptied.
    for (let i = 0; i < stripped.length && total > target; i++) {
      const msg = stripped[i]
      if (msg.role !== 'assistant') continue
      if (!msg.contentBlocks.some(b => b.type === 'thinking' || b.type === 'redacted_thinking')) continue
      if (!msg.contentBlocks.some(b => b.type !== 'thinking' && b.type !== 'redacted_thinking')) continue
      let delta = 0
      const kept: typeof msg.contentBlocks = []
      for (const b of msg.contentBlocks) {
        if ((b.type === 'thinking' || b.type === 'redacted_thinking') && total - delta > target) {
          delta += estimateTextTokens(b.type === 'thinking' ? (b as { thinking: string }).thinking : (b as { data: string }).data)
          continue
        }
        kept.push(b)
      }
      if (kept.length !== msg.contentBlocks.length) {
        total -= delta
        stripped[i] = { ...msg, contentBlocks: kept }
        strippedAny = true
      }
    }

    // Phase 2c — tool_use giant STRING params, oldest first (review_20261028
    // 中4): the result-side and thinking layers above can both come up short
    // when the overflow itself is a write.content / spawn task that rode into
    // history inside the protection window — no layer below emergency touches
    // tool_use params, so the request would 400 forever. Elide the oversized
    // STRING VALUES only: keys and small values keep the call legible, the
    // tool_use_id keeps result pairing intact, and a shortened string value
    // cannot break JSON structure. The full input still lives in the engine's
    // own history copy and the transcript UI — this trims the API copy of a
    // call that already executed.
    for (let i = 0; i < stripped.length && total > target; i++) {
      const msg = stripped[i]
      if (msg.role !== 'assistant') continue
      if (!msg.contentBlocks.some(b => b.type === 'tool_use')) continue
      let modified = false
      const blocks = msg.contentBlocks.map((block) => {
        if (block.type !== 'tool_use') return block
        const tu = block as ToolUseBlock
        if (!tu.input || total <= target) return block
        const input: Record<string, unknown> = {}
        let touched = false
        for (const [key, value] of Object.entries(tu.input)) {
          if (typeof value !== 'string' || value.length <= OVERFLOW_TOOL_PARAM_CHARS) {
            input[key] = value
            continue
          }
          const elided = value.length - OVERFLOW_STRIP_PREFIX
          const replacement =
            `${value.slice(0, OVERFLOW_STRIP_PREFIX)}` +
            `\n\n… [上下文超限，该参数在请求副本中截断（约 ${elided.toLocaleString()} 字符省略）——调用已执行，结果见对应 tool_result，写入的文件可在工作区 read 取回] …`
          total -= estimateTextTokens(value) - estimateTextTokens(replacement)
          input[key] = replacement
          touched = true
        }
        if (!touched) return block
        modified = true
        return { ...tu, input }
      })
      if (modified) {
        stripped[i] = { ...msg, contentBlocks: blocks }
        strippedAny = true
      }
    }

    if (strippedAny) {
      console.log(`[AgentEngine] emergencyTruncate: stripped oldest tool_result/thinking/tool_use-param content for a ${hardLimit}-token provider limit (context now ~${Math.max(0, Math.round(total))})`)
      return stripped
    }
    return working
  }

  getHistorySummary(): { firstKeptId: string; text: string } | null {
    // The covered-id set is internal bookkeeping — never ships in the
    // compaction event (Sets do not survive the IPC round-trip).
    const cache = this.historySummary
    return cache ? { firstKeptId: cache.firstKeptId, text: cache.text } : null
  }

  seedHistorySummary(text?: string, frontierId?: string): void {
    this.historySummary = text && frontierId ? { firstKeptId: frontierId, text, covered: undefined } : null
  }

  /** Request-path entry (prepareLoopRequest). If a prewarm is in flight, wait
   *  it out first: the prewarm computed its frontier with the very same
   *  nano → light → hard pipeline, so one LLM round-trip of waiting lands this
   *  pass in the stable-frontier cache hit below instead of racing a second
   *  concurrent summarization call — and the user's next message tends to
   *  land inside the prewarm's window, which is why the prewarm exists
   *  (review0924 M2). The prewarm itself calls injectHistorySummaryInto
   *  directly, so the wait can never self-deadlock. */
  async injectHistorySummary(
    original: AgentMessage[],
    truncated: AgentMessage[],
    instruction?: string
  ): Promise<AgentMessage[]> {
    if (this.prewarmPromise) await this.prewarmPromise.catch(() => {})
    return this.injectHistorySummaryInto(original, truncated, instruction)
  }

  /** Land a summary text, rolling it (one re-summarization of the whole text)
   *  when it exceeds HISTORY_SUMMARY_MAX_CHARS — the summary rides the API
   *  copy after hardTruncate, so nothing else will ever compress it
   *  (review_20260929 低3). Returns null when the roll fails: the caller keeps
   *  its previous cache state and must NOT absorb the new coverage into the
   *  ledger (the 中3 rule — the ledger may only claim what the landed text
   *  really carries). */
  private async cappedSummaryText(text: string, instruction?: string): Promise<string | null> {
    if (text.length <= HISTORY_SUMMARY_MAX_CHARS) return text
    console.log(`[AgentEngine] history summary over cap (${text.length} > ${HISTORY_SUMMARY_MAX_CHARS} chars) — rolling it`)
    // mode 'roll': the input is the accumulated summary chain, not a raw
    // region — the roll prompt consolidates sections instead of re-compressing.
    const rolled = await this.deps.runHistorySummary(text, instruction, 'roll')
    return rolled || null
  }

  /** Compose the model's handover note (context_compact's `notes`,
   *  PLAN-context-compact-tool D5) onto a summary text BEFORE the cap: the
   *  merged text is what gets rolled, so a roll re-writes note and summary
   *  together. `notes` lands VERBATIM (【交接笔记】 section) — never through
   *  the summarizer. The cap applies with or without a note (an oversized
   *  FIRST summary rolls exactly as before); null = nothing to land (roll
   *  failure): the caller keeps its previous state. */
  private async composeWithNotes(
    base: string | null,
    notesSection: string | null,
    instruction?: string
  ): Promise<string | null> {
    if (base === null && notesSection === null) return null
    const merged = notesSection ? (base ? `${base}\n\n${notesSection}` : notesSection) : base
    return this.cappedSummaryText(merged as string, instruction)
  }

  private async injectHistorySummaryInto(
    original: AgentMessage[],
    truncated: AgentMessage[],
    instruction?: string,
    notes?: string,
    opts?: { bypassBreaker?: boolean }
  ): Promise<AgentMessage[]> {
    const notesSection = notes?.trim() ? `【交接笔记】\n${notes.trim()}` : null
    // Read by the engine's compactForTool envelope (notesKept): did the note
    // actually ride the landed text?
    this.lastNotesLanded = false
    // The dropped region is the EXACT set difference: everything the pre-pipeline
    // copy holds that the kept tail does not. The old arithmetic
    // (lightCompacted.length - truncated.length) measured only hard's share, so
    // whenever light was the active layer — every long tool session, where it
    // dropped 618 of 806 messages per request while hard dropped 0 — the summary
    // AND the user replays were both skipped wholesale: the model lost the region
    // with zero compensation (conv_20260927170026, 2026-09-29).
    const keptIds = new Set(truncated.map((m) => m.id))
    const dropped = original.filter((m) => !keptIds.has(m.id))
    this.lastInjectReplayCount = 0
    this.lastReminderCount = 0
    if (dropped.length === 0) return truncated

    // The coverage frontier is the NEWEST dropped message: the cached text
    // covers everything dropped so far, and the next pass's newly-dropped slice
    // is whatever lands after this id. (light drops HOLES — whole tool cycles —
    // not a clean prefix, so the old frontier = truncated[0].id pinned itself to
    // the first surviving non-cycle message: the cache hit its reuse branch
    // forever and never extended — the marathon's 683-char summary sat
    // un-extended for 29h across ~300 drop passes. Serialized under the
    // historical `firstKeptId` name; every consumer treats it as an opaque id.)
    const frontierId = dropped[dropped.length - 1].id

    // The dropped region's user words ride the copy verbatim (budget-capped) —
    // the summary paraphrases, the intent stays quotable.
    const replays = collectUserReplays(dropped)
    this.lastInjectReplayCount = replays.length
    // The dropped region's successful reads ride back as pointer lines — the
    // discovery half of the compensation (the retrieval half is the persisted
    // tool_results table + tool_result_search).
    const reminderText = buildDroppedReadReminder(dropped, truncated)
    this.lastReminderCount = reminderText !== null ? 1 : 0
    const withCompensation = (summaryText: string | null, covered?: Set<string>): AgentMessage[] => [
      ...replays,
      ...(summaryText !== null
        ? [makeHistorySummaryMessage(summaryText, covered ? buildSummaryCoverageHeader(dropped, covered) : null)]
        : []),
      ...(reminderText !== null ? [makeDroppedReadReminderMessage(reminderText)] : []),
      ...truncated,
    ]
    const cache = this.historySummary

    // The coverage the CACHED text claims (PLAN-context-summary-structure):
    // the in-memory ledger when present, else the same positional rebuild a
    // rehydrated cache derives below — the coverage line must never state more
    // than the landed text really covers. An empty set (the notes-only
    // landing, firstKeptId '') renders no line.
    const cacheCovered = (): Set<string> | undefined => {
      if (!cache) return undefined
      if (cache.covered) return cache.covered
      const j = dropped.findIndex((m) => m.id === cache.firstKeptId)
      return new Set(dropped.slice(0, j + 1).map((m) => m.id))
    }

    // Refill breaker active: reuse whatever summary state exists WITHOUT
    // absorbing the uncovered slice (the ledger must not claim what no LLM
    // saw — same discipline as a failed extension) and without firing a call.
    // No cache yet → plain truncation until the rhythm normalizes; the first
    // post-lift pass builds the full summary in one call. The model's own
    // context_compact bypasses this (D6): the call is an explicit paid
    // decision, and the once-per-turn cap already bounds its churn.
    if (this.deps.isSummarySuspended?.() && !opts?.bypassBreaker) {
      return withCompensation(cache ? cache.text : null, cacheCovered())
    }

    // No cache → summarize the full dropped region. A failed/empty summarizer
    // no longer voids the whole landing when the model handed over notes (D5):
    // the notes-only text lands with an EMPTY coverage claim (nothing may be
    // stamped covered — no LLM saw the region), and `firstKeptId: ''` keeps
    // the frontier unpinned (the falsy guard in seedHistorySummary drops the
    // cache at persistence, so a rehydrate re-summarizes honestly).
    if (!cache) {
      const built = buildDroppedRegionText(dropped)
      if (!built.text.trim() && !notesSection) return withCompensation(null)
      const summary = built.text.trim() ? await this.deps.runHistorySummary(built.text, instruction, 'region') : null
      const text = await this.composeWithNotes(summary, notesSection, instruction)
      if (!text) {
        console.warn('[AgentEngine] history summary empty, using plain truncation')
        return withCompensation(null)
      }
      if (notesSection) this.lastNotesLanded = true
      const covered = new Set(summary ? built.coveredIds : [])
      this.historySummary = {
        firstKeptId: summary ? frontierId : '',
        text,
        // Only what the summarizer really saw is covered — the 40K-capped
        // tail stays uncovered so the next pass absorbs it (review_20260929 中3).
        covered,
      }
      console.log(`[AgentEngine] injected history summary (${text.length} chars) for ${dropped.length} dropped messages`)
      return withCompensation(text, covered)
    }

    // Unified cache rule: uncovered = currently-dropped − already-covered.
    // Positions cannot tell them apart — protection releases (the last text
    // user message ceding to a newer turn, the hot zone sliding) drop messages
    // BEHIND the frontier, and those must be absorbed like any other new drop.
    const covered = cache.covered ?? cacheCovered() ?? new Set<string>()
    const uncovered = dropped.filter((m) => !covered.has(m.id))
    if (uncovered.length === 0) {
      // Everything currently dropped is already covered — the cached text rides
      // as-is. The one exception: a tool call's notes still land (D5 — the model
      // paid for this pass), joined onto the cached text without moving the
      // frontier or the coverage ledger.
      if (!notesSection) return withCompensation(cache.text, covered)
      const text = await this.composeWithNotes(cache.text, notesSection, instruction)
      if (!text) return withCompensation(cache.text, covered)
      this.lastNotesLanded = true
      this.historySummary = { ...cache, text }
      return withCompensation(text, covered)
    }

    // Below the accrual line the cached text is reused WITHOUT absorbing, so
    // the uncovered slice keeps accruing and one LLM call covers it all: a
    // fit-based lightCompact drops new content on essentially every request of
    // a long tool loop, and a summary call per request is exactly the cost this
    // cache exists to avoid. The uncovered hole is bounded by the line (the
    // replays carry the recent user intent across it). A tool call's notes
    // land regardless — they are not coverage, only the merged text is.
    const built = buildDroppedRegionText(uncovered)
    const wantsExtension = built.text.length >= SUMMARY_EXTEND_MIN_CHARS
    if (!wantsExtension && !notesSection) return withCompensation(cache.text, covered)
    const extra = wantsExtension ? await this.deps.runHistorySummary(built.text, instruction, 'region') : null
    if (!extra && !notesSection) return withCompensation(cache.text, covered)
    const parts = [cache.text]
    if (extra) parts.push(extra)
    if (notesSection) parts.push(notesSection)
    const text = await this.cappedSummaryText(parts.join('\n\n'), instruction)
    if (!text) {
      // Roll failed: the OLD text and OLD coverage stay landed — the new slice
      // is not stamped covered (the ledger may only claim what the text really
      // carries), so it retries on a later pass, exactly like a failed extension.
      return withCompensation(cache.text, covered)
    }
    if (notesSection) this.lastNotesLanded = true
    const landed = new Set([...covered, ...(extra ? built.coveredIds : [])])
    this.historySummary = {
      // The frontier only advances when an extension REALLY ran: a notes-only
      // landing must not pin the frontier onto slices no summary text covers.
      firstKeptId: extra ? frontierId : cache.firstKeptId,
      text,
      // Same rule as the first pass: only the built prefix enters the ledger,
      // so a slice capped away by SUMMARY_INPUT_CAP is retried next pass
      // instead of being stamped covered and lost forever. On the roll path
      // the roll saw the whole merged text, so absorbing everything is honest.
      covered: landed,
    }
    console.log(`[AgentEngine] extended history summary (${text.length} chars) for ${uncovered.length} newly-dropped messages`)
    return withCompensation(text, landed)
  }

  estimateTokens(messages?: AgentMessage[]): number {
    // CJK-aware shared estimator (engine/context-estimate.ts). The old flat
    // chars/3.5 undercounted Chinese text ~3x, which delayed every compaction
    // trigger past the point where the provider rejects the request.
    return estimateMessagesTokens(messages ?? this.deps.getMessages())
  }

  nanoCompact(messages: AgentMessage[]): AgentMessage[] {
    const TIER_MAP = NANO_TIER_MAP
    const TIER_SIZES = NANO_TIER_SIZES
    const TIER3_NAMES = NANO_TIER3_NAMES
    const PROTECTION_WINDOW = NANO_PROTECTION_WINDOW

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

    if (Object.keys(compressTargets).length === 0 && this.mandatedCompressIds.size === 0) return messages

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
        // Check order IS the semantics (D3b): a mandated id compresses
        // regardless of the tier quotas and never enters the marks set (the
        // marks' "compressed once → skip → the block re-inflates" bounce is
        // the opposite of what the model asked for); a marked id skips so the
        // one-shot nano compression can re-inflate; the quota walk applies to
        // everything else.
        const mandated = this.mandatedCompressIds.has(block.tool_use_id)
        if (!mandated && this._compressedToolUseIds.has(block.tool_use_id)) return block
        const tr = block as ToolResultBlock
        if (TOOL_RESULT_PLACEHOLDER_PREFIXES.some((p) => tr.content.startsWith(p))) return block
        if (!mandated) {
          const tier = TIER_MAP[name] ?? 2
          const target = compressTargets[tier]
          if (!target || target <= 0) return block
          if ((compressed[tier] || 0) >= target) return block
          compressed[tier] = (compressed[tier] || 0) + 1
        }
        if (!tr.tool_result_id) tr.tool_result_id = crypto.randomUUID()
        modified = true
        if (!mandated) this._compressedToolUseIds.add(tr.tool_use_id)
        return { ...tr, content: `⟨archived: ${tr.tool_result_id}⟩` }
      })
      return modified ? { ...msg, contentBlocks: newBlocks } : msg
    })
  }

  /** Message ids whose stale thinking the REQUEST path has already stripped.
   *  Reporting state only — the strip itself is a pure function of
   *  (messages, anchor) and never consults this set. It exists so the
   *  compaction event names 'thinking' only on the request that strips
   *  something NEW (a turn just closed), not on every request: the strip
   *  rebuilds the same objects each build, so reference identity (nano's
   *  footprint) would read as a fresh compaction every time. The prewarm
   *  simulation passes record=false — it must not consume the request path's
   *  "new" signal. */
  private strippedThinkingIds = new Set<string>()
  /** Messages the last recording stripStaleThinking pass stripped for the
   *  first time. */
  lastThinkingStripNew = 0

  /** Conversation reset — a new history has no stripped ids to remember. */
  clearStrippedThinkingIds(): void {
    this.strippedThinkingIds.clear()
    this.lastThinkingStripNew = 0
  }

  /** Strip thinking off assistant messages behind the turn anchor (see
   *  THINKING_STRIP_USED_RATIO). Runs beside nano at BOTH pipeline sites —
   *  prepareLoopRequest and prewarmBody — so the prewarm simulation prices the
   *  copy the next request will actually build. Deliberately NOT nano's
   *  one-shot compress → skip → re-inflate shape: the same block is stripped on
   *  every build, because a bouncing block would flip the cache prefix every
   *  request. Two bookkeeping corrections ride along, both in heuristic units:
   *  `outputTokens` is cleared on a stripped message (that report priced the
   *  thinking now gone — estimateMessagesTokens would otherwise keep billing
   *  the message at the report alone, the 模块11 underprice rule inverted),
   *  and the report anchor's `inputTokens` loses the weight of every block
   *  stripped BEFORE it (its prompt held them; left alone the anchor over-reads
   *  by exactly that weight on the turn's first request, and an over-read fires
   *  light into dropping cycles the next summary pass may absorb for good). The
   *  CJK-heavy heuristic over-prices DeepSeek's thinking by ~30%, so the
   *  corrected anchor UNDER-reads for that one request until the next real
   *  report — the safer error, and the max-guard's full heuristic backstops it.
   *  Untouched messages keep their identity. */
  stripStaleThinking(messages: AgentMessage[], contextLength: number, fixedOverhead = 0, record = true): AgentMessage[] {
    if (record) this.lastThinkingStripNew = 0
    if (!contextLength) return messages
    if (this.contextTokens(messages, fixedOverhead) < contextLength * THINKING_STRIP_USED_RATIO) return messages
    const anchor = lastTextUserMessageIndex(messages)
    if (anchor < 0) return messages

    let reportIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].inputTokens) { reportIdx = i; break }
    }

    let strippedBeforeReport = 0
    let changed = false
    let fresh = 0
    const out = messages.map((m, i) => {
      if (i >= anchor || m.role !== 'assistant' || !m.contentBlocks.some(isThinkingBlock)) return m
      changed = true
      if (record && !this.strippedThinkingIds.has(m.id)) {
        this.strippedThinkingIds.add(m.id)
        fresh++
      }
      if (i < reportIdx) {
        for (const b of m.contentBlocks) {
          if (isThinkingBlock(b)) strippedBeforeReport += estimateTextTokens(thinkingTextOf(b))
        }
      }
      return { ...m, contentBlocks: m.contentBlocks.filter((b) => !isThinkingBlock(b)), outputTokens: undefined }
    })
    if (!changed) return messages
    if (record) this.lastThinkingStripNew = fresh
    if (reportIdx >= 0 && strippedBeforeReport > 0) {
      const r = out[reportIdx]
      out[reportIdx] = { ...r, inputTokens: Math.max(1, (r.inputTokens ?? 0) - strippedBeforeReport) }
    }
    return out
  }

  /** Heuristic token contribution of ONE message — the same rule
   *  estimateMessagesTokens applies, scoped to a single message so the drop
   *  walk can subtract a cycle's weight without re-walking the whole list. */
  private contributionOf(msg: AgentMessage): number {
    return estimateMessagesTokens([msg])
  }

  /** Text-only contribution of ONE message — what a stripped user message
   *  (tool_results removed, text kept) still weighs after the strip. Deliberately
   *  NOT estimateMessagesTokens: that returns a real outputTokens report whole,
   *  which would zero the strip's delta. */
  private textContributionOf(msg: AgentMessage): number {
    let total = 0
    for (const b of msg.contentBlocks) {
      if (b.type === 'text') total += estimateTextTokens(b.text)
    }
    return total
  }

  lightCompact(messages: AgentMessage[], contextLength: number, fixedOverhead = 0, force = false): AgentMessage[] {
    if (!contextLength) return messages

    const estimatedTokens = this.contextTokens(messages, fixedOverhead)
    // Trigger on remaining window, not usage ratio: floor the headroom at 30K so
    // light compaction still fires early on small model windows.
    const remainingWindow = contextLength - estimatedTokens
    if (!force && remainingWindow >= Math.max(contextLength * 0.3, LIGHT_COMPACT_MIN_REMAINING)) return messages

    // Fit target, same units as the walk below (heuristic + fixed overhead):
    // once triggered, drop only the OLDEST cycles needed to bring the kept copy
    // back under the line that fired — passive target is exactly the trigger
    // line, forced (/compact) aligns with hardTruncate's 0.6× window. The old
    // shape had no target at all: one trigger wiped EVERY droppable cycle down
    // to the 8K hot zone, and because the live transcript stays over the line
    // forever (the copy is re-derived per request), a long tool session ran
    // with the model seeing ~11-18% of its window (conv_20260927170026, 618 of
    // 806 messages dropped per request).
    //
    // Floored at half the window: on a small model the trigger's 30K headroom
    // subtracts PAST zero (26K window → −4K), fits() went always-false and the
    // walk degenerated back into the wipe-to-hot-zone this target exists to
    // prevent (review_20260929 中2) — and the log printed a negative target.
    // Half the window is the smallest number that still means "fit".
    const targetTokens = Math.max(
      force ? contextLength * 0.6 : contextLength - Math.max(contextLength * 0.3, LIGHT_COMPACT_MIN_REMAINING),
      contextLength * 0.5,
    )

    const contributions = messages.map((m) => this.contributionOf(m))
    const totalH = contributions.reduce((a, b) => a + b, 0)
    // hardTruncate/emergencyTruncate's own rule: the char heuristic never sees
    // the fixed overhead, and when a real report anchors `estimatedTokens` the
    // gap also carries every token the heuristic mis-priced — a gateway whose
    // completion_tokens excludes reasoning underprices each assistant message
    // (模块11 replay: 126 reported vs ~1.5K of thinking+tool_use per message,
    // ~26K accumulated over 50 rounds). Deriving the overhead from that gap is
    // what makes fits() speak the units the trigger above fired in. Without it
    // the walk believed the copy already fit (112K heuristic + assumed overhead
    // ≤ 140K) and dropped nothing for several requests while the real wire
    // climbed 140K → 161K with zero compaction events. Unanchored, the gap is
    // exactly fixedOverhead, so honest-reporting sessions are byte-identical.
    const overhead = Math.max(0, estimatedTokens - totalH)
    let droppedH = 0
    const fits = (): boolean => totalH - droppedH + overhead <= targetTokens

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
      if (fits()) break // the kept copy is back under the line — keep the rest

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
          else if (b.type === 'thinking') remainingChars += (b as { thinking: string }).thinking.length
        }
      }
      if (remainingChars < 8000 * 3.5) continue

      const userHasText = next.contentBlocks.some(b => b.type === 'text')

      if (!userHasText) {
        toDelete.add(i)
        toDelete.add(i + 1)
        droppedH += contributions[i] + contributions[i + 1]
        roundsDeleted++
      } else {
        toDelete.add(i)
        toStrip.set(i + 1, next.contentBlocks.filter(b => b.type === 'text'))
        droppedH += contributions[i] + contributions[i + 1] - this.textContributionOf(next)
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

    console.log(
      `[AgentEngine] lightCompact: dropped ${roundsDeleted} tool cycles ` +
      `(context ~${Math.round(estimatedTokens)} → ~${Math.round(totalH - droppedH + overhead)}, target ${Math.round(targetTokens)} of ${contextLength})`
    )
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
    source: 'post-turn' | 'manual' | 'tool'
    instruction?: string
    /** The model's handover note (context_compact), composed verbatim onto the
     *  summary text and into the cache — see injectHistorySummaryInto. */
    notes?: string
    /** hardTruncate's force bit INSIDE the simulation. manual/post-turn keep
     *  the historical always-true (the cache only exists when hard drops, and
     *  the re-key branch absorbs the drift); the tool source passes false so
     *  the simulation matches what the next request will actually build
     *  (PLAN-context-compact-tool D3: the tool force bypasses ONLY light). */
    hardForce?: boolean
  }): Promise<CompactionEvent | null> {
    const { contextLength, source, instruction, notes, hardForce = true } = options
    if (!contextLength || this.prewarmInFlight) return null
    const original = this.deps.getMessages()
    if (original.length <= MIN_KEEP) return null
    this.prewarmInFlight = true
    const run = this.prewarmBody(original, contextLength, source, instruction, notes, hardForce).finally(() => {
      this.prewarmInFlight = false
      this.prewarmPromise = null
    })
    this.prewarmPromise = run
    return run
  }

  /** The in-flight prewarm's promise, if any. The request path reads it (via
   *  injectHistorySummary) to wait out a running summary instead of racing a
   *  second concurrent LLM call — review0924 M2. */
  private prewarmPromise: Promise<CompactionEvent | null> | null = null

  private async prewarmBody(
    original: AgentMessage[],
    contextLength: number,
    source: 'post-turn' | 'manual' | 'tool',
    instruction?: string,
    notes?: string,
    hardForce = true
  ): Promise<CompactionEvent | null> {
    const savedMarks = new Set(this._compressedToolUseIds)
    // Marks snapshot at the suspension point (assigned just before the await):
    // everything added from there on belongs to a request that interleaved
    // during the await — JS is single threaded, so the sync pipeline before it
    // cannot be interrupted — and the finally below must keep those while
    // still discarding this prewarm's own marks.
    let marksAtSuspend = savedMarks
    try {
      const tokensBefore = contextTokensOf(original)
      const nano = this.nanoCompact(original)
      // The simulation must run the SAME force bits the next real request will:
      // manual sticks (manualCompactActive on both layers), tool's one-shot
      // force bypasses ONLY light (hard stays passive, its 0.9× trigger
      // untouched), post-turn runs fully passive on light. A mismatched
      // simulation would promise a drop the request never materializes (or
      // cover ids the real copy keeps). Same units too: the fit walks are
      // overhead-sensitive, so the simulation prices the last real request's
      // fixed overhead, not 0.
      const overhead = this.lastRequestOverhead
      // record=false: the simulation must not consume the request path's
      // "newly stripped" signal (see strippedThinkingIds).
      const stripped = this.stripStaleThinking(nano, contextLength, overhead, false)
      const light = this.lightCompact(stripped, contextLength, overhead, source === 'manual' || source === 'tool')
      const truncated = this.hardTruncate(light, contextLength, overhead, hardForce)
      // Light's cycle drops count too — they are the main dropper once the
      // transcript outgrows the window, and the summary exists to cover
      // everything the copy loses, not just hard's share.
      const droppedCount = stripped.length - truncated.length
      if (droppedCount <= 0) return null
      const summaryBefore = this.historySummary ? { ...this.historySummary } : null
      marksAtSuspend = new Set(this._compressedToolUseIds)
      const final = await this.injectHistorySummaryInto(original, truncated, instruction, notes, { bypassBreaker: source === 'tool' })
      const summary = this.historySummary
      const summaryChanged =
        !summary || !summaryBefore ||
        summary.firstKeptId !== summaryBefore.firstKeptId ||
        summary.text !== summaryBefore.text
      const strategies: string[] = []
      if (nano.some((m, i) => m !== original[i])) strategies.push('nano')
      if (stripped.some((m, i) => m !== nano[i])) strategies.push('thinking')
      if (light.length !== stripped.length) strategies.push('light')
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
        // Pick the wire fields explicitly — the cache carries the internal
        // covered-id Set, which must not ride the IPC event.
        summary: summaryChanged ? (summary ? { firstKeptId: summary.firstKeptId, text: summary.text } : null) : undefined,
      }
    } finally {
      // Merge, not whole-restore: this prewarm's own nano marks are still
      // discarded (the prewarmed copy is thrown away — keeping them would make
      // the real request's nano pass skip those blocks and re-inflate), but
      // marks a request wrote while we were suspended must survive — a whole
      // restore erased them and only placeholder re-derivation + the double
      // tool_result_id got the copy back (review0924 M2).
      const current = this._compressedToolUseIds
      const merged = new Set(savedMarks)
      for (const id of current) if (!marksAtSuspend.has(id)) merged.add(id)
      this._compressedToolUseIds = merged
    }
  }

}
