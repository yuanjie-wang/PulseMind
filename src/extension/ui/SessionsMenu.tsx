/** The header's 历史会话 dropdown (2026-10-31 PLAN-extension-panel-state-surface
 *  交付物4): the session API has been live on both ends all along —
 *  `usePanel.resumeSession/deleteSession` and the worker's `panel/resume|delete`
 *  branches — with nothing rendering it, so the panel could only ever see the
 *  tab's current session and 新会话 threw history away. This is the missing UI.
 *
 * rename stays unwired (行内输入框形态另裁定); delete uses an inline
 * confirm row — the panel has no Modal, and window.confirm inside a shadow
 * root is a browser dialog the panel cannot style. */

import { useState } from 'react'
import type { SessionSummary } from '../bridge'
import { Icon } from './icons'
import { useDropdown } from './useDropdown'
import { relativeTime } from './StateStrip'

export function SessionsMenu({ sessions, currentId, onResume, onDelete }: {
  sessions: SessionSummary[]
  currentId: string | null
  onResume: (sessionId: string) => void
  onDelete: (sessionId: string) => void
}): React.JSX.Element {
  const menu = useDropdown()
  /** 行内二次确认:一次点击只把它带到「确认删除?」,再一次才真删。 */
  const [confirmId, setConfirmId] = useState<string | null>(null)
  return (
    <span className="pm-sessions-anchor" ref={menu.anchorRef}>
      <button
        className={`pm-icon-btn${menu.open ? ' pm-icon-btn-active' : ''}`}
        title="历史会话"
        onClick={menu.toggle}
      >
        <Icon name="history" />
      </button>
      {menu.open ? (
        <div className="pm-sessions-menu" data-sessions-menu="">
          {sessions.length === 0 ? <div className="pm-sessions-empty">暂无历史会话</div> : null}
          {sessions.map((s) => (
            <div key={s.sessionId} className={`pm-sessions-row${s.sessionId === currentId ? ' pm-sessions-row-current' : ''}`}>
              <button
                className="pm-sessions-open"
                onClick={() => {
                  menu.close()
                  setConfirmId(null)
                  onResume(s.sessionId)
                }}
              >
                <span className="pm-sessions-title">{s.title || '未命名会话'}</span>
                <span className="pm-sessions-time">
                  {s.sessionId === currentId ? '当前 · ' : ''}
                  {relativeTime(s.updatedAt)}
                </span>
              </button>
              {confirmId === s.sessionId ? (
                <span className="pm-sessions-confirm">
                  确认删除?
                  <button
                    className="pm-sessions-confirm-yes"
                    onClick={() => {
                      setConfirmId(null)
                      menu.close()
                      onDelete(s.sessionId)
                    }}
                  >
                    删除
                  </button>
                  <button className="pm-sessions-confirm-no" onClick={() => setConfirmId(null)}>
                    取消
                  </button>
                </span>
              ) : (
                <button
                  className="pm-sessions-del"
                  title="删除会话"
                  onClick={(e) => {
                    e.stopPropagation()
                    setConfirmId(s.sessionId)
                  }}
                >
                  <Icon name="close" />
                </button>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </span>
  )
}
