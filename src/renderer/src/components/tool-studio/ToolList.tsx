// ── Tool list (M5R) ──
// The left column of the browse/run state: grouped list (预置工具 / 我的工具)
// with a「+ 新建工具」entry, per-row hover ops (复制 / 编辑 / 导出 / 删除) and
// the「恢复预置工具」entry shown only when deletion records exist (D-R2).

import React, { useState } from 'react'
import { Button, Tooltip } from 'antd'
import {
  PlusOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
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
  onExport: (tool: UserTool) => void
  onDelete: (tool: UserTool) => void
  onRestorePresets: () => void
}

function ToolRow({ tool, selected, active, onOpen, onEdit, onDuplicate, onExport, onDelete }: {
  tool: UserTool
  selected: boolean
  active: boolean
  onOpen: () => void
  onEdit: () => void
  onDuplicate: () => void
  onExport: () => void
  onDelete: () => void
}): React.ReactElement {
  const [hover, setHover] = useState(false)
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onOpen}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '7px 10px', borderRadius: 8, cursor: 'pointer',
        background: selected ? 'rgba(0,0,0,0.06)' : 'transparent',
        fontWeight: selected ? 600 : 400,
      }}
    >
      <span style={{ flex: 1, minWidth: 0, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 }}>{tool.name}</span>
        {tool.preset && (
          <span style={{ flexShrink: 0, fontSize: 10, lineHeight: '16px', padding: '0 5px', borderRadius: 4, background: 'rgba(0,0,0,0.06)', color: '#888' }}>
            预置
          </span>
        )}
      </span>
      {hover && (
        <span
          style={{ flexShrink: 0, display: 'inline-flex', gap: 0 }}
          onClick={(e) => e.stopPropagation()}
        >
          <Tooltip title="复制副本">
            <Button type="text" size="small" icon={<CopyOutlined style={{ fontSize: 12 }} />} onClick={onDuplicate} />
          </Tooltip>
          <Tooltip title="编辑">
            <Button type="text" size="small" icon={<EditOutlined style={{ fontSize: 12 }} />} onClick={onEdit} />
          </Tooltip>
          <Tooltip title="导出 HTML">
            <Button type="text" size="small" icon={<DownloadOutlined style={{ fontSize: 12 }} />} onClick={onExport} />
          </Tooltip>
          <Tooltip title="删除">
            <Button type="text" size="small" danger icon={<DeleteOutlined style={{ fontSize: 12 }} />} onClick={onDelete} />
          </Tooltip>
        </span>
      )}
      {!hover && active && <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#000', flexShrink: 0 }} />}
    </div>
  )
}

export function ToolList({
  tools, selectedId, hasDeletedPresets, onOpen, onCreate, onEdit, onDuplicate, onExport, onDelete, onRestorePresets,
}: ToolListProps): React.ReactElement {
  const presets = tools.filter((t) => t.preset)
  const mine = tools.filter((t) => !t.preset)

  const group = (label: string, items: UserTool[]): React.ReactElement => (
    <div style={{ marginBottom: 12 }}>
      <div style={{ padding: '2px 10px 4px', fontSize: 11, color: '#999' }}>{label}</div>
      {items.map((tool) => (
        <ToolRow
          key={tool.id}
          tool={tool}
          selected={tool.id === selectedId}
          active={tool.id === selectedId}
          onOpen={() => onOpen(tool.id)}
          onEdit={() => onEdit(tool)}
          onDuplicate={() => onDuplicate(tool)}
          onExport={() => onExport(tool)}
          onDelete={() => onDelete(tool)}
        />
      ))}
    </div>
  )

  return (
    <div style={{ width: 240, flexShrink: 0, borderRight: '1px solid #f0f0f0', padding: 10, display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
      <Button
        type="primary"
        icon={<PlusOutlined />}
        onClick={onCreate}
        style={{ borderRadius: 8, marginBottom: 12 }}
      >
        新建工具
      </Button>
      {presets.length > 0 && group('预置工具', presets)}
      {group(mine.length > 0 ? '我的工具' : '', mine)}
      {mine.length === 0 && presets.length === 0 && (
        <div style={{ padding: '16px 10px', color: '#999', fontSize: 12, lineHeight: 1.7 }}>
          还没有工具。点上方「新建工具」描述需求即可生成；下方预置工具开箱即用，也可就地改造。
        </div>
      )}
      {hasDeletedPresets && (
        <Button type="text" size="small" icon={<UndoOutlined />} onClick={onRestorePresets} style={{ marginTop: 'auto', justifyContent: 'flex-start' }}>
          恢复预置工具
        </Button>
      )}
    </div>
  )
}
