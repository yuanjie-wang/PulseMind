// ── Tool-result regroup (request-time adjacency repair, 2026-09-30) ──────
// The wave-barrier scheduler guaranteed every batch's results landed BEFORE
// the next assistant message, so the transcript was born wire-legal: each
// assistant(tool_use…) message was immediately followed by all of its
// results. Chained plan dispatch (2026-09-30, 「不应该浪费槽」) breaks that
// shape: a chained wave's assistant message lands BETWEEN a live batch and
// its still-arriving results. Both providers require each tool_result to sit
// in the user run directly after its own tool_use message — Anthropic 400s
// otherwise, and the adapters' reconcilers read the same adjacency and would
// inject phantom "interrupted" results for spawns that are merely still
// running. This pass rebuilds the API copy so every result hangs off its own
// call, and merges adjacent assistant messages into one (the clean plan
// dispatch lands right after a text-ending turn — a same-role run Anthropic
// 400s on). The live transcript keeps its chronological shape — only the
// request is repaired.
//
// Identity is the cache contract: on an already-legal history the function
// returns the SAME array reference (byte-identical request, zero re-bill —
// sessions that never chain pay nothing), and the rebuild is a pure function
// of the input, so a growing history's regrouped prefix stays stable across
// requests. Compaction runs downstream of this and sees the legal shape.

import type { AgentMessage } from '../types/agent'
import type { ContentBlock, ToolResultBlock } from '../../../shared/types/agent'

const isToolResult = (b: ContentBlock): b is ToolResultBlock => b.type === 'tool_result'

/** Wire-legal: every tool_result sits inside the user run that immediately
 *  follows the assistant message declaring its tool_use id, AND no two
 *  assistant messages are adjacent — Anthropic/Bedrock 400 on same-role runs
 *  (`roles must alternate`), and the oldest offender is not the chained
 *  dispatch but the plan scheduler's clean one: a turn that ends with text
 *  while the plan is still open appends the synthetic dispatch assistant
 *  right after the model's own closing text (review_20260930 中6). Results
 *  with no preceding assistant at all are orphans — the reconcilers own
 *  those, not this pass. */
export function isToolResultAdjacencyLegal(messages: AgentMessage[]): boolean {
  let openIds: Set<string> | null = null
  let lastRole: 'user' | 'assistant' | null = null
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      if (lastRole === 'assistant') return false
      const uses = msg.contentBlocks.filter(b => b.type === 'tool_use')
      openIds = uses.length > 0 ? new Set(uses.map(b => (b as { id: string }).id)) : null
    } else {
      for (const b of msg.contentBlocks) {
        if (isToolResult(b) && openIds !== null && !openIds.has(b.tool_use_id)) return false
      }
    }
    lastRole = msg.role
  }
  return true
}

/** Rebuild so every result is adjacent to its call. The synthetic carrier
 *  message's id is derived from its parent assistant message's id — stable
 *  across requests, so a compaction frontier landing on it keeps resolving. */
export function regroupToolResults(messages: AgentMessage[]): AgentMessage[] {
  if (isToolResultAdjacencyLegal(messages)) return messages

  // Merge adjacent assistant messages first (review_20260930 中6): the
  // [assistant(text), assistant(tool_use)] pair the scheduler's clean dispatch
  // produces must not reach the wire as a same-role run. The survivor is the
  // FIRST message (its id keeps naming the turn's own text), and the merge
  // happens before bucketing so a tool_use's parent — and the carrier id
  // derived from it — is the merged message the request actually carries.
  const merged: AgentMessage[] = []
  for (const msg of messages) {
    const last = merged[merged.length - 1]
    if (msg.role === 'assistant' && last?.role === 'assistant') {
      merged[merged.length - 1] = { ...last, contentBlocks: [...last.contentBlocks, ...msg.contentBlocks] }
    } else {
      merged.push(msg)
    }
  }

  // Bucket every result under the LATEST earlier assistant declaring its id
  // (results always follow their call; ids are unique per dispatch).
  const parentOf = new Map<string, AgentMessage>()
  for (const msg of merged) {
    if (msg.role !== 'assistant') continue
    for (const b of msg.contentBlocks) {
      if (b.type === 'tool_use') parentOf.set(b.id, msg)
    }
  }
  const buckets = new Map<AgentMessage, ToolResultBlock[]>()
  for (const msg of merged) {
    if (msg.role !== 'user') continue
    for (const b of msg.contentBlocks) {
      if (!isToolResult(b)) continue
      const parent = parentOf.get(b.tool_use_id)
      if (!parent) continue
      const bucket = buckets.get(parent)
      if (bucket) bucket.push(b)
      else buckets.set(parent, [b])
    }
  }

  const out: AgentMessage[] = []
  for (const msg of merged) {
    if (msg.role === 'assistant') {
      out.push(msg)
      const bucket = buckets.get(msg)
      if (bucket) {
        out.push({
          id: `regroup_${msg.id}`,
          role: 'user',
          contentBlocks: bucket,
          createdAt: msg.createdAt,
        })
      }
    } else {
      const rest = msg.contentBlocks.filter(b => !isToolResult(b) || !parentOf.has(b.tool_use_id))
      if (rest.length === msg.contentBlocks.length) {
        out.push(msg)
      } else if (rest.length > 0) {
        out.push({ ...msg, contentBlocks: rest })
      }
    }
  }
  return out
}
