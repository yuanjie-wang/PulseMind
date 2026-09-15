// ── Review bar for an assistant-proposed form patch ──
// Shared by the routine editor and the expert editor's form columns: nothing
// writes into the form until the user applies it here; 忽略 hides the banner
// until the assistant proposes a NEW patch (the fence lives in
// useFormAssistSession's fingerprint). The summary line is page-provided so
// each domain names its own draft.

import React from 'react'
import { Button } from 'antd'
import { CheckOutlined, RobotOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'

export interface AssistantDraftBannerProps {
  /** One-line summary, e.g. 对话生成了任务草稿：「每日巡检」. */
  text: string
  onApply: () => void
  onDismiss: () => void
}

export function AssistantDraftBanner({ text, onApply, onDismiss }: AssistantDraftBannerProps): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 8, background: '#fff', border: '1px solid #d9d9d9', fontSize: 12 }}>
      <RobotOutlined style={{ color: '#666', flexShrink: 0 }} />
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#666' }}>{text}</span>
      <Button size="small" type="primary" icon={<CheckOutlined />} onClick={onApply}>{t('formAssist.apply')}</Button>
      <Button size="small" onClick={onDismiss}>{t('formAssist.dismiss')}</Button>
    </div>
  )
}
