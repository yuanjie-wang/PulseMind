import type { AgentMessage } from '../../types/agent'

/**
 * Turn identity for the llm-request hook (2026-11-20, user definition):
 * `taskId` marks ONE Q&A turn — minted at turn start, stable across every
 * re-issue inside the turn (HTTP-level retries AND the engine's continuation
 * rounds: thinking-only retry, idle-timeout retry, overflow rescue, early-stop
 * continuation, steer, retryLastTurn — all bypass prepareTurn on purpose, so
 * they keep the minted id). `turnIndex` is the 0-based position of the turn in
 * the conversation.
 *
 * Pure functions only — the engine calls them from prepareTurn, the single
 * choke point every turn entrance funnels through.
 */

/** A fresh turn id, in the same shape as the request ids (`api_*` / `ns_*`). */
export function mintTurnId(): string {
  return `turn_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

/**
 * How many real user inputs the transcript already holds — the index the NEXT
 * turn will carry. A user turn is a user-role message with a non-empty TEXT
 * block; tool_result carriers are also user-role but hold none.
 *
 * Derived from the transcript instead of an in-memory counter so the numbering
 * survives restarts (cold open hydrates this.messages from the DB) — and it
 * stays correct because compaction only projects the request copy and never
 * rewrites `this.messages`. A mid-turn steer's appended text counts as its own
 * input in the NEXT turn's index: indices stay strictly increasing and unique.
 */
export function countUserTurns(messages: readonly AgentMessage[]): number {
  let count = 0
  for (const m of messages) {
    if (m.role !== 'user') continue
    if (m.contentBlocks?.some((b) => b.type === 'text' && typeof (b as { text?: unknown }).text === 'string' && (b as { text: string }).text.trim())) count++
  }
  return count
}
