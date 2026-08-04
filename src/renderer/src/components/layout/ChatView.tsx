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
import { WelcomeContent } from '../chat/WelcomeContent'

// --- Props ---

interface ChatViewProps {
  messages: AgentMessage[]
  isRequesting: boolean
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
  planScrollToMsgId
}: ChatViewProps): React.ReactElement {
  const uid = useId()
  const animName = `ecg-scroll-${uid.replace(/[:.]/g, '')}`
  const scrollRef = useRef<HTMLDivElement>(null)
  const isNearBottomRef = useRef(true)

  // Platform detection for Windows (disable frosted glass, full opacity)
  const [isWin, setIsWin] = useState(false)
  useEffect(() => {
    window.electronAPI.getPlatformInfo().then(info => {
      setIsWin(info.platform === 'win32')
    }).catch(() => { /* default to false */ })
  }, [])

  // Scroll tracking
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100
  }, [])

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [])

  const prevConvIdRef = useRef(conversationId)
  const pendingScrollRef = useRef(false)
  const scrollRafRef = useRef<number>(0)
  useEffect(() => {
    const isConvSwitch = prevConvIdRef.current !== conversationId
    if (isConvSwitch) {
      pendingScrollRef.current = true
      prevConvIdRef.current = conversationId
    }

    if (!isNearBottomRef.current || messages.length === 0) return

    if (pendingScrollRef.current) {
      // Conversation switch with async-loaded messages: wait for DOM to settle
      pendingScrollRef.current = false
      cancelAnimationFrame(scrollRafRef.current)
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = requestAnimationFrame(scrollToBottom)
      })
    } else {
      // Use rAF to let DOM layout settle before measuring scrollHeight
      cancelAnimationFrame(scrollRafRef.current)
      scrollRafRef.current = requestAnimationFrame(scrollToBottom)
    }
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
    return () => cancelAnimationFrame(scrollRafRef.current)
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

  const [highlightedMsgId, setHighlightedMsgId] = useState<string | null>(null)

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
    setHighlightedMsgId(targetId)
    const scrollTimer = setTimeout(() => {
      document.getElementById(`chat-msg-${targetId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 100)
    const clearTimer = setTimeout(() => setHighlightedMsgId(null), 2000)
    return () => { clearTimeout(scrollTimer); clearTimeout(clearTimer) }
  }, [planScrollToMsgId])

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
  }, [highlightedMsgId, allSegments, isRequesting, agentStatus.status, streamingBlocks, onApproveTool, onRejectTool, onKillTool, onRespondToTool, onSaveConversation, conversationId, conversationTitle])

  // ── Render ──

  // Welcome page when no messages and not streaming
  if (!hasMessages && !isStreaming) {
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
        style={{ height: '100%', overflow: 'auto' }}
      >
        <div style={{ height: 24 }} />

        {allSegments.map((seg, index) => (
          <React.Fragment key={getSegmentKey(seg)}>
            {renderSegment(seg, index)}
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
