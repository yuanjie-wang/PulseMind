/**
 * One transcript segment's body, shared by the main chat and the tool studio so
 * both render messages, execution segments and streaming text identically.
 */
import React from 'react'
import { XMarkdown } from '@ant-design/x-markdown'
import Latex from '@ant-design/x-markdown/plugins/Latex'
import { MessageGroup } from './MessageGroup'
import { ExecutionSegment } from './ExecutionSegment'
import { CodeBlock } from './CodeBlock'
import type { ContentBlock } from '../../types/agent'
import type { Segment } from './message-segments'

export interface SegmentViewProps {
  seg: Segment
  /** Passed to ExecutionSegment — its collapsed header behaves differently on
   *  the live tail. */
  isLastSegment: boolean
  /** Assistant messages only show their action row when the next segment is not
   *  part of the same execution (the original chat rule). */
  showActions: boolean
  conversationId?: string
  conversationTitle?: string
  contextLength?: number
  isRequesting?: boolean
  onApproveTool: (toolUseId: string) => void
  onRejectTool: (toolUseId: string) => void
  onKillTool?: (toolUseId: string) => void
  onRespondToTool?: (toolUseId: string, response: string) => void
}

/** Streaming text is markdown, rendered with the same components as a settled
 *  message so nothing reflows when the stream lands. */
function StreamingText({ blocks }: { blocks: ContentBlock[] }): React.ReactElement {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 12 }}>
      <div style={{ paddingLeft: 12, width: '100%', fontSize: 14, lineHeight: 1.6 }}>
        {blocks.map((block, i) => {
          if (block.type !== 'text') return null
          return (
            <div key={i} className="x-markdown-light" style={{ color: '#333' }}>
              <XMarkdown content={block.text} components={{ code: CodeBlock }} config={{ extensions: Latex() }} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function SegmentView({
  seg,
  isLastSegment,
  showActions,
  conversationId,
  conversationTitle,
  contextLength,
  isRequesting,
  onApproveTool,
  onRejectTool,
  onKillTool,
  onRespondToTool,
}: SegmentViewProps): React.ReactElement {
  if (seg.type === 'streaming') return <StreamingText blocks={seg.blocks} />

  if (seg.type === 'execution') {
    return (
      <ExecutionSegment
        messages={seg.msgs}
        isLastSegment={isLastSegment}
        isRequesting={!!isRequesting}
        isReceiving={seg.msgs.some((m) => m.id === 'streaming-exec')}
        onApproveTool={onApproveTool}
        onRejectTool={onRejectTool}
        onKillTool={onKillTool ?? onRejectTool}
        onRespondToTool={onRespondToTool}
        conversationId={conversationId}
        conversationTitle={conversationTitle}
        contextLength={contextLength}
      />
    )
  }

  return (
    <MessageGroup
      msg={seg.msg}
      showActions={showActions}
      onApproveTool={onApproveTool}
      onRejectTool={onRejectTool}
      onRespondToTool={onRespondToTool}
      onKillTool={onKillTool ?? onRejectTool}
      conversationId={conversationId}
      conversationTitle={conversationTitle}
      contextLength={contextLength}
    />
  )
}

/** The segment's DOM anchor — plan jumps and search hits scroll to it. */
export function segmentAnchorId(seg: Segment): string | undefined {
  if (seg.type === 'single') return seg.msg.id.replace(/__\w+$/, '')
  if (seg.type === 'execution') return seg.msgs[0]?.id?.replace(/__\w+$/, '')
  return undefined
}

/** A segment in the standard transcript column, optionally highlighted. */
export function SegmentBlock({
  seg,
  nextSeg,
  isLastSegment,
  highlightedMsgId,
  showActions = true,
  ...viewProps
}: Omit<SegmentViewProps, 'showActions'> & {
  /** The following segment, if any — decides whether actions show. */
  nextSeg?: Segment
  highlightedMsgId?: string | null
  /** Caller-level switch for the action row (see TranscriptViewProps). */
  showActions?: boolean
}): React.ReactElement {
  const anchorId = segmentAnchorId(seg)
  const highlighted = !!highlightedMsgId && highlightedMsgId === anchorId
  const actionsVisible = showActions && seg.type === 'single' && seg.msg.role === 'assistant' && nextSeg?.type !== 'execution'
  return (
    <div
      id={anchorId ? `chat-msg-${anchorId}` : undefined}
      style={{
        maxWidth: 1000,
        margin: '0 auto',
        padding: '0 24px',
        transition: 'background 0.5s',
        background: highlighted ? 'rgba(22, 119, 255, 0.08)' : undefined,
      }}
    >
      <SegmentView
        seg={seg}
        isLastSegment={isLastSegment}
        showActions={actionsVisible}
        {...viewProps}
      />
    </div>
  )
}
