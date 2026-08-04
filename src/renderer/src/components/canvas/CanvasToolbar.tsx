import React from 'react'
import { Tooltip, Modal } from 'antd'
import { ExclamationCircleFilled } from '@ant-design/icons'
import { MousePointer2, Hand, SquarePlus, Undo2, Trash2, Redo2 } from 'lucide-react'
import { useCanvasStore } from '../../stores/canvasStore'

const MOD = /Mac|iPod|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl+'

interface ToolDef {
  key: string
  icon: React.ReactNode
  label: string
  shortcut?: string
  action: 'tool' | 'action'
  separatorAfter?: boolean
}

const ICON_SIZE = 15

const TOOLS: ToolDef[] = [
  { key: 'cursor', icon: <MousePointer2 size={ICON_SIZE} />, label: '箭头', shortcut: 'V', action: 'tool' },
  { key: 'pan', icon: <Hand size={ICON_SIZE} />, label: '移动', shortcut: 'M', action: 'tool', separatorAfter: true },
  { key: 'rect', icon: <SquarePlus size={ICON_SIZE} />, label: '创建', shortcut: 'C', action: 'tool', separatorAfter: true },
  { key: 'undo', icon: <Undo2 size={ICON_SIZE} />, label: '撤销', shortcut: `${MOD}Z`, action: 'action' },
  { key: 'restore', icon: <Redo2 size={ICON_SIZE} />, label: '恢复', shortcut: `${MOD}⇧Z`, action: 'action' },
  { key: 'clear', icon: <Trash2 size={ICON_SIZE} />, label: '清空', action: 'action' },
]

interface CanvasToolbarProps {
  onClearAll?: () => void
}

export default function CanvasToolbar({ onClearAll }: CanvasToolbarProps): React.ReactElement {
  const currentTool = useCanvasStore(s => s.currentTool)
  const setCurrentTool = useCanvasStore(s => s.setCurrentTool)
  const clearAllAnnotations = useCanvasStore(s => s.clearAllAnnotations)
  const undoAction = useCanvasStore(s => s.undo)
  const redoAction = useCanvasStore(s => s.redo)
  const canUndo = useCanvasStore(s => s.canUndo)
  const canRedo = useCanvasStore(s => s.canRedo)
  const setSelectedRectId = useCanvasStore(s => s.setSelectedRectId)
  const annotationCount = useCanvasStore(s => s.annotations.length)

  const handleClick = (t: ToolDef) => {
    if (t.action === 'tool') {
      setCurrentTool(t.key as any)
      if (t.key === 'pan' || t.key === 'rect') setSelectedRectId(null)
    } else {
      switch (t.key) {
        case 'undo':
          undoAction()
          break
        case 'restore':
          redoAction()
          break
        case 'clear':
          Modal.confirm({
            title: '清空画布',
            icon: <ExclamationCircleFilled />,
            content: '确定要清空所有画布内容吗？此操作不可撤销。',
            okText: '确认清空',
            okButtonProps: { danger: true },
            cancelText: '取消',
            onOk: () => {
              onClearAll?.()
              clearAllAnnotations()
            }
          })
          break
      }
    }
  }

  const isDisabled = (t: ToolDef): boolean => {
    if (t.key === 'undo' && !canUndo) return true
    if (t.key === 'restore' && !canRedo) return true
    if (t.key === 'clear' && annotationCount === 0) return true
    return false
  }

  const btnStyle = (t: ToolDef): React.CSSProperties => {
    const disabled = isDisabled(t)
    return {
      width: 30,
      height: 30,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      border: 'none',
      borderRadius: 6,
      background: t.action === 'tool' && currentTool === t.key
        ? 'rgba(79,140,255,0.2)'
        : 'transparent',
      color: disabled ? '#aeaeb2' : (t.action === 'tool' && currentTool === t.key ? '#4f8cff' : '#6e6e73'),
      cursor: disabled ? 'default' : 'pointer',
      transition: 'background 0.15s',
    }
  }

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 2,
      height: 32,
    }}>
      {TOOLS.map(t => (
        <React.Fragment key={t.key}>
          <Tooltip title={t.shortcut ? `${t.label} (${t.shortcut})` : t.label}>
            <button
              style={btnStyle(t)}
              onClick={() => handleClick(t)}
              disabled={isDisabled(t)}
            >
              {t.icon}
            </button>
          </Tooltip>
          {t.separatorAfter && (
            <div style={{ width: 1, height: 16, background: '#d2d2d7', margin: '0 4px' }} />
          )}
        </React.Fragment>
      ))}
    </div>
  )
}
