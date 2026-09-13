/**
 * Studio transcript: the same message stream the main chat renders
 * (chat/message-segments + chat/SegmentView), minus the chat's windowing and
 * plan-jump machinery — a studio conversation is short and always follows the
 * live tail.
 */
import React, { useEffect, useMemo, useRef } from 'react'
import type { AgentStatus, AgentMessage, ContentBlock, ToolUseBlock } from '../../types/agent'
import { buildSegments, getSegmentKey, type Segment } from '../chat/message-segments'
import { SegmentBlock } from '../chat/SegmentView'
import { StreamingCursor } from '../chat/StreamingCursor'
import { ErrorDisplay } from '../chat/ErrorDisplay'

export interface StudioTranscriptProps {
  messages: AgentMessage[]
  agentStatus: AgentStatus
  streamingBlocks: ContentBlock[]
  isRequesting: boolean
  restoring: boolean
  emptyHint: string
  onApproveTool: (toolUseId: string) => void
  onRejectTool: (toolUseId: string) => void
  onKillTool: (toolUseId: string) => void
  onRespondToTool: (toolUseId: string, response: string) => void
  onClearError: () => void
  onRetry: () => void
}

export function StudioTranscript({
  messages,
  agentStatus,
  streamingBlocks,
  isRequesting,
  restoring,
  emptyHint,
  onApproveTool,
  onRejectTool,
  onKillTool,
  onRespondToTool,
  onClearError,
  onRetry,
}: StudioTranscriptProps): React.ReactElement {
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
      {!hasMessages && !restoring && (
        <div style={{ padding: '0 14px', color: '#999', fontSize: 13, whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>
          {emptyHint}
        </div>
      )}
      {segments.map((seg, i) => (
        <SegmentBlock
          key={getSegmentKey(seg)}
          seg={seg}
          nextSeg={segments[i + 1]}
          isLastSegment={i === segments.length - 1}
          isRequesting={isRequesting}
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
