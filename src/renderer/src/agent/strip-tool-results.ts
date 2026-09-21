/**
 * Strip base64 image payloads out of tool_result contents before they go to the
 * LLM — the originals stay in the engine's live `messages` so the UI can still
 * render them.
 *
 * Extracted verbatim from the closure that used to sit inline in
 * `AgentEngine.prepareLoopRequest` (2026-09-21). The body is byte-for-byte the
 * same; only the name moved. Two reasons for the extraction:
 *
 *   1. It is a **per-loop-iteration O(total tool_result bytes)** cost — the
 *      closure ran for the whole history on every request inside the tool loop,
 *      not once per user turn. As a named export it can be driven directly by
 *      `scripts/probe-loop-iteration-perf.mjs`, so the cost is measured on the
 *      real function instead of a replica of it.
 *   2. It is the single place a `WeakMap` memoisation could later cache at, if
 *      the probe says the cost is worth it.
 *
 * Identity: only the two early exits return the SAME object (non-user roles, and
 * user messages carrying no tool_result block at all). Anything that reaches the
 * rebuild returns a fresh message, exactly as the inline closure did — so the
 * API-copy path keeps sharing message objects with the live history wherever the
 * inline version did, and nowhere else.
 */
import type { AgentMessage, ToolResultBlock } from '../types/agent'
import { stripImageData } from './image-utils'

export function stripToolResultImages(msg: AgentMessage): AgentMessage {
  if (msg.role !== 'user') return msg
  const blocks = msg.contentBlocks
  if (!blocks || !blocks.some(b => b.type === 'tool_result')) return msg
  const newBlocks = blocks.map(b => {
    if (b.type !== 'tool_result') return b
    const tb = b as ToolResultBlock
    let content = tb.content || ''
    try {
      const parsed = JSON.parse(content)
      content = JSON.stringify(stripImageData(parsed))
    } catch {
      content = stripImageData(content) as string
    }
    return { ...tb, content }
  })
  return { ...msg, contentBlocks: newBlocks }
}
