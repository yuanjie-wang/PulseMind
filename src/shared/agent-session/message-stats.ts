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
