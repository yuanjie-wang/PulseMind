/**
 * One transcript segment's body, shared by the main chat and the tool studio so
 * both render messages, execution segments and streaming text identically.
 */
import React from 'react'
import { XMarkdown } from '@ant-design/x-markdown'
import Latex from '@ant-design/x-markdown/plugins/Latex'
import { MessageGroup, type MessageActions } from './MessageGroup'
import { ExecutionSegment } from './ExecutionSegment'
import { CodeBlock } from './CodeBlock'
import type { ContentBlock } from '../../types/agent'
import type { Segment } from './message-segments'

/** The chat's message-column padding. It is what makes the bubbles line up with
 *  the composer: the column is 1000 wide, the composer card 952, and the 24px
 *  per side closes the gap between them. */
export const MESSAGE_COLUMN_INSET = 24

export interface SegmentViewProps {
  seg: Segment
  /** Passed to ExecutionSegment — its collapsed header behaves differently on
   *  the live tail. */
  isLastSegment: boolean
  /** Which action buttons a settled assistant message gets (see MessageActions).
   *  The row itself only shows when the next segment is not part of the same
   *  execution (the original chat rule). */
  actions: MessageActions
  conversationId?: string
  conversationTitle?: string
  contextLength?: number
  isRequesting?: boolean
  /** The engine is parked awaiting approval (`agentStatus: 'awaiting_approval'`).
   *  A held call opens its way out of both collapsed layers — the execution
   *  segment and the tool card — so 运行/跳过 never need expanding. Optional and
   *  defaulting to off: a host that doesn't report the status renders exactly as
   *  it did before (its pending calls simply stay collapsed). */
  awaitingApproval?: boolean
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
  actions,
  conversationId,
  conversationTitle,
  contextLength,
  isRequesting,
  awaitingApproval,
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
        awaitingApproval={awaitingApproval}
      />
    )
  }

  return (
    <MessageGroup
      msg={seg.msg}
      actions={actions}
      onApproveTool={onApproveTool}
      onRejectTool={onRejectTool}
      onRespondToTool={onRespondToTool}
      onKillTool={onKillTool ?? onRejectTool}
      conversationId={conversationId}
      conversationTitle={conversationTitle}
      contextLength={contextLength}
      awaitingApproval={awaitingApproval}
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
  actions = 'full',
  contentInset = MESSAGE_COLUMN_INSET,
  ...viewProps
}: Omit<SegmentViewProps, 'actions'> & {
  /** The following segment, if any — decides whether actions show. */
  nextSeg?: Segment
  highlightedMsgId?: string | null
  /** Caller-level switch for the action row (see TranscriptViewProps). */
  actions?: MessageActions
  /** Horizontal padding of the message column. The chat's 24 pairs with its
   *  composer, whose card is capped 48px narrower than the column's 1000 — a
   *  narrower host (the expert editor's card) passes 0 instead, so the bubbles
   *  and the composer end up the same width there too. */
  contentInset?: number
}): React.ReactElement {
  const anchorId = segmentAnchorId(seg)
  const highlighted = !!highlightedMsgId && highlightedMsgId === anchorId
  const actionsVisible = actions !== 'none' && seg.type === 'single' && seg.msg.role === 'assistant' && nextSeg?.type !== 'execution'
  return (
    <div
      id={anchorId ? `chat-msg-${anchorId}` : undefined}
      style={{
        maxWidth: 1000,
        margin: '0 auto',
        padding: `0 ${contentInset}px`,
        transition: 'background 0.5s',
        background: highlighted ? 'rgba(22, 119, 255, 0.08)' : undefined,
      }}
    >
      <SegmentView
        seg={seg}
        isLastSegment={isLastSegment}
        actions={actionsVisible ? actions : 'none'}
        {...viewProps}
      />
    </div>
  )
}
