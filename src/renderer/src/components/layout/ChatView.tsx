import React, { useRef, useEffect, useCallback, useMemo, useId, useState } from 'react'
import type { AgentStatus, AgentMessage, ContentBlock, ToolUseBlock } from '../../types/agent'
import type { LlmProfile } from '../../types/settings'
import { Tooltip, Segmented } from 'antd'
import { FolderOpenOutlined } from '@ant-design/icons'
import { SegmentBlock } from '../chat/SegmentView'
import { buildSegments, getSegmentAnchorId, getSegmentKey, type Segment } from '../chat/message-segments'
import { StreamingCursor } from '../chat/StreamingCursor'
import { ErrorDisplay } from '../chat/ErrorDisplay'
import { ExtensionPrompt, SubAgentStopPrompt } from '../chat/ExtensionPrompt'
import { InputArea } from '../chat/InputArea'
import { estimateContextUsed } from '../chat/ContextRing'
import { WelcomeContent } from '../chat/WelcomeContent'
import { startBottomPin } from '../../utils/bottom-pin'
import { useBrowserPaneBinding } from '../../hooks/useBrowserPane'
import { useBrowserPaneStore } from '../../stores/browserPaneStore'
import { BrowserPaneChrome } from '../browser/BrowserPaneChrome'
import { useTranslation } from '../../i18n/useTranslation'
import { useNewTaskStore, type NewTaskMode } from '../../stores/newTaskStore'
import type { ConversationListItem } from '../../types/conversation'

// --- Props ---

interface ChatViewProps {
  messages: AgentMessage[]
  isRequesting: boolean
  /** True while a switched-to conversation is still loading from the DB —
   *  suppresses the welcome screen so it doesn't flash before messages land. */
  isLoadingConversation?: boolean
  agentStatus: AgentStatus
  streamingBlocks: ContentBlock[]
  hasApiKey: boolean
  onSendMessage: (content: string) => void
  onCancel: () => void
  onApproveTool: (toolUseId: string) => void
  onRejectTool: (toolUseId: string) => void
  onKillTool?: (toolUseId: string) => void
  onRespondToTool?: (toolUseId: string, response: string) => void
  onClearError: () => void
  onRetryLast?: () => void
  profiles?: LlmProfile[]
  activeProfileId?: string
  onSelectProfile?: (profileId: string) => void
  onExtendLoop?: () => void
  onResumeExecution?: () => void
  onStopExecution?: () => void
  onSaveConversation?: () => void
  greeting?: string | null
  conversationId?: string
  conversationTitle?: string
  planScrollToMsgId?: string | null
  /** Called once the plan jump has been performed so the parent can clear the
   *  request — without this the scroll effect keeps re-running on every
   *  message/window change and yanks the viewport back to the step. */
  onPlanScrollHandled?: () => void
  contextLength?: number
  /** Resolved working directory of the active conversation (M8.5); shown above
   *  the message list once the main-side session creation reports back. */
  workspaceDir?: string
  /** Conversation list feeding the welcome page's quick entries. */
  conversations: ConversationListItem[]
  /** Conversations with a running loop — status lights in the quick entries. */
  activeLoopConvIds?: string[]
  /** Switch to a conversation picked from the welcome page's quick entries. */
  onOpenConversation: (key: string) => void
  /** The active conversation's summoned expert id (@-mention); absent = unbound. */
  activeExpertId?: string
  /** Clear the active conversation's expert binding (chip ×). */
  onUnbindExpert?: (convId: string) => void
}

// --- Message grouping lives in chat/message-segments (shared with the tool studio) ---

// --- Main component ---

function ChatView({
  messages,
  isRequesting,
  isLoadingConversation,
  agentStatus,
  streamingBlocks,
  onSendMessage,
  onCancel,
  onApproveTool,
  onRejectTool,
  onKillTool,
  onRespondToTool,
  hasApiKey,
  onClearError,
  onRetryLast,
  onExtendLoop,
  onResumeExecution,
  onStopExecution,
  onSaveConversation,
  conversationId,
  conversationTitle,
  profiles,
  activeProfileId,
  onSelectProfile,
  greeting,
  planScrollToMsgId,
  onPlanScrollHandled,
  contextLength,
  workspaceDir,
  conversations,
  activeLoopConvIds,
  onOpenConversation,
  activeExpertId,
  onUnbindExpert,
}: ChatViewProps): React.ReactElement {
  const uid = useId()
  const { t } = useTranslation()
  const taskMode = useNewTaskStore((s) => s.mode)
  const setTaskMode = useNewTaskStore((s) => s.setMode)
  // Context usage for the input area's ring: real input tokens from the API when
  // available, otherwise estimated from the message contents.
  const contextUsed = useMemo(() => estimateContextUsed(messages), [messages])
  const animName = `ecg-scroll-${uid.replace(/[:.]/g, '')}`
  const scrollRef = useRef<HTMLDivElement>(null)
  const isNearBottomRef = useRef(true)

  // ── Windowed rendering ──
  // Only the latest PAGE_SIZE segments render initially; older segments are
  // prepended lazily on scroll-up (extraTop = extra segments above the tail).
  // The live tail stays rendered so streaming / new messages always show.
  const PAGE_SIZE = 50
  const [extraTop, setExtraTop] = useState(0)
  const loadMoreRef = useRef<() => void>(() => {})
  const loadMoreBusyRef = useRef(false)

  // Scroll tracking: near-bottom drives autoscroll and drops prepended history;
  // scroll-up near the top lazily loads one more page of older segments.
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100
    isNearBottomRef.current = nearBottom
    // While a landing is running (conversation switch) or a plan jump's smooth
    // scroll is animating, don't collapse the widened window or trigger
    // lazy-load: our own writes move scrollTop, and the early frames near the
    // top would otherwise widen the window and fight the landing back to the tail.
    if (landingRef.current || suppressPlanScrollRef.current) return
    if (nearBottom) {
      setExtraTop(0)
      return
    }
    if (el.scrollTop < 150) {
      loadMoreRef.current()
    }
  }, [])

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [])

  const prevConvIdRef = useRef(conversationId)
  // In-app browser pane (A-M5): live state from the host store + the
  // binding that pushes what is on screen and folds/restores the WebView.
  const browserPane = useBrowserPaneStore((s) => s.update)
  const paneRootRef = useRef<HTMLDivElement | null>(null)
  const browserPaneBinding = useBrowserPaneBinding(conversationId, paneRootRef)
  const pendingScrollRef = useRef(false)
  const scrollRafRef = useRef<number>(0)
  // Cancel handle for the bottom-pinner started after a conversation switch —
  // content height keeps growing for frames after the messages commit
  // (XMarkdown renders null on first pass; images/code/mermaid load later), so
  // a one-shot scroll lands mid-content. See utils/bottom-pin.ts.
  const cancelPinRef = useRef<(() => void) | null>(null)
  // True while the bottom-pinner owns the viewport. handleScroll must not
  // lazy-load or collapse the window during that window — the pin's own writes
  // move scrollTop, and reacting to them would fight the landing.
  const landingRef = useRef(false)

  useEffect(() => {
    const isConvSwitch = prevConvIdRef.current !== conversationId
    if (isConvSwitch) {
      pendingScrollRef.current = true
      prevConvIdRef.current = conversationId
      cancelPinRef.current?.()
      cancelPinRef.current = null
      setExtraTop(0)
    }

    if (messages.length === 0) return

    if (pendingScrollRef.current) {
      // Conversation switch: always land at the tail, regardless of where the
      // previous conversation was scrolled — isNearBottomRef describes the old
      // viewport and must not veto this. Scroll synchronously (DOM is already
      // committed) so the switch never paints the new conversation at the old
      // scroll offset, then pin while the content height settles.
      pendingScrollRef.current = false
      isNearBottomRef.current = true
      setExtraTop(0)
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
      cancelPinRef.current?.()
      // Must be set synchronously with starting the pin so handleScroll (which
      // reads it) never reacts to the landing's own scroll writes.
      // eslint-disable-next-line react-hooks/immutability
      landingRef.current = true
      cancelPinRef.current = startBottomPin(() => scrollRef.current, {
        onStop: () => {
          landingRef.current = false
        },
      })
      return
    }

    if (!isNearBottomRef.current) return
    setExtraTop(0)
    // Use rAF to let DOM layout settle before measuring scrollHeight
    cancelAnimationFrame(scrollRafRef.current)
    scrollRafRef.current = requestAnimationFrame(scrollToBottom)
  }, [messages, streamingBlocks, scrollToBottom, conversationId])

  // When streaming completes, scroll again after DOM settles (double rAF)
  const prevStatusRef = useRef(agentStatus.status)
  useEffect(() => {
    const prev = prevStatusRef.current
    prevStatusRef.current = agentStatus.status
    if (prev === 'streaming' && agentStatus.status === 'completed' && isNearBottomRef.current) {
      cancelAnimationFrame(scrollRafRef.current)
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = requestAnimationFrame(scrollToBottom)
      })
    }
  }, [agentStatus.status, scrollToBottom])

  // Cleanup rAF on unmount
  useEffect(() => {
    return () => {
      cancelAnimationFrame(scrollRafRef.current)
      cancelPinRef.current?.()
    }
  }, [])

  const isStreaming = agentStatus.status === 'streaming'
  const isAwaitingExtension = agentStatus.status === 'awaiting_extension'
  const isAwaitingContinue = agentStatus.status === 'awaiting_continue'
  const isError = agentStatus.status === 'error'
  const isRetrying = agentStatus.status === 'retrying'
  const [retryCountdown, setRetryCountdown] = useState(0)
  useEffect(() => {
    if (agentStatus.status !== 'retrying') {
      setRetryCountdown(0)
      return
    }
    setRetryCountdown(Math.ceil(agentStatus.delay / 1000) - 1)
    const interval = setInterval(() => {
      setRetryCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(interval)
          return 0
        }
        return prev - 1
      })
    }, 1000)
    return () => clearInterval(interval)
  }, [isRetrying ? agentStatus.attempt : -1])

  const hasMessages = messages.length > 0

  // Accumulate streaming tool_use blocks across renders so OpenAI's per-delta
  // tool_call chunks don't appear as scattered execution segments.
  const streamingToolAccumRef = useRef<Map<string, ToolUseBlock>>(new Map())

  useEffect(() => {
    if (!isStreaming) streamingToolAccumRef.current.clear()
  }, [isStreaming])

  // Structural sharing: reuse previous Segment objects when underlying messages
  // haven't changed. Messages are append-only, so old segments never mutate.
  const cachedSegmentsRef = useRef<readonly Segment[]>([])

  const allSegments = useMemo((): Segment[] => {
    const segs = buildSegments({
      messages,
      isStreaming,
      streamingBlocks,
      cached: cachedSegmentsRef.current,
      streamingToolAccum: streamingToolAccumRef.current,
    })
    cachedSegmentsRef.current = segs
    return segs
  }, [messages, isStreaming, streamingBlocks])

  // Windowed render slice: always includes the live tail, optionally prepending
  // extraTop older segments above it. Keeps DOM size bounded for long threads.
  const windowTop = Math.max(0, allSegments.length - PAGE_SIZE - extraTop)
  const renderedSegments = allSegments.slice(windowTop)

  // Lazy-load one more page of older segments on scroll-up. The segment that was
  // topmost is used as a scroll anchor: after React prepends the older segments,
  // scrollTop is restored so the content doesn't visibly jump.
  const loadMore = useCallback(() => {
    if (loadMoreBusyRef.current) return
    const el = scrollRef.current
    if (!el) return
    if (windowTop <= 0) return
    const topSeg = renderedSegments[0]
    const anchorId =
      topSeg?.type === 'single' ? topSeg.msg.id.replace(/__\w+$/, '') : topSeg?.type === 'execution' ? topSeg.msgs[0]?.id?.replace(/__\w+$/, '') : undefined
    if (!anchorId) return
    const anchorEl = document.getElementById(`chat-msg-${anchorId}`)
    const anchorTop = anchorEl ? anchorEl.getBoundingClientRect().top : null

    loadMoreBusyRef.current = true
    setExtraTop((e) => Math.min(allSegments.length, e + PAGE_SIZE))

    // Double rAF: wait for React to commit the new segments before restoring scroll.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        loadMoreBusyRef.current = false
        const elAfter = scrollRef.current
        const anchorAfter = document.getElementById(`chat-msg-${anchorId}`)
        if (elAfter && anchorAfter && anchorTop !== null) {
          elAfter.scrollTop += anchorAfter.getBoundingClientRect().top - anchorTop
        }
      }),
    )
  }, [windowTop, renderedSegments, allSegments.length])

  // handleScroll is stable (deps: []) and reads the latest loadMore via this
  // ref; the effect keeps the ref in sync after every render. loadMore itself
  // decides whether older segments exist (windowTop > 0).
  useEffect(() => {
    loadMoreRef.current = loadMore
  })

  const [highlightedMsgId, setHighlightedMsgId] = useState<string | null>(null)
  // Stable ref for the plan-jump-done callback so the effect below never needs it
  // in deps (the parent's inline arrow would otherwise re-run the effect every render).
  const onPlanScrollHandledRef = useRef(onPlanScrollHandled)
  onPlanScrollHandledRef.current = onPlanScrollHandled
  // Timers live in refs and are only cancelled on unmount, not on effect re-runs:
  // the parent clears planScrollToMsgId right after the jump (see below), which
  // re-runs this effect and would otherwise cancel the pending highlight clear.
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout>>()
  // Set while the plan jump's smooth scroll is animating so handleScroll doesn't
  // collapse the widened window mid-animation (see handleScroll).
  const suppressPlanScrollRef = useRef(false)
  useEffect(
    () => () => {
      clearTimeout(highlightTimerRef.current)
      clearTimeout(scrollTimerRef.current)
    },
    [],
  )

  // Map any message id to the chat-msg-* anchor of its segment. Execution
  // segments merge several assistant messages but expose only one DOM anchor
  // (msgs[0].id), so plan steps whose advance_plan lives deeper in a segment
  // must resolve to that anchor to be locatable. Kept in a ref because
  // allSegments changes on every message append (avoid re-running scroll).
  const msgIdToAnchorRef = useRef(new Map<string, string>())
  useEffect(() => {
    const map = new Map<string, string>()
    for (const seg of allSegments) {
      if (seg.type === 'execution') {
        const anchor = seg.msgs[0].id.replace(/__\w+$/, '')
        for (const m of seg.msgs) map.set(m.id.replace(/__\w+$/, ''), anchor)
      } else if (seg.type === 'single') {
        const id = seg.msg.id.replace(/__\w+$/, '')
        map.set(id, id)
      }
    }
    msgIdToAnchorRef.current = map
  }, [allSegments])

  // Plan panel scroll-to-message
  useEffect(() => {
    if (!planScrollToMsgId) return
    const targetId = msgIdToAnchorRef.current.get(planScrollToMsgId) ?? planScrollToMsgId
    // If the target segment is above the rendered window, widen it so the target's
    // anchor mounts; the effect re-runs after windowTop settles, then scrolls below.
    const anchor = document.getElementById(`chat-msg-${targetId}`)
    if (!anchor) {
      const targetIdx = allSegments.findIndex((seg) => getSegmentAnchorId(seg) === targetId)
      if (targetIdx >= 0 && targetIdx < windowTop) {
        setExtraTop(Math.max(extraTop, allSegments.length - PAGE_SIZE - targetIdx))
        return
      }
      // Target segment isn't loaded and can't be widened to — stop retrying.
      onPlanScrollHandledRef.current?.()
      return
    }
    setHighlightedMsgId(targetId)
    clearTimeout(scrollTimerRef.current)
    // Suppress near-bottom collapse while the smooth scroll runs. Must be set
    // synchronously (not in a timeout) so handleScroll never fires mid-scroll.
    // eslint-disable-next-line react-hooks/immutability
    suppressPlanScrollRef.current = true
    scrollTimerRef.current = setTimeout(() => {
      document.getElementById(`chat-msg-${targetId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      // Let handleScroll resume normal near-bottom collapse / lazy-load once the
      // smooth scroll has settled, and clear the parent's request so this effect
      // stops re-running on later message/window changes (lazy-load, new messages,
      // approval dialogs) — which previously yanked the viewport back to the step
      // after the user scrolled away and re-widened the window after it was
      // collapsed to the tail. Clearing also lets the same step be re-clicked later
      // to jump again.
      setTimeout(() => {
        suppressPlanScrollRef.current = false
      }, 700)
      onPlanScrollHandledRef.current?.()
    }, 100)
    highlightTimerRef.current = setTimeout(() => setHighlightedMsgId(null), 2000)
  }, [planScrollToMsgId, allSegments, windowTop, extraTop])

  // ── Render helpers ──

  const renderSegment = useCallback(
    (seg: Segment, index: number) => (
      <SegmentBlock
        seg={seg}
        nextSeg={allSegments[index + 1]}
        isLastSegment={index === allSegments.length - 1}
        highlightedMsgId={highlightedMsgId}
        isRequesting={isRequesting}
        onApproveTool={onApproveTool}
        onRejectTool={onRejectTool}
        onKillTool={onKillTool ?? onRejectTool}
        onRespondToTool={onRespondToTool}
        conversationId={conversationId}
        conversationTitle={conversationTitle}
        contextLength={contextLength}
      />
    ),
    [highlightedMsgId, allSegments, isRequesting, onApproveTool, onRejectTool, onKillTool, onRespondToTool, conversationId, conversationTitle, contextLength],
  )

  // ── Render ──

  // Welcome page when no messages and not streaming. While a conversation
  // switch is still loading its messages from the DB, skip the welcome screen —
  // falling through to the (empty) message view keeps the layout stable so the
  // loaded content replaces it without a visible flash.
  if (!hasMessages && !isStreaming && !isLoadingConversation) {
    return (
      <div
        style={{
          height: '100%',
          background: '#fff',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Task form switcher (M8.4-rev): 对话 / 项目, its own top band so
            short windows can never slide the content over it (it used to be
            absolutely pinned, and the centered logo overlapped it). Drives the
            same store the welcome page panels and handleRequest consume. */}
        <div style={{ flexShrink: 0, display: 'flex', justifyContent: 'center', padding: '16px 0 8px' }}>
          <Segmented
            className="task-switch"
            size="large"
            value={taskMode}
            onChange={(v) => setTaskMode(v as NewTaskMode)}
            options={[
              { label: t('welcome.modeChat'), value: 'chat' },
              { label: t('welcome.modeProject'), value: 'project' },
            ]}
          />
        </div>

        {/* Welcome content: auto-margin centering that degrades to scrolling
            when the window is too short (alignItems:center would clip the top
            under the switcher instead). */}
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex' }}>
          <WelcomeContent
            greeting={greeting}
            hasApiKey={hasApiKey}
            animName={animName}
            conversations={conversations}
            activeLoopConvIds={activeLoopConvIds}
            onOpenConversation={onOpenConversation}
          />
        </div>

        <div style={{ flexShrink: 0, padding: '0 24px 16px', maxWidth: 1048, margin: '0 auto', width: '100%' }}>
          <InputArea
            key={conversationId ?? 'new'}
            layout="inline"
            isRequesting={isRequesting}
            isStreaming={isStreaming}
            isAwaitingApproval={agentStatus.status === 'awaiting_approval'}
            isAwaitingInput={agentStatus.status === 'awaiting_user_input'}
            hasMessages={hasMessages}
            onSendMessage={(content: string) => {
              isNearBottomRef.current = true
              onSendMessage(content)
            }}
            onCancel={onCancel}
            profiles={profiles}
            activeProfileId={activeProfileId}
            onSelectProfile={onSelectProfile}
            contextUsed={contextUsed}
            contextLength={contextLength}
          />
        </div>
        <style>{`
          /* Task switcher: enlarged capsule (M8.4-rev) — !important beats antd's
             own item/thumb radii, which would otherwise square off the pill */
          .task-switch { padding: 4px; border-radius: 999px !important; }
          .task-switch .ant-segmented-item { border-radius: 999px !important; }
          .task-switch .ant-segmented-thumb { border-radius: 999px !important; }
          .task-switch .ant-segmented-item-label { padding: 8px 34px !important; font-size: 16px; font-weight: 600; }
        `}</style>
      </div>
    )
  }

  // Chat view
  return (
    <div
      ref={paneRootRef}
      style={{
        position: 'relative',
        height: '100%',
        background: '#fff',
        // Reserve the pane strip so chat content never flows under the
        // WebView; transitions off — the drag handle needs 1:1 tracking.
        paddingRight: browserPane.visible ? browserPane.width : 0,
      }}
    >
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        // overflowAnchor: none — when content above the viewport grows after a
        // conversation opens (markdown bodies, images, tool blocks), Chrome's
        // scroll anchoring would otherwise adjust scrollTop to keep the old
        // anchor node stable and drag the view off the tail.
        style={{ height: '100%', overflow: 'auto', overflowAnchor: 'none' }}
      >
        <div style={{ height: 24 }} />

        {/* Resolved working directory (M8.5) — appears once the main-side
            session creation reports back; click opens the folder. */}
        {workspaceDir && (
          <div style={{ maxWidth: 1000, margin: '0 auto', padding: '0 24px', marginBottom: 8 }}>
            <span
              style={{
                fontSize: 11,
                color: '#999',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                background: 'rgba(0,0,0,0.03)',
                borderRadius: 12,
                padding: '2px 10px',
                maxWidth: '100%',
              }}
            >
              {t('chatView.workspaceDir')}
              <code style={{ fontSize: 11, color: '#666', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{workspaceDir}</code>
              <Tooltip title={t('chatView.openWorkspaceDir')}>
                <FolderOpenOutlined
                  style={{ cursor: 'pointer', color: '#999', flexShrink: 0 }}
                  onClick={() => void window.electronAPI.openFolder(workspaceDir)}
                />
              </Tooltip>
            </span>
          </div>
        )}

        {renderedSegments.map((seg, i) => (
          <React.Fragment key={getSegmentKey(seg)}>{renderSegment(seg, windowTop + i)}</React.Fragment>
        ))}

        <div style={{ minHeight: 1, paddingBottom: 160 }}>
          {/* Single blinking cursor — always present during active request */}
          <StreamingCursor show={isRequesting} />

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
                  background: 'rgba(255,149,0,0.08)',
                  border: '1px solid rgba(255,149,0,0.25)',
                  borderRadius: 8,
                  fontSize: 12,
                  color: '#b84d00',
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ff9500" strokeWidth="2.5" strokeLinecap="round" style={{ flexShrink: 0 }}>
                  <circle cx="12" cy="12" r="10" stroke="rgba(255,149,0,0.25)" strokeWidth="2.5" />
                  <path d="M12 2a10 10 0 0 1 10 10" strokeDasharray="31.4 31.4" strokeDashoffset="0">
                    <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.7s" repeatCount="indefinite" />
                  </path>
                </svg>
                <span>
                  网络波动，正在重试 ({agentStatus.attempt}/{agentStatus.maxRetries})
                  {retryCountdown > 0 && <span style={{ marginLeft: 8, color: '#999' }}>{retryCountdown}s</span>}
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

      {browserPane.visible && (
        <BrowserPaneChrome
          pane={browserPane}
          chatAreaWidth={browserPaneBinding.chatAreaWidth}
          onWidth={browserPaneBinding.pushWidth}
          onAction={browserPaneBinding.action}
        />
      )}

      <InputArea
        key={conversationId ?? 'new'}
        isRequesting={isRequesting}
        isStreaming={isStreaming}
        isAwaitingApproval={agentStatus.status === 'awaiting_approval'}
        isAwaitingInput={agentStatus.status === 'awaiting_user_input'}
        hasMessages={hasMessages}
        rightInset={browserPane.visible ? browserPane.width : 0}
        onSendMessage={(content: string) => {
          isNearBottomRef.current = true
          onSendMessage(content)
        }}
        onCancel={onCancel}
        profiles={profiles}
        activeProfileId={activeProfileId}
        onSelectProfile={onSelectProfile}
        contextUsed={contextUsed}
        contextLength={contextLength}
        boundExpertId={activeExpertId}
        onUnbindExpert={() => conversationId && onUnbindExpert?.(conversationId)}
      />
    </div>
  )
}

export default ChatView
