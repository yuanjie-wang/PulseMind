/**
 * Transcript view: the same message stream the main chat renders
 * (chat/message-segments + chat/SegmentView), minus the chat's windowing and
 * plan-jump machinery — for short, settled or live conversations that always
 * follow the tail (tool studio, routine run records, the expert editor's
 * conversational form filler).
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import type { AgentStatus, AgentMessage, ContentBlock, ToolUseBlock } from '../../types/agent'
import { buildSegments, createLiveKeys, getSegmentKey, hasLiveTextTail, type Segment } from './message-segments'
import { SegmentBlock, MESSAGE_COLUMN_INSET } from './SegmentView'
import { useSegmentEntrance } from './use-segment-entrance'
import type { MessageActions } from './MessageGroup'
import { StreamingCursor } from './StreamingCursor'
import { ErrorDisplay } from './ErrorDisplay'
import { useTailFollow } from '../../../../shared/ui/useTailFollow'

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
  /** 运行中「转入后台」(PLAN-background-tasks A). Optional. */
  onPromoteTool?: (toolUseId: string) => void
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
  onPromoteTool,
  onRespondToTool,
  onClearError,
  onRetry,
}: TranscriptViewProps): React.ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null)
  // Tail following lives in utils/tail-follow.ts: intent decides (a wheel/key/touch
  // away releases on the spot, at any distance), and the settle loop chases growth
  // that lands after the commit. This host used to keep its own followRef/pinnedRef
  // geometry — the source of both user reports (stalls mid-stream, a magnetic band
  // on scroll-up).
  const follow = useTailFollow(() => scrollRef.current)
  const isStreaming = agentStatus.status === 'streaming'

  // Streaming tool_use chunks accumulate across renders (same rule as the chat).
  const accumRef = useRef<Map<string, ToolUseBlock>>(new Map())
  useEffect(() => { if (!isStreaming) accumRef.current.clear() }, [isStreaming])

  /** Live-tail key registry — see message-segments' LiveKeys. Per-view. */
  const liveKeysRef = useRef(createLiveKeys())

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
      liveKeys: liveKeysRef.current,
    })
    cachedRef.current = segs
    /* eslint-enable react-hooks/refs */
    return segs
  }, [messages, isStreaming, streamingBlocks])

  // Newly arrived segments play the entrance animation; hydration renders
  // settled (see the hook). Layout-effect driven, so the animation style is on
  // the element before its first paint.
  const freshSegKeys = useSegmentEntrance(segments, entranceKey)

  // ── Stable tool handlers (user 2026-11-09「对话区上下滚动有卡顿」) ──
  // The segment family memoizes on prop identity: message-segments reuses cached
  // segment objects (「cached segment objects keep their identity so React.memo
  // can skip them」) and MessageGroup / ExecutionSegment are React.memo — so the
  // transcript only re-renders the segment that changed... as long as the props
  // it hands down keep their identity. Most hosts pass fresh arrows every
  // render (`onApproveTool={(id, always) => session.engineCall('approveTool', …)}`,
  // FormAssistColumn's exact shape), which replaced the whole prop set on every
  // streamed chunk and re-rendered EVERY message in the thread. The engine
  // mirrors to the renderer once per frame while streaming, so a long thread
  // spent its frame budget re-rendering settled markdown: the frame never
  // finished, and scrolling (which competes for the same main thread) read as
  // jank. Measured in scripts/probe-transcript-perf.mjs: one chunk cost 12.4ms
  // instead of 2.4ms on a 22-message thread, and the gap grows with the thread.
  //
  // Forwarding through a ref keeps the identity constant while still calling the
  // LATEST prop — a stale closure would be a worse bug than the jank (the
  // assistant's 新会话 swaps the session under a still-mounted column, and a
  // cached arrow would drive the old one). Written in a layout effect, not in
  // render: it is a ref, and events can only fire after the commit anyway.
  const handlersRef = useRef({ onApproveTool, onRejectTool, onKillTool, onPromoteTool, onRespondToTool })
  useLayoutEffect(() => {
    handlersRef.current = { onApproveTool, onRejectTool, onKillTool, onPromoteTool, onRespondToTool }
  })
  const approveTool = useCallback((id: string, alwaysAllow?: boolean) => handlersRef.current.onApproveTool(id, alwaysAllow), [])
  const rejectTool = useCallback((id: string) => handlersRef.current.onRejectTool(id), [])
  const killTool = useCallback((id: string) => handlersRef.current.onKillTool(id), [])
  const promoteTool = useCallback((id: string) => handlersRef.current.onPromoteTool?.(id), [])
  const respondToTool = useCallback((id: string, response: string) => handlersRef.current.onRespondToTool(id, response), [])

  // Two landings need to (re)attach to the tail because nothing re-renders after
  // them while the height keeps growing (XMarkdown renders null on its first
  // pass; code blocks and images fill in later) — and both are the user landing
  // here, not reading history, so they re-follow deliberately. `resume()` snaps
  // and starts the settle loop, which is what bottom-pin used to provide.
  // History arriving: a run record, a sub-agent session or a 新会话's fresh
  // thread hydrating into this still-mounted view. A live turn settling: the
  // final chunk's markdown body often commits a render after the status flips.
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
    follow.resume()
  }, [follow, hasMessages])
  useEffect(() => {
    const was = prevStreamingRef.current
    prevStreamingRef.current = isStreaming
    if (was && !isStreaming) follow.resume()
  }, [follow, isStreaming])

  return (
    <div ref={scrollRef} style={{ flex: 1, overflow: 'auto', padding: '12px 0 8px' }}>
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
          onApproveTool={approveTool}
          onRejectTool={rejectTool}
          onKillTool={killTool}
          onPromoteTool={onPromoteTool ? promoteTool : undefined}
          onRespondToTool={respondToTool}
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
