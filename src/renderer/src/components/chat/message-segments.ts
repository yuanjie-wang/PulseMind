/**
 * Message → segment grouping, shared by every transcript view (main chat and
 * the tool studio) so both render the same transcript the same way.
 *
 * Text and ask_user are breakpoints; everything between consecutive breakpoints
 * (a tool_use ↔ tool_result cycle) is grouped into one execution segment. This
 * gives a flat layout with tools collapsible and text/ask_user always visible.
 */
import type { AgentMessage, ContentBlock, ToolUseBlock } from '../../types/agent'
import { messageStatsSignature } from '../../../../shared/agent-session/message-stats'

export type Segment =
  | {
      type: 'single'
      msg: AgentMessage
      /** Stable key override — see LiveKeys. */
      key?: string
      /** 流式尾段 (2026-11-13, step 2): the round is still streaming this text.
       *  The tail is a `single` segment now, NOT its own `type: 'streaming'`
       *  union member. That member was what made the two sides different
       *  component types, so the commit that landed the paragraph unmounted
       *  the whole markdown subtree and re-laid it out (user report
       *  2026-11-13: one visible refresh per finished paragraph). One union
       *  member means the renderer cannot branch on the type — only this flag
       *  flips, and AssistantMarkdown keeps the subtree alive across it.
       *  `toolsStarted`: the round's tool call has begun streaming, so the
       *  parse throttle must flush the sentence complete in the same render
       *  the tool card mounts (2026-10-28 report — the 150ms interval
       *  otherwise let the card outrun the frozen tail by up to one tick). */
      live?: { toolsStarted: boolean }
    }
  | { type: 'execution'; msgs: AgentMessage[] }

/** Split segments rename their message copy (`__text` / `__exec` / `__ask`, the
 *  `groupMessages` breakpoint ids below); the mirror still holds the UNSUFFIXED
 *  id and that is what every backend write must address — the DB has no
 *  `msg_…__text` row, so a suffixed id misses the message-existence check
 *  (「消息尚未保存或不属于此会话」) and a metadata UPDATE silently hits 0 rows. */
export function stripMessageIdSuffix(id: string): string {
  return id.replace(/__\w+$/, '')
}

/** Per-view bookkeeping for the live tail's React key (see adoptLiveKeys).
 *  The keys only ever feed THIS view's own rendering (React keys, the entrance
 *  set), never another view or the backend — so each view mints its own here
 *  instead of having the engine hand over the id it is about to commit, which
 *  would have to cross the session IPC (session-manager's streaming_blocks
 *  event + its snapshot) to reach the renderer. */
export interface LiveKeys {
  /** The key the round in flight is showing. The settled segment adopts it. */
  pending: string | null
  /** Settled message id (suffix stripped) → the key it adopted. */
  bound: Map<string, string>
  seq: number
}

export function createLiveKeys(): LiveKeys {
  return { pending: null, bound: new Map(), seq: 0 }
}

export function getSegmentKey(seg: Segment): string {
  if (seg.type === 'single') return seg.key ?? 's-' + seg.msg.id
  // Raw first-msg id, NOT stripped: one message can contribute TWO exec slices
  // (__think before its text, __exec after) landing in different segments —
  // stripping would key both 'e-<id>' and React would see duplicate keys.
  return 'e-' + (seg.msgs[0]?.id ?? 'empty')
}

export function getSegmentAnchorId(seg: Segment | undefined): string | undefined {
  if (!seg) return undefined
  // A live tail has no anchor: 'streaming-text' is synthetic — no plan step or
  // search hit can name it — and handing it out would put
  // id="chat-msg-streaming-text" into the DOM on every streamed tick.
  if (seg.type === 'single') return seg.live ? undefined : stripMessageIdSuffix(seg.msg.id)
  return seg.msgs[0]?.id ? stripMessageIdSuffix(seg.msgs[0].id) : undefined
}

/** Index of the last text block that already carries text, -1 when none. The
 *  streaming caret rides that block (SegmentView's streaming tail): it is the
 *  end of what the user is reading, and a later block still empty has no text
 *  token for x-markdown to put a tail after anyway. */
export function lastLiveTextIndex(blocks: readonly ContentBlock[]): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]
    if (b.type === 'text' && b.text.length > 0) return i
  }
  return -1
}

/** A live text tail is on screen — the streaming segment has text and the
 *  round has not moved past it (its tool_use is not streaming yet). The
 *  in-text caret it used to anchor is retired (user ruling 2026-11-21,
 *  渐变流式期间不要光标): the growing text itself is the streaming indicator,
 *  and hosts' foot StreamingCursor still yields through this gate
 *  (`show={isRequesting && !hasLiveTextTail(segments)}`) so the textless
 *  phases — thinking, tool rounds — are where the foot caret shows. Once
 *  `toolsStarted` flips (the text block is done, tool args are streaming)
 *  the gate opens again — the finished sentence is reading material, the
 *  live position is the foot (2026-10-28 report). */
export function hasLiveTextTail(segs: readonly Segment[]): boolean {
  return segs.some((s) => s.type === 'single' && s.live !== undefined && s.live.toolsStarted !== true && lastLiveTextIndex(s.msg.contentBlocks) >= 0)
}

/** Same segment, and unchanged content: reused by the structural-sharing cache
 *  (cached segment objects keep their identity so React.memo can skip them). */
export function matchSegment(a: Segment, b: Segment): boolean {
  if (a.type !== b.type) return false
  if (a.type === 'single') {
    // 流式尾段（2026-11-13）: the live single's msg is rebuilt every tick and the
    // tail must follow it — reusing a cached object would freeze the text one
    // tick behind, the same in-place-mutation lesson as the exec slices below.
    if (a.live !== undefined || (b as typeof a).live !== undefined) return false
    if (a.msg.id !== (b as typeof a).msg.id) return false
    // The terminal stamp (shared/agent-session/message-stats.ts) patches the
    // answer message's stats IN PLACE after it was appended — the turn total
    // replacing that round's own stream time is exactly the change this cache
    // must not swallow, or the 耗时 row freezes on the per-round value until
    // remount (conv_20261116210413: an 17.8min turn read as its last round's
    // 16.4s on screen while the DB already held the total). Same signature the
    // transport diffs by, so both layers call a stats change a change.
    if (messageStatsSignature(a.msg) !== messageStatsSignature((b as typeof a).msg)) return false
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
    // Live synthetic slices mutate in place every streamed tick — a matching id
    // set must never reuse the cached segment, or the group header freezes one
    // tick behind (the in-place-mutation lesson from the mirror fold).
    const live = (m: AgentMessage) => m.id === 'streaming-think' || m.id === 'streaming-exec'
    if (a.msgs.some(live) || ab.msgs.some(live)) return false
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

  // Forward-stable grouping (user ruling 2026-10-25, ninth of the day —
  // replacing the round-8 retro-folding): the user diagnosed the old design
  // exactly — thinking was held in the pending buffer and its fate (fold into
  // the text bubble / fuse with tools / stand alone) was decided by what
  // arrived AFTER it, so committed structure kept rewriting itself (a visible
  // 深度思考 group dissolved the moment its text landed). NO MORE LOOK-AHEAD:
  // thinking commits into the exec group the moment it exists; text flushes
  // that group as-is (its own 已完成 · 深度思考N次 segment — a completed step,
  // not an orphan); later text/tools are their own stable segments. Groups
  // still GROW in place while pending (consecutive thinking rounds count up
  // 1次→2次 before any flush) but never dissolve after formation.

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

      // Thinking is execution-family (user ruling 2026-10-25: 把 thinking 当作
      // execution 合并入 segment): it lives in the collapsible exec grouping,
      // never the text bubble and never a bare standalone strip. Models emit
      // reasoning FIRST, and this persona narrates before acting — so thinking
      // is its own slice that the text breakpoint flushes, keeping the reading
      // order [▸Thinking] [narration] [▸tools] instead of burying the
      // narration under the tools it introduced. Adjacent rounds with no text
      // between them share one group.
      if (thinkingBlocks.length > 0) {
        if (!pendingExec) pendingExec = []
        pendingExec.push({ ...msg, id: msg.id + '__think', contentBlocks: thinkingBlocks })
      }

      // Text is a breakpoint: flush pending execution, emit text as standalone.
      // The flushed group stands as-is — no folding into the bubble, no
      // retroactive dissolution (see the forward-stable note above).
      if (textBlocks.length > 0) {
        flushExec()
        segments.push({
          type: 'single',
          msg: { ...msg, id: msg.id + '__text', contentBlocks: textBlocks }
        })
      }

      // Non-ask_user tools → add to current execution segment
      if (nonAskUserTools.length > 0) {
        const toolMsg = { ...msg, id: msg.id + '__exec', contentBlocks: nonAskUserTools }
        if (!pendingExec) pendingExec = []
        pendingExec.push(toolMsg)
      }

      // ask_user is a breakpoint: flush pending, ask_user stands alone
      if (hasAskUser) {
        flushExec()
        const askUserBlocks = toolBlocks.filter((b) => b.name === 'ask_user')
        segments.push({ type: 'single', msg: { ...msg, id: msg.id + '__ask', contentBlocks: askUserBlocks } })
      }

      // Truly empty (no thinking, no tools, no text) → skip
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
  /** Per-view live-tail key registry. Omit and the tail falls back to the key
   *  its synthetic id implies ('s-streaming-text') — hosts that predate
   *  adoptLiveKeys keep the old remounting behaviour. */
  liveKeys?: LiveKeys
}

/** Keep ONE React key alive across the streaming→settled boundary.
 *
 *  The live tail is a `single` segment carrying `live` (step 2, same day); the
 *  message it becomes is the `single` segment keyed 's-<msgId>__text'. Same
 *  component type now, so only the KEY still differs — and a changed key alone
 *  is enough to unmount the row and replay SegmentBlock's entrance animation,
 *  one visible refresh per finished paragraph (user report 2026-11-13). Handing
 *  the settled segment the key the tail was showing turns that remount into a
 *  plain re-render.
 *
 *  Adoption targets the LAST text segment only: messages are append-only, so
 *  the one a commit appended is the last one. A round that lands no text
 *  segment (sentinel-stripped, tool-only, cancelled) leaves `pending` set — the
 *  next round's tail reuses that same key and adopts it on ITS commit, so an
 *  aborted round cannot strand a key or steal someone else's. */
function adoptLiveKeys(segs: Segment[], liveTextStreaming: boolean, live: LiveKeys): void {
  if (live.pending !== null && !liveTextStreaming) {
    for (let i = segs.length - 1; i >= 0; i--) {
      const seg = segs[i]
      if (seg.type !== 'single' || !seg.msg.id.endsWith('__text')) continue
      const base = stripMessageIdSuffix(seg.msg.id)
      if (!live.bound.has(base)) {
        live.bound.set(base, live.pending)
        live.pending = null
      }
      break
    }
  }
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]
    if (seg.type !== 'single' || seg.key !== undefined || !seg.msg.id.endsWith('__text')) continue
    const adopted = live.bound.get(stripMessageIdSuffix(seg.msg.id))
    // New object, not a mutation: cached segments are shared with previous
    // renders and assigning in place would edit one another's history. Only
    // the pass that adopts a key allocates, so identity stays stable after.
    if (adopted !== undefined) segs[i] = { ...seg, key: adopted }
  }
}

/** Group messages for rendering, then append the live streaming tail: text
 *  blocks as a streaming segment, tool_use blocks accumulated across renders so
 *  OpenAI's per-delta tool_call chunks don't appear as scattered segments.
 *  Returns the new segment list, which doubles as the next call's `cached`. */
export function buildSegments(input: BuildSegmentsInput): Segment[] {
  const { messages, isStreaming, streamingBlocks, cached, streamingToolAccum, liveKeys } = input
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

  // Before the early return: a text-only final round commits with the turn
  // already over, so isStreaming is false on the very render that must adopt.
  if (liveKeys) adoptLiveKeys(segs, isStreaming && streamingBlocks.some((b) => b.type === 'text'), liveKeys)

  if (!isStreaming) return segs

  if (streamingBlocks.length > 0) {
    const thinkingBlocks = streamingBlocks.filter((b) => b.type === 'thinking' || b.type === 'redacted_thinking')
    const textBlocks = streamingBlocks.filter((b) => b.type === 'text')
    const toolBlocks = streamingBlocks.filter((b) => b.type === 'tool_use')

    // Streaming thinking JOINS the open execution segment (user spec
    // 2026-10-25, tenth ruling: message → thinking/tool_use open ONE segment,
    // subsequent blocks 塞入 it; the segment closes only at the next message).
    // The old separate strip fragmented the open segment into [group][strip].
    // Anti-freeze visibility is kept by the group header (ExecutionSegment
    // renders the live reasoning tail while receiving). The live slices are
    // FOUND within the segment (think/tool deltas may interleave) — never
    // appended twice.
    if (thinkingBlocks.length > 0) {
      const last = segs[segs.length - 1]
      if (last?.type === 'execution') {
        const existing = last.msgs.find((m) => m.id === 'streaming-think')
        if (existing) {
          existing.contentBlocks = thinkingBlocks
        } else {
          segs[segs.length - 1] = {
            type: 'execution',
            msgs: [...last.msgs, { role: 'assistant', id: 'streaming-think', createdAt: new Date().toISOString(), contentBlocks: thinkingBlocks }],
          }
        }
      } else {
        segs.push({
          type: 'execution',
          msgs: [{ role: 'assistant', id: 'streaming-think', createdAt: new Date().toISOString(), contentBlocks: thinkingBlocks }],
        })
      }
    }
    // Text streams as a streaming segment. toolsStarted rides the round's
    // tool_use presence — streamingBlocks derives from currentAssistantBlocks,
    // so once the block exists it is in every tick until commit (the flag
    // never flips back within a round).
    if (textBlocks.length > 0) {
      // The key is minted once per round and outlives the round: the settled
      // segment adopts this exact string (adoptLiveKeys), so React reconciles
      // the tail into the finished paragraph instead of remounting it.
      const liveKey = liveKeys ? (liveKeys.pending ??= `live-${++liveKeys.seq}`) : undefined
      // 'streaming-text' follows the existing synthetic-id convention
      // ('streaming-think' / 'streaming-exec'): no host writes it anywhere, and
      // it never ends in '__text', so adoptLiveKeys cannot mistake it for a
      // settled paragraph (the guard there says so out loud anyway).
      segs.push({
        type: 'single',
        msg: { role: 'assistant', id: 'streaming-text', createdAt: '', contentBlocks: textBlocks },
        live: { toolsStarted: toolBlocks.length > 0 },
        ...(liveKey ? { key: liveKey } : {}),
      })
    }
    // Tool_use blocks: accumulate across renders and merge into a single synthetic message.
    if (toolBlocks.length > 0) {
      for (const tb of toolBlocks) {
        streamingToolAccum.set(tb.id, tb)
      }
      const accumulated = Array.from(streamingToolAccum.values())

      const lastSeg = segs[segs.length - 1]
      if (lastSeg?.type === 'execution') {
        const existingExec = lastSeg.msgs.find((m) => m.id === 'streaming-exec')
        if (existingExec) {
          // Merge accumulated blocks into the existing live slice
          existingExec.contentBlocks = Array.from(
            new Map<string, ContentBlock>(
              [...existingExec.contentBlocks, ...accumulated].map((b) => [
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
