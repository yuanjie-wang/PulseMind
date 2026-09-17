// ── Sidebar's manage modal (对话管理) ──
// One dialog for conversation management, unified from the former chats-tab
// batch delete + projects-tab project center (both gone): it sets the 清理会话
// 策略 — 最长保留时长. Unpinned conversations older than the window are deleted
// main-side (startup + on every settings save), so the save reloads the
// sidebar's list afterwards. Row-level delete lives in the sidebar rows, not
// here.

import React, { useState } from 'react'
import { App as AntdApp, Button, Modal, Segmented } from 'antd'
import { useTranslation } from '../../i18n/useTranslation'
import { useSettings } from '../../hooks/SettingsContext'
import { retentionOptions } from '../settings/retention-options'

interface ConversationManageModalProps {
  open: boolean
  onClose: () => void
  /** Called after a retention change — main has already cleaned up, so the
   *  sidebar's list should re-read from the DB. */
  onRetentionChanged?: () => void
}

function ConversationManageModal({
  open,
  onClose,
  onRetentionChanged
}: ConversationManageModalProps): React.ReactElement {
  const { t } = useTranslation()
  const { message } = AntdApp.useApp()
  const { settings, saveSettings } = useSettings()
  const [savingRetention, setSavingRetention] = useState(false)

  const retentionDays = settings.conversationRetentionDays ?? 0

  const changeRetention = async (days: number): Promise<void> => {
    if (days === retentionDays || savingRetention) return
    setSavingRetention(true)
    try {
      // settings.handler awaits the expiry cleanup before answering, so by the
      // time this resolves the sidebar's rows may already be gone.
      await saveSettings({ ...settings, conversationRetentionDays: days })
      message.success(days > 0 ? t('manageChatsModal.retentionSaved', { n: days }) : t('manageChatsModal.retentionForeverSaved'))
      onRetentionChanged?.()
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSavingRetention(false)
    }
  }

  return (
    <Modal
      title={t('manageChatsModal.title')}
      open={open}
      onCancel={onClose}
      width={440}
      footer={[<Button key="done" onClick={onClose}>{t('manageChatsModal.done')}</Button>]}
    >
      <div style={{ marginBottom: 10, fontSize: 13, fontWeight: 600 }}>
        {t('manageChatsModal.retentionTitle')}
      </div>
      <Segmented
        block
        size="small"
        value={retentionDays}
        onChange={(v) => { void changeRetention(v as number) }}
        options={retentionOptions(t).map(({ days, label }) => ({ value: days, label }))}
        style={{ marginBottom: 10 }}
      />
      <div style={{ fontSize: 12, color: '#999', lineHeight: 1.6 }}>
        {t('manageChatsModal.retentionHint')}
      </div>
    </Modal>
  )
}

export default ConversationManageModal
