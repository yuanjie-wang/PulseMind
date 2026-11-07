// ── ChatBody (PLAN-layout-modes 2026-11-03) ──
// The conversation column's INNER content, extracted from ChatView so the
// same wiring can render in either host of the view-mode layout: the primary
// card (对话优先, ChatView's own card wrapper — byte-identical to the
// pre-extraction DOM) or the side dock's 对话 tab (文件/浏览器优先, passed to
// WorkbenchPane as the chatSlot node). All the conversation wiring — scroll
// tracking, segment building, deliverables, nav jumps, browser binding —
// stays in ChatView; this component is the render face those hooks feed.
//
// Two arms:
//   • transcript (default): scroller + per-turn deliverable cards + streaming
//     cursor + error/retry/pause/extension banners + the floating composer.
//     No wrapper of its own — the fragment mounts straight under the host's
//     card box, so the positioned-ancestor chain the floating Composer
//     anchors against is the host's card (primary) or the dock card (side).
//   • narrow welcome (welcome && narrow): the side chat's empty state — task
//     switcher + a compact centered greeting (the 952-wide WelcomeContent is
//     a primary-column surface) + the inline composer. Chat-primary keeps its
//     own welcome early-return in ChatView, untouched.
//
// Remounting between hosts is accepted (PLAN-layout-modes): conversation
// state lives in ChatView's hooks and the stores, so a host switch only
// resets the scroll position — the follow-tail effect lands the fresh mount
// at the bottom anyway.

import React, { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { Segmented } from 'antd'
import type { AgentStatus, SteerOutcome } from '../../types/agent'
import type { LlmProfile } from '../../types/settings'
import type { CompactionEvent } from '../../../../shared/agent-protocol'
import type { SandboxApprovalMode } from '../../../../shared/sandbox/policy'
import type { Segment } from './message-segments'
import { getSegmentKey } from './message-segments'
import { StreamingCursor } from './StreamingCursor'
import { ErrorDisplay } from './ErrorDisplay'
import { ExtensionPrompt, SubAgentStopPrompt } from './ExtensionPrompt'
import { TurnDeliverablesCard } from './TurnDeliverablesCard'
import type { collectTurnDeliverables, segmentTurnPlacement } from './deliverables'
import { InputArea } from './InputArea'
import { SelectionToolbar } from './SelectionToolbar'
import { ApiKeyGuide } from '../welcome/ApiKeyGuide'
import { useTranslation } from '../../i18n/useTranslation'
import type { NewTaskMode } from '../../stores/newTaskStore'

// The chat scrollers are inset from the pane's right edge by this much. The
// 6px global scrollbar paints flush at the container edge, and that edge is a
// native drag surface the scrollbar must not touch: with the workbench closed
// it is the OS resize border (~4-5px, kept by titleBarStyle:'hidden') — it
// swallows pointer events before they reach the page, so of the 6px scrollbar
// only ~1px actually scrolled and every grab became a window resize; with the
// workbench open the pane's 6px col-resize drag handle sits flush against the
// scrollbar's right edge, one stray pixel into a pane-width drag. The gap
// clears both. (Lives here now — both hosts' scrollers need it, and ChatView's
// welcome region imports it from this module.)
export const CHAT_SCROLLER_EDGE_GAP = 10

/** Breathing room between the newest message's bottom and the top edge of the
 *  floating composer slot. The slot is measured, so this is NOT a guess at its
 *  height — it only keeps the last line off the strip's rounded corner and
 *  drop shadow. */
const TRANSCRIPT_TAIL_GAP = 8

/** staging 载荷（ChatView memo 后传入；与 InputArea 的 props 同形）。 */
interface Staging {
  convId: string
  onSendNow: (text: string) => Promise<boolean>
}

interface ChatBodyProps {
  /** welcome 表单（无消息且非流式）：narrow 形态渲染紧凑欢迎面。 */
  welcome: boolean
  /** 侧栏 dock 形态（视图模式 ≠ chat，对话住在 WorkbenchPane 的对话 tab）。
   *  welcome 时走紧凑面；transcript 形态下目前与主卡无差异，保留字段让
   *  两个宿主的分叉点显式化（窄宽样式后续都挂在这里）。 */
  narrow?: boolean
  // ── transcript ──
  scrollRef: React.RefObject<HTMLDivElement>
  onScroll: () => void
  renderedSegments: Segment[]
  windowTop: number
  turnPlacement: ReturnType<typeof segmentTurnPlacement>
  turnRows: ReturnType<typeof collectTurnDeliverables>
  /** 未落定的 live 轮（本轮产物卡等落定才出，ChatView 按 routineEntryAllowed 算）。 */
  liveTurn: number | undefined
  renderSegment: (seg: Segment, index: number, aboveActions?: React.ReactNode) => React.ReactNode
  showCursor: boolean
  isRequesting: boolean
  workspaceDir?: string
  // ── status banners ──
  agentStatus: AgentStatus
  isError: boolean
  isRetrying: boolean
  retryCountdown: number
  isAwaitingContinue: boolean
  isAwaitingExtension: boolean
  onClearError: () => void
  onRetryLast?: () => void
  onStopExecution?: () => void
  onResumeExecution?: () => void
  onExtendLoop?: () => void
  // ── composer ──
  conversationId?: string
  /** drill-in 覆盖：composer display:none 但保持挂载（草稿契约），永不卸载。 */
  hideComposer?: boolean
  /** messages.length > 0（首轮流式刚开始时可为 false——autoFocus 语义跟随它）。 */
  hasMessages: boolean
  /** 空转录的占位内容（浏览器任务：打开页面的静态开场）。只在没有任何
   *  segment 时渲染——消息一到就让位给转录，不参与滚动高度之外的布局。 */
  emptySlot?: React.ReactNode
  navTopSlot: React.ReactNode
  onSendMessage: (content: string) => void
  onSteer?: (text: string) => Promise<SteerOutcome>
  onCancel: () => void
  staging?: Staging
  profiles?: LlmProfile[]
  activeProfileId?: string
  profilePinned?: boolean
  onSelectProfile?: (profileId: string) => void
  onResetProfile?: () => void
  contextUsed?: number
  contextLength?: number
  lastCompaction?: CompactionEvent | null
  activeExpertId?: string
  /** 已绑会话的解绑回调（ChatView 的 handleUnbindExpert——参数已捕获）。 */
  onUnbindExpert?: () => void
  sendAccentHue?: number
  approvalMode?: SandboxApprovalMode
  onChangeApprovalMode?: (mode: SandboxApprovalMode) => void
  // ── narrow welcome ──
  greeting?: string | null
  taskMode: NewTaskMode
  newTaskProjectId: string | null
  onTaskModeChange: (mode: NewTaskMode) => void
  welcomeFocusToken: string
  composerShakeRef: React.MutableRefObject<HTMLDivElement | null>
  onSendBlocked: () => void
  /** 已配置 API 密钥：false 时窄欢迎面的输入框退场、改出引导卡（与主卡的
   *  hasApiKey 门同一裁定——没有密钥发送必然失败）。 */
  hasApiKey: boolean
}

export function ChatBody({
  welcome,
  isRequesting,
  scrollRef,
  onScroll,
  renderedSegments,
  windowTop,
  turnPlacement,
  turnRows,
  liveTurn,
  renderSegment,
  showCursor,
  workspaceDir,
  agentStatus,
  isError,
  isRetrying,
  retryCountdown,
  isAwaitingContinue,
  isAwaitingExtension,
  onClearError,
  onRetryLast,
  onStopExecution,
  onResumeExecution,
  onExtendLoop,
  conversationId,
  hideComposer,
  hasMessages,
  emptySlot,
  navTopSlot,
  onSendMessage,
  onSteer,
  onCancel,
  staging,
  profiles,
  activeProfileId,
  profilePinned,
  onSelectProfile,
  onResetProfile,
  contextUsed,
  contextLength,
  lastCompaction,
  activeExpertId,
  onUnbindExpert,
  sendAccentHue,
  approvalMode,
  onChangeApprovalMode,
  greeting,
  taskMode,
  newTaskProjectId,
  onTaskModeChange,
  welcomeFocusToken,
  composerShakeRef,
  onSendBlocked,
  hasApiKey,
}: ChatBodyProps): React.ReactElement {
  const { t } = useTranslation()

  // ── Above-card reserve (2026-11-04) ──
  // The floating composer's aboveCard slot (stage strip, plan strip) is
  // absolutely positioned, so it paints OVER the transcript rather than
  // pushing it — the newest message ended up under the strip (user report
  // 「暂存消息会遮挡底部的最新消息」). InputArea measures the slot's persistent
  // content and reports height+gap here; the spacer below adds it to the
  // composer reserve. Hooks sit before the welcome early-return so the hook
  // order stays stable across the two arms.
  // ── 选中文字工具栏的「提问」通道（2026-11-06）──
  // 选中文字 → 引用 chip 挂到 Composer 上沿。InputArea 的引用是自己 state，
  // 外部只能靠一个 token 化的请求对象递进去（token 变了才消费一次，否则
  // 每次宿主重渲染都会重新插入同一段引用）。
  const [quoteRequest, setQuoteRequest] = useState<{ token: number; text: string; conv: string | undefined } | null>(
    null,
  )
  const quoteTokenRef = useRef(0)
  const handleAskSelection = useCallback(
    (text: string) => {
      quoteTokenRef.current += 1
      setQuoteRequest({ token: quoteTokenRef.current, text, conv: conversationId })
    },
    [conversationId],
  )
  /** 请求被吃下之后立刻收回。这条不是锦上添花：InputArea 带着
   *  key={conversationId}，换会话会重建，它内部「已消费」的 ref 随之归零——
   *  宿主这边若还留着旧请求，重建后的新实例就会把它当成新请求再消费一遍，
   *  A 会话摘下的引用于是跑到 B 会话里去了（2026-11-06 用户实测）。请求是
   *  一次性事件，用完即弃，重建后便无物可重放。 */
  const handleQuoteConsumed = useCallback((): void => setQuoteRequest(null), [])
  /** 引用属于它被摘下的那段对话：只把「属于当前会话」的请求递下去。写进对象
   *  而不是在渲染期比对/清状态，是因为状态要能跨渲染存活——派生出来的这个
   *  值天然跟着 conversationId 变，换会话那一帧就已经是 null 了。 */
  const activeQuoteRequest = quoteRequest && quoteRequest.conv === conversationId ? quoteRequest : null

  const [aboveCardReserve, setAboveCardReserve] = useState(0)
  // The composer card's own band (root padding + card height), measured by
  // Composer. 160 was a one-line card plus slack and is the FLOOR, not the
  // number: the Sender autosizes, so a multi-row draft (or header chips) grows
  // the card ~22px per row and the last message slid under both the card and
  // the staged strip above it (user report, same sentence, second round).
  const [composerBand, setComposerBand] = useState(0)
  // At-tail flag for the re-pin below. Written ONLY by the scroll handler (the
  // same discipline as ChatView's followRef): measuring after the reserve
  // changed would always read "away from the tail" — the padding growth IS
  // what pushed it away — while the question is whether the user was at the
  // tail BEFORE it grew.
  const atTailRef = useRef(true)
  const prevPadRef = useRef(0)
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (el) atTailRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100
    onScroll()
  }, [onScroll, scrollRef])
  // The spacer's total: the measured card band (never less than the 160 band
  // the layout was designed around) plus the above-card slot's persistent
  // content. One number, because the re-pin below must fire on growth from
  // EITHER source — typing a new draft row at the tail hides the newest
  // message exactly like staging a row does.
  const composerPad = Math.max(160, composerBand + TRANSCRIPT_TAIL_GAP) + aboveCardReserve
  // Padding alone does not keep the newest message visible: at the tail the
  // extra reserve lands BELOW the fold, so the last message stays exactly where
  // it was and still reads as covered. Growing the pad therefore re-pins to
  // the bottom — only for a reader who was at the tail; someone scrolled up to
  // read history must not be yanked down because a message was staged.
  useLayoutEffect(() => {
    const prev = prevPadRef.current
    prevPadRef.current = composerPad
    if (prev === composerPad) return
    const el = scrollRef.current
    if (!el || !atTailRef.current) return
    el.scrollTop = el.scrollHeight
  }, [composerPad, scrollRef])

  // ── 紧凑 welcome（侧栏对话的空态；主卡 welcome 在 ChatView 的早退分支）──
  if (welcome) {
    // 窄面只提供有出口的档位（review_20261105 中2）：BrowserTaskPanel 只存在
    // 于整页 welcome（ChatView 的早退分支），窄面没有 URL 表单——「浏览器」
    // 档在这里是点了没反应的死档。主卡 welcome 若把 mode 留在 browser（store
    // 是全局单例），窄面按 chat 显示——composer 本就以 chat 形态工作，点任
    // 一档即把真实档位写回 store。
    const narrowMode = taskMode === 'browser' ? 'chat' : taskMode
    return (
      <>
        {/* Task form switcher: 对话/项目两档（browser 只在整页 welcome 有
            出口，见上方 narrowMode）。task-switch 的胶囊样式是全局 CSS——
            主卡早退分支渲染同一张 <style>，两处各自携带保证哪个宿主先挂载
            都有样式。 */}
        <div data-welcome-switcher style={{ flexShrink: 0, display: 'flex', justifyContent: 'center', padding: '12px 0 4px' }}>
          <Segmented
            className="task-switch"
            size="large"
            value={narrowMode}
            onChange={(v) => onTaskModeChange(v as NewTaskMode)}
            options={[
              { label: t('welcome.modeChat'), value: 'chat' },
              { label: t('welcome.modeProject'), value: 'project' },
            ]}
          />
        </div>
        <div data-welcome-region style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', marginRight: CHAT_SCROLLER_EDGE_GAP }}>
          <div style={{ margin: 'auto', textAlign: 'center', padding: '0 24px' }}>
            {greeting && <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--pm-text-strong)' }}>{greeting}</div>}
            <div style={{ marginTop: 6, fontSize: 12, color: 'var(--pm-text-quiet)' }}>{t('welcome.modeChat')}</div>
          </div>
        </div>
        {/* 窄面的输入框同样按密钥门（2026-11-04）：没有密钥时换成引导卡——
            空态只剩一句问候、连「为什么不能输入」都没有，比灰钮更差。 */}
        {hasApiKey ? (
          <div
            ref={composerShakeRef}
            data-welcome-shake="composer"
            style={{ flexShrink: 0, padding: '0 16px 12px', maxWidth: 1048, margin: '0 auto', width: '100%' }}
          >
            <InputArea
              key={conversationId ?? 'new'}
              layout="inline"
              focusToken={welcomeFocusToken}
              sendBlocked={taskMode === 'project' && !newTaskProjectId}
              onSendBlocked={onSendBlocked}
              sendAccentHue={sendAccentHue}
              staging={staging}
              isRequesting={isRequesting}
              isStreaming={agentStatus.status === 'streaming'}
              isAwaitingApproval={agentStatus.status === 'awaiting_approval'}
              isAwaitingInput={agentStatus.status === 'awaiting_user_input'}
              hasMessages={false}
              onSendMessage={onSendMessage}
              onCancel={onCancel}
              profiles={profiles}
              activeProfileId={activeProfileId}
              profilePinned={profilePinned}
              onSelectProfile={onSelectProfile}
              onResetProfile={onResetProfile}
              contextUsed={contextUsed}
              contextLength={contextLength}
              lastCompaction={lastCompaction}
              approvalMode={approvalMode}
              onChangeApprovalMode={onChangeApprovalMode}
            />
          </div>
        ) : (
          <div style={{ flexShrink: 0, padding: '0 16px 12px', maxWidth: 1048, margin: '0 auto', width: '100%' }}>
            <ApiKeyGuide compact />
          </div>
        )}
        <style>{`
          .task-switch { padding: 4px; border-radius: 999px !important; }
          .task-switch .ant-segmented-item { border-radius: 999px !important; }
          .task-switch .ant-segmented-thumb { border-radius: 999px !important; }
          .task-switch .ant-segmented-item-label { padding: 8px 34px !important; font-size: 16px; font-weight: 600; }
        `}</style>
      </>
    )
  }

  // ── transcript 形态：scroller + 横幅 + 浮动 composer（无自有包装——
  //    fragment 直挂宿主的卡盒，浮动 Composer 的定位链与抽取前一致）。──
  return (
    <>
      <div
        ref={scrollRef}
        data-pm-chat-scroll
        onScroll={handleScroll}
        // overflowAnchor: none — when content above the viewport grows after a
        // conversation opens (markdown bodies, images, tool blocks), Chrome's
        // scroll anchoring would otherwise adjust scrollTop to keep the old
        // anchor node stable and drag the view off the tail.
        // marginRight: CHAT_SCROLLER_EDGE_GAP — keeps the scrollbar clear of
        // the native resize border / the workbench pane's drag handle (see the
        // constant's note). 卡内同理（沉浸对话卡同款，滚动条与卡缘的既有关系）。
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          overflowAnchor: 'none',
          marginRight: CHAT_SCROLLER_EDGE_GAP,
        }}
      >
        <div style={{ height: 24 }} />

        {/* 空转录占位（浏览器任务的静态开场）：消息一到 segment 就非空，
            占位随之退场；它与转录共用同一个 scroller，滚动条关系不变。 */}
        {renderedSegments.length === 0 && emptySlot}

        {renderedSegments.map((seg, i) => {
          const abs = windowTop + i
          const turn = turnPlacement.turnOf[abs]
          // 本轮产物卡等轮次完全落定（2026-10-25 用户裁定）：轮次未落定时最后一轮
          // 是 live 轮——文件行随 tool_result 逐个到齐，卡会跟着流式尾巴逐帧下坠、
          // 行数中途变化；落定（idle/completed/error，routine-entry 同一套判定）
          // 后才一次性出现。更早的轮次是已落定的历史，照常出卡。
          const turnDeliverable = turn !== undefined && turn !== liveTurn && turnPlacement.lastSegmentOfTurn[turn] === abs ? turnRows[turn] : undefined
          const card =
            turnDeliverable && turnDeliverable.rows.length > 0 ? (
              <TurnDeliverablesCard deliverable={turnDeliverable} conversationId={conversationId} workspaceDir={workspaceDir} />
            ) : null
          // A turn closing on assistant text mounts the card INSIDE the message
          // (above its 对话工具条); otherwise the card is a sibling block after
          // the turn's last segment — the column wrapper keeps the sibling's
          // footprint aligned with the slotted one (24px inset + 16px margin).
          const cardInMessage = seg.type === 'single' && seg.msg.role === 'assistant'
          return (
            <React.Fragment key={getSegmentKey(seg)}>
              {renderSegment(seg, abs, cardInMessage ? card : undefined)}
              {!cardInMessage && card && <div style={{ maxWidth: 1000, margin: '0 auto', padding: '0 24px' }}>{card}</div>}
            </React.Fragment>
          )
        })}

        {/* data-pm-composer-spacer: the probe's measuring point — the reserve's
            real geometry is verified in scripts/probe-above-card-reserve.mjs. */}
        <div data-pm-composer-spacer="" style={{ minHeight: 1, paddingBottom: composerPad }}>
          {/* 160 = the floating composer's own band (root padding + card).
              aboveCardReserve = the above-card slot's persistent height + gap
              — without it the stage strip paints over the newest message. */}
          {/* The single cursor of a run: at the foot while nothing streams as
              text, otherwise at the end of the live text (SegmentView's tail). */}
          <StreamingCursor show={showCursor} />

          {/* Error state */}
          {isError && (
            <div style={{ maxWidth: 1000, margin: '0 auto', padding: '0 24px' }}>
              <ErrorDisplay message={'error' in agentStatus ? agentStatus.error : 'Unknown error'} onDismiss={onClearError} onRetry={onRetryLast} />
            </div>
          )}

          {/* Retry indicator */}
          {isRetrying && (
            <div style={{ maxWidth: 1000, margin: '0 auto', padding: '0 24px' }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  padding: '8px 16px',
                  margin: '0 16px',
                  background: 'var(--pm-retry-bg)',
                  border: '1px solid var(--pm-retry-border)',
                  borderRadius: 8,
                  fontSize: 12,
                  color: 'var(--pm-retry-ink)',
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ff9500" strokeWidth="2.5" strokeLinecap="round" style={{ flexShrink: 0 }}>
                  <circle cx="12" cy="12" r="10" stroke="var(--pm-retry-border)" strokeWidth="2.5" />
                  <path d="M12 2a10 10 0 0 1 10 10" strokeDasharray="31.4 31.4" strokeDashoffset="0">
                    <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.7s" repeatCount="indefinite" />
                  </path>
                </svg>
                <span>
                  网络波动，正在重试
                  {/* The count is the payload of this banner — but only when it
                      actually arrived: undefined keys render `(/)`, so the
                      parens ride behind key presence, not truthiness. */}
                  {'attempt' in agentStatus && 'maxRetries' in agentStatus && ` (${agentStatus.attempt}/${agentStatus.maxRetries})`}
                  {retryCountdown > 0 && <span style={{ marginLeft: 8, color: 'var(--pm-text-muted)' }}>{retryCountdown}s</span>}
                </span>
              </div>
            </div>
          )}

          {/* Pause — resume or fully stop */}
          {isAwaitingContinue && (
            <div style={{ maxWidth: 1000, margin: '0 auto', padding: '0 24px' }}>
              <SubAgentStopPrompt onConfirm={onStopExecution} onResume={onResumeExecution} />
            </div>
          )}

          {/* Loop extension prompt */}
          {isAwaitingExtension && (
            <div style={{ maxWidth: 1000, margin: '0 auto', padding: '0 24px' }}>
              <ExtensionPrompt
                currentCount={'currentCount' in agentStatus ? agentStatus.currentCount : 50}
                limit={'limit' in agentStatus ? agentStatus.limit : 50}
                onExtend={onExtendLoop}
                onStop={onClearError}
              />
            </div>
          )}
        </div>
      </div>

      {/* 选中文字工具栏（portal 到 body，位置相对视口）：「复制」人人都有，
          「提问」把选中文字递进 Composer——它只在这个宿主里有落点
          （TranscriptView 的复用宿主没有输入框，那里不传 onAsk）。 */}
      <SelectionToolbar containerRef={scrollRef} onAsk={handleAskSelection} />

      <InputArea
        key={conversationId ?? 'new'}
        hidden={hideComposer}
        quoteRequest={activeQuoteRequest}
        onQuoteConsumed={handleQuoteConsumed}
        isRequesting={isRequesting}
        isStreaming={agentStatus.status === 'streaming'}
        isAwaitingApproval={agentStatus.status === 'awaiting_approval'}
        isAwaitingInput={agentStatus.status === 'awaiting_user_input'}
        hasMessages={hasMessages}
        topSlot={navTopSlot}
        onAboveCardReserve={setAboveCardReserve}
        onCardBand={setComposerBand}
        // No rightInset: the host's reserve already ends the in-flow
        // wrapper at the pane's left edge, and the composer is absolute
        // INSIDE that wrapper — an inset here would deduct the pane twice.
        onSendMessage={onSendMessage}
        onSteer={onSteer}
        onCancel={onCancel}
        profiles={profiles}
        activeProfileId={activeProfileId}
        profilePinned={profilePinned}
        onSelectProfile={onSelectProfile}
        onResetProfile={onResetProfile}
        contextUsed={contextUsed}
        contextLength={contextLength}
        lastCompaction={lastCompaction}
        boundExpertId={activeExpertId}
        // The conversation's project keeps coloring the send button after the
        // first message — the color belongs to the task, not to the welcome form.
        sendAccentHue={sendAccentHue}
        staging={staging}
        onUnbindExpert={onUnbindExpert}
        approvalMode={approvalMode}
        onChangeApprovalMode={onChangeApprovalMode}
      />
    </>
  )
}
