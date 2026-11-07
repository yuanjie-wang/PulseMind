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
//
// Each of those sections is a BLOCK for paging: the first 10 render, and a
// 显示更多 button under the block loads 10 more. 置顶除外 — the pin pool (and
// pinned rows in the project tab's flat list) render whole, because a pin
// hidden behind a button is a pin that failed.

import React, { useEffect, useState } from 'react'
import { Dropdown, Input, Modal } from 'antd'
import type { MenuProps } from 'antd'
import {
  DeleteOutlined,
  EditOutlined,
  EllipsisOutlined,
  ExportOutlined,
  PushpinOutlined
} from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { CLOCK_TICK_MS, bucketDayByDate, describeRelativeTimeText, type DayBucket } from '../../utils/relative-time'
import { ConversationLightDot, ConversationLightDotStyle } from './ConversationLightDot'
import type { ConversationLight } from '../../hooks/useConversationEngine'
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
  fontSize: 11, color: 'var(--pm-text-muted)', fontWeight: 600,
  padding: '9px 8px 4px', textTransform: 'uppercase', letterSpacing: 0.3,
  userSelect: 'none'
}

const GROUP_LABEL_KEY: Record<ConversationDateGroup['bucket'], string> = {
  pinned: 'conversationSidebar.groupPinned',
  today: 'conversationSidebar.groupToday',
  yesterday: 'conversationSidebar.groupYesterday',
  earlier: 'conversationSidebar.groupEarlier'
}

/** First page of a block — and how much each 显示更多 click loads. Both tabs'
 *  blocks start at 10: 今天/昨天/更早 in the 对话 tab, each project's list in
 *  the project tab. The 置顶 block is outside the count (see header). */
export const CONVERSATION_PAGE_SIZE = 10

/** The block's 显示更多 row — rendered only while rows remain hidden. */
function ShowMoreBlock({
  blockKey,
  remaining,
  onMore
}: {
  blockKey: string
  remaining: number
  onMore: (blockKey: string) => void
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      className="conv-show-more"
      data-conv-more={blockKey}
      onClick={() => onMore(blockKey)}
    >
      {t('conversationSidebar.showMore', { count: remaining })}
    </button>
  )
}

interface ConversationRowsProps {
  conversations: ConversationListItem[]
  activeKey: string | undefined
  /** Per-conversation sidebar light, keyed by conversation id (statusToLight). */
  lights?: Record<string, ConversationLight>
  /** 每会话仍在跑的后台任务数（PLAN-background-tasks B）——灯槽里的小标记；
   *  状态灯亮着时让位（灯更紧急），只在灯未亮时画。 */
  backgroundCounts?: Record<string, number>
  /** Wrap the rows in 置顶 / 今天 / 昨天 / 更早 sections instead of one flat
   *  list. The 对话 tab turns this on; the project tab keeps the flat order. */
  groupByDate?: boolean
  onSelect: (key: string) => void
  onDelete: (key: string) => void
  onRename: (key: string, newLabel: string) => void
  onTogglePin: (key: string, pinned: boolean) => void
  /** Pop this conversation out into its own window (PLAN-conversation-popout).
   *  Optional: absent = the menu item is hidden (surfaces that predate the
   *  feature keep their three-item menu). */
  onPopout?: (key: string, label: string) => void
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

// The solid dots (color table + blink keyframes) moved into the shared
// ConversationLightDot — the immersive window's header conversation switcher
// renders the same dot, and one table keeps the two surfaces from drifting.

interface ConversationRowProps {
  /** The conversation's list key, re-declared so the row root can carry it as
   *  the `data-conv-row` probe hook (`key` is React's own, never a prop). */
  convKey: string
  label: string
  timeText: string | null
  active: boolean
  /** null = unlit; the light state derives from the conversation's mirrored
   *  agentStatus (statusToLight): running is the slow-blinking blue dot, the
   *  other three are static solid dots — waiting amber, error red, green. */
  light: ConversationLight | null
  /** 仍在跑的后台任务数（PLAN-background-tasks B）。灯未亮时灯槽画它的小
   *  标记；亮着时让位（灯更紧急）。 */
  backgroundCount: number
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
  backgroundCount,
  pinned,
  hovered,
  menuOpen,
  menu,
  onSelect,
  onHover,
  onMenuOpenChange
}: ConversationRowProps): React.ReactElement {
  const { t } = useTranslation()
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
        background: active ? 'var(--pm-hover-strong)' : hovered ? 'var(--pm-hover)' : 'transparent'
      }}
    >
      {/* The light sits in a reserved gutter rather than in the flow, so a running task
          never shifts the title sideways. One dot shape for every state; only the
          running dot animates (user ruling 2026-09-30: the ring read badly — a slow
          opacity blink on the link-blue dot instead, same 6px as the rest). */}
      <span style={{ width: STATUS_GUTTER_WIDTH, flexShrink: 0, display: 'flex', justifyContent: 'center' }}>
        {light && <ConversationLightDot light={light} />}
        {/* 后台运行中标记（PLAN-background-tasks B）：灯未亮时灯槽画它——灯更
            紧急，亮着就让位。数字即仍在跑的后台任务数。 */}
        {!light && backgroundCount > 0 && (
          <span
            data-bg-running={convKey}
            title={t('conversationSidebar.bgRunning', { count: backgroundCount })}
            style={{
              fontSize: 9, lineHeight: '10px', fontWeight: 600, color: 'var(--pm-link)',
              fontVariantNumeric: 'tabular-nums', userSelect: 'none',
            }}
          >
            {backgroundCount}
          </span>
        )}
      </span>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--pm-row-ink)', fontSize: 14, lineHeight: '20px' }}>
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
              style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: 4, color: 'var(--pm-text-muted)', fontSize: 14, cursor: 'pointer' }}
            >
              <EllipsisOutlined />
            </span>
          </Dropdown>
        ) : (
          <>
            {pinned && <PushpinOutlined style={{ fontSize: 13, color: 'var(--pm-text-faint)', flexShrink: 0 }} />}
            {timeText && (
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--pm-text-muted)', fontSize: 11, lineHeight: '15px' }}>
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
  lights = {},
  backgroundCounts = {},
  groupByDate = false,
  onSelect,
  onDelete,
  onRename,
  onTogglePin,
  onPopout
}: ConversationRowsProps): React.ReactElement {
  const { t } = useTranslation()
  // "Now" is an input to the rendered times, so tick it to keep them current.
  const [now, setNow] = useState(() => Date.now())
  const [hoveredKey, setHoveredKey] = useState<string | null>(null)
  const [openMenuKey, setOpenMenuKey] = useState<string | null>(null)
  const [renamingKey, setRenamingKey] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  // Per-block visible count, keyed by block (bucket name, or 'flat' for the
  // project tab's one list). Absent = the first page. Local to this mount: a
  // tab switch or a collapsed project group starts back at 10, like the rest
  // of the list's transient state (collapsedIds).
  const [limits, setLimits] = useState<Record<string, number>>({})
  const showMore = (blockKey: string): void =>
    setLimits((prev) => ({ ...prev, [blockKey]: (prev[blockKey] ?? CONVERSATION_PAGE_SIZE) + CONVERSATION_PAGE_SIZE }))

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
    return () => clearInterval(timer)
  }, [])

  const sorted = [...conversations].sort(byPinnedThenRecency)

  const menuFor = (conv: ConversationListItem): MenuProps => ({
    items: [
      ...(onPopout ? [{
        label: t('conversationSidebar.popOut'),
        icon: <ExportOutlined />,
        key: 'popout',
        onClick: () => { setOpenMenuKey(null); onPopout(conv.key, conv.label) }
      }] : []),
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
      light={lights[conv.key] ?? null}
      backgroundCount={backgroundCounts[conv.key] ?? 0}
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

  // The project tab's flat list pages too: pins render whole, the unpinned
  // tail takes the first page (置顶除外 — same rule as the pin group above).
  const flatLimit = limits.flat ?? CONVERSATION_PAGE_SIZE
  const flatRest = sorted.filter((c) => !c.pinned)
  const flatVisible = flatRest.slice(0, flatLimit)

  return (
    <>
      <ConversationLightDotStyle />
      <style>{`
        .conv-show-more {
          display: block; width: 100%; text-align: left;
          border: none; background: transparent; cursor: pointer;
          font: inherit; font-size: 12px; color: var(--pm-text-muted);
          /* Aligned with the rows above (10px gutter + 6px gap + 8px pad). */
          padding: 4px 8px 4px 24px; margin-bottom: 2px; border-radius: 6px;
        }
        .conv-show-more:hover { color: var(--pm-ink); background: var(--pm-hover); }
      `}</style>
      {groups
        ? groups.map((group) => {
          // 置顶除外: the pin pool renders whole; a day bucket pages at 10.
          const limit = group.bucket === 'pinned' ? group.items.length : limits[group.bucket] ?? CONVERSATION_PAGE_SIZE
          const items = group.items.slice(0, limit)
          const remaining = group.items.length - items.length
          return (
            <div key={group.bucket}>
              <div data-conv-group={group.bucket} style={GROUP_HEADER_STYLE}>
                {t(GROUP_LABEL_KEY[group.bucket])}
              </div>
              {items.map(renderRow)}
              {remaining > 0 && (
                <ShowMoreBlock blockKey={group.bucket} remaining={remaining} onMore={showMore} />
              )}
            </div>
          )
        })
        : (
          <>
            {sorted.filter((c) => c.pinned).map(renderRow)}
            {flatVisible.map(renderRow)}
            {flatRest.length - flatVisible.length > 0 && (
              <ShowMoreBlock
                blockKey="flat"
                remaining={flatRest.length - flatVisible.length}
                onMore={showMore}
              />
            )}
          </>
        )}
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
