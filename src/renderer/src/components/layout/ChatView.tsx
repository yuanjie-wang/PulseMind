import React, { useRef, useEffect, useCallback, useMemo, useId, useState } from 'react'
import type { AgentStatus, AgentMessage, ContentBlock, ToolUseBlock, Plan } from '../../types/agent'
import type { LlmProfile } from '../../types/settings'
import { Segmented } from 'antd'
import { useNewTaskStore, type NewTaskMode } from '../../stores/newTaskStore'
import { useProjectHue } from '../../stores/projectStore'
import { useNavigationStore } from '../../stores/navigationStore'
import { SegmentBlock } from '../chat/SegmentView'
import { buildSegments, getSegmentAnchorId, getSegmentKey, type Segment } from '../chat/message-segments'
import { routineEntryAllowed, routineEntryTargetIndex } from '../chat/routine-entry'
import { StreamingCursor } from '../chat/StreamingCursor'
import { ErrorDisplay } from '../chat/ErrorDisplay'
import { ExtensionPrompt, SubAgentStopPrompt } from '../chat/ExtensionPrompt'
import { TurnDeliverablesCard } from '../chat/TurnDeliverablesCard'
import { useDeliverables } from '../../hooks/useDeliverables'
import { collectTurnDeliverables, segmentTurnPlacement } from '../chat/deliverables'
import { InputArea } from '../chat/InputArea'
import { projectContextUsed } from '../chat/ContextRing'
import type { CompactionEvent } from '../../../../shared/agent-protocol'
import { WelcomeContent } from '../chat/WelcomeContent'
import { startBottomPin } from '../../utils/bottom-pin'
import { useWelcomeShake } from '../../utils/welcome-shake'
import { useBrowserPaneBinding } from '../../hooks/useBrowserPane'
import { useBrowserPaneStore } from '../../stores/browserPaneStore'
import { useWorkbenchStore } from '../../stores/workbenchStore'
import { WorkbenchPane } from '../workbench/WorkbenchPane'
import { usePreviewPaneStore, DRAFT_CONVERSATION_KEY } from '../../stores/previewPaneStore'
import { usePreviewPaneSync } from '../../hooks/usePreviewPaneSync'
import { useTranslation } from '../../i18n/useTranslation'
import type { ConversationListItem } from '../../types/conversation'
import type { SandboxApprovalMode } from '../../../../shared/sandbox/policy'
import { TABULAR_NUMS } from '../../theme/tokens'

// --- Props ---

interface ChatViewProps {
  messages: AgentMessage[]
  isRequesting: boolean
  /** The active conversation's last compaction pass — drives the ring's
   *  post-compaction projection and the composer's 已压缩 chip. */
  lastCompaction?: CompactionEvent | null
  /** True while a switched-to conversation is still loading from the DB —
   *  suppresses the welcome screen so it doesn't flash before messages land. */
  isLoadingConversation?: boolean
  agentStatus: AgentStatus
  streamingBlocks: ContentBlock[]
  hasApiKey: boolean
  onSendMessage: (content: string) => void
  /** 立即发送 (staged strip): stop the running turn and send this text as a new
   *  turn; false = the send never left (the row restores itself). Absent (or
   *  no conversationId) = the staged queue is off for this view. */
  onSendStaged?: (text: string) => Promise<boolean>
  onCancel: () => void
  onApproveTool: (toolUseId: string) => void
  onRejectTool: (toolUseId: string) => void
  onKillTool?: (toolUseId: string) => void
  onRespondToTool?: (toolUseId: string, response: string) => void
  onClearError: () => void
  onRetryLast?: () => void
  profiles?: LlmProfile[]
  activeProfileId?: string
  /** The active conversation carries its own model choice (`profile_id`
   *  column) — the picker then offers 跟随默认模型 to drop the pin. */
  profilePinned?: boolean
  onSelectProfile?: (profileId: string) => void
  onResetProfile?: () => void
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
  /** The active conversation's plan (workbench 计划 tab + slim status strip). */
  plan?: Plan | null
  /** Plan DAG node click → jump to the node's conversation round. */
  onPlanJump?: (msgId: string) => void
  /** Plan DAG node click → open the node's linked sub-agent session view.
   *  When provided it takes precedence over onPlanJump. */
  onOpenPlanNode?: (nodeId: string) => void
  /** Which plan nodes open something (cursor + tooltip affordance). */
  canOpenNode?: (nodeId: string) => boolean
  /** spawn_agent card's 查看子代理会话 icon → open that sub-agent's session in
   *  the same view the DAG drill-in uses (`SubAgentSessionView`). The chat is
   *  the other entry point: a spawn with no plan node (a plain loop, or a single
   *  @expert summon) has no node to click, so the card is the only way in. */
  onOpenSubAgent?: (subConvId: string, title: string) => void
  /** 存为日常任务: distill the whole conversation into a routine draft and jump
   *  to the routine editor (see useChatController.extractRoutine). Main-chat
   *  only — every other host renders the transcript without this, so the
   *  toolbar button exists exactly where this prop arrives. */
  onExtractRoutine?: () => void | Promise<void>
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
  /** The active conversation's bound expert id (legacy @-summon binding);
   *  absent = unbound. */
  activeExpertId?: string
  /** Clear the active conversation's expert binding (chip ×). */
  onUnbindExpert?: (convId: string) => void
  /** Effective tool-approval level for the composer's 授权 button. */
  approvalMode?: SandboxApprovalMode
  onChangeApprovalMode?: (mode: SandboxApprovalMode) => void
}

// --- Message grouping lives in chat/message-segments (shared with the tool studio) ---

// --- Main component ---

function ChatView({
  messages,
  isRequesting,
  lastCompaction,
  isLoadingConversation,
  agentStatus,
  streamingBlocks,
  onSendMessage,
  onSendStaged,
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
  onSaveConversation: _onSaveConversation,
  conversationId,
  conversationTitle,
  profiles,
  activeProfileId,
  profilePinned,
  onSelectProfile,
  onResetProfile,
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
  approvalMode,
  onChangeApprovalMode,
  plan,
  onPlanJump,
  onOpenPlanNode,
  onOpenSubAgent,
  onExtractRoutine,
  canOpenNode,
}: ChatViewProps): React.ReactElement {
  const uid = useId()
  const { t } = useTranslation()
  const taskMode = useNewTaskStore((s) => s.mode)
  const setTaskMode = useNewTaskStore((s) => s.setMode)
  const newTaskProjectId = useNewTaskStore((s) => s.projectId)
  const viewKind = useNavigationStore((s) => s.view.kind)
  // The welcome composer re-focuses whenever the new-task state (re)enters:
  // the chat view becoming visible again, or the 对话/项目 form changing.
  // Mount-time autoFocus alone misses a welcome surface that never unmounts
  // (the chat view stays mounted while other top-level views show).
  const welcomeFocusToken = `${viewKind}:${taskMode}:${newTaskProjectId ?? ''}`
  // Staged-message queue wiring for both InputArea sites: keyed by the open
  // conversation — absent with none (the first message IS the row's
  // materialization, so nothing can be staged ahead of it) or when the
  // controller didn't hand us the interrupt path (feature off).
  const staging =
    onSendStaged && conversationId ? { convId: conversationId, onSendNow: onSendStaged } : undefined
  // Context usage for the input area's ring: the projected size once a
  // compaction pass ran (the copy the model actually sees, plus everything
  // appended since), otherwise the same live estimate the compactor reads.
  const contextUsed = useMemo(() => projectContextUsed(messages, lastCompaction), [messages, lastCompaction])
  // The spawn tree's delivered files (hydrated at terminal status — see
  // useDeliverables): the per-child map the per-turn cards attribute with.
  const childDeliverables = useDeliverables(conversationId, messages, agentStatus)
  const animName = `ecg-scroll-${uid.replace(/[:.]/g, '')}`
  const scrollRef = useRef<HTMLDivElement>(null)
  const isNearBottomRef = useRef(true)
  // The welcome composer's half of the 新建任务 guidance shake (the picker's
  // half lives in ProjectCards): the wrapper — not InputArea itself, so the
  // component never remounts and the draft survives — wiggles once per click.
  const composerShakeRef = useRef<HTMLDivElement | null>(null)
  useWelcomeShake('composer', composerShakeRef)

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
  // Right-side workbench (PLAN-workbench): one docked pane hosting the file
  // preview, the browser and the plan DAG behind tool tabs. Open state is per
  // conversation — this one's flag, with the draft key for a not-yet-created row.
  const wbKey = conversationId ?? DRAFT_CONVERSATION_KEY
  const workbenchOpen = useWorkbenchStore((s) => s.openByConversation[wbKey] ?? false)
  const workbenchWidth = useWorkbenchStore((s) => s.width)
  const workbenchTab = useWorkbenchStore((s) => s.activeTab)
  useEffect(() => {
    usePreviewPaneStore.getState().switchConversation(conversationId ?? null)
  }, [conversationId])
  // The file tab resolves tool-relative paths against this conversation's
  // workspace; keep the store in sync for the entry-point helpers.
  useEffect(() => {
    usePreviewPaneStore.getState().setWorkspaceDir(workspaceDir ?? null)
  }, [workspaceDir])
  // A fresh browser session (tab count 0 → N) is the main process telling us
  // the browser tool went to work — bring the workbench up on its tab. The
  // ref is keyed to the conversation and only same-conversation pushes may
  // seed it: the pushed update is scoped to the pane's conversation, so an
  // unkeyed 0→N also fires when the user switches to a conversation that
  // already has tabs, or re-fires when a non-chat view's (tabs: []) push
  // decays the count and the user comes back.
  const prevBrowserTabsRef = useRef<{ convKey: string; count: number } | null>(null)
  useEffect(() => {
    if (browserPane.conversationId !== (conversationId ?? null)) return
    const count = browserPane.tabs.length
    const prev = prevBrowserTabsRef.current
    if (prev && prev.convKey === wbKey && prev.count === 0 && count > 0) {
      useWorkbenchStore.getState().openTab(wbKey, 'browser')
    }
    prevBrowserTabsRef.current = { convKey: wbKey, count }
  }, [browserPane.tabs.length, browserPane.conversationId, wbKey, conversationId])
  // While the browser tab is frontmost the dock must track the workbench
  // width (native WebView alignment); other tabs fold the dock via the
  // browserActive flag inside useBrowserPaneBinding. The deps are the
  // primitives actually consumed — the binding object itself is a fresh
  // literal every render, and keying on it re-ran this effect (one
  // browserPaneSetWidth IPC) after every render, whose pane update re-rendered
  // ChatView, closing a render↔main IPC loop for as long as the browser tab
  // stayed frontmost.
  const { pushWidth, chatAreaWidth } = browserPaneBinding
  useEffect(() => {
    if (workbenchOpen && workbenchTab === 'browser') {
      pushWidth(workbenchWidth, chatAreaWidth)
    }
  }, [workbenchOpen, workbenchTab, workbenchWidth, pushWidth, chatAreaWidth])
  // write → auto-open, write/edit → refresh open tabs (D3/D7)
  usePreviewPaneSync(conversationId, workspaceDir)
  // Slim status strip above the composer (W8): the workbench's 计划 tab owns
  // the full DAG — this only reminds that a plan is running while folded.
  const planSettled = plan ? plan.nodes.filter((n) => n.status !== 'pending').length : 0
  const planTotal = plan?.nodes.length ?? 0
  const planStrip = plan && !plan.completed && planTotal > 0 && !workbenchOpen ? (
    <div
      onClick={() => useWorkbenchStore.getState().openTab(wbKey, 'plan')}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, height: 26, padding: '0 12px',
        borderRadius: 13, background: 'var(--pm-elevated)', border: '1px solid var(--pm-pop-border)',
        boxShadow: 'var(--pm-shadow-soft)', fontSize: 11, color: 'var(--pm-text-body)', cursor: 'pointer',
        ...TABULAR_NUMS,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: 3, background: 'var(--pm-link)', flexShrink: 0 }} />
      <span>计划进行中 · {planSettled}/{planTotal}</span>
      <span style={{ color: 'var(--pm-link)' }}>查看</span>
    </div>
  ) : null
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
    // A thin wire (older main, or the pair never arrived) carries no delay:
    // seeding from undefined gives NaN, and `NaN <= 1` is false — the interval
    // would tick for the rest of the turn while the seconds never render.
    if (agentStatus.status !== 'retrying' || !Number.isFinite(agentStatus.delay)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- seeds the countdown from the wire status; the interval below owns every tick after
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

  // The two halves of this view are mutually exclusive, and they take the
  // composer's project from different places: on the welcome form it is the pick
  // (project mode only), past it the conversation's own project. Naming the test
  // keeps the project source in step with whichever one actually renders.
  const isWelcomeForm = !hasMessages && !isStreaming && !isLoadingConversation
  // Which project the composer belongs to. On the welcome form it is the pick,
  // and only in project mode — a plain conversation, or project mode before a
  // card is chosen, keeps the app's black button (which is how the color
  // arriving reads as "this task now belongs to Alpha"). Past the first message
  // it is the conversation's own project, so the color stays with the task
  // instead of dropping back to black. `conversations` carries that binding
  // optimistically from materialization (useChatController writes the row before
  // the loop starts), so it is there on the chat view's first frame; a
  // conversation in the default project has no `projectId` at all and stays
  // black, as it should — nobody chose that project.
  const activeConversationProjectId = conversationId
    ? conversations.find((c) => c.key === conversationId)?.projectId
    : undefined
  const composerProjectId = isWelcomeForm
    ? taskMode === 'project'
      ? (newTaskProjectId ?? undefined)
      : undefined
    : activeConversationProjectId
  // The identity color the send button wears, from the project store — the same
  // hue the project card's wash and check icon use.
  const composerProjectHue = useProjectHue(composerProjectId)

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
    /* eslint-disable react-hooks/refs -- structural-sharing caches, not UI state (same pattern as TranscriptView) */
    const segs = buildSegments({
      messages,
      isStreaming,
      streamingBlocks,
      cached: cachedSegmentsRef.current,
      streamingToolAccum: streamingToolAccumRef.current,
    })
    cachedSegmentsRef.current = segs
    /* eslint-enable react-hooks/refs */
    return segs
  }, [messages, isStreaming, streamingBlocks])

  // Windowed render slice: always includes the live tail, optionally prepending
  // extraTop older segments above it. Keeps DOM size bounded for long threads.
  const windowTop = Math.max(0, allSegments.length - PAGE_SIZE - extraTop)
  const renderedSegments = allSegments.slice(windowTop)

  // Per-turn deliverables (2026-09-19): rows derived from the FULL message
  // list, keyed on its identity — deliberately NOT on allSegments, which is
  // rebuilt per streamed token, so the per-turn derivation is not re-paid per
  // token. Placement comes from the segments instead (cheap index math), and
  // the card mounts at the turn's end: INSIDE the last message (above its
  // 对话工具条, via MessageGroup's aboveActions slot) when the turn closes on
  // assistant text, or as a sibling block after the last segment otherwise.
  const turnRows = useMemo(
    () => collectTurnDeliverables(messages, childDeliverables),
    [messages, childDeliverables],
  )
  const turnPlacement = useMemo(() => segmentTurnPlacement(allSegments), [allSegments])

  // 存为日常任务 rides exactly one action row — the conversation's last settled
  // assistant message, and only while a turn is settled (routine-entry.ts).
  // `null` takes the prop away from every segment, so streaming/execution tails
  // and parked states simply render the rows they always did.
  const routineEntryIndex = useMemo(() => {
    if (!onExtractRoutine || !routineEntryAllowed(agentStatus.status)) return null
    return routineEntryTargetIndex(allSegments)
  }, [onExtractRoutine, agentStatus.status, allSegments])

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
  // eslint-disable-next-line react-hooks/refs -- latest-callback mirror for the jump effect below (see the comment above)
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
    (seg: Segment, index: number, aboveActions?: React.ReactNode) => (
      <SegmentBlock
        seg={seg}
        nextSeg={allSegments[index + 1]}
        isLastSegment={index === allSegments.length - 1}
        highlightedMsgId={highlightedMsgId}
        isRequesting={isRequesting}
        awaitingApproval={agentStatus.status === 'awaiting_approval'}
        onApproveTool={onApproveTool}
        onRejectTool={onRejectTool}
        onKillTool={onKillTool ?? onRejectTool}
        onRespondToTool={onRespondToTool}
        conversationId={conversationId}
        conversationTitle={conversationTitle}
        onOpenSubAgent={onOpenSubAgent}
        onExtractRoutine={routineEntryIndex === index ? onExtractRoutine : undefined}
        aboveActions={aboveActions}
      />
    ),
    [highlightedMsgId, allSegments, isRequesting, agentStatus.status, onApproveTool, onRejectTool, onKillTool, onRespondToTool, conversationId, conversationTitle, routineEntryIndex, onExtractRoutine, onOpenSubAgent],
  )

  // ── Render ──

  // Welcome page when no messages and not streaming. While a conversation
  // switch is still loading its messages from the DB, skip the welcome screen —
  // falling through to the (empty) message view keeps the layout stable so the
  // loaded content replaces it without a visible flash.
  if (isWelcomeForm) {
    return (
      <div
        style={{
          height: '100%',
          background: 'var(--pm-bg)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Task form switcher (M8.4-rev): 对话 / 项目, its own top band so
            short windows can never slide the content over it (it used to be
            absolutely pinned, and the centered logo overlapped it). Drives the
            same store the welcome page panels and handleRequest consume.
            Bottom padding stays SMALL: the switcher-to-logo breathing room is
            an elastic spacer inside WelcomeContent (flex-grow, capped), not a
            fixed band — a fixed 144px here sat outside the scroll region and
            squeezed the logo on short windows. */}
        <div data-welcome-switcher style={{ flexShrink: 0, display: 'flex', justifyContent: 'center', padding: '16px 0 8px' }}>
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
        <div data-welcome-region style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex' }}>
          <WelcomeContent
            greeting={greeting}
            hasApiKey={hasApiKey}
            animName={animName}
            conversations={conversations}
            activeLoopConvIds={activeLoopConvIds}
            onOpenConversation={onOpenConversation}
          />
        </div>

        <div
          ref={composerShakeRef}
          data-welcome-shake="composer"
          style={{ flexShrink: 0, padding: '0 24px 16px', maxWidth: 1048, margin: '0 auto', width: '100%' }}
        >
          <InputArea
            key={conversationId ?? 'new'}
            layout="inline"
            focusToken={welcomeFocusToken}
            // A project task owes a project: with none picked the send button
            // greys out (the input keeps working) until a card is chosen — the
            // welcome page asks, rather than the send failing with a warning.
            sendBlocked={taskMode === 'project' && !newTaskProjectId}
            sendAccentHue={composerProjectHue}
            staging={staging}
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
        background: 'var(--pm-bg)',
        // Reserve the workbench strip so chat content never flows under the
        // docked pane (PLAN-workbench W1: one width, one reserve — the old
        // browser+preview additive stack is gone). Transitions off — the
        // drag handle needs 1:1 tracking.
        paddingRight: workbenchOpen ? workbenchWidth : 0,
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

        {renderedSegments.map((seg, i) => {
          const abs = windowTop + i
          const turn = turnPlacement.turnOf[abs]
          const turnDeliverable =
            turn !== undefined && turnPlacement.lastSegmentOfTurn[turn] === abs ? turnRows[turn] : undefined
          const card =
            turnDeliverable && turnDeliverable.rows.length > 0 ? (
              <TurnDeliverablesCard
                deliverable={turnDeliverable}
                conversationId={conversationId}
                workspaceDir={workspaceDir}
              />
            ) : null
          // A turn closing on assistant text mounts the card INSIDE the message
          // (above its 对话工具条); otherwise the card is a sibling block after
          // the turn's last segment — the column wrapper keeps the sibling's
          // footprint aligned with the slotted one (24px inset + 16px margin).
          const cardInMessage = seg.type === 'single' && seg.msg.role === 'assistant'
          return (
            <React.Fragment key={getSegmentKey(seg)}>
              {renderSegment(seg, abs, cardInMessage ? card : undefined)}
              {!cardInMessage && card && (
                <div style={{ maxWidth: 1000, margin: '0 auto', padding: '0 24px' }}>{card}</div>
              )}
            </React.Fragment>
          )
        })}

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

      <WorkbenchPane
        conversationId={conversationId}
        chatAreaWidth={browserPaneBinding.chatAreaWidth}
        plan={plan ?? null}
        onPlanJump={onPlanJump}
        onOpenPlanNode={onOpenPlanNode}
        canOpenNode={canOpenNode}
        browserPane={browserPane}
        onBrowserAction={browserPaneBinding.action}
        onBrowserWidth={(w) => browserPaneBinding.pushWidth(w, browserPaneBinding.chatAreaWidth)}
      />

      <InputArea
        key={conversationId ?? 'new'}
        isRequesting={isRequesting}
        isStreaming={isStreaming}
        isAwaitingApproval={agentStatus.status === 'awaiting_approval'}
        isAwaitingInput={agentStatus.status === 'awaiting_user_input'}
        hasMessages={hasMessages}
        topSlot={planStrip}
        // No rightInset: the root's paddingRight already ends the in-flow
        // wrapper at the pane's left edge, and the composer is absolute
        // INSIDE that wrapper — an inset here would deduct the pane twice.
        onSendMessage={(content: string) => {
          isNearBottomRef.current = true
          onSendMessage(content)
        }}
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
        sendAccentHue={composerProjectHue}
        staging={staging}
        onUnbindExpert={() => conversationId && onUnbindExpert?.(conversationId)}
        approvalMode={approvalMode}
        onChangeApprovalMode={onChangeApprovalMode}
      />
    </div>
  )
}

export default ChatView
