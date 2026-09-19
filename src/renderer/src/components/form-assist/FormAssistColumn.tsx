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

import React from 'react'
import { RobotOutlined } from '@ant-design/icons'
import { TranscriptView } from '../chat/TranscriptView'
import { InputArea } from '../chat/InputArea'
import { PromptChip } from '../chat/PromptChip'
import { useTranslation } from '../../i18n/useTranslation'
import { EDITOR_CHAT_CARD, EDITOR_COLUMN_HEADER } from '../layout/editor-layout'
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
}: FormAssistColumnProps<P>): React.ReactElement {
  const { t } = useTranslation()
  const emptyContent =
    emptyIntro || emptyExamples?.length ? (
      <div style={{ padding: '0 14px' }}>
        {emptyIntro && (
          <div style={{ color: '#999', fontSize: 13, lineHeight: 1.7, marginBottom: 12 }}>{emptyIntro}</div>
        )}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {(emptyExamples ?? []).map((example) => (
            <PromptChip key={example} label={example} onClick={() => onSendMessage(example)} />
          ))}
        </div>
      </div>
    ) : undefined

  return (
    <div style={EDITOR_CHAT_CARD}>
      <div style={EDITOR_COLUMN_HEADER}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <RobotOutlined />
          {title}
        </span>
      </div>
      <TranscriptView
        messages={session.messages}
        agentStatus={session.agentStatus}
        streamingBlocks={session.streamingBlocks}
        isRequesting={session.isBusy}
        restoring={session.restoring}
        restoringHint={
          <div style={{ padding: '0 14px', color: '#999', fontSize: 13 }}>{t('formAssist.restoring')}</div>
        }
        emptyContent={emptyContent}
        contentInset={0}
        onApproveTool={(id) => session.engineCall('approveTool', id)}
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
    </div>
  )
}
