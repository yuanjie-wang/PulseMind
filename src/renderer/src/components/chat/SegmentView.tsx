/**
 * One transcript segment's body, shared by the main chat and the tool studio so
 * both render messages, execution segments and streaming text identically.
 */
import React, { useRef } from 'react'
import { XMarkdown, type XMarkdownProps } from '@ant-design/x-markdown'
import Latex from '@ant-design/x-markdown/plugins/Latex'
import { MessageGroup, type MessageActions } from './MessageGroup'
import { ExecutionSegment } from './ExecutionSegment'
import { CodeBlock } from './CodeBlock'
import { StreamingCaret } from './StreamingCaret'
import { useMarkdownThemeClass } from '../../theme/mode'
import { createTextThrottle, STREAM_PARSE_MIN_INTERVAL } from './stream-throttle'
import { ENTER_ANIM } from './motion'
import type { ContentBlock } from '../../types/agent'
import { lastLiveTextIndex, type Segment } from './message-segments'

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
  /** Open a spawn_agent card's sub-conversation in the host's session view
   *  (`components/subagent/SubAgentSessionView`). Optional: a host that passes
   *  nothing renders the spawn card without its 查看子代理会话 icon. */
  onOpenSubAgent?: (subConvId: string, title: string) => void
  isRequesting?: boolean
  /** A node mounted between a settled message's bubble and its action
   *  toolbar (the turn deliverables card). Only meaningful for 'single'
   *  segments; execution segments have no toolbar and ignore it. */
  aboveActions?: React.ReactNode
  /** The engine is parked awaiting approval (`agentStatus: 'awaiting_approval'`).
   *  A held call opens its way out of both collapsed layers — the execution
   *  segment and the tool card — so 运行/跳过 never need expanding. Optional and
   *  defaulting to off: a host that doesn't report the status renders exactly as
   *  it did before (its pending calls simply stay collapsed). */
  awaitingApproval?: boolean
  /** 存为日常任务, onto the segment's action row (see MessageGroup). Optional:
   *  ChatView passes it for the conversation's last settled assistant message
   *  only; every other host leaves it off and renders as before. */
  onExtractRoutine?: () => void | Promise<void>
  /** 重发 on the user bubble's hover toolbar (see MessageGroup). Optional: only
   *  hosts with a send channel (ChatView) pass it; everything else renders the
   *  copy button alone. */
  onResendUserMessage?: (text: string) => void
  onApproveTool: (toolUseId: string, alwaysAllow?: boolean) => void
  onRejectTool: (toolUseId: string) => void
  onKillTool?: (toolUseId: string) => void
  /** 运行中「转入后台」(PLAN-background-tasks A). Optional: hosts without the
   *  handler render the card without the button. */
  onPromoteTool?: (toolUseId: string) => void
  onRespondToTool?: (toolUseId: string, response: string) => void
}

/** Streaming text is markdown, rendered with the same components as a settled
 *  message so nothing reflows when the stream lands.
 *
 *  The parse is throttled (PLAN-long-task-perf M1-T3, measured in
 *  probe-chat-stream-perf): each tick used to re-parse the WHOLE accumulated
 *  text, a cost that grows with the answer (9.4→15.7ms/tick over a 20KB
 *  answer, ~half the sampled renderer CPU in the markdown pipeline). The
 *  snapshot XMarkdown sees now advances at most every
 *  STREAM_PARSE_MIN_INTERVAL — the same component on both sides of the
 *  streaming/settled boundary is the anti-reflow design and is untouched; only
 *  the snapshot's freshness is quantized, and the settled message always
 *  carries the complete text. */
function StreamingText({ blocks, toolsStarted }: { blocks: ContentBlock[]; toolsStarted?: boolean }): React.ReactElement {
  const mdClass = useMarkdownThemeClass()
  // Per-block throttles (streaming usually carries one text block; a Map keeps
  // several stable). feed() is O(1) and idempotent for the shown text, so
  // running it here every tick is nothing — what it gates is the parse below.
  // toolsStarted force-advances the snapshot: the tick that mounts the tool
  // card below this segment must render the sentence COMPLETE, not one
  // interval behind (2026-10-28 report). During the tool-args phase the text
  // no longer changes, so the forced feed is an idempotent no-op there.
  const throttlesRef = useRef<Map<number, ReturnType<typeof createTextThrottle>>>(new Map())
  // The caret rides the last block that has text — the end of what the user is
  // reading — and yields once the round moves on to its tool call (the text is
  // finished reading material then; hasLiveTextTail is the same test over the
  // segment, so the foot caret takes over exactly when this one steps aside).
  const tailIndex = lastLiveTextIndex(blocks)
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 12 }}>
      <div style={{ paddingLeft: 12, width: '100%', fontSize: 14, lineHeight: 1.6 }}>
        {blocks.map((block, i) => { // eslint-disable-line react-hooks/refs -- per-block throttle cache: a structural-sharing cache, not UI state (same pattern as TranscriptView)
          if (block.type !== 'text') return null
          let throttle = throttlesRef.current.get(i)
          if (!throttle) {
            throttle = createTextThrottle(STREAM_PARSE_MIN_INTERVAL)
            throttlesRef.current.set(i, throttle)
          }
          // eslint-disable-next-line react-hooks/purity -- the stream throttle's arrival clock: feed() decides how much of the accumulated text may show now
          const shown = throttle.feed(block.text, performance.now(), toolsStarted === true)
          return (
            <div key={i} className={mdClass} style={{ color: 'var(--pm-text-strong)' }}>
              <StreamingMarkdown shown={shown} tail={i === tailIndex && toolsStarted !== true} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** x-markdown's streaming mode for the live tail. `hasNextChunk` holds an
 *  unclosed token back until it closes — half a `**` or a `[text](` no longer
 *  flashes as raw syntax between refreshes; `enableAnimation` fades in each
 *  refresh's new text per block (the throttle sets the chunk size, the default
 *  200ms fade overlaps the 150ms interval; motion.tsx's reduced-motion rule
 *  covers the keyframe). The flag is a constant `true`, not `isStreaming`: this
 *  component exists only while the segment is live — the settled message is a
 *  different segment rendering a plain XMarkdown — and the memo below only
 *  watches `shown`/`tail`, so a flipping flag would be swallowed anyway.
 *  Module constants because XMarkdown memoizes on the object's identity. */
type StreamingOption = NonNullable<XMarkdownProps['streaming']>
const STREAMING_MD: StreamingOption = { hasNextChunk: true, enableAnimation: true }
/** The caret at the end of the live text: the transcript's own glyph, which
 *  the foot StreamingCursor stops drawing while this tail exists. x-markdown
 *  injects it after the last text token, so an empty `shown` draws none. */
function StreamingTail(): React.ReactElement {
  return <StreamingCaret style={{ marginLeft: 2 }} />
}
const STREAMING_MD_TAIL: StreamingOption = { ...STREAMING_MD, tail: { component: StreamingTail } }

/** The parse boundary. Memoized on the FROZEN snapshot: the live text changes
 *  every tick, but `shown` only advances at STREAM_PARSE_MIN_INTERVAL, so
 *  between advances this skips the render entirely — and XMarkdown's parse
 *  with it. That skip is where the throttle's saving lives (a same-content
 *  re-render would re-parse anyway). */
const StreamingMarkdown = React.memo(
  function StreamingMarkdown({ shown, tail }: { shown: string; tail: boolean }): React.ReactElement {
    return (
      <XMarkdown
        content={shown}
        streaming={tail ? STREAMING_MD_TAIL : STREAMING_MD}
        components={{ code: CodeBlock }}
        config={{ extensions: Latex() }}
      />
    )
  },
  (a, b) => a.shown === b.shown && a.tail === b.tail,
)

/** The open live segment: streaming thinking ('streaming-think') and streaming
 *  tool deltas ('streaming-exec') both mark it as receiving. */
const isLiveSlice = (m: { id: string }): boolean => m.id === 'streaming-exec' || m.id === 'streaming-think'

export function SegmentView({
  seg,
  isLastSegment,
  actions,
  aboveActions,
  conversationId,
  conversationTitle,
  onOpenSubAgent,
  isRequesting,
  awaitingApproval,
  onExtractRoutine,
  onResendUserMessage,
  onApproveTool,
  onRejectTool,
  onKillTool,
  onPromoteTool,
  onRespondToTool,
}: SegmentViewProps): React.ReactElement {
  if (seg.type === 'streaming') return <StreamingText blocks={seg.blocks} toolsStarted={seg.toolsStarted === true} />

  if (seg.type === 'execution') {
    return (
      <ExecutionSegment
        messages={seg.msgs}
        isLastSegment={isLastSegment}
        isRequesting={!!isRequesting}
        isReceiving={seg.msgs.some(isLiveSlice)}
        onApproveTool={onApproveTool}
        onRejectTool={onRejectTool}
        onKillTool={onKillTool ?? onRejectTool}
        onRespondToTool={onRespondToTool}
        conversationId={conversationId}
        conversationTitle={conversationTitle}
        onOpenSubAgent={onOpenSubAgent}
        awaitingApproval={awaitingApproval}
      />
    )
  }

  return (
    <MessageGroup
      msg={seg.msg}
      actions={actions}
      aboveActions={aboveActions}
      onApproveTool={onApproveTool}
      onRejectTool={onRejectTool}
      onRespondToTool={onRespondToTool}
      onKillTool={onKillTool ?? onRejectTool}
      onPromoteTool={onPromoteTool}
      conversationId={conversationId}
      conversationTitle={conversationTitle}
      onOpenSubAgent={onOpenSubAgent}
      onExtractRoutine={onExtractRoutine}
      onResendUserMessage={onResendUserMessage}
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
  enter = false,
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
  /** A newly arrived segment (use-segment-entrance): one entrance animation on
   *  this mount. History hydration and windowed remounts pass nothing and
   *  render settled. */
  enter?: boolean
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
        background: highlighted ? 'var(--pm-link-bg)' : undefined,
        animation: enter ? ENTER_ANIM : undefined,
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
