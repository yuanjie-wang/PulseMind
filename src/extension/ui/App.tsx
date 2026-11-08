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

import { useCallback, useEffect, useRef, useState } from 'react'
import { openOptions } from '../content/bridge'
import { Composer } from './Composer'
import { Icon } from './icons'
import { Logo } from './logo'
import { SessionsMenu } from './SessionsMenu'
import { StateStrip } from './StateStrip'
import { Transcript } from './Transcript'
import { useFabDrag } from './useFabDrag'
import { usePanel } from './usePanel'
import { trustedOnly } from './trusted'

const STATUS_LABELS: Record<string, string> = {
  idle: '就绪',
  streaming: '思考中',
  executing: '执行中',
  retrying: '重试中',
  awaiting_approval: '等待批准',
  awaiting_user_input: '等待回答',
  awaiting_extension: '等待扩展',
  awaiting_continue: '已暂停',
  queued: '排队中',
  completed: '完成',
  error: '出错',
}

/** 重试横幅的计数与倒计时（2026-10-31 交付物2）——mirror 早就持有
 *  attempt/maxRetries/delay（mirroredStatus 的成对重建纪律），此前只印裸词。
 *  成对缺失时回落裸词：横幅宁可藏起括号，也不渲染 `(/)`。倒计时在 attempt
 *  变化时重置——同一次退避里的秒针跳到 0 后由下一次 status 事件接管。 */
function RetryStatusLabel({ attempt, maxRetries, delayMs }: { attempt: number; maxRetries: number; delayMs: number }): React.JSX.Element {
  const [remaining, setRemaining] = useState(() => Math.max(1, Math.ceil(delayMs / 1000)))
  useEffect(() => {
    setRemaining(Math.max(1, Math.ceil(delayMs / 1000)))
    const timer = window.setInterval(() => setRemaining((s) => Math.max(0, s - 1)), 1000)
    return () => window.clearInterval(timer)
  }, [attempt, maxRetries, delayMs])
  return (
    <>
      重试中 ({attempt}/{maxRetries} · {remaining}s)
    </>
  )
}

function ConnectionChip({ state }: { state: ReturnType<typeof usePanel>['connection'] }): React.JSX.Element {
  const label = state.connected ? '已连接' : state.state === 'connecting' ? '连接中' : '未连接'
  return <span className={`pm-chip ${state.connected ? 'pm-chip-ok' : 'pm-chip-bad'}`}>{label}</span>
}

/** 兜底清理期限：正常路径是面板自身的 width/height `transitionend` 摘掉过渡类
 *  （两个属性各发一次事件，摘一次即可）；这个定时器只在收不到 transitionend 时
 *  兜底——典型是 `prefers-reduced-motion` 下 styles.css 的媒体查询把过渡整个
 *  关掉。数值只需严格大于样式里的 0.2s（改样式时长时留意这一对）。 */
const PANEL_ANIM_FALLBACK_MS = 400

export function App(): React.JSX.Element {
  const panel = usePanel()
  const fab = useFabDrag()
  /** 放大态：面板铺到「窗口高 − 上下各一道 20px 边距」/ 宽度的 40%
   *  （styles.css 的 .pm-panel-wide）。只活在本次挂载里 —— 收起/展开是 worker
   *  按 tab 记的（背景/state.ts），尺寸不是。 */
  const [wide, setWide] = useState(false)
  /** 转到桌面端的两步确认（PLAN-extension-handoff）：一次点击变确认态，确认
   *  才发 panel/handoff——转出后此页签的会话绑定即解除，误触不可逆。 */
  const [confirmHandoff, setConfirmHandoff] = useState(false)
  /** 尺寸切换的补间只活在切换瞬间（styles.css .pm-panel-animating 的注释）：
   *  同一次提交里挂上、transitionend 摘掉、兜底定时器保底。 */
  const [animating, setAnimating] = useState(false)
  const animTimer = useRef<number | undefined>(undefined)
  const { connection, session } = panel
  const status = session.agentStatus
  const statusLabel =
    status.status === 'retrying' && typeof status.attempt === 'number' && typeof status.maxRetries === 'number' ? (
      <RetryStatusLabel attempt={status.attempt} maxRetries={status.maxRetries} delayMs={status.delay ?? 0} />
    ) : (
      (STATUS_LABELS[status.status] ?? status.status)
    )

  useEffect(() => () => window.clearTimeout(animTimer.current), [])

  const toggleWide = useCallback(() => {
    setWide((v) => !v)
    // 两个 setState 落在同一次提交里，样式重算时过渡已在位——这就是「变化走
    // 补间而不是瞬跳」的全部机关。
    setAnimating(true)
    window.clearTimeout(animTimer.current)
    animTimer.current = window.setTimeout(() => setAnimating(false), PANEL_ANIM_FALLBACK_MS)
  }, [])

  const clearAnimating = useCallback((e: React.TransitionEvent<HTMLDivElement>) => {
    // 头部按钮有自己的 color/border 过渡，transitionend 会冒泡上来——只有面板
    // 自身的 width/height 结束才算尺寸动画完毕。
    if (e.target !== e.currentTarget || (e.propertyName !== 'width' && e.propertyName !== 'height')) return
    window.clearTimeout(animTimer.current)
    setAnimating(false)
  }, [])

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
    <div className={`pm-panel ${wide ? 'pm-panel-wide' : ''} ${animating ? 'pm-panel-animating' : ''}`} onTransitionEnd={clearAnimating}>
      <header className="pm-header">
        <span className="pm-brand">PulseMind</span>
        <ConnectionChip state={connection} />
        <span className="pm-status">{statusLabel}</span>
        <span className="pm-spacer" />
        <SessionsMenu
          sessions={panel.sessions}
          currentId={panel.sessionId}
          onResume={(id) => void panel.resumeSession(id)}
          onDelete={(id) => void panel.deleteSession(id)}
        />
        <button className="pm-icon-btn" title="新会话" onClick={() => void panel.newSession()}>
          <Icon name="plus" />
        </button>
        {/* 转到桌面端继续（PLAN-extension-handoff）：只在已绑定会话时出现——没有
            会话的页签无可移交。确认不复用头部图标（expand 与「放大」撞形），
            走头部下方的确认卡——与循环上限卡同族。 */}
        {panel.sessionId && (
          <button className="pm-icon-btn" title="转到桌面端继续" onClick={() => setConfirmHandoff(true)}>
            <Icon name="external" />
          </button>
        )}
        <button className="pm-icon-btn" title={wide ? '还原' : '放大'} onClick={toggleWide}>
          <Icon name={wide ? 'compress' : 'expand'} />
        </button>
        <button className="pm-icon-btn" title="收起" onClick={() => panel.setOpen(false)}>
          <Icon name="close" />
        </button>
      </header>

      {/* 转出确认卡（PLAN-extension-handoff，2026-11-08 交互返工）：头部两步图标
          确认太隐晦（冒出两个陌生图标钮），改成语义卡——说清后果、两个明确按钮。 */}
      {confirmHandoff && (
        <div className="pm-iterate">
          <div className="pm-iterate-title">转到桌面端继续？</div>
          <div className="pm-iterate-desc">
            当前会话将在桌面端 PulseMind 打开并继续对话，此页签解除绑定；当前页面与登录状态（cookie）一并带走。
          </div>
          <div className="pm-iterate-actions">
            <button
              className="pm-iterate-btn pm-iterate-btn-primary"
              onClick={(e) => {
                if (!trustedOnly(e)) return
                setConfirmHandoff(false)
                void panel.handoff({ url: location.href, title: document.title })
              }}
            >
              转到桌面端
            </button>
            <button className="pm-iterate-btn pm-iterate-btn-danger" onClick={() => setConfirmHandoff(false)}>
              取消
            </button>
          </div>
        </div>
      )}

      {/* 「已转出」空态横幅（PLAN-extension-handoff）：会话已在桌面端继续，此
          页签解绑；「开始新对话」走 newSession（worker 会清掉 handedOff 标记）。
          页签导航后 worker 清标记，横幅自然消失。 */}
      {panel.handedOff && (
        <div className="pm-banner">
          <span className="pm-banner-title">该会话已在桌面端 PulseMind 继续聊</span>
          <button className="pm-link" onClick={() => void panel.newSession()}>
            开始新对话
          </button>
        </div>
      )}

      {!connection.connected ? (
        <div className="pm-banner">
          {/* 话术就这一句（user 2026-10-09 裁定，诊断原因不再上横幅——options 页
              与 [PulseMind] 日志仍是诊断面）；连接中不催开桌面端——那正是它
              正在做的事。 */}
          <span className="pm-banner-title">{connection.state === 'connecting' ? '正在连接桌面端 PulseMind…' : '请先打开 PulseMind 桌面端，并稍等片刻'}</span>
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
      {/* Loop-limit decision (desktop chat/ExtensionPrompt, same zh strings):
          the engine parks on awaiting_extension until answered — without this
          card the panel's only way out was 停止. The zh strings are the
          renderer's own (i18n/locales/zh.ts extensionPrompt); the description
          deliberately carries NO count — the renewal adds the user-configured
          loop limit (default 200), so any literal number here would be wrong
          (review_20261008 中2). */}
      {session.agentStatus.status === 'awaiting_extension' && (
        <div className="pm-iterate">
          <div className="pm-iterate-title">循环次数已达上限</div>
          <div className="pm-iterate-desc">任务仍在进行中，是否继续执行？继续将按当前上限额外增加一轮循环额度。</div>
          <div className="pm-iterate-actions">
            <button
              className="pm-iterate-btn pm-iterate-btn-primary"
              onClick={(e) => {
                if (trustedOnly(e)) panel.respondIteration(true)
              }}
            >
              继续执行
            </button>
            <button
              className="pm-iterate-btn pm-iterate-btn-danger"
              onClick={(e) => {
                if (trustedOnly(e)) panel.respondIteration(false)
              }}
            >
              停止
            </button>
          </div>
        </div>
      )}
      {/* mirror 早已折叠的三态（plan / file_changes / compaction）的渲染面
          （2026-10-31 交付物3）——数据一直在，缺的只是这块展示面。 */}
      <StateStrip plan={session.plan} fileChanges={session.fileChanges} lastCompaction={session.lastCompaction} />
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
