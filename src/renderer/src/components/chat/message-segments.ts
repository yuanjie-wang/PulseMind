/**
 * Message → segment grouping, shared by every transcript view (main chat and
 * the tool studio) so both render the same transcript the same way.
 *
 * Text and ask_user are breakpoints; everything between consecutive breakpoints
 * (a tool_use ↔ tool_result cycle) is grouped into one execution segment. This
 * gives a flat layout with tools collapsible and text/ask_user always visible.
 */
import type { AgentMessage, ContentBlock, ToolUseBlock } from '../../types/agent'

export type Segment =
  | { type: 'single'; msg: AgentMessage }
  | { type: 'execution'; msgs: AgentMessage[] }
  | { type: 'streaming'; blocks: ContentBlock[] }

export function getSegmentKey(seg: Segment): string {
  if (seg.type === 'single') return 's-' + seg.msg.id
  if (seg.type === 'execution') return 'e-' + (seg.msgs[0]?.id?.replace(/__\w+$/, '') || 'empty')
  return 'streaming'
}

export function getSegmentAnchorId(seg: Segment | undefined): string | undefined {
  if (!seg) return undefined
  if (seg.type === 'single') return seg.msg.id.replace(/__\w+$/, '')
  if (seg.type === 'execution') return seg.msgs[0]?.id?.replace(/__\w+$/, '')
  return undefined
}

/** Same segment, and unchanged content: reused by the structural-sharing cache
 *  (cached segment objects keep their identity so React.memo can skip them). */
export function matchSegment(a: Segment, b: Segment): boolean {
  if (a.type !== b.type) return false
  if (a.type === 'single') {
    if (a.msg.id !== (b as typeof a).msg.id) return false
    // If tool_use block statuses differ, content has changed (e.g. ask_user
    // responded) — don't match, so the new segment isn't replaced with cached.
    const bSeg = b as typeof a
    for (const block of a.msg.contentBlocks) {
      if (block.type !== 'tool_use') continue
      const bBlock = bSeg.msg.contentBlocks.find(c => c.type === 'tool_use' && c.id === block.id)
      if (bBlock && (block as { status?: string }).status !== (bBlock as { status?: string }).status) return false
    }
    return true
  }
  if (a.type === 'execution') {
    const ab = b as typeof a
    if (a.msgs.length !== ab.msgs.length) return false
    return a.msgs.every((m, i) => m.id === ab.msgs[i].id)
  }
  return false
}

export function groupMessages(messages: AgentMessage[]): Segment[] {
  const segments: Segment[] = []
  let i = 0
  let pendingExec: AgentMessage[] | null = null

  const flushExec = () => {
    if (pendingExec && pendingExec.length > 0) {
      segments.push({ type: 'execution', msgs: pendingExec })
      pendingExec = null
    }
  }

  while (i < messages.length) {
    const msg = messages[i]

    // User message without tool_result → standalone (flushes any pending execution)
    if (msg.role === 'user' && !msg.contentBlocks.some((b) => b.type === 'tool_result')) {
      flushExec()
      segments.push({ type: 'single', msg })
      i++
      continue
    }

    // Tool_result user message → belongs to current execution segment (but skip if no pending execution — e.g. ask_user result)
    if (msg.role === 'user' && msg.contentBlocks.some((b) => b.type === 'tool_result')) {
      if (!pendingExec) {
        i++
        continue
      }
      pendingExec.push(msg)
      i++
      continue
    }

    // Assistant message — inspect content blocks
    if (msg.role === 'assistant') {
      const textBlocks = msg.contentBlocks.filter((b) => b.type === 'text')
      const thinkingBlocks = msg.contentBlocks.filter((b) => b.type === 'thinking' || b.type === 'redacted_thinking')
      const toolBlocks = msg.contentBlocks.filter((b) => b.type === 'tool_use')
      const hasAskUser = toolBlocks.some((b) => b.name === 'ask_user')
      const nonAskUserTools = toolBlocks.filter((b) => b.name !== 'ask_user')

      // Text is a breakpoint: flush pending execution, emit text as standalone
      if (textBlocks.length > 0) {
        flushExec()
        segments.push({
          type: 'single',
          msg: { ...msg, id: msg.id + '__text', contentBlocks: textBlocks }
        })
      }

      // Non-ask_user tools → add to current execution segment
      if (nonAskUserTools.length > 0) {
        // Thinking stays with tools only when text was NOT emitted already
        const extra = textBlocks.length === 0 ? thinkingBlocks : []
        const toolMsg = { ...msg, id: msg.id + '__exec', contentBlocks: [...extra, ...nonAskUserTools] }
        if (!pendingExec) pendingExec = []
        pendingExec.push(toolMsg)
      }

      // ask_user is a breakpoint: flush pending, ask_user stands alone
      if (hasAskUser) {
        flushExec()
        const askUserBlocks = toolBlocks.filter((b) => b.name === 'ask_user')
        segments.push({ type: 'single', msg: { ...msg, id: msg.id + '__ask', contentBlocks: askUserBlocks } })
      }

      // No text, no tools, no ask_user → nothing visible (thinking-only / empty), skip
      i++
      continue
    }

    // Fallback
    segments.push({ type: 'single', msg })
    i++
  }

  flushExec()
  return segments
}

export interface BuildSegmentsInput {
  messages: AgentMessage[]
  isStreaming: boolean
  streamingBlocks: ContentBlock[]
  /** Previous segments — the unchanged prefix is reused by identity. */
  cached: readonly Segment[]
  /** Accumulator for streaming tool_use blocks (see below). */
  streamingToolAccum: Map<string, ToolUseBlock>
}

/** Group messages for rendering, then append the live streaming tail: text
 *  blocks as a streaming segment, tool_use blocks accumulated across renders so
 *  OpenAI's per-delta tool_call chunks don't appear as scattered segments.
 *  Returns the new segment list, which doubles as the next call's `cached`. */
export function buildSegments(input: BuildSegmentsInput): Segment[] {
  const { messages, isStreaming, streamingBlocks, cached, streamingToolAccum } = input
  const segs = groupMessages(messages)

  // Reuse cached segment objects for the unchanged prefix (by type, msg ID, and length).
  // This lets React.memo detect that unchanged segments don't need re-render.
  // Execution segments are skipped (not cached): tool_use status is mutated in-place,
  // so the cached msgs array reference would cause React.memo to skip the re-render.
  const prefixLen = Math.min(segs.length, cached.length)
  for (let i = 0; i < prefixLen; i++) {
    if (matchSegment(cached[i], segs[i])) {
      if (segs[i].type !== 'execution') {
        segs[i] = cached[i]
      }
    } else {
      break
    }
  }

  if (!isStreaming) return segs

  if (streamingBlocks.length > 0) {
    const textBlocks = streamingBlocks.filter((b) => b.type === 'text')
    const toolBlocks = streamingBlocks.filter((b) => b.type === 'tool_use')

    // Text streams as a streaming segment
    if (textBlocks.length > 0) {
      segs.push({ type: 'streaming', blocks: textBlocks })
    }
    // Tool_use blocks: accumulate across renders and merge into a single synthetic message.
    if (toolBlocks.length > 0) {
      for (const tb of toolBlocks) {
        streamingToolAccum.set(tb.id, tb)
      }
      const accumulated = Array.from(streamingToolAccum.values())

      const lastSeg = segs[segs.length - 1]
      if (lastSeg?.type === 'execution') {
        const lastMsg = lastSeg.msgs[lastSeg.msgs.length - 1]
        if (lastMsg?.id === 'streaming-exec') {
          // Merge accumulated blocks into the existing synthetic message
          lastMsg.contentBlocks = Array.from(
            new Map<string, ContentBlock>(
              [...lastMsg.contentBlocks, ...accumulated].map((b) => [
                b.type === 'tool_use' ? (b as ToolUseBlock).id : b.type,
                b,
              ] as [string, ContentBlock])
            ).values()
          )
          segs[segs.length - 1] = { type: 'execution', msgs: [...lastSeg.msgs] }
        } else {
          segs[segs.length - 1] = {
            type: 'execution',
            msgs: [...lastSeg.msgs, {
              role: 'assistant',
              id: 'streaming-exec',
              createdAt: new Date().toISOString(),
              contentBlocks: accumulated,
            }]
          }
        }
      } else {
        segs.push({
          type: 'execution',
          msgs: [{
            role: 'assistant',
            id: 'streaming-exec',
            createdAt: new Date().toISOString(),
            contentBlocks: accumulated,
          }]
        })
      }
    }
  }
  return segs
}
