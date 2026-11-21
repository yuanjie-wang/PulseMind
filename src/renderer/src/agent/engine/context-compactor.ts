/**
 * Context compaction pipeline (PLAN-0.3.5 refactor): extracted from AgentEngine
 * so the state machine stays under the class-size budget. Owns the history
 * summary cache and the three-layer compaction (nano → light → hard truncate).
 * Operates on API-copy message arrays only — never touches the engine's live
 * messages (deps.getMessages supplies the live list for token estimation).
 */
import type { AgentMessage, ContentBlock, ToolResultBlock, TextBlock, ToolUseBlock } from '../../types/agent'
import type { CompactionEvent } from '../../../../shared/agent-protocol/payloads'
import { contextTokensOf, copyTokensOf, estimateMessagesTokens, estimateTextTokens } from './context-estimate'
import { regroupToolResults } from '../../llm/regroup-tool-results'
import { elideTodoWritePairs } from '../../llm/elide-todo-pairs'
import { stripToolResultImages } from '../strip-tool-results'

// ── Epoch: ONE decision point + a frozen base (PLAN-compaction-epoch) ───
// The four old gates (nano fit / thinking strip / light / hard) each decided
// on their OWN ratio line, so any request crossing ANY of them rewrote a slice
// of the head — and a rewritten head invalidates every cached byte behind it.
// The session-level hit rate is governed by exactly two numbers: how often the
// head moves, and how much survives each move. The copy is therefore FROZEN
// between cuts (`epochBase`, materialized bytes), one predicate (`price > T`)
// decides whether to cut at all, and a cut goes deep in one shot (lands at
// `T − Δ`). No request below the line touches a single byte.
//
//   g = p75 of the recent per-request copy growth (samples capped at 8)
//   T = b − max(1.5·g, 0.08·b)          // cut when the copy crosses this
//   Δ = clamp(1.5·g, 0.15·b, 0.30·b)    // depth: land at T − Δ
//   cold start (<4 samples): g = 0.10·b ⇒ T = 0.85b, land at 0.70b
//
// b is `effectiveInputWindow(contextLength, maxTokens)` — the output reserve
// is never spendable. `contextTokensOf` survives only as a backstop reader
// (provider-400 recast, emergencyTruncate, the final hard insurance).
const EPOCH_SAMPLE_CAP = 8
const EPOCH_MIN_SAMPLES = 4
const EPOCH_COLD_GROWTH_RATIO = 0.10
/** Safety pad: never wait until the window is nearly full to act. */
const EPOCH_TRIGGER_PAD_RATIO = 0.08
/** `1.5·g` reads "one cut must still buy a turn and a half". */
const EPOCH_GROWTH_MULTIPLE = 1.5
/** Cut depth floor/ceiling as a share of the budget. */
const EPOCH_DEPTH_MIN_RATIO = 0.15
const EPOCH_DEPTH_MAX_RATIO = 0.30
/** `/compact` materializes immediately and goes deeper than a passive cut
 *  (`T − Δ` sits near 0.70b on a cold start): the user asked for a cut, so
 *  land where the retired forced-light pass landed — 60% of the budget. */
export const EPOCH_MANUAL_TARGET_RATIO = 0.60

export interface EpochLines {
  /** p75 growth the lines were derived from (tokens). */
  growth: number
  /** `price > trigger` ⇒ cut. */
  trigger: number
  /** Required depth: a cut lands at or below `target`. */
  depth: number
  /** `trigger − depth`, floored at 0. */
  target: number
}

/** What one directed cut did — the request path turns this into the epoch log
 *  line and the compaction event. */
export interface DirectCutResult {
  /** The new copy (when `cut` is false: the priced copy, unchanged). */
  messages: AgentMessage[]
  /** Steps that actually fired, plus `epoch` when a new base materialized. */
  strategies: string[]
  cut: boolean
  priceBefore: number
  priceAfter: number
  targetTokens: number
  droppedMessages: number
}

/** Nearest-rank percentile over a small sample set (the caller sorts). */
function upperQuantile(samples: readonly number[], q: number): number {
  const sorted = [...samples].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))
  return sorted[idx]
}

/**
 * The two lines, from the budget and the observed growth. Pure: the request
 * log prints its inputs so a T/Δ that "feels wrong" is traceable to samples.
 *
 * Cold start is deliberately WIDE (`0.85b` trigger / `0.70b` floor): with no
 * growth history the safe assumption is "nothing much will grow", so the first
 * cut happens late enough to be rare and deep enough to last.
 */
export function epochLines(budget: number, samples: readonly number[]): EpochLines {
  const b = Math.max(0, budget)
  const enough = samples.length >= EPOCH_MIN_SAMPLES
  const growth = enough ? upperQuantile(samples, 0.75) : b * EPOCH_COLD_GROWTH_RATIO
  const headroom = Math.max(EPOCH_GROWTH_MULTIPLE * growth, b * EPOCH_TRIGGER_PAD_RATIO)
  const trigger = Math.max(0, b - headroom)
  const depth = Math.min(b * EPOCH_DEPTH_MAX_RATIO, Math.max(b * EPOCH_DEPTH_MIN_RATIO, EPOCH_GROWTH_MULTIPLE * growth))
  return { growth, trigger, depth, target: Math.max(0, trigger - depth) }
}
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
// frontier is worth an LLM call. A cut drops a whole region at once, but the
// protected tail (the last text turn and the 8K hot zone) can hand the SAME
// slice back on consecutive cuts, and a cut landing on top of a cached summary
// often uncovers only a few messages — below the line the cached text rides and
// the slice keeps accruing. This is the "not worth rewriting the prefix" bar
// (D6), not a rate limiter: at most one summary lands per epoch by construction.
const SUMMARY_EXTEND_MIN_CHARS = 12_000
// Hard cap on the accrued-dropped carrier (see `droppedSinceSummary`). The
// region BUILDER caps at SUMMARY_INPUT_CAP chars anyway, so this only bounds
// memory; in practice absorption fires long before it (~12K chars of region
// text ≈ 30 tool cycles), and a list that reaches the cap means the dropped
// messages carry almost no summarizable text (thinking-only turns are elided
// by the wedge before they can ever be dropped).
const SUMMARY_ACCRUED_MESSAGES_CAP = 200
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
// Post-turn prewarm used to open at a fixed 0.75 share of the window; it is
// now PREDICTIVE — it materializes the next base as soon as the copy crosses
// `T − Δ` (see epochLines), because a base minted "before it is needed" costs
// an idle LLM call where one minted at request time blocks the turn.
// Stale-thinking strip used to be latched behind a 0.5 usage line (a
// non-latched gate oscillated: strip shrank the wire below the line, thinking
// re-entered, reopen). Inside a cut it is unconditional — there is no gate
// left to oscillate, and the strip's cost is paid by a head move that was
// happening anyway.

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
// mirrors nanoCompact's DECISION deterministically (protection window + quota
// caps + the merged fit gate + placeholder pricing) without the live engine's
// mandates, which only it knows — the two share planNanoArchival, so neither
// can drift. Tail-only callers pass a
// slice: quotas/protection are computed over exactly that slice, and the gate
// needs the caller's anchor (baselineTokens) because it compares the whole
// copy's usage to the window. The approximation errs toward OVER-reading the
// shipped copy, never under it.
/** TOKEN-unit placeholder price — the number is NOT a char count. The printed
 *  placeholder ('⟨archived: <uuid>⟩' + the two multibyte glyphs, ~45 chars)
 *  is really ~13-20 tokens by estimateTextTokens; 45 keeps the OVER-reading
 *  direction this section declares (each compressed result prices a little
 *  high, never low). "Correcting" it to the char-true token count would make
 *  the ring reading silently sag — re-derive the direction note above in the
 *  same change or leave it alone. (review_20261025 低3) */
export const NANO_PLACEHOLDER_COST = 45
/** nano tier quotas, shared by nanoCompact and the ring-side projection
 *  (estimateAfterNanoTokens) — ONE constant: a drifted copy in the projection
 *  would silently misprice every ring reading. */
const NANO_TIER_SIZES: Record<number, number> = { 1: 10, 2: 20 }

// ── Nano's role inside a cut ───────────────────────────────────────────
// nano used to run on its own fit gate (open at 0.60·window, archive down to
// 0.50·window, defer under a 4K reclaim floor) with a ledger (`gateArchivedIds`)
// carrying placeholders across requests so an honest gate could not bounce.
// All of that is gone: nano is now step 2 of a cut whose target the epoch
// predicate already chose, and the placeholders live in the FROZEN base —
// there is nothing to bounce back, because the copy is not re-derived from the
// transcript. The tier quota survives unchanged as the CAP on how much one
// pass may take: the newest full batch of a tier stays whole.
/** One tool_result's reclaimable weight: its priced text minus the placeholder
 *  that replaces it, floored at 0 (a result shorter than the placeholder has
 *  nothing to give). */
function nanoReclaimableTokens(content: string): number {
  return Math.max(0, estimateTextTokens(content) - NANO_PLACEHOLDER_COST)
}

/** A block's raw wire price — shared so the projection's "what would ship
 *  unarchived" pass and its planned-prefix pass cannot price one block two
 *  different ways. */
function nanoBlockPrice(block: ContentBlock): number {
  if (block.type === 'tool_result') return estimateTextTokens((block as ToolResultBlock).content || '')
  if (block.type === 'text') return estimateTextTokens((block as TextBlock).text)
  if (block.type === 'tool_use') return estimateTextTokens(JSON.stringify((block as ToolUseBlock).input) + (block as ToolUseBlock).name)
  if (block.type === 'thinking') return estimateTextTokens((block as { thinking: string }).thinking)
  return 0
}

interface NanoArchivalPlan {
  /** tool_use ids whose tool_result becomes a placeholder this pass. */
  ids: Set<string>
  /** Heuristic tokens the pass takes off the copy. */
  reclaimedTokens: number
}

/** What the last nano pass decided. The cut log prints one line from this so
 *  "how deep did the cut go" is measurable without a post-hoc DB query. */
export interface NanoArchiveStats {
  /** Heuristic copy usage the directed walk priced. 0 when nothing was
   *  priced (no window / no cut). */
  used: number
  /** Results this pass took. */
  archived: number
  reclaimed: number
  /** Where the pass was aiming (heuristic units); 0 when it had no target. */
  target: number
}

/**
 * THE archival decision, for both consumers: nanoCompact (live, with the
 * model's mandates) and estimateAfterNanoTokens (ring projection, without them
 * — it may over-read, never under). ONE implementation; a drifted copy in the
 * projection would silently misprice every ring reading.
 *
 * Two modes, picked by `targetTokens`:
 *  - ABSENT → the pre-merge quota walk (byte-for-byte the old behavior):
 *    callers with no target keep taking whole tier batches. Kept because the
 *    walk is also the only rule that means anything without a budget.
 *  - PRESENT → directed: take oldest-first until `usedTokens − reclaimed`
 *    reaches the target, stopping at the tier caps. No ratio gate and no
 *    min-reclaim floor — the caller only calls this when it has decided to
 *    cut, and the cut's own target is the floor.
 *
 * The walk stays OLDEST-FIRST in both modes, so the cut lands as deep as the
 * archival frontier allows and the newest batch stays readable (the cap).
 */
function planNanoArchival(
  messages: AgentMessage[],
  opts: {
    /** Explicit model picks: count toward the bite regardless of caps. */
    mandatedIds?: ReadonlySet<string>
    /** Directed mode: current copy usage in heuristic units. */
    usedTokens?: number
    /** Directed mode: the usage to reach. */
    targetTokens?: number
  } = {},
): NanoArchivalPlan {
  const plan: NanoArchivalPlan = { ids: new Set<string>(), reclaimedTokens: 0 }
  const take = (id: string, saving: number): void => {
    plan.ids.add(id)
    plan.reclaimedTokens += saving
  }

  // Protect the newest N user messages carrying tool_results — the live tail
  // the model is still reasoning over.
  const protectedMsgIds = new Set<string>()
  {
    let found = 0
    for (let i = messages.length - 1; i >= 0 && found < NANO_PROTECTION_WINDOW; i--) {
      const msg = messages[i]
      if (msg.role !== 'user') continue
      if (msg.contentBlocks.some(b => b.type === 'tool_result')) { protectedMsgIds.add(msg.id); found++ }
    }
  }

  // Name table + per-tier counts over every tool_use (tier3 excluded).
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

  // Mandates first: an explicit model pick bypasses every size guard below —
  // this is exactly what the model asked for.
  const mandated = opts.mandatedIds
  if (mandated?.size) {
    for (const msg of messages) {
      if (msg.role !== 'user') continue
      for (const block of msg.contentBlocks) {
        if (block.type !== 'tool_result') continue
        const id = block.tool_use_id
        if (!mandated.has(id) || plan.ids.has(id)) continue
        const name = toolUseToName.get(id)
        if (!name || NANO_TIER3_NAMES.has(name)) continue
        const content = (block as ToolResultBlock).content || ''
        if (TOOL_RESULT_PLACEHOLDER_PREFIXES.some((p) => content.startsWith(p))) continue
        take(id, nanoReclaimableTokens(content))
      }
    }
  }

  // Eligible candidates in document order (oldest first).
  const candidates: Array<{ id: string; tier: number; saving: number }> = []
  for (const msg of messages) {
    if (msg.role !== 'user' || protectedMsgIds.has(msg.id)) continue
    for (const block of msg.contentBlocks) {
      if (block.type !== 'tool_result') continue
      const id = block.tool_use_id
      if (plan.ids.has(id)) continue
      const name = toolUseToName.get(id)
      if (!name || NANO_TIER3_NAMES.has(name)) continue
      const content = (block as ToolResultBlock).content || ''
      if (TOOL_RESULT_PLACEHOLDER_PREFIXES.some((p) => content.startsWith(p))) continue
      candidates.push({ id, tier: NANO_TIER_MAP[name] ?? 2, saving: nanoReclaimableTokens(content) })
    }
  }

  const target = opts.targetTokens
  if (typeof target !== 'number') {
    // ── Quota walk (no target known) ────────────────────────────────────
    const targets: Record<number, number> = {}
    for (const [tierStr, count] of Object.entries(counts)) {
      const tier = Number(tierStr)
      const size = NANO_TIER_SIZES[tier]
      if (!size) continue
      const fullTiers = Math.floor(count / size)
      if (fullTiers >= 2) targets[tier] = (fullTiers - 1) * size
    }
    const taken: Record<number, number> = {}
    for (const c of candidates) {
      const target = targets[c.tier]
      if (!target || target <= 0) continue
      if ((taken[c.tier] || 0) >= target) continue
      taken[c.tier] = (taken[c.tier] || 0) + 1
      take(c.id, c.saving)
    }
    return plan
  }

  // ── Directed walk ─────────────────────────────────────────────────────
  // Mandates already count toward the bite: their reclaim is part of what the
  // caller asked for, so the walk must not spend that share on extra
  // candidates.
  let budget = Math.max(0, (opts.usedTokens ?? 0) - Math.max(0, target) - plan.reclaimedTokens)
  if (budget <= 0) return plan
  // The quota's "keep the newest batch" promise, in cap form: a pass may take
  // at most count − size results per tier, so the newest full batch of every
  // tracked tier stays whole however far over the target the copy is.
  const capLeft: Record<number, number> = {}
  for (const [tierStr, count] of Object.entries(counts)) {
    const tier = Number(tierStr)
    const size = NANO_TIER_SIZES[tier]
    if (!size) continue
    capLeft[tier] = Math.max(0, count - size)
  }
  for (const c of candidates) {
    if (budget <= 0) break
    if (c.saving <= 0) continue
    if (!((capLeft[c.tier] || 0) > 0)) continue
    capLeft[c.tier] = (capLeft[c.tier] || 0) - 1
    take(c.id, c.saving)
    budget -= c.saving
  }
  return plan
}

/**
 * Price a message list AS THE NEXT REQUEST WILL CARRY IT: planned tool_results
 * become placeholders at `NANO_PLACEHOLDER_COST`, everything else prices raw.
 * This is the ring's projection — it must over-read the shipped copy, never
 * under. With `contextLength` the projection aims at the COLD-START epoch
 * target (`0.70b`): that is the depth a cut would reach today, so the ring
 * never claims less headroom than the pipeline will actually create. Absent
 * window ⇒ the quota walk. `baselineTokens` is the anchor a tail-only caller
 * priced its slice against (the target is whole-copy, the slice is not).
 */
export function estimateAfterNanoTokens(
  messages: AgentMessage[],
  contextLength?: number,
  baselineTokens = 0,
): number {
  let raw = 0
  for (const msg of messages) for (const block of msg.contentBlocks) raw += nanoBlockPrice(block)
  const plan = planNanoArchival(messages, {
    usedTokens: contextLength ? baselineTokens + raw : undefined,
    targetTokens: contextLength ? epochLines(contextLength, []).target : undefined,
  })
  if (plan.ids.size === 0) return raw
  // Planned blocks price at the constant (the deliberate over-read documented
  // above), not their own text — the same arithmetic the pre-merge function
  // did inline. Assistant messages price per-BLOCK throughout:
  // estimateMessagesTokens' outputTokens substitution (a gateway that honestly
  // reports completion_tokens, thinking included, replaces the block estimate)
  // is deliberately NOT mirrored — ring-side only, and the wire-report anchor
  // upstream absorbs most of the residual. (review_20261025 低3)
  let total = 0
  for (const msg of messages) {
    for (const block of msg.contentBlocks) {
      const planned = block.type === 'tool_result' && plan.ids.has(block.tool_use_id)
      total += planned ? NANO_PLACEHOLDER_COST : nanoBlockPrice(block)
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

/** Merge a reminder carried from the PREVIOUS frozen base with the one this
 *  cut re-derives. A new base is built from the old one, so reads archived two
 *  epochs ago are no longer in `dropped` — without the carry arm their pointer
 *  lines would silently disappear the first time a cut lands on top of an
 *  older cut. Fresh entries come first (newest reads), carried ones fill in
 *  behind, dedupe is by file path, and the shared cap still holds. */
export function mergeReminderText(
  carried: string | null,
  fresh: string | null,
  cap = DROPPED_READ_REMINDER_CAP
): string | null {
  if (!carried) return fresh
  if (!fresh) return carried
  const parse = (text: string): { header: string; entries: string[]; overflow: number } => {
    const lines = text.split('\n')
    const entries: string[] = []
    let overflow = 0
    for (const line of lines.slice(1)) {
      const m = /^（另有 (\d+) 个更早的已归档读取未列出）$/.exec(line)
      if (m) {
        overflow += Number(m[1])
        continue
      }
      if (line.startsWith('- ')) entries.push(line)
    }
    return { header: lines[0], entries, overflow }
  }
  const pathOf = (line: string): string => line.slice(2).split('（tool_result_id')[0]
  const f = parse(fresh)
  const c = parse(carried)
  const seen = new Set<string>()
  const entries: string[] = []
  let overflow = f.overflow + c.overflow
  for (const line of [...f.entries, ...c.entries]) {
    const path = pathOf(line)
    if (seen.has(path)) continue
    seen.add(path)
    if (entries.length >= cap) {
      overflow++
      continue
    }
    entries.push(line)
  }
  if (entries.length === 0) return null
  const trailer = overflow > 0 ? [`（另有 ${overflow} 个更早的已归档读取未列出）`] : []
  return [f.header, ...entries, ...trailer].join('\n')
}

/** Reminder text already baked into a frozen base, if any — the carry source
 *  for the next cut (see mergeReminderText). */
export function reminderTextOf(messages: AgentMessage[]): string | null {
  for (const msg of messages) {
    if (!msg.id.startsWith('read_reminder_')) continue
    const text = msg.contentBlocks.find((b) => b.type === 'text')
    if (text && text.type === 'text') return text.text
  }
  return null
}

/** Synthetic messages a cut synthesizes itself. They carry no transcript
 *  identity: their text is re-derived (summary) or carried (reminder), so a
 *  new base must never treat them as droppable source material. */
export function isSyntheticMessage(msg: AgentMessage): boolean {
  return msg.id.startsWith('summary_') || msg.id.startsWith('read_reminder_')
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

  /** The model's own nano picks (context_compact's `free_results`,
   *  PLAN-context-compact-tool D3b). A mandated id compresses EVERY request
   *  regardless of the fit gate and tier caps, so the placeholder the model
   *  asked for is stable. Cleared with the conversation (engine reset).
   *
   *  There is deliberately no "already archived" set beside it (W2 of
   *  PLAN-nano-light-trigger-merge, 2026-11-09): the plan is a pure function
   *  of the copy, so every request re-derives the same placeholders from the
   *  full-text source and the wire copy is byte-stable between frontier
   *  advances. The retired one-shot marks made each archive live exactly one
   *  request — the next build re-shipped the full text and broke the provider
   *  prefix cache again. */
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
  // ── Epoch state (PLAN-compaction-epoch) ──────────────────────────────
  // The frozen base IS the product: its bytes are what ships, request after
  // request, until one predicate (`price > T`) cuts. Everything the retired
  // ledgers bought by re-deriving ("once archived, always archived") is now
  // structural: a placeholder baked into `epochBase` can never be re-inflated
  // because the base is never re-derived from the live transcript.
  private epochBase: AgentMessage[] | null = null
  /** How much of the live transcript `epochBase` covers; the copy is
   *  `epochBase ++ live[epochStart..]` (with the structural wedge reapplied to
   *  the seam so regroup/elide/thinking rules hold across it). */
  private epochStart = 0
  /** The live message id that closed the base at bake time. The id anchor (not
   *  the index) is the integrity check: a list that shifted under us (rewind,
   *  delete) breaks the anchor and forces a rebuild instead of silently
   *  concatenating the wrong tail. */
  private epochAnchorId: string | null = null
  /** Request ordinal of the last cut — observation only (the log line). */
  private epochCutAt = -1
  private epochCounter = 0
  /** Per-request copy growth samples (capped at EPOCH_SAMPLE_CAP). Feeds the
   *  p75 that positions T and sizes Δ. */
  private growthSamples: number[] = []
  /** The last priced copy, so the next request's growth is a subtraction. */
  private lastCopyPrice = 0

  /** Conversation reset — the base was another history's bytes, and the growth
   *  samples described a curve this history never lived. */
  clearEpoch(): void {
    this.epochBase = null
    this.epochStart = 0
    this.epochAnchorId = null
    this.epochCutAt = -1
    this.growthSamples = []
    this.lastCopyPrice = 0
  }

  /** The structural wedge: zero-information-loss normalizations that every
   *  request applies at assembly time (images, thinking-only turns, todo
   *  pairs, tool_result adjacency). Cheap enough to run unconditionally, and
   *  it is what makes the seam between a frozen base and the live tail legal
   *  on the wire. */
  private structuralWedge(messages: AgentMessage[]): AgentMessage[] {
    if (messages.length === 0) return messages
    return regroupToolResults(
      elideTodoWritePairs(dropStaleThinkingOnlyTurns(messages.map(stripToolResultImages))),
    )
  }

  /** The copy this request will ship: the frozen base plus the live tail.
   *  Identity when nothing was appended — the SAME array, so the bytes the
   *  provider sees are literally the bytes it saw last time.
   *
   *  The base's last element is always a real live message (synthetics ride at
   *  the FRONT of the compensation block), so the seam is re-wedged as
   *  `[base.last, ...tail]` and the result spliced back — that keeps regroup's
   *  adjacency rule and the thinking anchor spanning the boundary. Accepted
   *  slack: the base may keep one todo_write pair that the tail's newer pair
   *  supersedes; that is a one-time byte change when a new pair lands, not
   *  per-request churn. */
  assembleCopy(): AgentMessage[] {
    const live = this.deps.getMessages()
    if (this.epochBase !== null) {
      const shifted = live.length < this.epochStart
        || (this.epochStart > 0 && live[this.epochStart - 1]?.id !== this.epochAnchorId)
      if (shifted) this.clearEpoch()
    }
    if (this.epochBase === null) {
      const base = this.structuralWedge(live)
      this.epochBase = base
      this.epochStart = live.length
      this.epochAnchorId = live.length > 0 ? live[live.length - 1].id : null
      return base
    }
    if (live.length === this.epochStart) return this.epochBase
    const head = this.epochBase.slice(0, -1)
    const boundary = this.epochBase[this.epochBase.length - 1]
    const tail = live.slice(this.epochStart)
    const wedged = this.structuralWedge(
      boundary === undefined ? tail : [boundary, ...tail],
    )
    return boundary === undefined ? wedged : [...head, ...wedged]
  }

  /** Price the copy and (optionally) book the growth sample. Growth is a
   *  POSITIVE difference against the last priced copy — a cut resets the
   *  baseline to the new base's price, so the samples measure "what one turn
   *  costs", never "how much the cut freed". */
  private priceCopy(copy: AgentMessage[], overhead: number, record: boolean): number {
    const price = this.copyTokens(copy, overhead)
    if (record) {
      if (this.lastCopyPrice > 0) {
        const growth = price - this.lastCopyPrice
        if (growth > 0) {
          this.growthSamples.push(growth)
          if (this.growthSamples.length > EPOCH_SAMPLE_CAP) this.growthSamples.shift()
        }
      }
      this.lastCopyPrice = price
    }
    return price
  }

  /** THE request-path reader: price the copy and book this request's growth
   *  sample. Called on EVERY request, cut or not — the curve is what positions
   *  T and sizes Δ, so booking only the cut requests would pin the lines at
   *  the cold-start defaults forever. */
  priceRequest(copy: AgentMessage[], overhead: number): number {
    return this.priceCopy(copy, overhead, true)
  }

  /** The two lines for the current budget, from the observed growth. */
  epochLines(budget: number): EpochLines {
    return epochLines(budget, this.growthSamples)
  }
  /** History-summary cache. `firstKeptId` is the persisted COVERAGE FRONTIER
   *  (the newest message the text covers — historical field name, opaque to
   *  every consumer). `covered` is the in-memory id set the text actually
   *  covers: light drops HOLES (whole tool cycles) and protection releases
   *  drop messages BEHIND the frontier later, so a position slice cannot tell
   *  covered from new — only the set can. Not persisted (the frontier id is);
   *  a rehydrate rebuilds it positionally from the frontier. */
  private historySummary: { firstKeptId: string; text: string; covered?: Set<string> } | null = null
  /** Dropped-but-unrepresented transcript, carried ACROSS cuts (D6's 跨切割
   *  累积). Under the epoch a cut derives the next base from the previous one,
   *  so a message an earlier cut dropped is GONE from the copy — `dropped` can
   *  only ever describe this cut's slice. The pre-epoch pipeline got the
   *  accrual for free: lightCompact re-dropped the transcript's older half on
   *  every request, so its `dropped` grew monotonically and the
   *  `SUMMARY_EXTEND_MIN_CHARS` gate eventually opened. Without this carrier
   *  the gate can never open after the first epoch and every later drop is
   *  silently unrepresented (only user-text replays survive).
   *
   *  Read (never written) by injectHistorySummaryInto; committed by directCut
   *  AFTER the cut is judged to have landed — a cut that no-ops ships the
   *  untruncated copy, so nothing was really dropped and nothing may accrue.
   *  Cleared when the cache is reset (seedHistorySummary). */
  private droppedSinceSummary: AgentMessage[] = []
  /** User messages the last injectHistorySummary pass replayed verbatim —
   *  read by the engine to populate the compaction event's counter. */
  lastInjectReplayCount = 0
  /** 1 when the last pass produced a dropped-read reminder message, 0
   *  otherwise — the request path reads it to tag the compaction event's
   *  strategies without re-derving the composition from array lengths. */
  lastReminderCount = 0
  /** The last nanoCompact decision (W3 observability). Written on every pass —
   *  prewarm's simulation included — and read by the engine IMMEDIATELY after
   *  its own synchronous call, so the two can never interleave. */
  lastNanoArchive: NanoArchiveStats | null = null
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

  // ── Copy-price calibration ───────────────────────────────────────────
  // copyTokensOf's heuristic misprices the provider's tokenizer by a few
  // percent, and the slant MOVES with the content mix — CJK-dense AGENTS.md
  // under-priced ~1.7% on one request and ~4.4% on the next
  // (conv_20261120152212: the model was told 112K against a 117,168 wire).
  // Every estimated surface (the gauge, the compaction event's before/after)
  // then disagrees with every measured one (the ring's anchor, the message
  // stats row) by that slop. The provider's own usage report is the ground
  // truth, and it lands after every request — so the LAST report calibrates
  // the next estimate: ratio = wire / raw estimate, clamped, applied by
  // copyTokens(). One request to converge, self-correcting on every content
  // shift; not persisted (the first request of a session estimates uncalibrated
  // and immediately re-learns).

  /** wire / raw-copy-estimate from the most recent measured request. */
  private copyCalibration = 1

  /** Absorb the latest measured wire against the raw copy estimate that was
   *  shipped (engine: lastBuildCopyEstimate). Non-finite / non-positive ratios
   *  are ignored — a request without a usage report must not reset a learned
   *  factor. Clamped: a single outlier request (one huge image the heuristic
   *  prices at 0, say) must not throw the next gauge at 2×. */
  setCopyCalibration(ratio: number): void {
    if (!Number.isFinite(ratio) || ratio <= 0) return
    this.copyCalibration = Math.min(1.6, Math.max(0.6, ratio))
  }

  /** The copy's price IN WIRE UNITS: copyTokensOf scaled by the learned
   *  factor. This is the number every display surface quotes — the gauge
   *  section, the compaction event's before/after — so "what the model is
   *  told", "what the ring projects after a cut" and "what the provider
   *  measures" converge on one value instead of straddling a 2–5% slop. */
  copyTokens(messages: AgentMessage[], fixedOverhead = 0): number {
    return Math.round(copyTokensOf(messages, fixedOverhead) * this.copyCalibration)
  }

  /** Largest keepStart whose kept tail fits `thresholdTokens` under the
   *  estimate plus fixed overhead — i.e. the cut retains as MUCH history as
   *  the threshold allows — bounded by the minimum-retention guards: the kept
   *  tail never holds fewer than the last MIN_USER_TURNS user turns and
   *  MIN_KEEP messages, and when even that floor cannot fit the threshold the
   *  floor still wins (cut to it anyway; whatever remains over the line is the
   *  emergency strip's problem, never a reason to no-op the whole pass).
   *  Shared by hardTruncate (a directed step inside a cut) and
   *  emergencyTruncate (threshold 0.6× the provider's named limit).
   *
   *  `scale` converts the heuristic suffix sum into the threshold's units. A
   *  cut's target is priced in CALIBRATED copy units (copyTokens), while the
   *  contributions are raw char-heuristics; when the heuristic over-reads (the
   *  thinking-heavy shape) a bare comparison drops more than needed. scale=1
   *  reduces to the additive form emergencyTruncate relies on — its overhead
   *  already carries the gap. */
  private fitKeepStart(messages: AgentMessage[], thresholdTokens: number, overhead: number, scale = 1): number {
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
    while (keepStart < guardMax && tail * scale + overhead > thresholdTokens) {
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

  /** Directed step: drop the oldest prefix until the copy fits `targetTokens`
   *  (calibrated copy units). No trigger of its own — the epoch predicate
   *  already decided a cut is happening, and this step only runs when nano +
   *  thinking + light could not reach the target. */
  hardTruncate(messages: AgentMessage[], targetTokens: number, fixedOverhead = 0): AgentMessage[] {
    if (messages.length <= MIN_KEEP) return messages

    const price = this.copyTokens(messages, fixedOverhead)
    if (price <= targetTokens) return messages

    // The walk below estimates the remaining content in char-heuristic units,
    // which never counts the fixed overhead (system prompt + tool schemas).
    // Re-add that overhead so the kept window actually lands under the
    // real-token target instead of over-retaining — and scale the heuristic
    // suffix into the calibrated units the target speaks.
    const heuristicTotal = this.estimateTokens(messages)
    const overhead = Math.max(0, price - heuristicTotal)
    const scale = heuristicTotal > 0 && price < heuristicTotal ? price / heuristicTotal : 1

    const keepStart = this.fitKeepStart(messages, targetTokens, overhead, scale)
    if (keepStart === 0) return messages

    const pairedStart = this.includePairedToolUses(messages, keepStart)
    const truncated = messages.slice(pairedStart)
    const dropped = messages.length - truncated.length
    console.log(
      `[AgentEngine] hardTruncate: dropped ${dropped}/${messages.length} oldest messages ` +
      `(copy ${price} → target ${Math.round(targetTokens)})`
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
    // The accrued drops belonged to the previous cache's ledger: a rehydrated
    // text covers an unknown region (positionally rebuilt), so carrying the
    // old list would double-count regions the new text may already describe.
    this.droppedSinceSummary = []
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

  /** The summary REGION a cut must consider: the carrier's older drops first
   *  (chronological), then this cut's newly-dropped messages. Read-only — the
   *  carrier is committed by directCut once the cut is known to have landed. */
  private accruedRegion(dropped: AgentMessage[]): AgentMessage[] {
    if (this.droppedSinceSummary.length === 0) return dropped
    const seen = new Set(this.droppedSinceSummary.map((m) => m.id))
    const fresh = dropped.filter((m) => !seen.has(m.id))
    return fresh.length > 0 ? [...this.droppedSinceSummary, ...fresh] : this.droppedSinceSummary
  }

  /** Commit a LANDED cut's drops into the carrier: everything the shipped copy
   *  no longer holds, minus what the summary text really covers (the same
   *  ledger discipline as the coverage claim — an id may only leave the
   *  carrier when an LLM actually saw it). Synthetics carry no transcript
   *  identity and never accrue. */
  private commitDroppedAccrual(copy: AgentMessage[], shipped: AgentMessage[]): void {
    const kept = new Set(shipped.map((m) => m.id))
    const covered = this.historySummary?.covered ?? new Set<string>()
    const seen = new Set<string>()
    const next: AgentMessage[] = []
    for (const m of [...this.droppedSinceSummary, ...copy]) {
      if (kept.has(m.id) || covered.has(m.id) || seen.has(m.id) || isSyntheticMessage(m)) continue
      seen.add(m.id)
      next.push(m)
    }
    this.droppedSinceSummary = next.length > SUMMARY_ACCRUED_MESSAGES_CAP
      ? next.slice(-SUMMARY_ACCRUED_MESSAGES_CAP)
      : next
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
    opts?: {
      bypassBreaker?: boolean
      carryReminder?: string | null
      /** The cut's landing promise. When set, the replay arm is sized to the
       *  room the steps actually left (`target − price(truncated)`) instead of
       *  the flat budget, so the block cannot undo the cut's depth. */
      targetTokens?: number
      overhead?: number
    }
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
    // Synthetic messages are not droppable material: a new base is derived from
    // the previous one, so the old summary/reminder ride in `original`. The
    // summary text is re-derived from `this.historySummary` and the reminder is
    // carried explicitly (opts.carryReminder) — letting either fall into
    // `dropped` would summarize a summary and re-count pointer lines as reads.
    const dropped = original.filter((m) => !keptIds.has(m.id) && !isSyntheticMessage(m))
    // Cross-cut accrual (D6): the summary REGION is this cut's drops PLUS the
    // drops earlier cuts could not absorb. `dropped` alone is always just one
    // cut's slice under the epoch (the next base is derived from the previous
    // one), so building the region from it would leave every later drop
    // unrepresented forever — see `droppedSinceSummary`. Replays, the read
    // reminder and the frontier stay on `dropped`: those are per-cut
    // compensation and the base already carries the older ones.
    const region = this.accruedRegion(dropped)
    this.lastInjectReplayCount = 0
    this.lastReminderCount = 0
    if (dropped.length === 0) {
      // Nothing of the transcript left the copy — but a base carries its own
      // compensation block, and those messages are synthetic (excluded from
      // `dropped` above). A cut that cannot move the price (hard off, or the
      // floors hit) still has to ship them: filtering them out here would
      // silently delete the record of every region an earlier cut removed.
      // Re-prepending the SAME objects also keeps the bytes stable.
      const carried = original.filter((m) => isSyntheticMessage(m) && !keptIds.has(m.id))
      return carried.length > 0 ? [...carried, ...truncated] : truncated
    }

    // The coverage frontier is the NEWEST dropped message: the cached text
    // covers everything dropped so far, and the next pass's newly-dropped slice
    // is whatever lands after this id. (light drops HOLES — whole tool cycles —
    // not a clean prefix, so the old frontier = truncated[0].id pinned itself to
    // the first surviving non-cycle message: the cache hit its reuse branch
    // forever and never extended — the marathon's 683-char summary sat
    // un-extended for 29h across ~300 drop passes. Serialized under the
    // historical `firstKeptId` name; every consumer treats it as an opaque id.)
    const frontierId = dropped[dropped.length - 1].id

    // The compensation block (user replays + read reminder) is injected as the
    // copy's PREFIX, so any drift in it shifts every kept message behind it and
    // invalidates the cached tail — a far larger penalty than the block's own
    // size. In the epoch design the block is baked into the frozen base, so the
    // stability question is answered structurally: a base is built once and
    // never re-derived, and the next cut carries the prior pointer lines
    // forward (mergeReminderText) instead of recomputing the whole set.
    //
    // The dropped region's user words ride the copy verbatim (budget-capped) —
    // the summary paraphrases, the intent stays quotable. The budget is the
    // room the cut left when a target is known (directCut aims the steps lower
    // by the same reserve, so the two agree); the legacy callers pass none and
    // keep the flat budget.
    const replayBudget = opts?.targetTokens == null
      ? USER_REPLAY_BUDGET_TOKENS
      : Math.max(0, Math.min(USER_REPLAY_BUDGET_TOKENS, Math.round(opts.targetTokens) - this.copyTokens(truncated, opts.overhead ?? 0)))
    const replays = collectUserReplays(dropped, replayBudget)
    // The dropped region's successful reads ride back as pointer lines — the
    // discovery half of the compensation (the retrieval half is the persisted
    // tool_results table + tool_result_search).
    const reminderText = mergeReminderText(opts?.carryReminder ?? null, buildDroppedReadReminder(dropped, truncated))
    this.lastInjectReplayCount = replays.length
    this.lastReminderCount = reminderText !== null ? 1 : 0
    const withCompensation = (summaryText: string | null, covered?: Set<string>): AgentMessage[] => [
      ...replays,
      ...(summaryText !== null
        ? [makeHistorySummaryMessage(summaryText, covered ? buildSummaryCoverageHeader(region, covered) : null)]
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
      const j = region.findIndex((m) => m.id === cache.firstKeptId)
      return new Set(region.slice(0, j + 1).map((m) => m.id))
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
      const built = buildDroppedRegionText(region)
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
    const uncovered = region.filter((m) => !covered.has(m.id))
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

  /**
   * Step 2 of a cut: archive old tool_results toward `targetTokens`
   * (calibrated copy units). No gate of its own — the epoch predicate already
   * decided the head is moving, so this step takes as much as the directed
   * walk allows and hands the result back. The placeholders live in the FROZEN
   * base, so there is no ledger to carry them across requests: planNanoArchival
   * skips blocks that already carry a placeholder, which makes every id it
   * returns genuinely fresh by construction (`gateArchivedIds` retired with
   * the re-derive-every-request pipeline it existed to stabilize).
   *
   * Units: the planner walks in char heuristics, the target speaks calibrated
   * wire. `scale` converts one into the other, and `overhead` is the fixed
   * part the heuristic never sees — scale 1 with zero overhead reduces to the
   * additive form byte for byte.
   */
  nanoCompact(messages: AgentMessage[], targetTokens: number, fixedOverhead = 0): AgentMessage[] {
    const price = this.copyTokens(messages, fixedOverhead)
    const totalH = this.estimateTokens(messages)
    const overhead = Math.max(0, price - totalH)
    const scale = totalH > 0 && price < totalH ? price / totalH : 1
    // The planner's budget is `usedTokens − targetTokens`, so both sides go
    // into heuristic units; the mandate share is subtracted inside it (a cut
    // must not spend the same budget twice).
    const targetH = Math.max(0, (targetTokens - overhead) / scale)
    const plan = planNanoArchival(messages, {
      mandatedIds: this.mandatedCompressIds,
      usedTokens: totalH,
      targetTokens: targetH,
    })
    // Written on EVERY path (the early return below included): a stale record
    // would report the previous cut's depth as this one's.
    this.lastNanoArchive = {
      used: price,
      archived: plan.ids.size,
      reclaimed: Math.round(plan.reclaimedTokens * scale),
      target: Math.round(targetTokens),
    }
    if (plan.ids.size === 0) return messages

    // The placeholder bytes are stable for the life of the base: the
    // tool_result_id is minted once onto the SOURCE block (the one property
    // this pass still writes through, so the id survives the DB roundtrip and
    // the rehydrated base mints the same glyph), and the placeholder text
    // itself is baked into the frozen epoch — no request below the next cut
    // re-derives it, which is the structural replacement for the retired
    // "re-derive, never remember" ledger dance.
    return messages.map(msg => {
      if (msg.role !== 'user') return msg
      let modified = false
      const newBlocks = msg.contentBlocks.map(block => {
        if (block.type !== 'tool_result') return block
        const tr = block as ToolResultBlock
        if (!plan.ids.has(tr.tool_use_id)) return block
        if (!tr.tool_result_id) tr.tool_result_id = crypto.randomUUID()
        modified = true
        return { ...tr, content: `⟨archived: ${tr.tool_result_id}⟩` }
      })
      return modified ? { ...msg, contentBlocks: newBlocks } : msg
    })
  }

  /** Strip thinking off assistant messages behind the turn anchor. Step 3 of a
   *  cut and deliberately UNCONDITIONAL there: the retired usage gate existed
   *  to decide whether a per-request pass was worth a head move, and it needed
   *  a latch because a non-latched gate oscillated (strip shrank the reading
   *  below the line, thinking re-entered, the gate reopened). A cut moves the
   *  head exactly once by definition, so there is nothing to oscillate and no
   *  gate to hold — the strip just runs.
   *
   *  Two bookkeeping corrections ride along, both in heuristic units:
   *  `outputTokens` is cleared on a stripped message (that report priced the
   *  thinking now gone — estimateMessagesTokens would otherwise keep billing
   *  the message at the report alone, the 模块11 underprice rule inverted),
   *  and the report anchor's `inputTokens` loses the weight of every block
   *  stripped BEFORE it (its prompt held them; left alone the anchor over-reads
   *  by exactly that weight on the turn's first request). The CJK-heavy
   *  heuristic over-prices DeepSeek's thinking by ~30%, so the corrected anchor
   *  UNDER-reads for that one request until the next real report — the safer
   *  error, and the backstop readers absorb it. Untouched messages keep their
   *  identity. */
  stripStaleThinking(messages: AgentMessage[]): AgentMessage[] {
    const anchor = lastTextUserMessageIndex(messages)
    if (anchor < 0) return messages

    let reportIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].inputTokens) { reportIdx = i; break }
    }

    let strippedBeforeReport = 0
    let changed = false
    const out = messages.map((m, i) => {
      if (i >= anchor || m.role !== 'assistant' || !m.contentBlocks.some(isThinkingBlock)) return m
      changed = true
      if (i < reportIdx) {
        for (const b of m.contentBlocks) {
          if (isThinkingBlock(b)) strippedBeforeReport += estimateTextTokens(thinkingTextOf(b))
        }
      }
      return { ...m, contentBlocks: m.contentBlocks.filter((b) => !isThinkingBlock(b)), outputTokens: undefined }
    })
    if (!changed) return messages
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

  /** Step 4 of a cut: drop the OLDEST tool cycles until the copy fits
   *  `targetTokens` (calibrated copy units). No trigger and no reclaim floor of
   *  its own — the epoch predicate already decided a cut is happening and Δ
   *  already decided how deep; a pass that reclaims little simply stops at the
   *  first cycle that lands the copy under the line.
   *
   *  The walk speaks heuristic units (per-message contributions) while the
   *  target speaks wire units, so the same conversion the other steps use
   *  applies: `overhead = price − totalH` and `scale = price/totalH` when the
   *  heuristic over-reads. `scale = 1` reduces to the plain additive form. */
  lightCompact(messages: AgentMessage[], targetTokens: number, fixedOverhead = 0): AgentMessage[] {
    const price = this.copyTokens(messages, fixedOverhead)
    if (price <= targetTokens) return messages

    const contributions = messages.map((m) => this.contributionOf(m))
    const totalH = contributions.reduce((a, b) => a + b, 0)
    const overhead = Math.max(0, price - totalH)
    const scale = totalH > 0 && price < totalH ? price / totalH : 1

    let droppedH = 0
    const fits = (): boolean => (totalH - droppedH) * scale + overhead <= targetTokens

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
      `(copy ${price} → ${Math.round((totalH - droppedH) * scale + overhead)}, target ${Math.round(targetTokens)})`
    )
    return newMessages
  }

  /** Upper bound on what the compensation block's replay arm can spend: the
   *  user-role TEXT in the copy (the only thing collectUserReplays replays),
   *  capped by its budget. An upper bound over-reserves when a cut drops only
   *  part of that text — the safe direction: the copy lands lower, never
   *  higher. */
  private replayReserveTokens(messages: AgentMessage[]): number {
    let total = 0
    for (const msg of messages) {
      if (msg.role !== 'user') continue
      for (const block of msg.contentBlocks) {
        if (block.type === 'text') total += estimateTextTokens(block.text)
      }
    }
    return Math.min(USER_REPLAY_BUDGET_TOKENS, total)
  }

  /** Materialize one directed cut on the current COPY (PLAN-compaction-epoch
   *  D5). The steps run cheapest-first and stop as soon as the copy fits
   *  `targetTokens`:
   *
   *    1. synthetic messages dropped (summary is re-derived, reminder carried)
   *    2. nano archive        — old tool_results toward the target
   *    3. stale reasoning     — unconditional inside a cut
   *    4. light drop          — whole tool cycles, oldest first
   *    5. hard truncate       — oldest prefix (skipped when allowHard is false)
   *    6. one summary + compensation block, baked into the new base
   *
   *  The steps aim at `targetTokens` MINUS the replay reserve (the block is
   *  prepended afterwards — see replayReserveTokens), so the landing price is
   *  the promise D4 asks for plus the summary's own size.
   *
   *  The epoch ALWAYS materializes: a cut that did not become the base would
   *  have to be re-derived next request, which is exactly the churn this design
   *  retires. `record` is a separate concern — it books the growth sample, and
   *  only the request path does that (prewarm passes false: it runs between
   *  requests, so its "growth" would read the cut's own shrink, and the curve
   *  belongs to the request path).
   *
   *  Cutting from the copy (never the transcript) is load-bearing: the new base
   *  is derived from the old one, so a region dropped two epochs ago cannot
   *  ride back in. */
  async directCut(targetTokens: number, opts: {
    /** Book the growth sample (request path). See priceRequest. */
    record?: boolean
    instruction?: string
    notes?: string
    /** context_compact asks for light-depth only (D8's two-power split). */
    allowHard?: boolean
    bypassBreaker?: boolean
    overhead?: number
    /** Priced instead of assembling a fresh copy (prewarm prices its own). */
    copy?: AgentMessage[]
  } = {}): Promise<DirectCutResult> {
    const record = opts.record ?? true
    const overhead = opts.overhead ?? this.lastRequestOverhead
    const copy = opts.copy ?? this.assembleCopy()
    const priceBefore = this.priceCopy(copy, overhead, record)
    const target = Math.max(0, Math.round(targetTokens))
    const strategies: string[] = []
    if (priceBefore <= target) {
      return {
        messages: copy, strategies, cut: false,
        priceBefore, priceAfter: priceBefore, targetTokens: target,
        droppedMessages: 0,
      }
    }

    // The compensation block is prepended AFTER the steps, so its weight has to
    // come out of the steps' aim or the landing promise (D4: price ≤ T − Δ) is
    // fiction: a 10K verbatim replay block on a 15K Δ leaves the next cut one
    // turn away — exactly the small-step churn this design retires. Reserve what
    // the dropped region can actually replay (user TEXT in the copy, capped by
    // the budget); the summary rides ON TOP of the promise instead, because it
    // is the record of what was dropped rather than a discretionary luxury, and
    // it is bounded by HISTORY_SUMMARY_MAX_CHARS.
    const stepTarget = Math.max(0, target - this.replayReserveTokens(copy))

    // Synthetics carry no transcript identity (see isSyntheticMessage): the
    // summary is re-derived from `this.historySummary` and the reminder is
    // carried below, so neither may be summarized or re-counted as a read.
    const carryReminder = reminderTextOf(copy)
    let working = copy.filter((m) => !isSyntheticMessage(m))

    working = this.nanoCompact(working, stepTarget, overhead)
    if ((this.lastNanoArchive?.archived ?? 0) > 0) strategies.push('nano')

    if (this.copyTokens(working, overhead) > stepTarget) {
      const stripped = this.stripStaleThinking(working)
      if (stripped !== working) strategies.push('thinking')
      working = stripped
    }

    if (this.copyTokens(working, overhead) > stepTarget) {
      const light = this.lightCompact(working, stepTarget, overhead)
      if (light !== working) strategies.push('light')
      working = light
    }

    if (this.copyTokens(working, overhead) > stepTarget && opts.allowHard !== false) {
      const hard = this.hardTruncate(working, stepTarget, overhead)
      if (hard !== working) strategies.push('hard')
      working = hard
    }

    // One summary per epoch, covering everything this cut dropped. `copy` is
    // the pre-wedge input so the dropped set is exactly "what the base held and
    // the kept tail does not".
    const summaryBefore = this.historySummary
    const final = await this.injectHistorySummaryInto(copy, working, opts.instruction, opts.notes, {
      bypassBreaker: opts.bypassBreaker,
      carryReminder,
      targetTokens: target,
      overhead,
    })
    // `summary` means the landed TEXT moved in this pass — a cache carried over
    // from an earlier epoch is not a strategy this cut exercised (its presence
    // must not be read as "something happened", see the no-op gate below).
    if (this.historySummary !== summaryBefore) strategies.push('summary')
    if (this.lastReminderCount > 0) strategies.push('reminder')

    // A cut that freed nothing is NOT a cut. Every step can no-op while the
    // price still sits above the target (a text-only copy with hard off, or
    // steps whose floors are all hit), and the compensation block re-prepends
    // the base's own synthetics — bytes and price unchanged. Reporting
    // `cut: true` there would trip the refill breaker on a head that never
    // moved, emit a compaction event that freed nothing, and freeze a base
    // identical to the copy it was derived from.
    if (strategies.length === 0) {
      return {
        messages: copy, strategies, cut: false,
        priceBefore, priceAfter: priceBefore, targetTokens: target,
        droppedMessages: 0,
      }
    }
    strategies.push('epoch')

    // Read the live list AFTER the await: a message appended meanwhile puts
    // `epochStart` past it (it belongs to the tail, not the base), and the id
    // anchor is what catches a list that shifted under us.
    const live = this.deps.getMessages()
    this.epochBase = final
    this.epochStart = live.length
    this.epochAnchorId = live.length > 0 ? live[live.length - 1].id : null
    this.epochCutAt = ++this.epochCounter
    this.growthSamples = []
    const priceAfter = this.copyTokens(final, overhead)
    // Baseline reset rides the cut even when the sample is not booked: the next
    // request's growth must measure "one turn", not "the bytes the cut freed".
    this.lastCopyPrice = priceAfter
    // The drops are real now, so the unrepresented region accrues — the next
    // cut's summary region is this slice plus whatever the cached text does not
    // cover yet (D6). Committed only here: a cut that no-opped ships the
    // untruncated copy and must not accrue anything.
    this.commitDroppedAccrual(copy, final)
    console.log(
      `[AgentEngine] directCut: ${strategies.join('+')} — copy ${priceBefore} → ${priceAfter} ` +
      `(target ${target}, dropped ${copy.length - final.length} messages)`
    )
    return {
      messages: final, strategies, cut: true,
      priceBefore, priceAfter, targetTokens: target,
      droppedMessages: copy.length - final.length,
    }
  }

  /**
   * Predictive base materialization (PLAN-compaction-epoch D8/M3): run the SAME
   * directed cut the next request would run, at idle, so the request path ships
   * an already-frozen copy instead of paying for a summary mid-turn.
   *
   *   · post-turn — target `T − Δ` (the passive cut); fires only when the copy
   *     has already crossed that line, i.e. the next request WOULD cut.
   *   · manual (/compact) — target 0.60b, hard allowed: the user asked for it.
   *   · tool (context_compact) — `T − Δ` like post-turn but hard is OFF: the
   *     model gets light-depth only, and the hard backstop stays the engine's.
   *
   * Growth samples are not booked here (directCut record=false): the curve
   * belongs to the request path. Returns the event for the caller to emit, or
   * null when the copy already fits (nothing to cut).
   */
  async prewarm(options: {
    contextLength: number
    source: 'post-turn' | 'manual' | 'tool'
    instruction?: string
    /** The model's handover note (context_compact), composed verbatim onto the
     *  summary text and into the base — see injectHistorySummaryInto. */
    notes?: string
  }): Promise<CompactionEvent | null> {
    const { contextLength, source, instruction, notes } = options
    if (!contextLength || this.prewarmInFlight) return null
    if (this.deps.getMessages().length <= MIN_KEEP) return null
    this.prewarmInFlight = true
    const run = this.prewarmBody(contextLength, source, instruction, notes).finally(() => {
      this.prewarmInFlight = false
      this.prewarmPromise = null
    })
    this.prewarmPromise = run
    return run
  }

  /** The in-flight prewarm's promise, if any. The request path waits it out
   *  (awaitPrewarm) instead of racing a second concurrent summary call —
   *  review0924 M2, restated for the epoch: the cut a prewarm materializes IS
   *  the base the next build should ship. */
  private prewarmPromise: Promise<CompactionEvent | null> | null = null

  /** Request-path gate: an in-flight prewarm is about to freeze a base, so the
   *  build must assemble AFTER it lands. Without this wait the build prices a
   *  copy that is already obsolete, cuts it a second time and pays two
   *  summarization calls for one head move. Idle is a no-op; a failed prewarm
   *  swallows its own error (the request path cuts on its own). */
  async awaitPrewarm(): Promise<void> {
    if (this.prewarmPromise) await this.prewarmPromise.catch(() => {})
  }

  private async prewarmBody(
    contextLength: number,
    source: 'post-turn' | 'manual' | 'tool',
    instruction?: string,
    notes?: string
  ): Promise<CompactionEvent | null> {
    const lines = this.epochLines(contextLength)
    const target = source === 'manual'
      ? contextLength * EPOCH_MANUAL_TARGET_RATIO
      : lines.target
    // tokensBefore/tokensAfter are the COPY's own units (copyTokens), not the
    // wire anchor: after a cut the anchor prices the PRE-cut request, and the
    // ring's re-base on tokensAfter could never drop below the cut it is
    // announcing (conv_20261120152212).
    const overhead = this.lastRequestOverhead
    const copy = this.assembleCopy()
    const tokensBefore = this.copyTokens(copy, overhead)
    const result = await this.directCut(target, {
      record: false,
      instruction,
      notes,
      allowHard: source !== 'tool',
      bypassBreaker: source === 'tool',
      overhead,
      copy,
    })
    if (!result.cut) return null
    const summary = this.historySummary
    console.log(
      `[AgentEngine] prewarm (${source}): dropped ${result.droppedMessages}, ` +
      `replays ${this.lastInjectReplayCount}, tokens ~${tokensBefore} → ~${Math.round(result.priceAfter)}`
    )
    return {
      ts: Date.now(),
      source,
      strategies: result.strategies,
      droppedMessages: result.droppedMessages,
      replayedUserMessages: this.lastInjectReplayCount,
      tokensBefore,
      tokensAfter: result.priceAfter,
      // Pick the wire fields explicitly — the cache carries the internal
      // covered-id Set, which must not ride the IPC event.
      summary: summary ? { firstKeptId: summary.firstKeptId, text: summary.text } : undefined,
    }
  }

}
