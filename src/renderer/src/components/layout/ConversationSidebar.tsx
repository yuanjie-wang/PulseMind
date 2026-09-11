import React, { useEffect, useState } from 'react'
import { Conversations } from '@ant-design/x'
import { Modal, Input } from 'antd'
import { PushpinOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { describeRelativeTime } from '../../utils/relative-time'
import type { ConversationListItem } from '../../types/conversation'

/** Gutter reserved for the task-status light, so titles line up whether or not one is lit. */
const STATUS_GUTTER_WIDTH = 10
/** Relative times only move at minute granularity, so that is the cheapest honest clock. */
const CLOCK_TICK_MS = 60_000

interface ConversationSidebarProps {
  conversations: ConversationListItem[]
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

  // "Now" is an input to the rendered times, so tick it to keep them current.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
    return () => clearInterval(timer)
  }, [])

  const formatTime = (updatedAt?: string): string | null => {
    const relative = describeRelativeTime(updatedAt, now)
    if (!relative) return null
    switch (relative.unit) {
      case 'justNow':
        return t('conversationSidebar.time.justNow')
      case 'minute':
        return t('conversationSidebar.time.minutesAgo', { count: relative.value })
      case 'hour':
        return t('conversationSidebar.time.hoursAgo', { count: relative.value })
      case 'day':
        return t('conversationSidebar.time.daysAgo', { count: relative.value })
      default:
        return relative.year === new Date(now).getFullYear()
          ? t('conversationSidebar.time.date', { month: relative.month, day: relative.day })
          : t('conversationSidebar.time.dateWithYear', { year: relative.year, month: relative.month, day: relative.day })
    }
  }

  const sorted = [...conversations].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1
    if (!a.pinned && b.pinned) return 1
    // Non-pinned: most recently updated first
    const aTime = a.updatedAt || ''
    const bTime = b.updatedAt || ''
    return bTime.localeCompare(aTime)
  })

  const items = sorted.map((conv) => {
    const isActive = activeLoopConvIds.includes(conv.key)
    const isRetrying = retryingConvIds.includes(conv.key)
    const timeText = formatTime(conv.updatedAt)
    return {
      key: conv.key,
      title: conv.label,
      label: (
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', minWidth: 0 }}>
          {/* The light sits in a reserved gutter rather than in the flow, so a running task
              never shifts the title sideways. */}
          <span style={{ width: STATUS_GUTTER_WIDTH, flexShrink: 0, display: 'flex', justifyContent: 'center' }}>
            {(isActive || isRetrying) && (
              <span style={{
                width: 6, height: 6, borderRadius: '50%',
                background: isRetrying ? '#faad14' : '#1677ff',
                animation: isRetrying ? 'none' : 'ant-status-processing 1.2s infinite ease-in-out'
              }} />
            )}
          </span>
          <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#444', lineHeight: '18px' }}>
              {conv.label}
            </span>
            {timeText && (
              <span style={{ color: '#999', fontSize: 11, lineHeight: '15px' }}>{timeText}</span>
            )}
          </span>
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
        // The two-line label needs a taller item than the component's fixed 40px, and an item
        // style is applied inline, which beats the component's own stylesheet. box-sizing is
        // pinned because the app loads no global reset, so the height would otherwise be
        // content-box and gain the item's padding on top of it.
        styles={{ item: { boxSizing: 'border-box', height: 'auto', minHeight: 46, padding: '5px 8px' } }}
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
