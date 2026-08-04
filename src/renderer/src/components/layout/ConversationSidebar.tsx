import React, { useState } from 'react'
import { Conversations } from '@ant-design/x'
import { Modal, Input } from 'antd'
import { PushpinOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'

interface ConversationSidebarProps {
  conversations: Array<{ key: string; label: string; pinned?: boolean }>
  activeKey: string | Symbol | undefined
  onSelect: (key: string) => void
  onDelete: (key: string) => void
  onRename: (key: string, newLabel: string) => void
  onTogglePin: (key: string, pinned: boolean) => void
  activeLoopConvIds?: string[]
  retryingConvIds?: string[]
}

function ConversationSidebar({
  conversations,
  activeKey,
  onSelect,
  onDelete,
  onRename,
  onTogglePin,
  activeLoopConvIds = [],
  retryingConvIds = []
}: ConversationSidebarProps): React.ReactElement {
  const { t } = useTranslation()
  const [renameModalOpen, setRenameModalOpen] = useState(false)
  const [renamingKey, setRenamingKey] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const sorted = [...conversations].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1
    if (!a.pinned && b.pinned) return 1
    // Non-pinned: most recently updated first
    const aTime = (a as any).updatedAt || ''
    const bTime = (b as any).updatedAt || ''
    return bTime.localeCompare(aTime)
  })

  const items = sorted.map((conv) => {
    const isActive = activeLoopConvIds.includes(conv.key)
    const isRetrying = retryingConvIds.includes(conv.key)
    return {
      key: conv.key,
      label: (
        <span style={{ display: 'flex', alignItems: 'center', width: '100%', gap: 6 }}>
          {isActive || isRetrying ? (
            <>
              <span style={{
                width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                background: isRetrying ? '#faad14' : '#1677ff',
                animation: isRetrying ? 'none' : 'ant-status-processing 1.2s infinite ease-in-out'
              }} />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#444', lineHeight: '22px' }}>
                {conv.label}
              </span>
            </>
          ) : (
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#444', lineHeight: '22px' }}>
              {conv.label}
            </span>
          )}
          {conv.pinned && <PushpinOutlined className="pin-icon" style={{ fontSize: 13, color: '#bbb', flexShrink: 0 }} />}
        </span>
      ),
      ...(conv.pinned ? { 'data-pinned': 'true' } : {})
    }
  })

  const openRenameModal = (key: string) => {
    const conv = conversations.find((c) => c.key === key)
    setRenamingKey(key)
    setRenameValue(conv?.label ?? '')
    setRenameModalOpen(true)
  }

  const handleRenameOk = () => {
    if (renamingKey && renameValue.trim()) {
      onRename(renamingKey, renameValue.trim())
    }
    setRenameModalOpen(false)
    setRenamingKey(null)
    setRenameValue('')
  }

  const handleRenameCancel = () => {
    setRenameModalOpen(false)
    setRenamingKey(null)
    setRenameValue('')
  }

  return (
    <>
      <style>{`
        [data-pinned="true"] .ant-conversations-menu-icon { display: none !important; }
        [data-pinned="true"]:hover .ant-conversations-menu-icon { display: inline !important; }
        [data-pinned="true"]:hover .pin-icon { display: none; }
        @keyframes ant-status-processing {
          0% { transform: scale(0.8); opacity: 0.5; }
          100% { transform: scale(2.4); opacity: 0; }
        }
      `}</style>
      <Conversations
        items={items}
        activeKey={activeKey as string}
        onActiveChange={(key) => {
          onSelect(key as string)
        }}
        menu={(item) => ({
            items: [
              {
                label: t(conversations.find(c => c.key === item.key)?.pinned ? 'conversationSidebar.unpin' : 'conversationSidebar.pin'),
                icon: <PushpinOutlined />,
                key: 'pin',
                onClick: () => onTogglePin(item.key, !conversations.find(c => c.key === item.key)?.pinned)
              },
              {
                label: t('conversationSidebar.rename'),
                icon: <EditOutlined />,
                key: 'rename',
                onClick: () => openRenameModal(item.key)
              },
              {
                label: t('conversationSidebar.delete'),
                icon: <DeleteOutlined />,
                key: 'delete',
                danger: true,
                onClick: () => onDelete(item.key)
              }
            ]
          })}
        style={{ padding: '8px' }}
      />
      <Modal
        title={t('conversationSidebar.renameTitle')}
        open={renameModalOpen}
        onOk={handleRenameOk}
        onCancel={handleRenameCancel}
      >
        <Input
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          placeholder={t('conversationSidebar.renamePlaceholder')}
          onPressEnter={handleRenameOk}
          autoFocus
        />
      </Modal>
    </>
  )
}

export default ConversationSidebar
