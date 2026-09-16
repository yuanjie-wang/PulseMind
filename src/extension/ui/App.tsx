/** The in-page panel (PLAN-browser-extension M1.2/M1.3): FAB + shadow-DOM panel.
 *
 * One component owns both the collapsed launcher and the expanded panel so the
 * open/closed state has a single source of truth; the worker persists it per tab
 * (see background/state.ts) and hands it back on attach, which is how a page
 * reload or navigation restores the panel.
 *
 * The transcript and composer inside are the desktop chat's markup and values
 * (ui/Transcript.tsx, ui/Composer.tsx); the header and banners are the panel's
 * own chrome, styled with the same light palette. */

import { useState } from 'react'
import { openOptions } from '../content/bridge'
import { Composer } from './Composer'
import { Icon } from './icons'
import { Logo } from './logo'
import { Transcript } from './Transcript'
import { useFabDrag } from './useFabDrag'
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

export function App(): React.JSX.Element {
  const panel = usePanel()
  const fab = useFabDrag()
  /** 放大态：面板铺到窗口高度的 90% / 宽度的 40%（见 styles.css 的 .pm-panel-wide）。
   *  只活在本次挂载里 —— 收起/展开是 worker 按 tab 记的（背景/state.ts），尺寸不是。 */
  const [wide, setWide] = useState(false)
  const { connection, session } = panel
  const statusLabel = STATUS_LABELS[session.agentStatus.status] ?? session.agentStatus.status

  if (!panel.open) {
    return (
      <button
        className="pm-fab"
        title="PulseMind"
        style={fab.style}
        onPointerDown={fab.onPointerDown}
        onPointerMove={fab.onPointerMove}
        onPointerUp={fab.onPointerUp}
        onPointerCancel={fab.onPointerCancel}
        // The browser delivers a click after a drag too; only a gesture that
        // did not move opens the panel.
        onClick={() => {
          if (!fab.consumeDragClick()) panel.setOpen(true)
        }}
      >
        <Logo width={32} />
      </button>
    )
  }

  return (
    <div className={`pm-panel ${wide ? 'pm-panel-wide' : ''}`}>
      <header className="pm-header">
        <span className="pm-brand">PulseMind</span>
        <ConnectionChip state={connection} />
        <span className="pm-status">{statusLabel}</span>
        <span className="pm-spacer" />
        <button className="pm-icon-btn" title="新会话" onClick={() => void panel.newSession()}>
          <Icon name="plus" />
        </button>
        <button className="pm-icon-btn" title={wide ? '还原' : '放大'} onClick={() => setWide((v) => !v)}>
          <Icon name={wide ? 'compress' : 'expand'} />
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
