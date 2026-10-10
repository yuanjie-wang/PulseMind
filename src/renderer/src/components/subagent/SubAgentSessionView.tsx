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
import { storedMessagesToAgentMessages } from '../../utils/message-utils'
import { TranscriptView } from '../chat/TranscriptView'
import { DECLARED_STATUS_LABEL } from '../../../../shared/plan/graph'

export interface SubAgentSessionViewProps {
  /** The sub-conversation this session runs in (plan node / spawn block link). */
  subConvId: string
  /** Header title: the plan node this session implements. */
  title: string
  /** Still open — poll the stored transcript for new turns while it runs. */
  live: boolean
  /** The tree is frozen (停止 → awaiting_continue): the spawn blocks still read
   *  running and the plan node still reads pending, but nothing is moving —
   *  the badge says 已暂停 and the blinking cursor stays off until 继续执行
   *  (App derives this from the conversation's agentStatus). */
  paused?: boolean
  /** The node's delivered report (PLAN-plan-exchange 表达面): the drill-in view
   *  is where the run's full story lives, so its header carries the same
   *  「查看报告」 entry the DAG card does — null when no report was filed. */
  reportPath?: string
  declaredStatus?: 'success' | 'partial' | 'failed'
  onOpenReport?: () => void
  onBack: () => void
}

/** Cheap content signature for the poll loop: growing text, new messages and
 *  tool-card status transitions all change it. No cap: new messages append at
 *  the TAIL, so a head-truncated signature (the old slice(0, 4000)) froze once
 *  the head alone passed the cap — every later turn and status transition fell
 *  past the cut and the follow-the-run view stopped updating mid-session. The
 *  strings are small (a tool-heavy 100-message run stays in the low KBs). */
function signature(msgs: AgentMessage[]): string {
  return msgs
    .map(m => `${m.id}:${(m.contentBlocks ?? []).map(b => b.type + (b.type === 'text' ? String((b as { text?: string }).text?.length ?? '') : ((b as { status?: string }).status ?? ''))).join(',')} `)
    .join('|')
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
 *  every 5s, so polling faster only re-read the same bytes (review 2026-09-18
 *  M12: at 2s the full hydrate ran 2-3× per actual new snapshot for the whole
 *  live window). */
const POLL_MS = 5000
/** Hard stop so a plan the model never settles cannot poll forever. */
const MAX_POLL_MS = 30 * 60_000
/** First frame renders the TAIL of the transcript only (review 2026-09-18
 *  M12): a several-hundred-message sub-agent run used to mount every text
 *  block as an XMarkdown instance in one synchronous render, and re-rendered
 *  the whole thing on every poll that changed anything. 加载更早 grows the
 *  window; the poll signature still covers ALL messages, so nothing at the
 *  head is lost — it is only not rendered until asked for. */
const INITIAL_VISIBLE = 60

export function SubAgentSessionView({ subConvId, title, live, paused = false, reportPath, declaredStatus, onOpenReport, onBack }: SubAgentSessionViewProps): React.ReactElement {
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  // The render window rides the conversation it was opened for: switching to
  // another sub-conversation resets it. Adjusting state during render is the
  // React-blessed reset pattern here (no effect, no ref access).
  const [windowState, setWindowState] = useState({ convId: subConvId, limit: INITIAL_VISIBLE })
  if (windowState.convId !== subConvId) {
    setWindowState({ convId: subConvId, limit: INITIAL_VISIBLE })
  }
  const visibleLimit = windowState.limit
  const sigRef = useRef('')

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const conv = await window.electronAPI.hydrateConversation(subConvId)
        if (cancelled) return
        // tool_use.status is stripped on save, so the raw rows reach us with
        // every block undefined — restore completion from the persisted
        // tool_results like every other load path, or the whole view renders
        // 执行状态未知.
        const msgs = renderable(storedMessagesToAgentMessages(conv?.messages ?? []))
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
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--pm-bg)', position: 'relative' }}>
      {/* Header — 返回主对话 at the top-left, run state at the right. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '0 16px',
          height: 44,
          flexShrink: 0,
          borderBottom: '1px solid var(--pm-separator-faint)',
          background: 'var(--pm-bg)',
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
            color: 'var(--pm-text-body)',
            cursor: 'pointer',
            flexShrink: 0,
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--pm-tile-soft)' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
        >
          <ArrowLeftOutlined style={{ fontSize: 12 }} />
          <span>返回主对话</span>
        </div>
        <div style={{ width: 1, height: 16, background: 'var(--pm-pop-border)', flexShrink: 0 }} />
        <div
          style={{ fontSize: 13, fontWeight: 600, color: 'var(--pm-text-strong)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={title}
        >
          {title}
        </div>
        <div style={{ flex: 1 }} />
        {reportPath && onOpenReport && (
          // 报告契约表达面：下钻视图是这场运行完整故事所在的地方，头部给与
          // DAG 卡同一入口；title 带申报状态（成功/部分成功/失败），对照的
          // 事实随身携带。
          <button
            type="button"
            data-sub-report
            onClick={onOpenReport}
            title={`${reportPath}${declaredStatus ? `（声明状态：${DECLARED_STATUS_LABEL[declaredStatus]}）` : ''}`}
            style={{
              flexShrink: 0,
              background: 'none',
              border: 'none',
              padding: '4px 8px',
              borderRadius: 6,
              fontSize: 12,
              color: 'var(--pm-link)',
              cursor: 'pointer',
            }}
          >
            查看报告
          </button>
        )}
        <span
          style={{
            fontSize: 11,
            padding: '2px 8px',
            borderRadius: 9,
            flexShrink: 0,
            color: paused ? 'var(--pm-warn)' : live ? 'var(--pm-link)' : 'var(--pm-text-muted)',
            background: paused ? 'var(--pm-warn-bg)' : live ? 'var(--pm-link-bg)' : 'var(--pm-fill)',
          }}
        >
          {paused ? '已暂停' : live ? '子代理运行中' : '已结束'}
        </span>
      </div>

      {/* Older turns load on demand — the window keeps first-frame and
          per-poll render cost bounded (M12). */}
      {messages.length > visibleLimit && (
        <div
          onClick={() => setWindowState((s) => ({ ...s, limit: s.limit * 2 }))}
          style={{
            flexShrink: 0,
            textAlign: 'center',
            padding: '6px 0',
            fontSize: 12,
            color: 'var(--pm-link)',
            cursor: 'pointer',
            borderBottom: '1px solid var(--pm-border-hairline)',
            background: 'var(--pm-wash)',
          }}
        >
          加载更早的消息（还有 {messages.length - visibleLimit} 条）
        </div>
      )}

      {/* The same transcript the main chat renders — minus the composer.
          While the node is still open the tail carries the blinking cursor,
          exactly like the main chat during a run (user ruling 2026-09-25:
          子对话需要和主对话一样有个闪烁光标). `live` is the App-derived node
          state (no engine handle here), `paused` gates it off again for a
          frozen tree (停止 → awaiting_continue — the blocks still read running
          but nothing is moving), and `loading` keeps the first hydrate from
          blinking over an empty transcript. */}
      <TranscriptView
        messages={messages.slice(-visibleLimit)}
        agentStatus={{ status: 'idle' }}
        streamingBlocks={[] as ContentBlock[]}
        isRequesting={live && !paused && !loading}
        restoring={loading}
        emptyHint={loadError ?? '暂无对话内容'}
        actions={live ? 'viewOnly' : 'full'}
        entranceKey={subConvId}
        // 子会话自己的 id：'full' 分支（已结束的子对话回看）的「存到知识库」
        // 需要 blank-id 守卫的真 id，否则按钮静默 no-op（full_20261011 M5-P1）。
        conversationId={subConvId}
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
