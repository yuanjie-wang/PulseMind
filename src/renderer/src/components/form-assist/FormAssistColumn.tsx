// ── Shared assistant column of a conversational form editor ──
// One composition of the chat's own transcript + inline composer inside the
// editor-layout white card (EDITOR_CHAT_CARD), wired to a useFormAssistSession.
// The routine editor and the expert editor render exactly this — per the 界面
// 复用 rule the message list and composer are chat/TranscriptView +
// chat/InputArea, never a second conversation UI. Page-specific bits (title,
// placeholder, empty-state copy, starter chips) arrive as props; chips and
// composer both route through onSendMessage so the page can attach the live
// form snapshot. The 授权 button is the chat's own too — its level lives on
// the session (useFormAssistSession), not on the page.
// 传 onToggleCollapsed 的宿主（任务向导）多两层：灰色圆角外壳
// EDITOR_ASSIST_SHELL 与收起/展开（USER 2026-11-09）。收起是布局变化而非
// 卸载——卡节点保留在壳里 display:none，草稿与转录不会丢。

import React from 'react'
import { Button, Modal } from 'antd'
import { LeftOutlined, PlusOutlined, RightOutlined, RobotOutlined } from '@ant-design/icons'
import { TranscriptView } from '../chat/TranscriptView'
import { InputArea } from '../chat/InputArea'
import { PromptChip } from '../chat/PromptChip'
import { useTranslation } from '../../i18n/useTranslation'
import { EDITOR_ASSIST_RAIL, EDITOR_ASSIST_SHELL, EDITOR_CHAT_CARD, EDITOR_COLUMN_HEADER } from '../layout/editor-layout'
import type { LlmProfile } from '../../../../shared/types/settings'
import type { FormAssistSession } from './useFormAssistSession'

export interface FormAssistColumnProps<P extends object> {
  session: FormAssistSession<P>
  /** Column header, e.g. 任务助手 / 专家创建助手. */
  title: string
  placeholder: string
  /** Empty-state intro line and starter chips (a click sends). Omitted when
   *  the caller wants the transcript's plain hint instead. */
  emptyIntro?: string
  emptyExamples?: string[]
  profiles?: LlmProfile[]
  activeProfileId?: string
  /** Profile switch — the session's own refreshOptions runs right after, so
   *  the next ask uses the newly selected model without page wiring. */
  onSelectProfile?: (profileId: string) => void
  /** Every user message (composer and chips) funnels through here. */
  onSendMessage: (text: string) => void
  /** 新会话 (user ruling 2026-09-20, both form assistants): discard the
   *  entity's current thread and start fresh — one slot per entity, the old
   *  history does not come back. The confirm lives HERE so both hosts get
   *  the identical dialog; the handler does the dispose/delete + reset. */
  onNewSession?: () => void
  /** 收起态（user 2026-11-09）。**这个 prop 就是「外壳 + 收起/展开」的总
   *  开关**：传了 onToggleCollapsed 才有外壳与两个按钮，所以任务向导拿到
   *  卡片外壳、专家编辑器不动（它的助手卡本就嵌在灰色 EDITOR_SURFACE 里，
   *  再套一层就是双层内距）。状态归宿主页，本组件只画。
   *
   *  同日再裁定「无底色圆角矩形」：壳从灰底换成沉浸卡片配方，壳里的内容卡
   *  透明无圆角（壳就是卡）。 */
  collapsed?: boolean
  onToggleCollapsed?: () => void
  /** 展开态宽度（px，宿主按拖拽结果与 clamp 算好）。传给壳的 flex-basis；
   *  不传 = EDITOR_ASSIST_SHELL 自己的 460 缺省。收起态不用它——窄条恒 44。 */
  width?: number
  /** 拖拽进行中：撤掉壳的 flex-basis 过渡，否则每一帧的宽度都被 160ms 的
   *  缓动拖住（与 AppLayout 侧边栏 `dragging ? 'none'` 同一条教训）。 */
  resizing?: boolean
}

export function FormAssistColumn<P extends object>({
  session,
  title,
  placeholder,
  emptyIntro,
  emptyExamples,
  profiles,
  activeProfileId,
  onSelectProfile,
  onSendMessage,
  onNewSession,
  collapsed,
  onToggleCollapsed,
  width,
  resizing,
}: FormAssistColumnProps<P>): React.ReactElement {
  const { t } = useTranslation()

  const askNewSession = (): void => {
    if (!onNewSession) return
    if (session.messages.length === 0) {
      onNewSession()
      return
    }
    Modal.confirm({
      title: t('formAssist.newSessionConfirmTitle'),
      content: t('formAssist.newSessionConfirmContent'),
      okText: t('common.confirm'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: onNewSession,
    })
  }

  const emptyContent =
    emptyIntro || emptyExamples?.length ? (
      <div style={{ padding: '0 14px' }}>
        {emptyIntro && <div style={{ color: 'var(--pm-text-muted)', fontSize: 13, lineHeight: 1.7, marginBottom: 12 }}>{emptyIntro}</div>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {(emptyExamples ?? []).map((example) => (
            <PromptChip key={example} label={example} shape="rounded" onClick={() => onSendMessage(example)} />
          ))}
        </div>
      </div>
    ) : undefined

  // 传了 onToggleCollapsed = 要外壳与收起能力（任务向导）；不传 = 现役两栏
  // 嵌进父级灰面的形态（专家编辑器），DOM 与之前逐字节一致。
  const framed = !!onToggleCollapsed
  const isCollapsed = framed && collapsed === true

  // 外壳即卡片（沉浸配方，无底色）。drag 中的宽度每一帧都写 flex-basis，
  // 壳自带的 160ms 过渡会把指针拖在后面，所以拖动期间显式关掉。
  const shellStyle: React.CSSProperties = isCollapsed
    ? EDITOR_ASSIST_RAIL
    : {
        ...EDITOR_ASSIST_SHELL,
        ...(width ? { flex: `0 0 ${width}px` } : null),
        ...(resizing ? { transition: 'none' } : null),
      }

  const header = (
    <div style={EDITOR_COLUMN_HEADER}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <RobotOutlined />
        {title}
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
        {onNewSession && (
          <Button size="small" type="text" icon={<PlusOutlined />} onClick={askNewSession}>
            {t('formAssist.newSession')}
          </Button>
        )}
        {framed && (
          // 收起向右：助手栏贴在页面右端，箭头指右 = 往右缩成窄条。
          <Button
            size="small"
            type="text"
            icon={<RightOutlined />}
            aria-label={t('formAssist.collapse')}
            title={t('formAssist.collapse')}
            data-form-assist-collapse
            onClick={onToggleCollapsed}
          />
        )}
      </span>
    </div>
  )

  const column = (
    <>
      {header}
      <TranscriptView
        messages={session.messages}
        agentStatus={session.agentStatus}
        streamingBlocks={session.streamingBlocks}
        isRequesting={session.isBusy}
        restoring={session.restoring}
        conversationId={session.conversationId}
        restoringHint={<div style={{ padding: '0 14px', color: 'var(--pm-text-muted)', fontSize: 13 }}>{t('formAssist.restoring')}</div>}
        emptyContent={emptyContent}
        contentInset={0}
        onApproveTool={(id, alwaysAllow) => session.engineCall('approveTool', id, alwaysAllow === true)}
        onRejectTool={(id) => session.engineCall('rejectTool', id)}
        onKillTool={(id) => session.engineCall('killTool', id)}
        onRespondToTool={(id, response) => session.engineCall('respondToTool', id, response)}
        onClearError={() => session.engineCall('clearError')}
        onRetry={() => session.engineCall('retryLastTurn')}
      />
      {/* D14 (user ruling 2026-09-19): the assistants deliberately expose
          ONLY model picker + 授权. @-summon stays off (startPlanningLoop /
          identity binding would fight the pinned persona) and attachments
          stay off (they drag form-snapshot and persistence semantics in).
          features === undefined means "everything" — that shape is the main
          chat's, never an assistant column's. */}
      <InputArea
        layout="inline"
        isRequesting={session.isBusy}
        isStreaming={session.isBusy}
        isAwaitingApproval={session.agentStatus.status === 'awaiting_approval'}
        isAwaitingInput={session.agentStatus.status === 'awaiting_user_input'}
        hasMessages={session.messages.length > 0}
        autoFocus={false}
        placeholder={placeholder}
        onSendMessage={onSendMessage}
        onCancel={session.cancel}
        profiles={profiles}
        activeProfileId={activeProfileId}
        onSelectProfile={(profileId) => {
          onSelectProfile?.(profileId)
          session.refreshOptions()
        }}
        features={{ modelPicker: true, authorization: true }}
        approvalMode={session.approvalMode}
        onChangeApprovalMode={session.setApprovalMode}
      />
    </>
  )

  // data-pm-form-assist: 探针锚点。任务向导要证明助手卡是步骤卡的**页面级
  // 兄弟**而非它的后代（user 2026-11-08「要从编辑面板中独立出来」）——源码
  // 里同一个组件既可能被嵌进去也可能被并列，只有 DOM 关系说得清。灰壳版本
  // 里锚点留在**最外层**（壳），收起态也还是同一个节点，探针的兄弟/常驻
  // 断言因此不用分叉。
  if (!framed) {
    return (
      <div style={EDITOR_CHAT_CARD} data-pm-form-assist>
        {column}
      </div>
    )
  }

  return (
    <div style={shellStyle} data-pm-form-assist data-form-assist-collapsed={isCollapsed ? 'true' : 'false'}>
      {isCollapsed && (
        <div data-form-assist-rail style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, flex: 1, minHeight: 0 }}>
          <Button
            size="small"
            type="text"
            icon={<LeftOutlined />}
            aria-label={t('formAssist.expand')}
            title={t('formAssist.expand')}
            data-form-assist-expand
            onClick={onToggleCollapsed}
          />
          <span
            data-form-assist-rail-title
            style={{
              writingMode: 'vertical-rl',
              letterSpacing: 1,
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--pm-text-muted)',
              flex: 1,
              minHeight: 0,
              overflow: 'hidden',
            }}
          >
            {title}
          </span>
        </div>
      )}
      {/* 收起是**布局**变化不是拆装：内容节点始终挂着（display:none），草稿、
         转录、滚动位置都留在原地——卸载会静默丢掉没发出去的输入。
         壳在 framed 形态下就是那张卡，所以内容卡放弃自己的底色与圆角，
          只保留列的几何（双层白卡在这里只会多出一圈内距）。 */}
      <div
        data-form-assist-card
        style={{
          ...EDITOR_CHAT_CARD,
          flex: 1,
          minWidth: 0,
          background: 'transparent',
          borderRadius: 0,
          padding: 0,
          ...(isCollapsed ? { display: 'none' } : null),
        }}
      >
        {column}
      </div>
    </div>
  )
}
