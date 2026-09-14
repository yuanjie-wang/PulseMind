// ── Sidebar 对话 tab's manage modal ──
// Batch management for exactly what the 对话 tab shows (the loose,
// project-less conversations): select rows — select-all included — and delete
// the selection in one go. The 项目 tab's manage entry has no modal of its
// own: it opens the project center (ProjectView), which already carries
// create / edit / delete.

import React, { useState } from 'react'
import { App as AntdApp, Button, Checkbox, Empty, Modal } from 'antd'
import { DeleteOutlined, PushpinOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { describeRelativeTimeText } from '../../utils/relative-time'
import { byPinnedThenRecency } from './ConversationRows'
import type { ConversationListItem } from '../../types/conversation'

interface ConversationManageModalProps {
  open: boolean
  /** The slice this modal manages — the 对话 tab's loose conversations. */
  conversations: ConversationListItem[]
  onClose: () => void
  onDeleteMany: (keys: string[]) => void
}

function ConversationManageModal({
  open,
  conversations,
  onClose,
  onDeleteMany
}: ConversationManageModalProps): React.ReactElement {
  const { t } = useTranslation()
  const { modal } = AntdApp.useApp()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  // Rendered times are relative, so snapshot "now" when the modal opens — a
  // transient dialog doesn't need ConversationRows' minute clock. Both this
  // and the selection reset run as the open event callback (not an effect, so
  // reopening never starts with stale keys deleted elsewhere in the meantime).
  const [now, setNow] = useState(() => Date.now())
  const afterOpenChange = (opened: boolean): void => {
    if (!opened) return
    setSelected(new Set())
    setNow(Date.now())
  }

  const sorted = [...conversations].sort(byPinnedThenRecency)
  const allSelected = conversations.length > 0 && selected.size === conversations.length

  const toggleOne = (key: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const toggleAll = (): void => {
    setSelected(allSelected ? new Set() : new Set(conversations.map((c) => c.key)))
  }

  const confirmDelete = (): void => {
    const keys = [...selected]
    if (keys.length === 0) return
    modal.confirm({
      title: t('manageChatsModal.confirmTitle'),
      content: t('manageChatsModal.confirmContent', { n: keys.length }),
      okText: t('conversationSidebar.delete'),
      okButtonProps: { danger: true },
      cancelText: t('manageChatsModal.cancel'),
      onOk: () => {
        onDeleteMany(keys)
        onClose()
      },
    })
  }

  return (
    <Modal
      title={t('manageChatsModal.title')}
      open={open}
      onCancel={onClose}
      afterOpenChange={afterOpenChange}
      width={440}
      footer={[
        <Button key="cancel" onClick={onClose}>{t('manageChatsModal.cancel')}</Button>,
        <Button
          key="delete"
          danger
          icon={<DeleteOutlined />}
          disabled={selected.size === 0}
          onClick={confirmDelete}
        >
          {t('manageChatsModal.deleteSelected')}
        </Button>,
      ]}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <Checkbox
          checked={allSelected}
          indeterminate={selected.size > 0 && !allSelected}
          disabled={conversations.length === 0}
          onChange={toggleAll}
        >
          {t('manageChatsModal.selectAll')}
        </Checkbox>
        {selected.size > 0 && (
          <span style={{ fontSize: 12, color: '#999' }}>
            {t('manageChatsModal.selectedCount', { n: selected.size })}
          </span>
        )}
      </div>
      {conversations.length === 0 ? (
        <Empty description={<span style={{ fontSize: 12, color: '#999' }}>{t('manageChatsModal.empty')}</span>} />
      ) : (
        <div style={{ maxHeight: 380, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {sorted.map((conv) => (
            <div
              key={conv.key}
              onClick={() => toggleOne(conv.key)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '6px 8px', borderRadius: 6, cursor: 'pointer', userSelect: 'none',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(0, 0, 0, 0.04)' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
            >
              <Checkbox
                checked={selected.has(conv.key)}
                onChange={() => toggleOne(conv.key)}
                onClick={(e) => e.stopPropagation()}
              />
              {conv.pinned && <PushpinOutlined style={{ fontSize: 12, color: '#bbb', flexShrink: 0 }} />}
              <span style={{
                flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
                whiteSpace: 'nowrap', fontSize: 13, color: '#333',
              }}>
                {conv.label}
              </span>
              <span style={{ flexShrink: 0, fontSize: 11, color: '#999' }}>
                {describeRelativeTimeText(conv.updatedAt, now, t)}
              </span>
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}

export default ConversationManageModal
