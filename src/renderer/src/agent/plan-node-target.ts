/**
 * Where a plan node's click goes (PLAN-workbench W12).
 *
 * The graph is a navigation surface: a node either opens the sub-agent session
 * that implements it or, failing that, jumps the main transcript to the round
 * that settled it. Two things make this worth its own module rather than an
 * inline scan in App:
 *
 *  - the link lives in TWO places and only one of them is durable. The plan node
 *    (`subConvId`) is written when spawn_agent claims the node and is persisted
 *    with the plan, so it survives a restart; the spawn tool block carries the
 *    same id as a wire field, which is fresher within a live run but disappears
 *    with its message (compaction, or just history the client no longer holds).
 *  - "is it still running?" is not derivable from the session at all — it is the
 *    node's own status that decides whether the view keeps polling.
 */
import type { AgentMessage, ToolUseBlock } from '../types/agent'
import type { PlanNode } from '../../../shared/types/plan'

export type PlanNodeTarget =
  /** Open the sub-agent session; `live` means the run is still open. */
  | { kind: 'session'; subConvId: string; live: boolean }
  /** No session — scroll the main transcript to the settling round. */
  | { kind: 'message'; msgId: string }

/** The sub-conversation of the LATEST spawn_agent call that declared this node.
 *  Latest, because a failed node is re-dispatched and the newest spawn is the
 *  one whose session the user means. */
function spawnSessionForNode(messages: AgentMessage[], nodeId: string): string | undefined {
  let found: string | undefined
  for (const m of messages) {
    for (const b of m.contentBlocks) {
      if (b.type !== 'tool_use') continue
      const tb = b as ToolUseBlock
      if (tb.name !== 'spawn_agent') continue
      // planNodeId is the engine's own marker; input.planNode covers a client
      // that only has the call parameters (the model passes n1/n2/2 alike).
      const tagged = tb.planNodeId
        ?? (tb.input?.planNode !== undefined ? `n${String(tb.input.planNode).replace(/^n/, '')}` : undefined)
      if (tagged === nodeId && tb.subConvId) found = tb.subConvId
    }
  }
  return found
}

/** Resolve a node click. Null when there is nowhere to go (a pending node the
 *  model never dispatched, e.g. a plan that was created and then abandoned). */
export function resolvePlanNodeTarget(
  node: PlanNode | undefined,
  messages: AgentMessage[],
): PlanNodeTarget | null {
  if (!node) return null
  const subConvId = node.subConvId ?? (node.execution ? undefined : spawnSessionForNode(messages, node.id))
  if (subConvId) {
    // Known terminal execution stops polling even before acceptance. Legacy
    // plans retain their pending fallback; never borrow a previous retry's link.
    const live = node.status === 'pending' && (!node.execution
      || node.execution.status === 'queued' || node.execution.status === 'running')
    return { kind: 'session', subConvId, live }
  }
  if (node.msgId) return { kind: 'message', msgId: node.msgId }
  return null
}
