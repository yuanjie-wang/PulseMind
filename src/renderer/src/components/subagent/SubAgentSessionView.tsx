// ── Sub-agent session view (PLAN-workbench W12: 点击 DAG 模块进入子代理会话) ──
// The sub-agent's conversation rendered with the SAME message stream the main
// chat uses (chat/TranscriptView — same segments, bubbles, tool cards), with
// exactly two differences per the ruling: no composer, and a 返回主对话 button
// at the top-left.
//
// There is no live engine handle to read here: engines are hosted in the main
// process (M1.4), so the only handle-side state that can cross over is the
// sub-conversation ID. The view therefore always reads the persisted
// sub-conversation — main re-saves it every few seconds while the sub-agent
// works — and polls while the node is still open, which also makes it work
// after a restart, for a finished run and for one that is still going.
import React, { useEffect, useRef, useState } from 'react'
import { ArrowLeftOutlined } from '@ant-design/icons'
import type { AgentMessage, ContentBlock } from '../../types/agent'
import { TranscriptView } from '../chat/TranscriptView'

export interface SubAgentSessionViewProps {
  /** The sub-conversation this session runs in (plan node / spawn block link). */
  subConvId: string
  /** Header title: the plan node this session implements. */
  title: string
  /** Still open — poll the stored transcript for new turns while it runs. */
  live: boolean
  onBack: () => void
}

/** Cheap content signature for the poll loop: growing text, new messages and
 *  tool-card status transitions all change it. */
function signature(msgs: AgentMessage[]): string {
  return msgs
    .map(m => `${m.id}:${(m.contentBlocks ?? []).map(b => b.type + (b.type === 'text' ? String((b as { text?: string }).text?.length ?? '') : ((b as { status?: string }).status ?? ''))).join(',')} `)
    .join('|')
    .slice(0, 4000)
}

/** Drop storage-only rows: a message is worth showing when it carries a
 *  renderable block (the stored `content` string alone is a mirror of them). */
function renderable(msgs: AgentMessage[]): AgentMessage[] {
  return msgs.filter(m =>
    m.contentBlocks?.some((b: ContentBlock) => b.type === 'text' || b.type === 'tool_use' || b.type === 'tool_result')
    || !!(m as unknown as { content?: string }).content)
}

const noop = (): void => {}
const noopResponse = (): void => {}

/** Follow-the-run poll interval. The main process snapshots a sub-conversation
 *  every 5s, so this only decides how quickly those snapshots are picked up. */
const POLL_MS = 2000
/** Hard stop so a plan the model never settles cannot poll forever. */
const MAX_POLL_MS = 30 * 60_000

export function SubAgentSessionView({ subConvId, title, live, onBack }: SubAgentSessionViewProps): React.ReactElement {
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const sigRef = useRef('')

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const conv = await window.electronAPI.hydrateConversation(subConvId)
        if (cancelled) return
        const msgs = renderable((conv?.messages ?? []) as AgentMessage[])
        const sig = signature(msgs)
        if (sig !== sigRef.current) {
          sigRef.current = sig
          setMessages(msgs)
        }
        setLoadError(msgs.length === 0 ? '暂无对话内容' : null)
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : '加载子代理会话失败')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()

    if (!live) return () => { cancelled = true }
    const startedAt = Date.now()
    const timer = setInterval(() => {
      if (Date.now() - startedAt > MAX_POLL_MS) { clearInterval(timer); return }
      void load()
    }, POLL_MS)
    return () => { cancelled = true; clearInterval(timer) }
  }, [subConvId, live])

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#fff', position: 'relative' }}>
      {/* Header — 返回主对话 at the top-left, run state at the right. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '0 16px',
          height: 44,
          flexShrink: 0,
          borderBottom: '1px solid #ececf0',
          background: '#fff',
        }}
      >
        <div
          onClick={onBack}
          title="返回主对话"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            padding: '4px 10px',
            borderRadius: 6,
            fontSize: 12,
            color: '#555',
            cursor: 'pointer',
            flexShrink: 0,
          }}
          onMouseEnter={e => { e.currentTarget.style.background = '#f0f1f4' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
        >
          <ArrowLeftOutlined style={{ fontSize: 12 }} />
          <span>返回主对话</span>
        </div>
        <div style={{ width: 1, height: 16, background: '#e5e6eb', flexShrink: 0 }} />
        <div
          style={{ fontSize: 13, fontWeight: 600, color: '#333', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={title}
        >
          {title}
        </div>
        <div style={{ flex: 1 }} />
        <span
          style={{
            fontSize: 11,
            padding: '2px 8px',
            borderRadius: 9,
            flexShrink: 0,
            color: live ? '#1677ff' : '#8c8c8c',
            background: live ? '#f0f7ff' : '#f5f5f5',
          }}
        >
          {live ? '子代理运行中' : '已结束'}
        </span>
      </div>

      {/* The same transcript the main chat renders — minus the composer. */}
      <TranscriptView
        messages={messages}
        agentStatus={{ status: 'idle' }}
        streamingBlocks={[] as ContentBlock[]}
        isRequesting={false}
        restoring={loading}
        emptyHint={loadError ?? '暂无对话内容'}
        actions={live ? 'viewOnly' : 'full'}
        onApproveTool={noop}
        onRejectTool={noop}
        onKillTool={noop}
        onRespondToTool={noopResponse}
        onClearError={noop}
        onRetry={noop}
      />
    </div>
  )
}
