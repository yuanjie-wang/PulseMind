import React, { useState, useMemo } from 'react'
import { RightOutlined } from '@ant-design/icons'
import type { AgentMessage, ContentBlock } from '../../types/agent'
import { MessageGroup } from './MessageGroup'

// Injected once into <head> to avoid creating a new <style> element on every render
const KEYFRAMES = `@keyframes pulsemind-spin { 100% { transform: rotate(360deg); } } @keyframes pulsemind-fade-in { 0% { opacity: 0; transform: translateY(2px); } 100% { opacity: 1; transform: translateY(0); } }`
let keyframesInjected = false
if (typeof document !== 'undefined' && !keyframesInjected) {
  const el = document.createElement('style')
  el.textContent = KEYFRAMES
  document.head.appendChild(el)
  keyframesInjected = true
}

// --- Props ---

interface ExecutionSegmentProps {
  messages: AgentMessage[]
  isLastSegment: boolean
  isRequesting: boolean
  isReceiving?: boolean
  onApproveTool: (toolUseId: string) => void
  onRejectTool: (toolUseId: string) => void
  onKillTool: (toolUseId: string) => void
  onRespondToTool?: (toolUseId: string, response: string) => void
  conversationId?: string
  conversationTitle?: string
}

// --- Extract displayable items from segment messages in LLM order ---

function summarizeInput(input: Record<string, unknown> | undefined): string {
  if (!input) return ''
  const entries = Object.entries(input).filter(([k]) => k !== 'description')
  if (entries.length === 0) return ''
  const [, v] = entries[0]
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > 60 ? s.slice(0, 57) + '...' : s + '...'
}

function contentBlocksToTexts(blocks: ContentBlock[]): string[] {
  const texts: string[] = []
  for (const block of blocks) {
    if (block.type === 'thinking') {
      const t = block.thinking.replace(/\n+/g, ' ').trim()
      if (t) texts.push(t)
    } else if (block.type === 'text') {
      const t = block.text.replace(/\n+/g, ' ').trim()
      if (t) texts.push(t)
    } else if (block.type === 'tool_use') {
      const input = summarizeInput(block.input)
      texts.push(`${block.name}${input ? ` ${input}` : ''}`)
    }
  }
  return texts
}

// --- Component ---

export const ExecutionSegment = React.memo(function ExecutionSegment(props: ExecutionSegmentProps): React.ReactElement {
  const [expanded, setExpanded] = useState(false)

  // Single traversal for all derived state — replaces 4 separate useMemo calls
  const { texts, initial, done, toolCount, receivingText } = useMemo(() => {
    let hasTools = false
    let anyNonPending = false // any tool has a status beyond 'pending' (running, completed, rejected)
    let anyRunning = false
    let hasToolResults = false // presence of tool_result indicates completion (used when status stripped on save)
    const texts: string[] = []
    let toolCount = 0
    const toolNames = new Set<string>()

    for (const msg of props.messages) {
      if (msg.role !== 'user') {
        texts.push(...contentBlocksToTexts(msg.contentBlocks))
      }
      for (const block of msg.contentBlocks) {
        if (block.type === 'tool_use') {
          toolCount++
          hasTools = true
          if (block.name) toolNames.add(block.name)
          if (block.status === 'running') anyRunning = true
          if (block.status === undefined) continue
          if (block.status !== 'pending') anyNonPending = true
        }
        if (block.type === 'tool_result') hasToolResults = true
      }
    }

    return {
      texts,
      initial: !anyNonPending && !hasToolResults,
      done: hasTools && !anyRunning && (anyNonPending || hasToolResults),
      toolCount,
      anyRunning,
      anyNonPending,
      receivingText: props.isReceiving && toolNames.size > 0
        ? Array.from(toolNames).join(', ') + ' 指令生成中...'
        : ''
    }
  }, [props.messages, props.isReceiving])

  // - Receiving (streaming blocks not yet committed): show "write 指令生成中..."
  // - Initial state (all tools still pending): show "开始执行"
  // - Done state (tools all done AND segment no longer last / engine idle): show "已完成（工具调用X次）"
  // - Executing: show the last extracted text
  const isPending = props.isLastSegment && props.isRequesting
  const showDone = done && !isPending
  const showInitialActive = initial && props.isRequesting
  const showSpinner = !showDone && props.isRequesting
  const displayText = props.isReceiving ? receivingText : (showDone ? `已完成（工具调用${toolCount}次）` : showInitialActive ? '开始执行' : (texts.length > 0 ? texts[texts.length - 1] : 'Processing...'))

  return (
    <div style={{ margin: '8px 0', borderRadius: 8, overflow: 'hidden' }}>
      {/* Collapsed header */}
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          height: 34,
          padding: '0 10px',
          background: 'transparent',
          cursor: 'pointer',
          userSelect: 'none',
          overflow: 'hidden'
        }}
      >
        {showSpinner && (
          <div style={{
            width: 14,
            height: 14,
            border: '2px solid #e8e8e8',
            borderTopColor: '#000',
            borderRadius: '50%',
            animation: 'pulsemind-spin 1s linear infinite',
            flexShrink: 0,
            marginRight: 6,
            willChange: 'transform'
          }} />
        )}
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden', alignItems: 'center', minWidth: 0 }}>
          <div
            key={displayText}
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
              flexShrink: 1,
              fontSize: 13,
              color: '#999',
              lineHeight: '22px',
              animation: 'pulsemind-fade-in 0.25s ease-out'
            }}
          >
            {displayText}
          </div>
          <RightOutlined
            style={{
              color: '#bbb',
              fontSize: 11,
              flexShrink: 0,
              marginLeft: 4,
              transform: expanded ? 'rotate(90deg)' : undefined,
              transition: 'transform 0.2s'
            }}
          />
        </div>
      </div>

      {/* Expanded body */}
      {expanded && (
        <div style={{ padding: '8px 12px 4px', border: '1px solid #e8e8e8', borderRadius: 8 }}>
          {props.messages.map((msg) => (
            <MessageGroup
              key={msg.id}
              msg={msg}
              showActions={false}
              onApproveTool={props.onApproveTool}
              onRejectTool={props.onRejectTool}
              onKillTool={props.onKillTool}
              onRespondToTool={props.onRespondToTool}
              conversationId={props.conversationId}
              conversationTitle={props.conversationTitle}
            />
          ))}
        </div>
      )}
    </div>
  )
})