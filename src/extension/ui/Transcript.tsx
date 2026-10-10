/** Transcript: the panel's message stream, mirrored from the desktop chat.
 *
 * The desktop renders `TranscriptView` → `SegmentBlock` → `MessageGroup`
 * (components/chat/*). The panel cannot import those (they depend on antd, the
 * renderer stores and `window.electronAPI`); what it can do is reproduce their
 * markup and classes, which is what this file and `MessageBlocks.tsx` do — the
 * values live in ui/styles.css, one annotated entry per renderer rule.
 *
 * Two deliberate differences from the desktop:
 *  - no execution-segment grouping: the chat folds a tool_use→tool_result cycle
 *    of an execution into one collapsible band (ExecutionSegment); the panel
 *    lists each tool card in message order, which is the same content without
 *    the extra collapse.
 *  - the action row is always the chat's `viewOnly` variant (copy / download /
 *    耗时 / Token) — like & favorite write message metadata, and a panel session
 *    has no conversation row to write to.
 *
 * One rule is mirrored, not differed: the row belongs to a turn's FINAL output
 * only. The chat decides that per segment (SegmentBlock's `actionsVisible`: a
 * text followed by an execution segment hides its row); the flat list here
 * decides it per message — `actionRowIds` below.
 *
 * The panel also shows the two things the desktop shows inline because they are
 * *held* on the client: a tool call waiting for approval, and an ask_user
 * question. Both are answered from here over the extension's reverse RPC. */

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { ContentBlock, ToolResultBlock, ToolUseBlock } from '../../shared/types/agent'
import type { SessionState } from '../../shared/agent-session/mirror'
import { ActionRow, AskUserBatchBlock, CursorRow, ErrorCard, MarkdownBlock, ThinkingBlock, ToolBlock } from './MessageBlocks'

type Message = SessionState['messages'][number]

/** How close to the bottom still counts as "following the tail" (px). The panel
 *  scrollport is ~450px tall, so this is the chat's 100px rule scaled down. */
const NEAR_BOTTOM_PX = 80

/** Tool calls whose tool_result is already in the transcript. Hydrated history
 *  has tool_use statuses stripped on save, so a matching result is the only
 *  proof a call finished (the desktop's rule, same reason). */
function completedToolIds(message: Message): Set<string> {
  const ids = new Set<string>()
  for (const block of message.contentBlocks ?? []) {
    if (block.type === 'tool_result') ids.add((block as ToolResultBlock).tool_use_id)
  }
  return ids
}

function hasDisplayable(msg: Message): boolean {
  return (msg.contentBlocks ?? []).some(
    (b) => b.type === 'text' || b.type === 'tool_use' || b.type === 'thinking' || b.type === 'redacted_thinking',
  )
}

/** The messages allowed to render the action row — the ids of every turn's
 *  FINAL assistant text, never the mid-turn narration.
 *
 *  The chat's rule is SegmentBlock's `actionsVisible`: a text whose next segment
 *  is an execution segment hides its row, so only each turn's last answer keeps
 *  one (a replayed history shows a row per turn, not one per transcript). The
 *  panel has no segments, so the same decision per flat message: an assistant
 *  message shows its row unless tool work follows it in the same turn — either
 *  in the message itself (the pre-tool narration of a mixed message, which the
 *  chat splits into text + execution) or in a later assistant message before
 *  the next plain user message starts a new turn. The tail message also stays
 *  bare while the session is running: its turn has not ended, and the row must
 *  not flicker onto an intermediate answer before the next step lands (the
 *  chat never shows one there because in-flight text lives in its own
 *  streaming segment). */
function actionRowIds(messages: Message[], busy: boolean): Set<string> {
  const ids = new Set<string>()
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role !== 'assistant') continue
    const blocks = msg.contentBlocks ?? []
    let workFollows = blocks.some((b) => b.type === 'tool_use' && (b as ToolUseBlock).name !== 'ask_user')
    if (!workFollows) {
      for (let j = i + 1; j < messages.length; j++) {
        const next = messages[j]
        if (next.role === 'assistant') {
          workFollows = true
          break
        }
        // A plain user message is the next turn's opening — everything before it
        // settled. Tool results ride with the current turn (the chat folds them
        // into its execution segment), so keep scanning past them.
        if ((next.contentBlocks ?? []).some((b) => b.type !== 'tool_result')) break
      }
    }
    if (!workFollows) ids.add(msg.id)
  }
  if (busy) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') {
        ids.delete(messages[i].id)
        break
      }
    }
  }
  return ids
}

/** Handlers threaded down to each tool block.
 *
 *  `awaitingApproval` is the session's own status, not a per-block flag: a tool
 *  call the engine is holding for approval and one still being generated both
 *  carry `status === 'pending'` on the block, and the session status is the only
 *  thing that tells them apart. */
interface BlockHandlers {
  awaitingApproval: boolean
  onApprovalResponse: (toolUseId: string, approved: boolean) => void
  onAnswer: (toolUseId: string, response: string) => void
}

/** Several asks dispatched in ONE turn render as ONE batch card at the first
 *  ask's position (the desktop MessageGroup's 2026-10-06 merge — the panel
 *  listed them individually until 几个问题同时出现 felt broken: N live cards
 *  bury the guidance and let answers land out of order). A single ask keeps
 *  the plain card; non-ask blocks pass through untouched. */
function groupAsks(blocks: ContentBlock[]): { block: ContentBlock; askGroup?: ToolUseBlock[]; skip?: boolean }[] {
  const asks = blocks.filter((b) => b.type === 'tool_use' && (b as ToolUseBlock).name === 'ask_user') as ToolUseBlock[]
  if (asks.length < 2) return blocks.map((block) => ({ block }))
  const firstAskIdx = blocks.findIndex((b) => b.type === 'tool_use' && (b as ToolUseBlock).name === 'ask_user')
  return blocks.map((block, i) => {
    if (block.type !== 'tool_use' || (block as ToolUseBlock).name !== 'ask_user') return { block }
    return i === firstAskIdx ? { block, askGroup: asks } : { block, skip: true }
  })
}

function AssistantBlock({ block, completed, streaming, handlers }: {
  block: ContentBlock
  completed: Set<string>
  /** The live stream's tail: an unterminated ```html fence previews instead of
   *  showing raw source (the settled history render is always complete). */
  streaming: boolean
  handlers: BlockHandlers
}): React.JSX.Element | null {
  switch (block.type) {
    case 'text':
      return <MarkdownBlock text={block.text} streaming={streaming} />
    case 'thinking':
      return <ThinkingBlock block={block} />
    case 'redacted_thinking':
      // The chat's inline lock line (MessageGroup's redacted branch).
      return (
        <div className="pm-thinking">
          <div className="pm-thinking-head">
            <span className="pm-thinking-caret">🔒</span>
            <span className="pm-thinking-title">Thinking redacted</span>
          </div>
        </div>
      )
    case 'tool_use': {
      const tool = block as ToolUseBlock
      return (
        <ToolBlock
          block={tool}
          completedFromResult={completed.has(tool.id)}
          // 'pending' + the session holding for approval = the user's turn.
          awaiting={handlers.awaitingApproval && tool.status === 'pending'}
          onApprovalResponse={handlers.onApprovalResponse}
          onAnswer={handlers.onAnswer}
        />
      )
    }
    default:
      // tool_result lives inside its own card (the chat's rendering too).
      return null
  }
}

function Message({ message, handlers, showRow }: {
  message: Message
  handlers: BlockHandlers
  /** Whether this message may carry the action row — `actionRowIds` decides. */
  showRow: boolean
}): React.JSX.Element | null {
  if (!hasDisplayable(message)) return null
  const isUser = message.role === 'user'

  if (isUser) {
    const text = (message.contentBlocks ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('\n')
    if (!text) return null
    return (
      <div className="pm-row-user">
        <div className="pm-bubble">
          <MarkdownBlock text={text} className="" />
        </div>
      </div>
    )
  }

  const completed = completedToolIds(message)
  const text = (message.contentBlocks ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('\n')

  return (
    <div className="pm-row-assistant">
      <div className="pm-bubble-assistant">
        {groupAsks(message.contentBlocks ?? []).map((entry, i) =>
          entry.skip ? null : entry.askGroup ? (
            <AskUserBatchBlock key={i} blocks={entry.askGroup} onAnswer={handlers.onAnswer} />
          ) : (
            <AssistantBlock key={i} block={entry.block} completed={completed} streaming={false} handlers={handlers} />
          ),
        )}
      </div>
      {/* The chat's row: 复制 / 下载 / 耗时 / Token (its `viewOnly` variant —
          like & favorite write message metadata a panel session has no row
          for). Only a turn's final output gets one (`actionRowIds`). */}
      {text && showRow ? <ActionRow text={text} msg={message} /> : null}
    </div>
  )
}

function StreamingBlocks({ blocks, handlers }: { blocks: ContentBlock[]; handlers: BlockHandlers }): React.JSX.Element | null {
  const visible = blocks.filter((b) => b.type === 'text' || b.type === 'thinking' || b.type === 'tool_use')
  if (visible.length === 0) return null
  return (
    <div className="pm-row-assistant">
      <div className="pm-bubble-assistant">
        {groupAsks(visible).map((entry, i) =>
          entry.skip ? null : entry.askGroup ? (
            <AskUserBatchBlock key={`stream-${i}`} blocks={entry.askGroup} onAnswer={handlers.onAnswer} />
          ) : (
            <AssistantBlock key={`stream-${i}`} block={entry.block} completed={new Set()} streaming={true} handlers={handlers} />
          ),
        )}
      </div>
    </div>
  )
}

export function Transcript({ session, busy, onApprovalResponse, onAnswer, onClearError }: {
  session: SessionState
  busy: boolean
  onApprovalResponse: (toolUseId: string, approved: boolean) => void
  onAnswer: (toolUseId: string, response: string) => void
  onClearError: () => void
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  /** Whether the next commit should keep the view at the tail (see handleScroll). */
  const followRef = useRef(true)
  const status = session.agentStatus
  const handlers: BlockHandlers = {
    awaitingApproval: status.status === 'awaiting_approval',
    onApprovalResponse,
    onAnswer,
  }

  // Whether the view is close enough to the tail to keep following it. Written
  // by scroll events only, never by a measurement taken after the content
  // changed: growth moves the tail away on its own, and one update can easily
  // add more than the threshold (a whole answer appended at once, a chunk of
  // streamed markdown) — measuring there reads as "the user scrolled up" and
  // then un-follows for the rest of the turn. The desktop chat tracks it the
  // same way (ChatView's `isNearBottomRef`, written by handleScroll and by
  // nothing else).
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
  }, [])

  // Follow the tail while the user is already at the bottom, so scrolling back
  // through an earlier run is not yanked forward (TranscriptView's rule). Snaps
  // after every commit — streaming deltas, appended messages and the busy cursor
  // all change the height — and before the paint, so new content cannot flash at
  // the old offset first. A plain `scrollTop` write, not `scrollIntoView`:
  // `block: 'end'` stops at the scrollport's edge and leaves the tail this
  // transcript's own bottom padding short of it (measured 7px), and the write
  // this way stays scoped to this element.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || !followRef.current) return
    el.scrollTop = el.scrollHeight
  })

  // 尺寸切换的补间（App 的 .pm-panel-animating）逐帧改变滚动区的盒子，而过渡
  // 期间 React 不提交——上面那次提交时的吸底会停在中间态，尾巴一直差着直到下
  // 一条流式分片。ResizeObserver 把跟随补齐到每一帧：只在跟随态动作，尺寸不
  // 变时它不触发，没有常驻成本。observe 的首次回调和上面的初始吸底等价，无害。
  // 回调里写 scrollTop 会触发一次 scroll 事件，handleScroll 重算后仍是跟随态，
  // 不会成环（RO 只看盒子尺寸，不看滚动位置）。
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      if (followRef.current) el.scrollTop = el.scrollHeight
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const hasContent = session.messages.length > 0 || session.streamingBlocks.length > 0
  const rowIds = actionRowIds(session.messages, busy)

  return (
    <div className="pm-transcript" ref={scrollRef} onScroll={handleScroll}>
      {!hasContent && !busy ? (
        <div className="pm-empty">
          在当前页面里直接对话。{'\n'}试试「总结这个页面」「把这个表单填了」。
        </div>
      ) : null}
      <div className="pm-column">
        {session.messages.map((message) => (
          <Message key={message.id} message={message} handlers={handlers} showRow={rowIds.has(message.id)} />
        ))}
        <StreamingBlocks blocks={session.streamingBlocks} handlers={handlers} />
        {busy ? <CursorRow /> : null}
      </div>
      {status.status === 'error' && (
        <div className="pm-column">
          <ErrorCard message={'error' in status ? status.error : '未知错误'} onDismiss={onClearError} />
        </div>
      )}
    </div>
  )
}
