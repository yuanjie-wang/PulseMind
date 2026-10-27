/**
 * Elide settled todo_write call pairs from the OUTGOING wire (2026-10-25,
 * user proposal). The todo list's authoritative state rides the
 * <session-state> block — formatPlanForPrompt rebuilds `## Current Plan`
 * from the live plan on EVERY request — so an old todo_write tool_use +
 * tool_result pair sitting in history is a pure echo: zero information,
 * permanent window cost (O(steps × list) accumulation over a long task).
 * This transform drops every elidable pair from the API copy and keeps only
 * the MOST RECENT todo_write call:
 *   - its result is load-bearing exactly once (the delta snapshot, the reword
 *     caution and the blocked drop-off callout all live there), and
 *   - the model keeps one format anchor of its own last call (weak models
 *     copy their previous shape).
 *
 * This runs on the API copy inside prepareLoopRequest — the same layer as
 * stripToolResultImages / regroupToolResults, and BEFORE compaction so the
 * elided pairs never enter the dropped-region arithmetic. The transcript
 * everywhere else (DB, mirrors, UI) keeps everything; this.messages is never
 * touched.
 *
 * Pair-atomic by contract: a tool_use is elided only when its paired
 * tool_result is present (matched by tool_use_id, wherever the collector left
 * it — this runs before regroup). An UNPAIRED todo_write call survives: the
 * adapters' reconcile owns interrupted calls, and eliding one would erase the
 * attempt while leaving nothing to explain the turn. Pure and
 * identity-preserving: histories with ≤1 todo_write call get back the SAME
 * array; touched messages are rebuilt (never mutated — store objects flow
 * through by reference), messages reduced to no payload are dropped whole.
 */
import type { AgentMessage } from '../types/agent'

const ELIDED_TOOL = 'todo_write'

export function elideTodoWritePairs(messages: AgentMessage[]): AgentMessage[] {
  // Locate every todo_write tool_use in the history (assistant messages).
  const uses: Array<{ mi: number; bi: number; id: string }> = []
  messages.forEach((m, mi) => {
    if (m.role !== 'assistant') return
    m.contentBlocks.forEach((b, bi) => {
      if (b.type === 'tool_use' && b.name === ELIDED_TOOL) uses.push({ mi, bi, id: b.id })
    })
  })
  if (uses.length <= 1) return messages
  const elideIds = new Set(uses.slice(0, -1).map(u => u.id))

  // Pair each elidable use with its result (any message; regroup has not
  // necessarily run yet — this sits before it in the pipeline).
  const resultAt = new Map<string, { mi: number; bi: number }>()
  messages.forEach((m, mi) => {
    m.contentBlocks.forEach((b, bi) => {
      if (b.type === 'tool_result' && elideIds.has(b.tool_use_id)) resultAt.set(b.tool_use_id, { mi, bi })
    })
  })
  const removable = new Set([...elideIds].filter(id => resultAt.has(id)))
  if (removable.size === 0) return messages

  const touched = new Set<number>(uses.filter(u => removable.has(u.id)).map(u => u.mi))
  for (const { mi } of resultAt.values()) touched.add(mi)

  const drop = new Set<number>()
  const out = messages.map((m, mi) => {
    if (!touched.has(mi)) return m
    const kept = m.contentBlocks.filter((b) => {
      if (b.type === 'tool_use' && b.name === ELIDED_TOOL && removable.has(b.id)) return false
      if (b.type === 'tool_result' && removable.has(b.tool_use_id)) return false
      return true
    })
    // A message reduced to nothing — or to bare thinking blocks, which carry
    // no text and no live call — has nothing the wire needs; drop it whole.
    const hasPayload = kept.some(b => b.type !== 'thinking' && b.type !== 'redacted_thinking')
    if (kept.length === 0 || !hasPayload) {
      drop.add(mi)
      return m
    }
    return { ...m, contentBlocks: kept }
  })
  if (drop.size === 0) return out
  return out.filter((_, mi) => !drop.has(mi))
}
