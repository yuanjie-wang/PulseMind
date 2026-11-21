/**
 * One transcript segment's body, shared by the main chat and the tool studio so
 * both render messages, execution segments and streaming text identically.
 */
import React from 'react'
import { MessageGroup, type MessageActions } from './MessageGroup'
import { ExecutionSegment } from './ExecutionSegment'
import { ENTER_ANIM } from './motion'
import type { Segment } from './message-segments'
import type { TurnMessageStats } from '../../../../shared/agent-session/message-stats'

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
  /** 回合级统计聚合（2026-11-21 user ruling，见 MessageGroup 同名 prop）：宿主
   *  按回合最后一段下发；缺省宿主回落为逐消息统计。 */
  turnStats?: TurnMessageStats
  /** 撤掉本段的统计行（回合中间的叙述段），见 MessageGroup 同名 prop。 */
  hideStats?: boolean
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

/** The open live segment: streaming thinking ('streaming-think') and streaming
 *  tool deltas ('streaming-exec') both mark it as receiving. */
const isLiveSlice = (m: { id: string }): boolean => m.id === 'streaming-exec' || m.id === 'streaming-think'

export function SegmentView({
  seg,
  isLastSegment,
  actions,
  aboveActions,
  turnStats,
  hideStats,
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

  // 流式尾段和它落地后的段落走同一个分支、同一个组件类型（2026-11-13, step 2）。
  // 提交那一帧变的只有 props：`live` 变 undefined，settled-only 的外壳（动作行、
  // aboveActions）随之回来。React 因此原地更新，不卸载 markdown 子树 —— 这正是
  // 最后一段文字落地时不再重排的原因。
  return (
    <MessageGroup
      msg={seg.msg}
      live={seg.live}
      actions={seg.live ? 'none' : actions}
      aboveActions={seg.live ? undefined : aboveActions}
      turnStats={turnStats}
      hideStats={hideStats}
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
  // A live tail has no anchor to offer (see getSegmentAnchorId in
  // message-segments): its id is synthetic and changes with the stream.
  if (seg.type === 'single') return seg.live ? undefined : seg.msg.id.replace(/__\w+$/, '')
  if (seg.type === 'execution') return seg.msgs[0]?.id?.replace(/__\w+$/, '')
  return undefined
}

/**
 * A segment in the standard transcript column, optionally highlighted.
 *
 * memo（user 2026-11-09「对话区上下滚动有卡顿」）：转录区不做虚拟化，跳过重渲染靠的
 * 是一对前提——「段对象身份不变」（message-segments 的结构共享缓存把未变段落的对象
 * 留住，注释原话「cached segment objects keep their identity so React.memo can skip
 * them」）加「props 身份稳定」。本层挂上同一个契约，省掉的是内层 memo 够不到的那一段：
 * SegmentView 的分支判断、StreamingText 的节流记账、StreamingMarkdown 包装层，以及这
 * 层 div 自己的 props diff。实测（scripts/probe-transcript-perf.mjs，22 条消息 + 每帧
 * 一个流式 chunk；对照 = 已修 handler 身份、但不挂本 memo）：一次 chunk 的同步渲染
 * 1.64ms vs 2.13ms。**真正的病根是 handler 身份**（见 TranscriptView 的 handlersRef，
 * 那一处不改则单次 chunk 12.45ms）；这里是让段落层也纳入同一份契约，不是主修。
 */
export const SegmentBlock = React.memo(function SegmentBlock({
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
  const actionsVisible = actions !== 'none' && seg.type === 'single' && seg.live === undefined && seg.msg.role === 'assistant' && nextSeg?.type !== 'execution'
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
})
