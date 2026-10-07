/** Panel composer: the desktop's input card in miniature.
 *
 * Visual source: components/chat/Composer.tsx (the `Sender` override block —
 * pill radius, frosted white, `0 5px 20px 2px rgb(80 100 200 / 20%)` shadow,
 * 24px primary circle send button) and components/chat/InputArea.tsx for the two
 * footer controls: 授权 (in the prefix slot there: icon + label + caret, a
 * dropdown of the three levels) and 模型 (in the trailing slot there: label +
 * caret, a dropdown of `settings.profiles`).
 *
 * What is deliberately absent: attachments and expert @-mentions. Those need
 * the desktop's file dialogs and profile store; the panel's job is 说一句话 —
 * the M4 side panel is where they land. */

import { useEffect, useRef, useState } from 'react'
import { MAX_USER_INPUT_CHARS } from '../../renderer/src/agent/engine/engine-constants'
import { DEFAULT_APPROVAL_MODE, type SandboxApprovalMode } from '../../shared/sandbox/policy'
import { fullModelLabel, type ModelState } from '../../shared/agent-protocol'
import { Icon } from './icons'

const MAX_HEIGHT_PX = 160

// ── 输入帽（2026-09-30 桌面裁定「给输入框一个4k的上限」）的面板镜像 ──
// 同一个常量：桌面 Composer 也从 engine-constants 取（AgentEngine 是 de-facto
// 共享代码，常量必须住在引擎侧才两边都够得着）。引擎端 prepareTurn 本来就会
// 对没有 UI 钳的客户端兜底裁切——但那是静默的：这里钳在 onChange 上，超限粘
// 贴被裁头，计数器告诉用户发生了什么。剪裁而非拒绝，与桌面同款。
export const COMPOSER_MAX_CHARS = MAX_USER_INPUT_CHARS

/** 计数器八成满时出现（桌面 COMPOSER_COUNT_VISIBLE_AT 同款算式）。 */
export const COMPOSER_COUNT_VISIBLE_AT = Math.floor(COMPOSER_MAX_CHARS * 0.8)

export function clampComposerInput(value: string): string {
  return value.length > COMPOSER_MAX_CHARS ? value.slice(0, COMPOSER_MAX_CHARS) : value
}

/** Approval levels, most restrictive first — the chat's order and wording
 *  (InputArea's APPROVAL_LEVELS + 授权文案). */
const APPROVAL_LEVELS: Array<{ mode: SandboxApprovalMode; label: string; icon: 'lock' | 'safety' | 'thunderbolt' }> = [
  { mode: 'always-ask', label: '始终询问', icon: 'lock' },
  { mode: 'outside-ask', label: '按需确认', icon: 'safety' },
  { mode: 'auto', label: '全部允许', icon: 'thunderbolt' },
]

/** One dropdown's plumbing: open state, its anchor ref, and the outside-click
 *  close. The panel has no antd Dropdown to do the latter, and both footer menus
 *  need exactly this much — so it is written once instead of twice. */
function useDropdown(): { open: boolean; anchorRef: React.RefObject<HTMLSpanElement>; toggle: () => void; close: () => void } {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      // `composedPath()`, NOT `e.target`: the panel renders inside a Shadow Root,
      // and a listener outside that root sees every inner event retargeted to the
      // *host* element — so `anchor.contains(e.target)` is false for a click on
      // our own menu item, the menu closes on mousedown, and the click never
      // lands. (Measured: the 授权 dropdown was dead to the mouse for exactly
      // this reason.) composedPath() crosses the shadow boundary and names the
      // real innermost node.
      const path = e.composedPath?.() ?? []
      const anchor = anchorRef.current
      if (anchor && !path.includes(anchor)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  return { open, anchorRef, toggle: () => setOpen((v) => !v), close: () => setOpen(false) }
}

export function Composer({ busy, disabled, approvalMode, model, onSend, onStop, onChangeApprovalMode, onSelectModel }: {
  busy: boolean
  disabled: boolean
  /** The conversation's current level; undefined until the desktop reports it. */
  approvalMode?: SandboxApprovalMode
  /** The selectable models + the active one; undefined until the service reports
   *  them (or while it is unreachable), which keeps the picker off the footer. */
  model?: ModelState
  onSend: (text: string) => void
  onStop: () => void
  onChangeApprovalMode: (mode: SandboxApprovalMode) => void
  onSelectModel: (profileId: string) => void
}): React.JSX.Element {
  const [text, setText] = useState('')
  const areaRef = useRef<HTMLTextAreaElement | null>(null)
  const approvalMenu = useDropdown()
  const modelMenu = useDropdown()

  // Grow with the content up to a cap, then scroll (antd autoSize minRows 1).
  useEffect(() => {
    const el = areaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`
  }, [text])

  const submit = (): void => {
    const value = text.trim()
    if (!value || busy || disabled) return
    setText('')
    onSend(value)
  }

  // Until the desktop reports a level (no session yet, or the service is
  // unreachable) the button shows the shared default rather than a hardcoded
  // 'auto': a brand-new session is held at 按需确认, and the panel must not
  // claim it is unrestricted while the ladder is gating its calls.
  const active =
    APPROVAL_LEVELS.find((l) => l.mode === approvalMode) ??
    APPROVAL_LEVELS.find((l) => l.mode === DEFAULT_APPROVAL_MODE) ??
    APPROVAL_LEVELS[0]
  // Same two-step as the desktop's own button: the active profile's label, with
  // the placeholder reserved for the case where there is no profile at all.
  const profiles = model?.profiles ?? []
  const activeProfile = profiles.find((p) => p.id === model?.activeId) ?? profiles[0]
  const activeModelLabel = activeProfile ? fullModelLabel(activeProfile) : '选择模型'

  // 全部允许 = 工具调用不再经过批准，是唯一「无人拦截」的一档，所以它的图标和
  // 文案一起转警示橙（InputArea 的 UNRESTRICTED_COLOR，同一值同一用意）。加在
  // 按钮 / 菜单项这些容器上，图标与文案由样式表的后代选择器一起染色。
  const autoTint = (mode: SandboxApprovalMode): string => (mode === 'auto' ? ' pm-approval-auto' : '')

  return (
    <div className="pm-composer">
      <div className="pm-input-card">
        <textarea
          ref={areaRef}
          className="pm-input"
          rows={1}
          placeholder={disabled ? '未连接桌面端' : '问点什么…（Enter 发送，Shift+Enter 换行）'}
          value={text}
          disabled={disabled}
          onChange={(e) => setText(clampComposerInput(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="pm-input-footer">
          {/* 授权：与桌面端同一个按钮语义 —— 决定工具调用是否需要批准，写在
              conversations.approval_mode 上，下一条消息生效。 */}
          <span className="pm-approval-anchor" ref={approvalMenu.anchorRef}>
            <button
              className={`pm-approval${approvalMenu.open ? ' pm-approval-active' : ''}${autoTint(active.mode)}`}
              title={`${active.label} · 工具调用审批`}
              onClick={approvalMenu.toggle}
            >
              <span className="pm-approval-icon">
                <Icon name={active.icon} />
              </span>
              <span className="pm-approval-label">{active.label}</span>
              <span className="pm-approval-caret">
                <Icon name="down" />
              </span>
            </button>
            {approvalMenu.open && (
              <div className="pm-approval-menu">
                {APPROVAL_LEVELS.map((level) => (
                  <button
                    key={level.mode}
                    className={`pm-approval-item${level.mode === active.mode ? ' pm-approval-item-active' : ''}${autoTint(level.mode)}`}
                    onClick={() => {
                      approvalMenu.close()
                      onChangeApprovalMode(level.mode)
                    }}
                  >
                    <span className="pm-approval-item-icon">
                      <Icon name={level.icon} />
                    </span>
                    <span className="pm-approval-item-label">{level.label}</span>
                  </button>
                ))}
              </div>
            )}
          </span>
          <span className="pm-input-spacer" />
          {/* 模型：与桌面端同一个按钮语义 —— 写 settings.activeProfileId（全局），
              服务端顺手把活跃会话换到新模型上，下一条消息即生效。顺序也照抄
              桌面端 trailing 槽：模型在发送按钮左边。 */}
          {activeProfile && (
            <span className="pm-model-anchor" ref={modelMenu.anchorRef}>
              <button
                className={`pm-model${modelMenu.open ? ' pm-model-active' : ''}`}
                title={activeModelLabel}
                onClick={modelMenu.toggle}
              >
                <span className="pm-model-label">{activeModelLabel}</span>
                <span className="pm-model-caret">
                  <Icon name="down" />
                </span>
              </button>
              {modelMenu.open && (
                <div className="pm-model-menu">
                  {/* Flat list with the 供应商 prefix (fullModelLabel): the
                      380px panel has no room for group headers, and with two
                      providers carrying the same model id a bare label no
                      longer says whose it is. */}
                  {profiles.map((profile) => (
                    <button
                      key={profile.id}
                      className={`pm-model-item${profile.id === model?.activeId ? ' pm-model-item-active' : ''}`}
                      title={profile.model}
                      onClick={() => {
                        modelMenu.close()
                        onSelectModel(profile.id)
                      }}
                    >
                      {fullModelLabel(profile)}
                    </button>
                  ))}
                </div>
              )}
            </span>
          )}
          {/* 到线计数（桌面 Composer 的 nearLimit 计数器，同款 inline 样式与
              值）：#d46b08 是到线琥珀（InputArea 的 UNRESTRICTED_COLOR），
              #999 是弱化墨色。八成满才出现，粘贴被裁头时它就是那个说明。 */}
          {text.length >= COMPOSER_COUNT_VISIBLE_AT && (
            <span
              className="pm-composer-count"
              style={{
                fontSize: 11,
                lineHeight: 1,
                color: text.length >= COMPOSER_MAX_CHARS ? '#d46b08' : '#999',
                fontVariantNumeric: 'tabular-nums',
                whiteSpace: 'nowrap',
              }}
            >
              {text.length}/{COMPOSER_MAX_CHARS}
            </span>
          )}
          {busy ? (
            <button className="pm-send pm-send-busy" title="停止" onClick={onStop}>
              <Icon name="loading" spin />
            </button>
          ) : (
            <button className="pm-send" title="发送" disabled={disabled || !text.trim()} onClick={submit}>
              <Icon name="arrowUp" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
