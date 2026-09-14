// ── Shared sidebar conversation rows ──
// One row design for both sidebar history tabs (对话 and 项目): a two-line
// label (title over the relative time), a reserved gutter for the task-status
// light, the pin indicator, an active highlight, and the hover-revealed menu
// (pin / rename / delete) with its rename modal. Tabs slice their slice of
// conversations and hand them here; rows sort pinned-first, then by recency,
// so the two tabs can never drift apart again.

import React, { useEffect, useState } from 'react'
import { Dropdown, Input, Modal } from 'antd'
import type { MenuProps } from 'antd'
import {
  DeleteOutlined,
  EditOutlined,
  EllipsisOutlined,
  PushpinOutlined
} from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { describeRelativeTimeText } from '../../utils/relative-time'
import type { ConversationListItem } from '../../types/conversation'

/** Gutter reserved for the task-status light, so titles line up whether or not one is lit. */
const STATUS_GUTTER_WIDTH = 10
/** Right slot holding the pin / menu swap at a fixed width, so nothing shifts on hover. */
const ACTION_SLOT_WIDTH = 20
/** Relative times only move at minute granularity, so that is the cheapest honest clock. */
const CLOCK_TICK_MS = 60_000

interface ConversationRowsProps {
  conversations: ConversationListItem[]
  activeKey: string | undefined
  activeLoopConvIds?: string[]
  retryingConvIds?: string[]
  onSelect: (key: string) => void
  onDelete: (key: string) => void
  onRename: (key: string, newLabel: string) => void
  onTogglePin: (key: string, pinned: boolean) => void
}

/** Pinned first, then most recently updated — the order both history tabs share
 *  (and the manage modal, so its rows read exactly like the list behind it). */
export function byPinnedThenRecency(a: ConversationListItem, b: ConversationListItem): number {
  if (a.pinned && !b.pinned) return -1
  if (!a.pinned && b.pinned) return 1
  return (b.updatedAt || '').localeCompare(a.updatedAt || '')
}

interface ConversationRowProps {
  label: string
  timeText: string | null
  active: boolean
  /** null = idle; the row's task is running (pulsing) or retrying (static amber). */
  light: 'running' | 'retrying' | null
  pinned: boolean
  /** Pointer is over the row: reveal the row menu, hide the pin. */
  hovered: boolean
  /** The row's dropdown is open — keep the menu revealed together with it. */
  menuOpen: boolean
  menu: MenuProps
  onSelect: () => void
  onHover: (hovered: boolean) => void
  onMenuOpenChange: (open: boolean) => void
}

/** One conversation row: status gutter, two-line label, pin/menu swap. Pure presentation. */
function ConversationRow({
  label,
  timeText,
  active,
  light,
  pinned,
  hovered,
  menuOpen,
  menu,
  onSelect,
  onHover,
  onMenuOpenChange
}: ConversationRowProps): React.ReactElement {
  const revealMenu = hovered || menuOpen
  return (
    <div
      onClick={onSelect}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      title={label}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '3px 8px', borderRadius: 6, cursor: 'pointer', userSelect: 'none',
        transition: 'background 0.2s',
        background: active ? 'rgba(0, 0, 0, 0.08)' : hovered ? 'rgba(0, 0, 0, 0.06)' : 'transparent'
      }}
    >
      {/* The light sits in a reserved gutter rather than in the flow, so a running task
          never shifts the title sideways. */}
      <span style={{ width: STATUS_GUTTER_WIDTH, flexShrink: 0, display: 'flex', justifyContent: 'center' }}>
        {light && (
          <span style={{
            width: 6, height: 6, borderRadius: '50%',
            background: light === 'retrying' ? '#faad14' : '#1677ff',
            animation: light === 'retrying' ? 'none' : 'ant-status-processing 1.2s infinite ease-in-out'
          }} />
        )}
      </span>
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#444', fontSize: 12, lineHeight: '17px' }}>
          {label}
        </span>
        {timeText && (
          <span style={{ color: '#999', fontSize: 11, lineHeight: '15px' }}>{timeText}</span>
        )}
      </span>
      {/* Pinned rows show the pin while idle and trade it for the row menu on hover. */}
      <span style={{ width: ACTION_SLOT_WIDTH, flexShrink: 0, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
        {pinned && !revealMenu && (
          <PushpinOutlined style={{ fontSize: 13, color: '#bbb' }} />
        )}
        {revealMenu && (
          <Dropdown open={menuOpen} onOpenChange={onMenuOpenChange} menu={menu} trigger={['hover']}>
            <span
              onClick={(e) => e.stopPropagation()}
              style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: ACTION_SLOT_WIDTH, height: 20, borderRadius: 4, color: '#999', fontSize: 14, cursor: 'pointer' }}
            >
              <EllipsisOutlined />
            </span>
          </Dropdown>
        )}
      </span>
    </div>
  )
}

function ConversationRows({
  conversations,
  activeKey,
  activeLoopConvIds = [],
  retryingConvIds = [],
  onSelect,
  onDelete,
  onRename,
  onTogglePin
}: ConversationRowsProps): React.ReactElement {
  const { t } = useTranslation()
  // "Now" is an input to the rendered times, so tick it to keep them current.
  const [now, setNow] = useState(() => Date.now())
  const [hoveredKey, setHoveredKey] = useState<string | null>(null)
  const [openMenuKey, setOpenMenuKey] = useState<string | null>(null)
  const [renamingKey, setRenamingKey] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
    return () => clearInterval(timer)
  }, [])

  const sorted = [...conversations].sort(byPinnedThenRecency)

  const menuFor = (conv: ConversationListItem): MenuProps => ({
    items: [
      {
        label: t(conv.pinned ? 'conversationSidebar.unpin' : 'conversationSidebar.pin'),
        icon: <PushpinOutlined />,
        key: 'pin',
        onClick: () => { setOpenMenuKey(null); onTogglePin(conv.key, !conv.pinned) }
      },
      {
        label: t('conversationSidebar.rename'),
        icon: <EditOutlined />,
        key: 'rename',
        onClick: () => { setOpenMenuKey(null); setRenamingKey(conv.key); setRenameValue(conv.label) }
      },
      {
        label: t('conversationSidebar.delete'),
        icon: <DeleteOutlined />,
        key: 'delete',
        danger: true,
        onClick: () => { setOpenMenuKey(null); onDelete(conv.key) }
      }
    ]
  })

  const handleRenameOk = () => {
    if (renamingKey && renameValue.trim()) {
      onRename(renamingKey, renameValue.trim())
    }
    setRenamingKey(null)
    setRenameValue('')
  }

  const handleRenameCancel = () => {
    setRenamingKey(null)
    setRenameValue('')
  }

  return (
    <>
      <style>{`
        @keyframes ant-status-processing {
          0% { transform: scale(0.8); opacity: 0.5; }
          100% { transform: scale(2.4); opacity: 0; }
        }
      `}</style>
      {sorted.map((conv) => (
        <ConversationRow
          key={conv.key}
          label={conv.label}
          timeText={describeRelativeTimeText(conv.updatedAt, now, t)}
          active={conv.key === activeKey}
          light={
            activeLoopConvIds.includes(conv.key)
              ? 'running'
              : retryingConvIds.includes(conv.key) ? 'retrying' : null
          }
          pinned={!!conv.pinned}
          hovered={hoveredKey === conv.key}
          menuOpen={openMenuKey === conv.key}
          menu={menuFor(conv)}
          onSelect={() => onSelect(conv.key)}
          onHover={(on) => setHoveredKey(on ? conv.key : null)}
          onMenuOpenChange={(open) => setOpenMenuKey(open ? conv.key : null)}
        />
      ))}
      <Modal
        title={t('conversationSidebar.renameTitle')}
        open={renamingKey !== null}
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

export default ConversationRows
