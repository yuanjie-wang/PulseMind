// ── Tool list (M5R) ──
// The left column of the browse/run state: a search box + one flat list of every
// tool — presets and user tools rank the same, no category split (revised
// 2026-09-13).
//
// Row anatomy (preset-UI pass): each row is a constant-height two-line card —
// tool avatar, name with the quiet「预置」badge on presets, one-line description
// underneath. Presets carry a curated icon + tint (toolVisual), user tools a
// first-character avatar, so the two kinds read apart at a glance while staying
// one flat list.
//
// Ops model, final: the rows carry NO buttons at all. 复制 / 删除 live in the
// runner header's top-right corner (next to 在工作区编辑 and 重新加载), which is
// where the tool they act on is on screen — a row-mounted cluster had to either
// reserve width (names truncated) or float a pill over the text (looked bolted
// on). The list keeps only a plain hover highlight as the click affordance, so
// row width is entirely the text's and every name fits.

import React, { useCallback, useMemo, useState } from 'react'
import { Button, Input, theme } from 'antd'
import { PlusOutlined, SearchOutlined, UndoOutlined } from '@ant-design/icons'
import type { UserTool } from '../../../../shared/types/user-tool'
import { PresetBadge, ToolAvatar } from './toolVisual'

export interface ToolListProps {
  tools: UserTool[]
  selectedId: string | null
  /** Deleted-preset records exist → offer「恢复预置工具」. */
  hasDeletedPresets: boolean
  onOpen: (id: string) => void
  onCreate: () => void
  onRestorePresets: () => void
}

/** Fixed row height so hover never changes the element's size. Two text lines
 *  (name + description) fit with room to spare. */
const ROW_HEIGHT = 48

/** Theme-derived neutrals, hoisted so memoized rows take one stable object. */
interface RowPalette {
  hoverBg: string
  selectedBg: string
  desc: string
  empty: string
  divider: string
  placeholderIcon: string
}

/** Simple filter for the search box: name or description contains the query. */
function matchesQuery(tool: UserTool, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return tool.name.toLowerCase().includes(q) || (tool.description ?? '').toLowerCase().includes(q)
}

interface ToolRowProps {
  tool: UserTool
  selected: boolean
  hovered: boolean
  palette: RowPalette
  onOpen: (id: string) => void
  /** Reports this row's id on enter and null on leave (list-owned hover). */
  onHoverChange: (id: string | null) => void
}

const ToolRow = React.memo(function ToolRow({
  tool, selected, hovered, palette, onOpen, onHoverChange,
}: ToolRowProps): React.ReactElement {
  return (
    <div
      onMouseEnter={() => onHoverChange(tool.id)}
      onMouseLeave={() => onHoverChange(null)}
      onClick={() => onOpen(tool.id)}
      style={{
        height: ROW_HEIGHT,
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '0 10px', borderRadius: 8, cursor: 'pointer',
        background: selected ? palette.selectedBg : hovered ? palette.hoverBg : 'transparent',
      }}
    >
      <ToolAvatar tool={tool} size={28} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
          <span
            style={{
              minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              fontSize: 13, lineHeight: '18px', fontWeight: selected ? 600 : 500,
            }}
          >
            {tool.name}
          </span>
          {tool.preset && <PresetBadge />}
        </div>
        <span
          title={tool.description || undefined}
          style={{
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            fontSize: 11, lineHeight: '15px', color: palette.desc,
          }}
        >
          {tool.description}
        </span>
      </div>
    </div>
  )
})

export function ToolList({
  tools, selectedId, hasDeletedPresets, onOpen, onCreate, onRestorePresets,
}: ToolListProps): React.ReactElement {
  const { token } = theme.useToken()
  const [query, setQuery] = useState('')
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const shown = useMemo(() => tools.filter((tool) => matchesQuery(tool, query)), [tools, query])
  const palette = useMemo<RowPalette>(() => ({
    hoverBg: token.colorFillQuaternary,
    selectedBg: token.colorFillTertiary,
    desc: token.colorTextTertiary,
    empty: token.colorTextTertiary,
    divider: token.colorBorderSecondary,
    placeholderIcon: token.colorTextQuaternary,
  }), [token])

  const handleHoverChange = useCallback((id: string | null) => setHoveredId(id), [])

  const handleQueryChange = (value: string): void => {
    setQuery(value)
    // The row under the pointer may be filtered away — drop the highlight
    // rather than leaving it attached to an id that is no longer rendered.
    setHoveredId(null)
  }

  return (
    <div style={{ width: 260, flexShrink: 0, borderRight: `1px solid ${palette.divider}`, padding: 10, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <Input
        size="small"
        allowClear
        value={query}
        onChange={(e) => handleQueryChange(e.target.value)}
        placeholder="搜索工具"
        prefix={<SearchOutlined style={{ color: palette.placeholderIcon, fontSize: 12 }} />}
        style={{ borderRadius: 8, marginBottom: 8 }}
      />
      <Button
        type="primary"
        icon={<PlusOutlined />}
        onClick={onCreate}
        style={{ borderRadius: 8, marginBottom: 10 }}
      >
        新建工具
      </Button>
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {shown.map((tool) => (
          <ToolRow
            key={tool.id}
            tool={tool}
            selected={tool.id === selectedId}
            hovered={tool.id === hoveredId}
            palette={palette}
            onOpen={onOpen}
            onHoverChange={handleHoverChange}
          />
        ))}
        {tools.length === 0 && (
          <div style={{ padding: '16px 10px', color: palette.empty, fontSize: 12, lineHeight: 1.7 }}>
            还没有工具。点上方「新建工具」描述需求即可生成；预置工具开箱即用，也可就地改造。
          </div>
        )}
        {tools.length > 0 && shown.length === 0 && (
          <div style={{ padding: '16px 10px', color: palette.empty, fontSize: 12 }}>没有匹配的工具</div>
        )}
      </div>
      {hasDeletedPresets && (
        <Button type="text" size="small" icon={<UndoOutlined />} onClick={onRestorePresets} style={{ marginTop: 6, justifyContent: 'flex-start', flexShrink: 0 }}>
          恢复预置工具
        </Button>
      )}
    </div>
  )
}
