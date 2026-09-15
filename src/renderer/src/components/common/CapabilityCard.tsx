// ── Capability card ──
// The one shell behind the 连接器 / 技能 / 专家 cards of the capability center.
// Those three had drifted into two skeletons: the connector card hand-rolled its
// header inside a headless Card body while the other two used antd's own head, so
// a single center showed two card shapes side by side — a divider under the title
// on two tabs and not the third, 13.5px vs 14px names, three action orders, and
// three grid rhythms (260/14, 260/12, 280/12) that made the columns jump when you
// switched tabs.
//
// What this fixes, and what a caller must not re-fork: antd's head with its divider
// (icon + name + optional badge in `title`, actions in `extra`), the size="small"
// body padding token, radius 10, hover + whole-card click, the action order
// (switch first, delete last and danger) and the grid rhythm below.
//
// Deliberately NOT here: 记忆 (`MemorySettings`) keeps its own headless card — a
// memory's text *is* the card, and two floating tags do not warrant a 38px head.

import React from 'react'
import { Button, Card, Empty, Switch, Tooltip } from 'antd'
import { DeleteOutlined } from '@ant-design/icons'

/** The capability pane's inset. It has to live *inside* the scroll container's clip,
 *  because an `overflow: auto` box clips its descendants at its own padding box —
 *  padding applied one level up leaves the outer cards sitting exactly on the clipping
 *  edge with their hover shadow sheared off (antd's boxShadowCard bleeds 10px
 *  sideways, 15px down, 5px up).
 *
 *  The bottom is therefore specified twice, on purpose. This one insets whatever the
 *  panel renders that is *not* the card grid (the 专家 editor's full-height columns,
 *  the empty states). The grid needs its own (`CAPABILITY_GRID`), because a scroll
 *  container's `padding-bottom` ends at its content box — an over-tall grid overflows
 *  straight past it, so that padding is not below the last row and scrolling to the
 *  end puts the last row flush against the clip. The grid's own padding sits inside
 *  the box that overflows, so it survives. For a grid the panel's copy is inert (the
 *  grid's bottom is the deeper of the two), which is why keeping it costs nothing. */
export const CAPABILITY_PANE_PADDING = '8px 24px 24px'

/** The single grid rhythm for every capability card grid, so 260px columns and a
 *  12px gutter no longer differ per tab. */
export const CAPABILITY_GRID: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
  gap: 12,
  paddingBottom: 24
}

export interface CapabilityCardProps {
  /** Head icon. Bare, not a filled tile: the head already anchors the identity. */
  icon: React.ReactNode
  name: string
  /** Badge after the name (内置 / 分类). */
  badge?: React.ReactNode
  /** Head action row — build it from CapabilitySwitch / CapabilityDeleteButton so
   *  the order and weights cannot drift again. */
  actions?: React.ReactNode
  /** Given, the whole card is the affordance (open editor / browser); the action
   *  row isolates its own clicks. Keyboard parity comes with it. */
  onClick?: () => void
  /** A divider-topped band pinned to the card's bottom, for callers whose cards
   *  must line up (the connector's tool count). */
  footer?: React.ReactNode
  children?: React.ReactNode
}

/** The shared capability card shell. */
function CapabilityCard({
  icon,
  name,
  badge,
  actions,
  onClick,
  footer,
  children
}: CapabilityCardProps): React.ReactElement {
  // Keyboard parity for the click-to-open card; inner buttons keep their own key
  // handling, so only the card's own target counts.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onClick?.()
    }
  }

  return (
    <Card
      size="small"
      hoverable={!!onClick}
      onClick={onClick}
      onKeyDown={onClick ? handleKeyDown : undefined}
      tabIndex={onClick ? 0 : undefined}
      style={{ borderRadius: 10, height: '100%', cursor: onClick ? 'pointer' : undefined }}
      styles={{
        // The card is a column so the body can take the height *left over* by the
        // head. It must not be `height: 100%`: that resolves against the card's
        // content box without subtracting the head, so everything below is pushed
        // out of the card — a bottom-pinned footer lands 24px outside it.
        root: { display: 'flex', flexDirection: 'column' },
        body: {
          flex: 1,
          minHeight: 0,
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column'
        }
      }}
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span style={{ flexShrink: 0, display: 'inline-flex', color: '#666' }}>{icon}</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
          {badge}
        </span>
      }
      extra={
        actions ? (
          <span
            style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}
            onClick={(e) => e.stopPropagation()}
          >
            {actions}
          </span>
        ) : undefined
      }
    >
      {children}
      {footer && (
        <>
          {/* Spacer pins the band to the bottom so a stretched grid row keeps its
              footers aligned. */}
          <div style={{ flex: 1, minHeight: 10 }} />
          <div style={{ paddingTop: 8, borderTop: '1px solid #f2f2f2' }}>{footer}</div>
        </>
      )}
    </Card>
  )
}

export interface CapabilitySwitchProps {
  checked: boolean
  onToggle: () => void
  disabled?: boolean
  loading?: boolean
  /** Tooltip copy. Omit both where the switch is self-evident (技能 / 专家) and
   *  pass them only where flipping it does something non-obvious (启动连接器). */
  onLabel?: string
  offLabel?: string
}

/** The card's on/off switch. */
export function CapabilitySwitch({
  checked,
  onToggle,
  disabled,
  loading,
  onLabel,
  offLabel
}: CapabilitySwitchProps): React.ReactElement {
  const toggle = (
    <Switch size="small" checked={checked} loading={loading} disabled={disabled} onClick={onToggle} />
  )
  return onLabel && offLabel ? <Tooltip title={checked ? offLabel : onLabel}>{toggle}</Tooltip> : toggle
}

/** The card's delete button: danger + icon + tooltip in one place (the skill card
 *  used to render a bare #bbb icon here). Confirmation stays with the caller —
 *  技能 deletes outright, 连接器 and 专家 confirm first. */
export function CapabilityDeleteButton({
  onClick,
  tooltip = '删除'
}: {
  onClick: () => void
  tooltip?: string
}): React.ReactElement {
  return (
    <Tooltip title={tooltip}>
      <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={onClick} />
    </Tooltip>
  )
}

/** The empty state shared by the three capability panels. */
export function CapabilityEmpty({
  title,
  hint,
  action
}: {
  title: string
  hint?: React.ReactNode
  action?: React.ReactNode
}): React.ReactElement {
  return (
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      style={{ marginTop: 48 }}
      description={
        <span style={{ fontSize: 13, color: '#666' }}>
          {title}
          {hint && <span style={{ display: 'block', fontSize: 12, color: '#bbb', marginTop: 4 }}>{hint}</span>}
        </span>
      }
    >
      {action}
    </Empty>
  )
}

export default CapabilityCard
