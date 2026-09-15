/** The in-page panel (PLAN-browser-extension M1.2/M1.3): FAB + shadow-DOM panel.
 *
 * One component owns both the collapsed launcher and the expanded panel so the
 * open/closed state has a single source of truth; the worker persists it per tab
 * (see background/state.ts) and hands it back on attach, which is how a page
 * reload or navigation restores the panel.
 *
 * The transcript and composer inside are the desktop chat's markup and values
 * (ui/Transcript.tsx, ui/Composer.tsx); the header, banners and session list are
 * the panel's own chrome, styled with the same light palette. */

import { useEffect, useRef, useState } from 'react'
import { openOptions } from '../content/bridge'
import { Composer } from './Composer'
import { Icon } from './icons'
import { Transcript } from './Transcript'
import { usePanel } from './usePanel'

const STATUS_LABELS: Record<string, string> = {
  idle: '就绪',
  streaming: '思考中',
  executing: '执行中',
  retrying: '重试中',
  awaiting_approval: '等待批准',
  awaiting_user_input: '等待回答',
  awaiting_extension: '等待扩展',
  queued: '排队中',
  completed: '完成',
  error: '出错',
}

function ConnectionChip({ state }: { state: ReturnType<typeof usePanel>['connection'] }): React.JSX.Element {
  const label = state.connected ? '已连接' : state.state === 'connecting' ? '连接中' : '未连接'
  return <span className={`pm-chip ${state.connected ? 'pm-chip-ok' : 'pm-chip-bad'}`}>{label}</span>
}

/** Inline title editor — no window.prompt, which would block the page. */
function SessionRow({ title, sessionId, active, onResume, onDelete, onRename }: {
  title: string
  sessionId: string
  active: boolean
  onResume: () => void
  onDelete: () => void
  onRename: (title: string) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const commit = (): void => {
    setEditing(false)
    const next = draft.trim()
    if (next && next !== title) onRename(next)
    else setDraft(title)
  }

  return (
    <div className={`pm-session ${active ? 'pm-session-active' : ''}`}>
      {editing ? (
        <input
          ref={inputRef}
          className="pm-session-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') {
              setDraft(title)
              setEditing(false)
            }
          }}
        />
      ) : (
        <button className="pm-session-title" title={sessionId} onClick={onResume}>
          {title || '未命名会话'}
        </button>
      )}
      <button className="pm-icon-btn" title="重命名" onClick={() => setEditing(true)}>
        <Icon name="edit" />
      </button>
      <button className="pm-icon-btn" title="删除" onClick={onDelete}>
        <Icon name="delete" />
      </button>
    </div>
  )
}

export function App(): React.JSX.Element {
  const panel = usePanel()
  const [historyOpen, setHistoryOpen] = useState(false)
  const { connection, session } = panel
  const statusLabel = STATUS_LABELS[session.agentStatus.status] ?? session.agentStatus.status

  if (!panel.open) {
    return (
      <button className="pm-fab" title="PulseMind" onClick={() => panel.setOpen(true)}>
        <Icon name="plus" style={{ fontSize: 18 }} />
      </button>
    )
  }

  return (
    <div className="pm-panel">
      <header className="pm-header">
        <span className="pm-brand">PulseMind</span>
        <ConnectionChip state={connection} />
        <span className="pm-status">{statusLabel}</span>
        <span className="pm-spacer" />
        <button className="pm-icon-btn" title="新会话" onClick={() => void panel.newSession()}>
          <Icon name="plus" />
        </button>
        <button
          className={`pm-icon-btn ${historyOpen ? 'pm-icon-btn-active' : ''}`}
          title="历史会话"
          onClick={() => setHistoryOpen((v) => !v)}
        >
          <Icon name="menu" />
        </button>
        <button className="pm-icon-btn" title="收起" onClick={() => panel.setOpen(false)}>
          <Icon name="close" />
        </button>
      </header>

      {!connection.connected ? (
        <div className="pm-banner">
          <span>{connection.reason ? `未连接：${connection.reason}` : '未连接桌面端 PulseMind'}</span>
          <button className="pm-link" onClick={openOptions}>
            打开设置
          </button>
        </div>
      ) : null}

      {panel.error ? (
        <div className="pm-banner pm-banner-error">
          <span>{panel.error}</span>
          <button className="pm-link" onClick={() => panel.setError(null)}>
            知道了
          </button>
        </div>
      ) : null}

      {historyOpen ? (
        <div className="pm-sessions">
          {panel.sessions.length === 0 ? (
            <div className="pm-sessions-empty">还没有历史会话</div>
          ) : (
            panel.sessions.map((s) => (
              <SessionRow
                key={s.sessionId}
                sessionId={s.sessionId}
                title={s.title ?? ''}
                active={s.sessionId === panel.sessionId}
                onResume={() => {
                  void panel.resumeSession(s.sessionId)
                  setHistoryOpen(false)
                }}
                onDelete={() => void panel.deleteSession(s.sessionId)}
                onRename={(title) => void panel.renameSession(s.sessionId, title)}
              />
            ))
          )}
        </div>
      ) : null}

      <Transcript
        session={session}
        busy={panel.busy}
        onApprovalResponse={(toolUseId, approved) => panel.respondToApproval(toolUseId, approved)}
        onAnswer={(toolUseId, response) => panel.answerQuestion(toolUseId, response)}
        onClearError={() => panel.setError(null)}
      />
      <Composer
        busy={panel.busy}
        disabled={!connection.connected}
        approvalMode={panel.approvalMode}
        model={panel.model}
        onSend={(t) => void panel.ask(t)}
        onStop={panel.cancel}
        onChangeApprovalMode={(mode) => void panel.setApprovalMode(mode)}
        onSelectModel={(profileId) => void panel.setModel(profileId)}
      />
    </div>
  )
}
