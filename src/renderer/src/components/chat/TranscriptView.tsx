/**
 * Transcript view: the same message stream the main chat renders
 * (chat/message-segments + chat/SegmentView), minus the chat's windowing and
 * plan-jump machinery — for short, settled or live conversations that always
 * follow the tail (tool studio, routine run records, the expert editor's
 * conversational form filler).
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import type { AgentStatus, AgentMessage, ContentBlock, ToolUseBlock } from '../../types/agent'
import { buildSegments, getSegmentKey, hasLiveTextTail, type Segment } from './message-segments'
import { SegmentBlock, MESSAGE_COLUMN_INSET } from './SegmentView'
import { useSegmentEntrance } from './use-segment-entrance'
import type { MessageActions } from './MessageGroup'
import { StreamingCursor } from './StreamingCursor'
import { ErrorDisplay } from './ErrorDisplay'
import { startBottomPin } from '../../utils/bottom-pin'

/** How close to the tail counts as "at the bottom" for follow-the-tail. */
const NEAR_BOTTOM_PX = 80

export interface TranscriptViewProps {
  messages: AgentMessage[]
  agentStatus: AgentStatus
  streamingBlocks: ContentBlock[]
  isRequesting: boolean
  restoring: boolean
  emptyHint?: string
  /** Rich empty state — replaces the text hint when the caller needs more than
   *  one line (e.g. the expert editor's starter chips). */
  emptyContent?: React.ReactNode
  /** Rendered while `restoring` with no messages yet (D10): the restore window
   *  used to be a three-way blank — no hint, no composer disable, nothing. */
  restoringHint?: React.ReactNode
  /** Assistant action row (copy / download / like / favorite + token stats).
   *  Pass 'viewOnly' for transcripts that are not a stored conversation: the row
   *  stays, minus the two buttons that write message metadata, because their
   *  message ids resolve to nothing. */
  actions?: MessageActions
  /** Horizontal padding of the message column — 24 in the full-width chat (it
   *  pairs with the composer's cap); a narrow host passes 0 so the bubbles and
   *  the composer are the same width. */
  contentInset?: number
  /** Conversation identity for the entrance rule: a host that swaps whole
   *  conversations under this still-mounted view (the sub-agent session view
   *  flipping nodes) passes the id, so a switch reads as an open (history, no
   *  entrance wave) instead of a burst of animations. A host that remounts per
   *  conversation needs nothing. */
  entranceKey?: string
  /** Conversation id of the transcript's own session — threaded to the
   *  assistant action row's 「存到知识库」 (full_20261011 M5-P1): without it
   *  the save action's blank-id guard no-ops silently and the two embedded
   *  hosts (form assist, sub-agent preview) showed a button that did
   *  nothing. Omit for viewOnly transcripts that are not stored rows. */
  conversationId?: string
  onApproveTool: (toolUseId: string, alwaysAllow?: boolean) => void
  onRejectTool: (toolUseId: string) => void
  onKillTool: (toolUseId: string) => void
  onRespondToTool: (toolUseId: string, response: string) => void
  onClearError: () => void
  onRetry: () => void
}

export function TranscriptView({
  messages,
  agentStatus,
  streamingBlocks,
  isRequesting,
  restoring,
  emptyHint,
  emptyContent,
  restoringHint,
  actions = 'full',
  contentInset = MESSAGE_COLUMN_INSET,
  entranceKey,
  conversationId,
  onApproveTool,
  onRejectTool,
  onKillTool,
  onRespondToTool,
  onClearError,
  onRetry,
}: TranscriptViewProps): React.ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null)
  /** Whether the next commit should keep the view at the tail (see handleScroll). */
  const followRef = useRef(true)
  /** The bottom write we performed last: the offset we set and the content
   *  height we saw when setting it. A scroll event whose offset is still at or
   *  past that write, over content that has since GROWN, is our own event
   *  catching up with new tail content — not a user scroll — so it must not
   *  un-follow (see handleScroll). */
  const pinnedRef = useRef<{ top: number; height: number } | null>(null)
  const rafRef = useRef(0)
  const cancelPinRef = useRef<(() => void) | null>(null)
  const isStreaming = agentStatus.status === 'streaming'

  // Streaming tool_use chunks accumulate across renders (same rule as the chat).
  const accumRef = useRef<Map<string, ToolUseBlock>>(new Map())
  useEffect(() => { if (!isStreaming) accumRef.current.clear() }, [isStreaming])

  // Segment/stream caches live in refs on purpose: they are render-time
  // memoization inputs, never UI state (same pattern as ChatView).
  const cachedRef = useRef<readonly Segment[]>([])
  const segments = useMemo((): Segment[] => {
    /* eslint-disable react-hooks/refs -- structural-sharing caches, not UI state */
    const segs = buildSegments({
      messages,
      isStreaming,
      streamingBlocks,
      cached: cachedRef.current,
      streamingToolAccum: accumRef.current,
    })
    cachedRef.current = segs
    /* eslint-enable react-hooks/refs */
    return segs
  }, [messages, isStreaming, streamingBlocks])

  // Newly arrived segments play the entrance animation; hydration renders
  // settled (see the hook). Layout-effect driven, so the animation style is on
  // the element before its first paint.
  const freshSegKeys = useSegmentEntrance(segments, entranceKey)

  // Write the view to its tail. A plain scrollTop write, not scrollIntoView:
  // `block: 'end'` stops at the scrollport's edge and leaves the tail the
  // transcript's own bottom padding short of it (measured 7px in the panel
  // probe), and the write stays scoped to this element.
  const snapToTail = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = { top: Math.max(0, el.scrollHeight - el.clientHeight), height: el.scrollHeight }
    el.scrollTop = el.scrollHeight
  }, [])

  // Whether the view is close enough to the tail to keep following it. Written
  // by scroll events only, never by a measurement taken after the content
  // changed: growth moves the tail away on its own, and one update can easily
  // add more than the threshold (a whole tool card, a chunk of streamed
  // markdown) — measuring there reads as "the user scrolled up" and then
  // un-follows for the rest of the turn. The desktop chat tracks it the same
  // way (ChatView's isNearBottomRef, written by handleScroll and by nothing
  // else), and so does the extension panel. The one case a bare gap read gets
  // wrong: x-markdown's body often lands a render AFTER the React commit, so
  // the scroll event our own snap queued fires over already-taller content and
  // reads past the threshold although the user never moved — that exact shape
  // (offset still at/below our write, height grown since) re-snaps instead of
  // un-following. A genuine user scroll-up always moves the offset ABOVE our
  // write, which is the only thing that un-follows here.
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight
    const pinned = pinnedRef.current
    if (pinned && el.scrollTop >= pinned.top && el.scrollHeight > pinned.height && gap >= NEAR_BOTTOM_PX) {
      snapToTail()
      return
    }
    pinnedRef.current = null
    followRef.current = gap < NEAR_BOTTOM_PX
  }, [snapToTail])

  // Follow the tail while the user is already at the bottom, so scrolling back
  // through history is not yanked forward. Each commit snaps twice: once in
  // the layout effect — before the paint, so the bulk of new content cannot
  // flash at the old offset — and once in the next animation frame, which is
  // the ChatView rule ("let DOM layout settle before measuring"): x-markdown
  // renders null on its first pass and fills its body a render later, and the
  // layout-effect write measured that shorter height.
  useLayoutEffect(() => {
    if (!followRef.current) return
    snapToTail()
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      if (followRef.current) snapToTail()
    })
  })
  useEffect(() => () => cancelAnimationFrame(rafRef.current), [])

  // Two landings need more than the per-commit snap, because nothing re-renders
  // after them while the height is still growing (XMarkdown renders null on its
  // first pass; code blocks and images fill in later) — both pin to the bottom
  // until the height settles, and both yield to real user input (bottom-pin's
  // own rule). History arriving: a run record, a sub-agent session or a
  // 新会话's fresh thread hydrating into this still-mounted view. A live turn
  // settling: the final chunk's markdown body often commits a render after the
  // status flips (the chat re-scrolls on that same edge).
  const prevHasMessagesRef = useRef(false)
  const hasMessages = messages.length > 0
  const prevStreamingRef = useRef(false)
  useEffect(() => {
    if (!hasMessages) {
      prevHasMessagesRef.current = false
      return
    }
    if (prevHasMessagesRef.current) return
    prevHasMessagesRef.current = true
    followRef.current = true
    cancelPinRef.current?.()
    cancelPinRef.current = startBottomPin(() => scrollRef.current)
  }, [hasMessages])
  useEffect(() => {
    const was = prevStreamingRef.current
    prevStreamingRef.current = isStreaming
    if (was && !isStreaming && followRef.current) {
      cancelPinRef.current?.()
      cancelPinRef.current = startBottomPin(() => scrollRef.current)
    }
  }, [isStreaming])
  useEffect(() => () => { cancelPinRef.current?.() }, [])

  return (
    <div ref={scrollRef} onScroll={handleScroll} style={{ flex: 1, overflow: 'auto', padding: '12px 0 8px' }}>
      {!hasMessages && restoring && restoringHint}
      {!hasMessages && !restoring && (emptyContent ?? (
        <div style={{ padding: '0 14px', color: 'var(--pm-text-muted)', fontSize: 13, whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>
          {emptyHint}
        </div>
      ))}
      {segments.map((seg, i) => (
        <SegmentBlock
          key={getSegmentKey(seg)}
          seg={seg}
          nextSeg={segments[i + 1]}
          isLastSegment={i === segments.length - 1}
          isRequesting={isRequesting}
          awaitingApproval={agentStatus.status === 'awaiting_approval'}
          actions={actions}
          contentInset={contentInset}
          conversationId={conversationId}
          enter={freshSegKeys.has(getSegmentKey(seg))}
          onApproveTool={onApproveTool}
          onRejectTool={onRejectTool}
          onKillTool={onKillTool}
          onRespondToTool={onRespondToTool}
        />
      ))}
      <StreamingCursor show={isRequesting && !hasLiveTextTail(segments)} contentInset={contentInset} />
      {agentStatus.status === 'error' && (
        <div style={{ maxWidth: 1000, margin: '0 auto', padding: '0 24px' }}>
          <ErrorDisplay
            message={'error' in agentStatus ? agentStatus.error : 'Unknown error'}
            onDismiss={onClearError}
            onRetry={onRetry}
          />
        </div>
      )}
    </div>
  )
}
