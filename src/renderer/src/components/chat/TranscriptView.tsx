/**
 * Transcript view: the same message stream the main chat renders
 * (chat/message-segments + chat/SegmentView), minus the chat's windowing and
 * plan-jump machinery — for short, settled or live conversations that always
 * follow the tail (tool studio, routine run records, the expert editor's
 * conversational form filler).
 */
import React, { useEffect, useMemo, useRef } from 'react'
import type { AgentStatus, AgentMessage, ContentBlock, ToolUseBlock } from '../../types/agent'
import { buildSegments, getSegmentKey, type Segment } from './message-segments'
import { SegmentBlock, MESSAGE_COLUMN_INSET } from './SegmentView'
import type { MessageActions } from './MessageGroup'
import { StreamingCursor } from './StreamingCursor'
import { ErrorDisplay } from './ErrorDisplay'

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
  onApproveTool: (toolUseId: string) => void
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
  onApproveTool,
  onRejectTool,
  onKillTool,
  onRespondToTool,
  onClearError,
  onRetry,
}: TranscriptViewProps): React.ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
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

  // Follow the tail: only while the user is already at the bottom, so scrolling
  // back through an earlier build is not yanked forward.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (!nearBottom) return
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [segments])

  const hasMessages = messages.length > 0

  return (
    <div ref={scrollRef} style={{ flex: 1, overflow: 'auto', padding: '12px 0 8px' }}>
      {!hasMessages && restoring && restoringHint}
      {!hasMessages && !restoring && (emptyContent ?? (
        <div style={{ padding: '0 14px', color: '#999', fontSize: 13, whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>
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
          onApproveTool={onApproveTool}
          onRejectTool={onRejectTool}
          onKillTool={onKillTool}
          onRespondToTool={onRespondToTool}
        />
      ))}
      <StreamingCursor show={isRequesting} />
      {agentStatus.status === 'error' && (
        <div style={{ maxWidth: 1000, margin: '0 auto', padding: '0 24px' }}>
          <ErrorDisplay
            message={'error' in agentStatus ? agentStatus.error : 'Unknown error'}
            onDismiss={onClearError}
            onRetry={onRetry}
          />
        </div>
      )}
      <div ref={endRef} />
    </div>
  )
}
