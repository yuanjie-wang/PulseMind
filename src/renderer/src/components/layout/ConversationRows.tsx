// ── Shared sidebar conversation rows ──
// One row design for both sidebar history tabs (对话 and 项目): a single-line
// label with the relative time parked at its right edge, a reserved gutter for
// the task-status light, the pin indicator, an active highlight, and a swap on
// hover/active that hides the time and reveals the row menu (pin / rename /
// delete) with its rename modal. Tabs slice their slice of
// conversations and hand them here; rows sort pinned-first, then by recency,
// so the two tabs can never drift apart again. The 对话 tab additionally passes
// `groupByDate`, which wraps the rows in 置顶 / 今天 / 昨天 / 更早 sections
// (groupConversationsByDate below); the project tab keeps the flat order
// inside each project group.

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
import { CLOCK_TICK_MS, bucketDayByDate, describeRelativeTimeText, type DayBucket } from '../../utils/relative-time'
import type { ConversationListItem } from '../../types/conversation'

/** Gutter reserved for the task-status light, so titles line up whether or not one is lit. */
const STATUS_GUTTER_WIDTH = 10
/** Right slot holding the time / pin / menu swap at a fixed width, so the title
 *  never reflows when hover trades the time for the row menu. Sized for the
 *  pin plus the longest common relative time ("N分钟前"). */
const ACTION_SLOT_WIDTH = 72

/** Section header of a time group — the routine center's bucket-label recipe
 *  (11px grey small caps), so the app's two grouping surfaces read alike. */
const GROUP_HEADER_STYLE: React.CSSProperties = {
  fontSize: 11, color: '#999', fontWeight: 600,
  padding: '9px 8px 4px', textTransform: 'uppercase', letterSpacing: 0.3,
  userSelect: 'none'
}

const GROUP_LABEL_KEY: Record<ConversationDateGroup['bucket'], string> = {
  pinned: 'conversationSidebar.groupPinned',
  today: 'conversationSidebar.groupToday',
  yesterday: 'conversationSidebar.groupYesterday',
  earlier: 'conversationSidebar.groupEarlier'
}

interface ConversationRowsProps {
  conversations: ConversationListItem[]
  activeKey: string | undefined
  activeLoopConvIds?: string[]
  retryingConvIds?: string[]
  /** Wrap the rows in 置顶 / 今天 / 昨天 / 更早 sections instead of one flat
   *  list. The 对话 tab turns this on; the project tab keeps the flat order. */
  groupByDate?: boolean
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

/** One rendered section: the 置顶 pin pool or a calendar-day bucket of the
 *  unpinned conversations. */
export interface ConversationDateGroup {
  bucket: 'pinned' | DayBucket
  items: ConversationListItem[]
}

/** Split the chats-tab list into the sections it renders. Pinning floats a
 *  conversation above every time bucket (its own leading group, or the pin's
 *  whole point is lost), the rest bucket by LOCAL calendar day of `updatedAt`
 *  — yesterday 23:59 stays 昨天 even one minute before midnight rolls it over.
 *  Within a group the shared pinned-then-recency order survives (recency, once
 *  the pins are pulled out); empty groups are omitted, so a quiet yesterday
 *  never paints a header with nothing under it. */
export function groupConversationsByDate(
  conversations: ConversationListItem[],
  now: number
): ConversationDateGroup[] {
  const byRecency = [...conversations].sort(byPinnedThenRecency)
  const pinned = byRecency.filter((c) => c.pinned)
  const buckets: Record<DayBucket, ConversationListItem[]> = { today: [], yesterday: [], earlier: [] }
  for (const conv of byRecency) {
    if (!conv.pinned) buckets[bucketDayByDate(conv.updatedAt, now)].push(conv)
  }
  const groups: ConversationDateGroup[] = []
  if (pinned.length > 0) groups.push({ bucket: 'pinned', items: pinned })
  // Object.keys iterates string keys in insertion order: today, yesterday, earlier.
  for (const bucket of Object.keys(buckets) as DayBucket[]) {
    if (buckets[bucket].length > 0) groups.push({ bucket, items: buckets[bucket] })
  }
  return groups
}

interface ConversationRowProps {
  /** The conversation's list key, re-declared so the row root can carry it as
   *  the `data-conv-row` probe hook (`key` is React's own, never a prop). */
  convKey: string
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

/** One conversation row: status gutter, single-line label with the relative
 *  time at its right, and a hover swap to the row menu. Pure presentation. */
function ConversationRow({
  convKey,
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
  // The active row gets the same treatment as hover: time hidden, row menu
  // revealed — the selected conversation always offers its actions.
  const revealMenu = hovered || menuOpen || active
  return (
    <div
      data-conv-row={convKey}
      onClick={onSelect}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      title={label}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '5px 8px', marginBottom: 2, borderRadius: 6, cursor: 'pointer', userSelect: 'none',
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
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#444', fontSize: 14, lineHeight: '20px' }}>
        {label}
      </span>
      {/* Idle: the relative time (plus the pin for pinned rows) at the row's right.
          Hover or active: the time hides and the row menu takes the slot. The slot
          keeps a fixed width and height across the swap so the row never reflows
          or grows. */}
      <span style={{ width: ACTION_SLOT_WIDTH, height: 20, flexShrink: 0, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 4 }}>
        {revealMenu ? (
          <Dropdown open={menuOpen} onOpenChange={onMenuOpenChange} menu={menu} trigger={['hover']}>
            <span
              onClick={(e) => e.stopPropagation()}
              style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: 4, color: '#999', fontSize: 14, cursor: 'pointer' }}
            >
              <EllipsisOutlined />
            </span>
          </Dropdown>
        ) : (
          <>
            {pinned && <PushpinOutlined style={{ fontSize: 13, color: '#bbb', flexShrink: 0 }} />}
            {timeText && (
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#999', fontSize: 11, lineHeight: '15px' }}>
                {timeText}
              </span>
            )}
          </>
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
  groupByDate = false,
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

  const renderRow = (conv: ConversationListItem): React.ReactElement => (
    <ConversationRow
      key={conv.key}
      convKey={conv.key}
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
  )

  // The chats tab renders sections (置顶 → 今天 → 昨天 → 更早, empties dropped);
  // the project tab keeps the one flat pinned-first list. Both read the same
  // ticking `now`, so a conversation re-buckets within a minute of midnight.
  const groups = groupByDate ? groupConversationsByDate(conversations, now) : null

  return (
    <>
      <style>{`
        @keyframes ant-status-processing {
          0% { transform: scale(0.8); opacity: 0.5; }
          100% { transform: scale(2.4); opacity: 0; }
        }
      `}</style>
      {groups
        ? groups.map((group) => (
          <div key={group.bucket}>
            <div data-conv-group={group.bucket} style={GROUP_HEADER_STYLE}>
              {t(GROUP_LABEL_KEY[group.bucket])}
            </div>
            {group.items.map(renderRow)}
          </div>
        ))
        : sorted.map(renderRow)}
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
