import React, { useRef, useEffect, useCallback, useMemo, useId, useState } from 'react'
import type { AgentStatus, AgentMessage, ContentBlock, ToolUseBlock } from '../../types/agent'
import type { LlmProfile } from '../../types/settings'
import { XMarkdown } from '@ant-design/x-markdown'
import Latex from '@ant-design/x-markdown/plugins/Latex'
import { MessageGroup } from '../chat/MessageGroup'
import { ExecutionSegment } from '../chat/ExecutionSegment'
import { CodeBlock } from '../chat/CodeBlock'
import { ErrorDisplay } from '../chat/ErrorDisplay'
import { ExtensionPrompt, SubAgentStopPrompt } from '../chat/ExtensionPrompt'
import { InputArea } from '../chat/InputArea'
import { estimateContextUsed } from '../chat/ContextRing'
import { WelcomeContent } from '../chat/WelcomeContent'
import { startBottomPin } from '../../utils/bottom-pin'

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
  onOpenSettings?: () => void
  onOpenAbout?: () => void
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
}

// --- Message grouping: break at text / ask_user, group tools between them ---
//
// Text and ask_user are breakpoints. Everything between consecutive breakpoints
// (a tool_use ↔ tool_result cycle) is grouped into one execution segment.
// This gives a flat layout with tools collapsible and text/ask_user always visible.

type Segment =
  | { type: 'single'; msg: AgentMessage }
  | { type: 'execution'; msgs: AgentMessage[] }
  | { type: 'streaming'; blocks: ContentBlock[] }

function getSegmentKey(seg: Segment): string {
  if (seg.type === 'single') return 's-' + seg.msg.id
  if (seg.type === 'execution') return 'e-' + (seg.msgs[0]?.id?.replace(/__\w+$/, '') || 'empty')
  return 'streaming'
}

function getSegmentAnchorId(seg: Segment | undefined): string | undefined {
  if (!seg) return undefined
  if (seg.type === 'single') return seg.msg.id.replace(/__\w+$/, '')
  if (seg.type === 'execution') return seg.msgs[0]?.id?.replace(/__\w+$/, '')
  return undefined
}

function groupMessages(messages: AgentMessage[]): Segment[] {
  const segments: Segment[] = []
  let i = 0
  let pendingExec: AgentMessage[] | null = null

  const flushExec = () => {
    if (pendingExec && pendingExec.length > 0) {
      segments.push({ type: 'execution', msgs: pendingExec })
      pendingExec = null
    }
  }

  while (i < messages.length) {
    const msg = messages[i]

    // User message without tool_result → standalone (flushes any pending execution)
    if (msg.role === 'user' && !msg.contentBlocks.some((b) => b.type === 'tool_result')) {
      flushExec()
      segments.push({ type: 'single', msg })
      i++
      continue
    }

    // Tool_result user message → belongs to current execution segment (but skip if no pending execution — e.g. ask_user result)
    if (msg.role === 'user' && msg.contentBlocks.some((b) => b.type === 'tool_result')) {
      if (!pendingExec) {
        i++
        continue
      }
      pendingExec.push(msg)
      i++
      continue
    }

    // Assistant message — inspect content blocks
    if (msg.role === 'assistant') {
      const textBlocks = msg.contentBlocks.filter((b) => b.type === 'text')
      const thinkingBlocks = msg.contentBlocks.filter((b) => b.type === 'thinking' || b.type === 'redacted_thinking')
      const toolBlocks = msg.contentBlocks.filter((b) => b.type === 'tool_use')
      const hasAskUser = toolBlocks.some((b) => b.name === 'ask_user')
      const nonAskUserTools = toolBlocks.filter((b) => b.name !== 'ask_user')

      // Text is a breakpoint: flush pending execution, emit text as standalone
      if (textBlocks.length > 0) {
        flushExec()
        segments.push({
          type: 'single',
          msg: { ...msg, id: msg.id + '__text', contentBlocks: textBlocks }
        })
      }

      // Non-ask_user tools → add to current execution segment
      if (nonAskUserTools.length > 0) {
        // Thinking stays with tools only when text was NOT emitted already
        const extra = textBlocks.length === 0 ? thinkingBlocks : []
        const toolMsg = { ...msg, id: msg.id + '__exec', contentBlocks: [...extra, ...nonAskUserTools] }
        if (!pendingExec) pendingExec = []
        pendingExec.push(toolMsg)
      }

      // ask_user is a breakpoint: flush pending, ask_user stands alone
      if (hasAskUser) {
        flushExec()
        const askUserBlocks = toolBlocks.filter((b) => b.name === 'ask_user')
        segments.push({ type: 'single', msg: { ...msg, id: msg.id + '__ask', contentBlocks: askUserBlocks } })
      }

      // No text, no tools, no ask_user → nothing visible (thinking-only / empty), skip
      if (textBlocks.length === 0 && nonAskUserTools.length === 0 && !hasAskUser) {
        // No-op: thinking-only messages have no displayable content in main area
      }

      i++
      continue
    }

    // Fallback
    segments.push({ type: 'single', msg })
    i++
  }

  flushExec()
  return segments
}

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
  onOpenSettings,
  onOpenAbout,
  conversationId,
  conversationTitle,
  profiles,
  activeProfileId,
  onSelectProfile,
  greeting,
  planScrollToMsgId,
  onPlanScrollHandled,
  contextLength
}: ChatViewProps): React.ReactElement {
  const uid = useId()
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

  // Platform detection for Windows (disable frosted glass, full opacity)
  const [isWin, setIsWin] = useState(false)
  useEffect(() => {
    window.electronAPI.getPlatformInfo().then(info => {
      setIsWin(info.platform === 'win32')
    }).catch(() => { /* default to false */ })
  }, [])

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
        onStop: () => { landingRef.current = false }
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
    if (agentStatus.status !== 'retrying') { setRetryCountdown(0); return }
    setRetryCountdown(Math.ceil(agentStatus.delay / 1000) - 1)
    const interval = setInterval(() => {
      setRetryCountdown(prev => { if (prev <= 1) { clearInterval(interval); return 0 }; return prev - 1 })
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

  function matchSegment(a: Segment, b: Segment): boolean {
    if (a.type !== b.type) return false
    if (a.type === 'single') {
      if (a.msg.id !== (b as typeof a).msg.id) return false
      // If tool_use block statuses differ, content has changed (e.g. ask_user
      // responded) — don't match, so the new segment isn't replaced with cached.
      const bSeg = b as typeof a
      for (const block of a.msg.contentBlocks) {
        if (block.type !== 'tool_use') continue
        const bBlock = bSeg.msg.contentBlocks.find(c => c.type === 'tool_use' && c.id === block.id)
        if (bBlock && (block as any).status !== (bBlock as any).status) return false
      }
      return true
    }
    if (a.type === 'execution') {
      const ab = b as typeof a
      if (a.msgs.length !== ab.msgs.length) return false
      return a.msgs.every((m, i) => m.id === ab.msgs[i].id)
    }
    return false
  }

  const allSegments = useMemo((): Segment[] => {
    const segs = groupMessages(messages)
    const cached = cachedSegmentsRef.current

    // Reuse cached segment objects for the unchanged prefix (by type, msg ID, and length).
    // This lets React.memo detect that unchanged segments don't need re-render.
    // Execution segments are skipped (not cached): tool_use status is mutated in-place,
    // so the cached msgs array reference would cause React.memo to skip the re-render.
    const prefixLen = Math.min(segs.length, cached.length)
    for (let i = 0; i < prefixLen; i++) {
      if (matchSegment(cached[i], segs[i])) {
        if (segs[i].type !== 'execution') {
          segs[i] = cached[i]
        }
      } else {
        break
      }
    }
    cachedSegmentsRef.current = segs

    if (isStreaming && streamingBlocks.length > 0) {
      const textBlocks = streamingBlocks.filter((b) => b.type === 'text')
      const toolBlocks = streamingBlocks.filter((b) => b.type === 'tool_use')

      // Text streams as a streaming segment
      if (textBlocks.length > 0) {
        segs.push({ type: 'streaming', blocks: textBlocks })
      }
      // Tool_use blocks: accumulate across renders and merge into a single synthetic message.
      if (toolBlocks.length > 0) {
        for (const tb of toolBlocks) {
          streamingToolAccumRef.current.set(tb.id, tb)
        }
        const accumulated = Array.from(streamingToolAccumRef.current.values())

        const lastSeg = segs[segs.length - 1]
        if (lastSeg?.type === 'execution') {
          const lastMsg = lastSeg.msgs[lastSeg.msgs.length - 1]
          if (lastMsg?.id === 'streaming-exec') {
            // Merge accumulated blocks into the existing synthetic message
            lastMsg.contentBlocks = [...new Map(
              [...lastMsg.contentBlocks, ...accumulated].map(b => [b.type === 'tool_use' ? b.id : b.type, b])
            ).values()] as any
            segs[segs.length - 1] = { type: 'execution', msgs: [...lastSeg.msgs] }
          } else {
            segs[segs.length - 1] = {
              type: 'execution',
              msgs: [...lastSeg.msgs, {
                role: 'assistant',
                id: 'streaming-exec',
                createdAt: new Date().toISOString(),
                contentBlocks: accumulated as any,
              }]
            }
          }
        } else {
          segs.push({ type: 'execution', msgs: [{
            role: 'assistant',
            id: 'streaming-exec',
            createdAt: new Date().toISOString(),
            contentBlocks: accumulated as any,
          }]})
        }
      }
    }
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
    const anchorId = topSeg?.type === 'single'
      ? topSeg.msg.id.replace(/__\w+$/, '')
      : topSeg?.type === 'execution'
        ? topSeg.msgs[0]?.id?.replace(/__\w+$/, '')
        : undefined
    if (!anchorId) return
    const anchorEl = document.getElementById(`chat-msg-${anchorId}`)
    const anchorTop = anchorEl ? anchorEl.getBoundingClientRect().top : null

    loadMoreBusyRef.current = true
    setExtraTop((e) => Math.min(allSegments.length, e + PAGE_SIZE))

    // Double rAF: wait for React to commit the new segments before restoring scroll.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      loadMoreBusyRef.current = false
      const elAfter = scrollRef.current
      const anchorAfter = document.getElementById(`chat-msg-${anchorId}`)
      if (elAfter && anchorAfter && anchorTop !== null) {
        elAfter.scrollTop += anchorAfter.getBoundingClientRect().top - anchorTop
      }
    }))
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
  useEffect(() => () => {
    clearTimeout(highlightTimerRef.current)
    clearTimeout(scrollTimerRef.current)
  }, [])

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
      setTimeout(() => { suppressPlanScrollRef.current = false }, 700)
      onPlanScrollHandledRef.current?.()
    }, 100)
    highlightTimerRef.current = setTimeout(() => setHighlightedMsgId(null), 2000)
  }, [planScrollToMsgId, allSegments, windowTop, extraTop])

  // ── Render helpers ──

  const renderSegment = useCallback((seg: Segment, index: number) => {
    if (seg.type === 'single') {
      const origId = seg.msg.id.replace(/__\w+$/, '')
      const isHighlighted = highlightedMsgId === origId
      return (
        <div
          id={`chat-msg-${origId}`}
          style={{
            maxWidth: 1000,
            margin: '0 auto',
            padding: '0 24px',
            transition: 'background 0.5s',
            background: isHighlighted ? 'rgba(22, 119, 255, 0.08)' : undefined
          }}
        >
          <MessageGroup
            msg={seg.msg}
            showActions={seg.msg.role === 'assistant' && allSegments[index + 1]?.type !== 'execution'}
            onApproveTool={onApproveTool}
            onRejectTool={onRejectTool}
            onRespondToTool={onRespondToTool}
            onKillTool={onKillTool ?? onRejectTool}
            conversationId={conversationId}
            conversationTitle={conversationTitle}
            contextLength={contextLength}
          />
        </div>
      )
    }

    if (seg.type === 'execution') {
      const hasStreamingMsg = seg.msgs.some((m) => m.id === 'streaming-exec')
      const origId = seg.msgs[0].id.replace(/__\w+$/, '')
      const isHighlighted = highlightedMsgId === origId
      return (
        <div
          id={`chat-msg-${origId}`}
          style={{
            maxWidth: 1000,
            margin: '0 auto',
            padding: '0 24px',
            transition: 'background 0.5s',
            background: isHighlighted ? 'rgba(22, 119, 255, 0.08)' : undefined
          }}
        >
          <ExecutionSegment
            messages={seg.msgs}
            isLastSegment={index === allSegments.length - 1}
            isRequesting={isRequesting}
            isReceiving={hasStreamingMsg}
            onApproveTool={onApproveTool}
            onRejectTool={onRejectTool}
            onKillTool={onKillTool ?? onRejectTool}
            onRespondToTool={onRespondToTool}
            conversationId={conversationId}
            conversationTitle={conversationTitle}
            contextLength={contextLength}
          />
        </div>
      )
    }

    // Streaming segment — only text blocks (tool_use goes to ExecutionSegment)
    return (
      <div style={{ maxWidth: 1000, margin: '0 auto', padding: '0 24px' }}>
        <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 12 }}>
          <div style={{ paddingLeft: 12, width: '100%', fontSize: 14, lineHeight: 1.6 }}>
            {seg.blocks.map((block, i) => {
              if (block.type === 'text') {
                return (
                  <div key={i} className="x-markdown-light" style={{ color: '#333' }}>
                    <XMarkdown content={block.text} components={{ code: CodeBlock }} config={{ extensions: Latex() }} />
                  </div>
                )
              }
              return null
            })}
          </div>
        </div>
      </div>
    )
  }, [highlightedMsgId, allSegments, isRequesting, agentStatus.status, streamingBlocks, onApproveTool, onRejectTool, onKillTool, onRespondToTool, onSaveConversation, conversationId, conversationTitle, contextLength])

  // ── Render ──

  // Welcome page when no messages and not streaming. While a conversation
  // switch is still loading its messages from the DB, skip the welcome screen —
  // falling through to the (empty) message view keeps the layout stable so the
  // loaded content replaces it without a visible flash.
  if (!hasMessages && !isStreaming && !isLoadingConversation) {
    return (
      <div
        style={{
          position: 'relative',
          height: '100%',
          background: '#fff'
        }}
      >
        <div
          style={{
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <WelcomeContent
            greeting={greeting}
            hasApiKey={hasApiKey}
            onOpenSettings={onOpenSettings}
            onOpenAbout={onOpenAbout}
            animName={animName}
          />
        </div>

        <InputArea
          key={conversationId ?? 'new'}
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

        <style>{`
          @keyframes blink {
            0%, 50% { opacity: 1; }
            51%, 100% { opacity: 0; }
          }
          @keyframes greetingIn {
            0% { opacity: 0; transform: translateY(4px); }
            100% { opacity: 1; transform: translateY(0); }
          }
          .ant-sender-actions-btn { display: none !important; }
          .ant-sender {
            background: ${isWin ? '#fff' : 'rgba(255,255,255,0.85)'} !important;
            ${isWin ? '' : 'backdrop-filter: blur(12px);'}
            ${isWin ? '' : '-webkit-backdrop-filter: blur(12px);'}
            border: 1px solid rgba(0,0,0,0.08);
            border-radius: 20px !important;
            max-width: 750px;
            margin: 0 auto;
            box-shadow: 0 5px 20px 2px rgb(80 100 200 / 20%) !important;
          }
        `}</style>
      </div>
    )
  }

  // Chat view
  return (
    <div
      style={{
        position: 'relative',
        height: '100%',
        background: '#fff'
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

        {renderedSegments.map((seg, i) => (
          <React.Fragment key={getSegmentKey(seg)}>
            {renderSegment(seg, windowTop + i)}
          </React.Fragment>
        ))}

        <div style={{ minHeight: 1, paddingBottom: 160 }}>
          {/* Single blinking cursor — always present during active request */}
          {isRequesting && (
            <div style={{ maxWidth: 1000, margin: '0 auto', padding: '0 24px' }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'flex-start',
                  marginBottom: 12,
                  paddingLeft: 12
                }}
              >
                <span
                  style={{
                    display: 'inline-block',
                    width: 6,
                    height: 14,
                    background: '#000',
                    animation: `blink 1s step-end infinite`,
                    verticalAlign: 'text-bottom',
                    willChange: 'opacity'
                  }}
                />
              </div>
            </div>
          )}

          {/* Error state */}
          {isError && (
            <div style={{ maxWidth: 1000, margin: '0 auto', padding: '0 24px' }}>
              <ErrorDisplay
                message={'error' in agentStatus ? agentStatus.error : 'Unknown error'}
                onDismiss={onClearError}
                onRetry={onRetryLast}
              />
            </div>
          )}

          {/* Retry indicator */}
          {isRetrying && (
            <div style={{ maxWidth: 1000, margin: '0 auto', padding: '0 24px' }}>
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                padding: '8px 16px', margin: '0 16px',
                background: 'rgba(255,149,0,0.08)', border: '1px solid rgba(255,149,0,0.25)',
                borderRadius: 8, fontSize: 12, color: '#b84d00',
              }}>
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
              <SubAgentStopPrompt
                onConfirm={onStopExecution}
                onResume={onResumeExecution}
              />
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

      <InputArea
        key={conversationId ?? 'new'}
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

      {/* Global keyframes */}
      <style>{`
        @keyframes blink {
          0%, 50% { opacity: 1; }
          51%, 100% { opacity: 0; }
        }
        @keyframes greetingIn {
          0% { opacity: 0; transform: translateY(4px); }
          100% { opacity: 1; transform: translateY(0); }
        }
        .ant-sender-actions-btn { display: none !important; }
        .ant-sender {
          background: ${isWin ? '#fff' : 'rgba(255,255,255,0.85)'} !important;
          ${isWin ? '' : 'backdrop-filter: blur(12px);'}
          ${isWin ? '' : '-webkit-backdrop-filter: blur(12px);'}
          border: 1px solid rgba(0,0,0,0.08);
          border-radius: 20px !important;
          max-width: 750px;
          margin: 0 auto;
          box-shadow: 0 5px 20px 2px rgb(80 100 200 / 20%) !important;
        }
      `}</style>
    </div>
  )
}

export default ChatView
