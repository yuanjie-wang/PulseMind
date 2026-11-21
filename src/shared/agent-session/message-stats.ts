// ── Session message-stats diff ──
// A message's stats are written twice. The first write happens when the
// assistant message is appended (that round's own token counts and stream time)
// and rides `messages_append` like the rest of the message. The second happens
// at the END of the turn, when the engine stamps the turn's wall clock
// (user send → last output character, thinking and tool rounds included) onto
// the last message IN PLACE — same message, same array length.
//
// The transport diffs by array length, so the second write had no carrier at
// all, and the chat showed the final answer's own LLM round instead of the
// task's duration (user feedback 2026-09-16). This is that carrier. It is
// diffed rather than sent wholesale for the same reason `tool_status` is:
// `notify()` fires on every streamed chunk, and the renderer re-renders on any
// message identity change.
import type { AgentMessage } from '../../renderer/src/types/agent'
import type { AgentEventData } from '../agent-protocol'
import { computeCacheHitRate, type CacheHitRate, type CacheHitSample } from './cache-hit-rate'

/** One message-level stat patch, as carried by the `message_stats` event. */
export type MessageStatsUpdate = Extract<AgentEventData, { type: 'message_stats' }>['updates'][number]

/** The stats a patch can carry, and their identity for diffing. Absent values
 *  are distinct from zero on purpose: `undefined` means "not reported", and a
 *  turn that genuinely took 0ms must still be able to replace a stale figure. */
export function messageStatsSignature(msg: AgentMessage): string {
  return [msg.processingMs, msg.inputTokens, msg.outputTokens, msg.promptCacheHitTokens]
    .map((v) => (v === undefined || v === null ? '' : String(v)))
    .join('|')
}

/**
 * Collect the messages whose stats changed since the last diff, updating
 * `registry` in place (keyed messageId → signature). Mutating the registry is
 * the contract: the caller owns it per session and passes the same Map back.
 */
export function diffMessageStats(
  registry: Map<string, string>,
  messages: readonly AgentMessage[]
): MessageStatsUpdate[] {
  const updates: MessageStatsUpdate[] = []
  for (const msg of messages) {
    const signature = messageStatsSignature(msg)
    if (registry.get(msg.id) === signature) continue
    registry.set(msg.id, signature)
    // Only ship stats that exist — an all-absent signature is a message whose
    // stats the engine never reported, and a patch of undefined fields would
    // replace nothing while still churning every client.
    if (signature.split('|').every((part) => part === '')) continue
    updates.push({
      messageId: msg.id,
      ...(msg.processingMs !== undefined ? { processingMs: msg.processingMs } : {}),
      ...(msg.inputTokens !== undefined ? { inputTokens: msg.inputTokens } : {}),
      ...(msg.outputTokens !== undefined ? { outputTokens: msg.outputTokens } : {}),
      ...(msg.promptCacheHitTokens !== undefined ? { promptCacheHitTokens: msg.promptCacheHitTokens } : {}),
    })
  }
  return updates
}

/** One message's cache accounting, in the normalized units cache-hit-rate.ts
 *  counts (see the denominator invariant stated there). */
function cacheHitSampleOf(msg: AgentMessage): CacheHitSample {
  return {
    inputTokens: msg.inputTokens,
    cacheReadTokens: msg.promptCacheHitTokens,
    // A synthesized summary message is compaction sidecar traffic — a one-shot
    // prompt with no stable prefix, which could never hit. The live engine
    // path never creates one (the summary call's usage is dropped whole, see
    // runHistorySummary); the flag rides back on REHYDRATED sessions whose old
    // rows carry auto_summary=1, and this filter is what keeps those out.
    sidecar: msg.autoSummary === true,
  }
}

/**
 * The session's token-weighted prompt-cache hit rate over MAIN-turn requests.
 * The counting rules (sidecar exclusion, token weighting, "no report is not a
 * miss") are stated once in cache-hit-rate.ts. A message that reported no usage
 * contributes no sample rather than a zero.
 */
export function sessionCacheHitRate(messages: readonly AgentMessage[]): CacheHitRate {
  return computeCacheHitRate(messages.map(cacheHitSampleOf))
}

// ── Turn-level stats aggregate (2026-11-21 user ruling) ─────────────────
// The per-message toolbar used to read each message's OWN usage — on a
// tool-loop turn that is the last request only (its input is the whole prompt
// of that one call, not what the turn consumed), which is exactly the number
// that made the row lie next to the turn-scoped duration. The ruling replaces
// the duration with the completion timestamp AND makes the tokens a TURN
// aggregate: Σ over every assistant request the turn issued, so ↑/↓ read as
// what the round trip actually moved and the cache rate weights the same way.

/** One turn's aggregate, as the toolbar renders it. `undefined` tokens mean
 *  "no request in the turn reported usage" — distinct from zero, which is a
 *  real report. `completedAt` is the FINAL assistant message's createdAt: the
 *  engine mints it when that request's stream completes, so it is the moment
 *  the turn's last output character landed (the counterpart of the opening
 *  user message's send time). */
export interface TurnMessageStats {
  completedAt?: string
  inputTokens?: number
  outputTokens?: number
  promptCacheHitTokens?: number
}

/**
 * Aggregate stats per turn, keyed by the turn's FINAL assistant message id —
 * the one message both clients hang the toolbar on (the desktop's segment for
 * it carries a `__text`/`__ask` suffix on the id, so callers strip the suffix
 * before looking up; the panel's `actionRowIds` already names the same
 * message). The turn boundary is the same rule everywhere: a plain user
 * message (no tool_result — those are the loop's result carriers) opens a new
 * turn. Sidecar summary rows are skipped, matching sessionCacheHitRate. A turn
 * whose requests reported no usage still gets an entry (the timestamp is a
 * per-message fact, not a usage report); turns with no assistant message get
 * none.
 */
export function collectTurnMessageStats(messages: readonly AgentMessage[]): Map<string, TurnMessageStats> {
  const byFinalId = new Map<string, TurnMessageStats>()
  let inputTokens: number | undefined
  let outputTokens: number | undefined
  let promptCacheHitTokens: number | undefined
  let finalId: string | undefined
  let finalCreatedAt: string | undefined
  let hasAssistant = false

  const flush = (): void => {
    if (hasAssistant && finalId) {
      byFinalId.set(finalId, { completedAt: finalCreatedAt, inputTokens, outputTokens, promptCacheHitTokens })
    }
    inputTokens = undefined
    outputTokens = undefined
    promptCacheHitTokens = undefined
    finalId = undefined
    finalCreatedAt = undefined
    hasAssistant = false
  }

  for (const msg of messages) {
    if (msg.role === 'user' && !(msg.contentBlocks ?? []).some((b) => b.type === 'tool_result')) {
      flush()
      continue
    }
    if (msg.role !== 'assistant' || msg.autoSummary === true) continue
    hasAssistant = true
    if (msg.inputTokens !== undefined) inputTokens = (inputTokens ?? 0) + msg.inputTokens
    if (msg.outputTokens !== undefined) outputTokens = (outputTokens ?? 0) + msg.outputTokens
    if (msg.promptCacheHitTokens !== undefined) promptCacheHitTokens = (promptCacheHitTokens ?? 0) + msg.promptCacheHitTokens
    finalId = msg.id
    finalCreatedAt = msg.createdAt
  }
  flush()
  return byFinalId
}
