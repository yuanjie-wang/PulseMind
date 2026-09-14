// ── Tool list (M5R) ──
// The left column of the browse/run state: a search box + one flat list of every
// tool — presets and user tools rank the same, no category split (revised
// 2026-09-13).
//
// Hover model, second pass: the row ops are NOT a permanently mounted subtree
// with a visibility toggle. Rows are memoized and carry no buttons at all; only
// the hovered row renders its ops, inside a slot whose width is always reserved
// so mounting them causes no reflow (name width and row height are constant).
// Hover is owned by the LIST (single hoveredId), so "two rows showing buttons at
// once" is impossible by construction, and a hover move mounts one small subtree
// instead of re-rendering N rows of antd Buttons/Tooltips — the cost that made
// the previous version flash both rows' buttons mid-transition.

import React, { useCallback, useMemo, useState } from 'react'
import { Button, Input, Tooltip } from 'antd'
import {
  PlusOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  SearchOutlined,
  UndoOutlined,
} from '@ant-design/icons'
import type { UserTool } from '../../../../shared/types/user-tool'

export interface ToolListProps {
  tools: UserTool[]
  selectedId: string | null
  /** Deleted-preset records exist → offer「恢复预置工具」. */
  hasDeletedPresets: boolean
  onOpen: (id: string) => void
  onCreate: () => void
  onEdit: (tool: UserTool) => void
  onDuplicate: (tool: UserTool) => void
  onDelete: (tool: UserTool) => void
  onRestorePresets: () => void
}

/** Fixed row height so hover never changes the element's size. */
const ROW_HEIGHT = 30
/** Width permanently reserved for the row ops. antd's small icon-only button is
 *  24px wide, so 3 × 24 + a little slack. */
const OPS_WIDTH = 76
const ROW_HOVER_BG = 'rgba(0,0,0,0.04)'
const ROW_SELECTED_BG = 'rgba(0,0,0,0.08)'
/** Row ops render as bare icons — antd's text-button hover tint is switched off. */
const OP_BUTTON_STYLE: React.CSSProperties = { background: 'transparent' }

/** Simple filter for the search box: name or description contains the query. */
function matchesQuery(tool: UserTool, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return tool.name.toLowerCase().includes(q) || (tool.description ?? '').toLowerCase().includes(q)
}

/** The hovered row's 复制 / 编辑 / 删除 cluster. The row is itself a click target
 *  (open the tool), and these buttons live inside it, so every op must swallow
 *  the click: without this the row's own handler runs right after — 编辑
 *  navigates to the workspace and is then overwritten by the run state. */
function RowOps({ tool, onEdit, onDuplicate, onDelete }: {
  tool: UserTool
  onEdit: (tool: UserTool) => void
  onDuplicate: (tool: UserTool) => void
  onDelete: (tool: UserTool) => void
}): React.ReactElement {
  const op = (run: (tool: UserTool) => void) => (event: React.MouseEvent) => {
    event.stopPropagation()
    run(tool)
  }
  return (
    <>
      <Tooltip title="复制副本">
        <Button type="text" size="small" style={OP_BUTTON_STYLE} icon={<CopyOutlined style={{ fontSize: 12 }} />} onClick={op(onDuplicate)} />
      </Tooltip>
      <Tooltip title="编辑">
        <Button type="text" size="small" style={OP_BUTTON_STYLE} icon={<EditOutlined style={{ fontSize: 12 }} />} onClick={op(onEdit)} />
      </Tooltip>
      <Tooltip title="删除">
        <Button type="text" size="small" danger style={OP_BUTTON_STYLE} icon={<DeleteOutlined style={{ fontSize: 12 }} />} onClick={op(onDelete)} />
      </Tooltip>
    </>
  )
}

interface ToolRowProps {
  tool: UserTool
  selected: boolean
  hovered: boolean
  onOpen: (id: string) => void
  onEdit: (tool: UserTool) => void
  onDuplicate: (tool: UserTool) => void
  onDelete: (tool: UserTool) => void
  /** Reports this row's id on enter and null on leave (list-owned hover). */
  onHoverChange: (id: string | null) => void
}

const ToolRow = React.memo(function ToolRow({
  tool, selected, hovered, onOpen, onEdit, onDuplicate, onDelete, onHoverChange,
}: ToolRowProps): React.ReactElement {
  return (
    <div
      onMouseEnter={() => onHoverChange(tool.id)}
      onMouseLeave={() => onHoverChange(null)}
      onClick={() => onOpen(tool.id)}
      style={{
        height: ROW_HEIGHT,
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '0 10px', borderRadius: 8, cursor: 'pointer',
        background: selected ? ROW_SELECTED_BG : hovered ? ROW_HOVER_BG : 'transparent',
        fontWeight: selected ? 600 : 400,
      }}
    >
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 }}>
        {tool.name}
      </span>
      {/* The slot is always here, so mounting the ops shifts nothing. The ops
          are inside the row, so moving onto them keeps the row hovered. */}
      <span style={{ width: OPS_WIDTH, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
        {hovered && <RowOps tool={tool} onEdit={onEdit} onDuplicate={onDuplicate} onDelete={onDelete} />}
      </span>
    </div>
  )
})

export function ToolList({
  tools, selectedId, hasDeletedPresets, onOpen, onCreate, onEdit, onDuplicate, onDelete, onRestorePresets,
}: ToolListProps): React.ReactElement {
  const [query, setQuery] = useState('')
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const shown = useMemo(() => tools.filter((tool) => matchesQuery(tool, query)), [tools, query])

  const handleHoverChange = useCallback((id: string | null) => setHoveredId(id), [])

  const handleQueryChange = (value: string): void => {
    setQuery(value)
    // The row under the pointer may be filtered away — drop the highlight
    // rather than leaving it attached to an id that is no longer rendered.
    setHoveredId(null)
  }

  return (
    <div style={{ width: 240, flexShrink: 0, borderRight: '1px solid #f0f0f0', padding: 10, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <Input
        size="small"
        allowClear
        value={query}
        onChange={(e) => handleQueryChange(e.target.value)}
        placeholder="搜索工具"
        prefix={<SearchOutlined style={{ color: '#bbb', fontSize: 12 }} />}
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
            onOpen={onOpen}
            onEdit={onEdit}
            onDuplicate={onDuplicate}
            onDelete={onDelete}
            onHoverChange={handleHoverChange}
          />
        ))}
        {tools.length === 0 && (
          <div style={{ padding: '16px 10px', color: '#999', fontSize: 12, lineHeight: 1.7 }}>
            还没有工具。点上方「新建工具」描述需求即可生成；预置工具开箱即用，也可就地改造。
          </div>
        )}
        {tools.length > 0 && shown.length === 0 && (
          <div style={{ padding: '16px 10px', color: '#999', fontSize: 12 }}>没有匹配的工具</div>
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
