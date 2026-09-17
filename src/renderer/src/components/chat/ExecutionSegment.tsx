import React, { useState, useMemo } from 'react'
import { RightOutlined } from '@ant-design/icons'
import type { AgentMessage, ContentBlock, ToolUseBlock } from '../../types/agent'
import { MessageGroup } from './MessageGroup'
import { ApprovalArea } from './ApprovalArea'
import { useTranslation } from '../../i18n/useTranslation'
import { toolBlockSummary, toolDisplayName, type ToolTranslator } from './tool-summary'

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
  /** Open a spawn card's sub-conversation in the host's session view (see
   *  MessageGroup). Threaded through unchanged; absent means no drill-in. */
  onOpenSubAgent?: (subConvId: string, title: string) => void
  /** The engine is parked on its held calls (`agentStatus: 'awaiting_approval'`). */
  awaitingApproval?: boolean
}

// --- Extract displayable items from segment messages in LLM order ---

function contentBlocksToTexts(blocks: ContentBlock[], t: ToolTranslator): string[] {
  const texts: string[] = []
  for (const block of blocks) {
    if (block.type === 'thinking') {
      const line = block.thinking.replace(/\n+/g, ' ').trim()
      if (line) texts.push(line)
    } else if (block.type === 'text') {
      const line = block.text.replace(/\n+/g, ' ').trim()
      if (line) texts.push(line)
    } else if (block.type === 'tool_use') {
      // PLAN-tool-ux T5: the same human summary the tool block's header uses —
      // the loop-state line used to splice `name + first input value` itself,
      // which read as `exec npm install…` mid-run while everything else had
      // moved to 运行命令 · …. (D1=C: exec's object stays the raw command.)
      texts.push(toolBlockSummary(block, t))
    }
  }
  return texts
}

// --- Component ---

export const ExecutionSegment = React.memo(function ExecutionSegment(props: ExecutionSegmentProps): React.ReactElement {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)

  // Single traversal for all derived state — replaces 4 separate useMemo calls
  const { texts, initial, done, toolCount, activityText, receivingText, liveOutput, heldCalls } = useMemo(() => {
    let hasTools = false
    let anyNonPending = false // any tool has a status beyond 'pending' (running, completed, rejected)
    let anyRunning = false
    let hasToolResults = false // presence of tool_result indicates completion (used when status stripped on save)
    const heldCalls: ToolUseBlock[] = [] // calls this segment holds for the user's approval
    const texts: string[] = []
    let toolCount = 0
    const toolNames = new Set<string>()
    // Activity narrative (PLAN-tool-ux T4): completed calls by family —
    // files read / files modified / commands run.
    let reads = 0
    let writes = 0
    let execs = 0
    // Last output line from any currently-running tool (e.g. sub-agent progress),
    // surfaced in the collapsed header so the user sees it move without expanding.
    let liveOutput: string | null = null

    for (const msg of props.messages) {
      if (msg.role !== 'user') {
        texts.push(...contentBlocksToTexts(msg.contentBlocks, t))
      }
      for (const block of msg.contentBlocks) {
        if (block.type === 'tool_use') {
          toolCount++
          hasTools = true
          if (block.name) toolNames.add(block.name)
          if (block.status === 'running') {
            anyRunning = true
            const out = (block as ToolUseBlock).output
            if (out) {
              const line = out.split('\n').filter(Boolean).pop() ?? ''
              liveOutput = line.length > 80 ? line.slice(0, 77) + '...' : line
            }
          }
          // `pending` + the parked engine: a call the ladder is holding. The parked
          // half is what keeps a still-generating tool from counting as one.
          if (block.status === 'pending' && props.awaitingApproval) heldCalls.push(block)
          if (block.status === undefined) continue
          if (block.status !== 'pending') anyNonPending = true
          // Only SETTLED calls count toward the narrative — a running exec is
          // not yet "跑了一条命令".
          if (block.status === 'completed' || block.status === 'rejected') {
            if (block.name === 'read') reads++
            else if (block.name === 'write' || block.name === 'edit') writes++
            else if (block.name === 'exec') execs++
          }
        }
        if (block.type === 'tool_result') hasToolResults = true
      }
    }

    const activityParts: string[] = []
    if (reads > 0) activityParts.push(`已读取 ${reads} 个文件`)
    if (writes > 0) activityParts.push(`修改 ${writes} 个文件`)
    if (execs > 0) activityParts.push(`运行 ${execs} 条命令`)

    return {
      texts,
      initial: !anyNonPending && !hasToolResults,
      done: hasTools && !anyRunning && (anyNonPending || hasToolResults),
      toolCount,
      activityText: activityParts.join(' · '),
      anyRunning,
      anyNonPending,
      liveOutput,
      heldCalls,
      receivingText: props.isReceiving && toolNames.size > 0
        ? Array.from(toolNames).map((name) => toolDisplayName(name, t)).join('、') + ' 指令生成中...'
        : ''
    }
  }, [props.messages, props.isReceiving, props.awaitingApproval, t])

  const anyHeld = heldCalls.length > 0

  // - Receiving (streaming blocks not yet committed): show "写入文件 指令生成中..."
  // - Initial state (all tools still pending): show "开始执行"
  // - Done state (tools all done AND segment no longer last / engine idle): show "已完成（工具调用X次）"
  // - Held for approval: show 待批准 (the engine cannot move until it is answered)
  // - Executing: show the last extracted text
  const isPending = props.isLastSegment && props.isRequesting
  const showDone = done && !isPending
  const showInitialActive = initial && props.isRequesting
  const showSpinner = !showDone && props.isRequesting
  // Done state carries the activity narrative when any family counts up
  // (PLAN-tool-ux T4); families that don't map (MCP, git, page tools) keep
  // the plain call-count form.
  const doneText = activityText || `工具调用${toolCount}次`
  const displayText = props.isReceiving ? receivingText : anyHeld ? t('commandCard.awaitingApproval') : (showDone ? `已完成 · ${doneText}` : showInitialActive ? '开始执行' : (liveOutput || (texts.length > 0 ? texts[texts.length - 1] : 'Processing...')))

  return (
    <div style={{ margin: '8px 0', borderRadius: 8, overflow: 'hidden' }}>
      {/* Collapsed header */}
      <div
        data-segment-head=""
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
              color: anyHeld ? '#d46b08' : '#999',
              fontWeight: anyHeld ? 500 : undefined,
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

      {/* The decision, below the collapsed header. This segment is the outermost
          thing hiding a held call, so the buttons have to appear here or answering
          means expanding twice (this, then the tool block). Expanding moves them
          down to the tool blocks — never both at once. */}
      {!expanded && anyHeld && (
        <div style={{ padding: '0 10px 4px' }}>
          <ApprovalArea
            blocks={heldCalls}
            onApproveTool={props.onApproveTool}
            onRejectTool={props.onRejectTool}
            identity
          />
        </div>
      )}

      {/* Expanded body */}
      {expanded && (
        <div style={{ padding: '8px 12px 4px', border: '1px solid #e8e8e8', borderRadius: 8 }}>
          {props.messages.map((msg) => (
            <MessageGroup
              key={msg.id}
              msg={msg}
              actions="none"
              onApproveTool={props.onApproveTool}
              onRejectTool={props.onRejectTool}
              onKillTool={props.onKillTool}
              onRespondToTool={props.onRespondToTool}
              conversationId={props.conversationId}
              conversationTitle={props.conversationTitle}
              onOpenSubAgent={props.onOpenSubAgent}
              awaitingApproval={props.awaitingApproval}
            />
          ))}
        </div>
      )}
    </div>
  )
})