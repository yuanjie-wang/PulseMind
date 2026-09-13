// ── Tool name editor (M5R) ──
// The one place a tool is renamed: the name plus a pencil affordance that swaps
// in an inline input (Enter or blur commits, Esc cancels, empty/unchanged is a
// no-op). Shared by the run view's header and the workspace header so the tool
// can be renamed in either state — a hidden click-on-title made it effectively
// undiscoverable (2026-09-13).

import React, { useRef, useState } from 'react'
import { App as AntdApp, Button, Input, Tooltip } from 'antd'
import { EditOutlined } from '@ant-design/icons'
import type { UserTool } from '../../../../shared/types/user-tool'

export interface ToolNameEditorProps {
  tool: UserTool
  /** Receives the updated manifest after a successful rename. */
  onRenamed: (tool: UserTool) => void
  /** Styles for the name text — headers differ in size/weight. */
  nameStyle?: React.CSSProperties
}

export function ToolNameEditor({ tool, onRenamed, nameStyle }: ToolNameEditorProps): React.ReactElement {
  const { message } = AntdApp.useApp()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  // Enter commits and the unmount-triggered blur would commit again; Esc must
  // not commit at all. One flag covers both.
  const cancelledRef = useRef(false)
  const busyRef = useRef(false)

  const start = (): void => {
    cancelledRef.current = false
    setDraft(tool.name)
    setEditing(true)
  }

  const commit = async (): Promise<void> => {
    if (cancelledRef.current) {
      cancelledRef.current = false
      return
    }
    if (busyRef.current) return
    busyRef.current = true
    setEditing(false)
    const name = draft.trim()
    if (!name || name === tool.name) {
      busyRef.current = false
      return
    }
    try {
      const updated = await window.electronAPI.toolUpdate(tool.id, { name })
      if (updated) onRenamed(updated)
    } catch (err) {
      message.error(`改名失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      busyRef.current = false
    }
  }

  if (editing) {
    return (
      <Input
        size="small"
        autoFocus
        value={draft}
        maxLength={40}
        style={{ width: 200 }}
        onChange={(e) => setDraft(e.target.value)}
        onPressEnter={() => void commit()}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            cancelledRef.current = true
            setEditing(false)
          }
        }}
      />
    )
  }

  return (
    <>
      <span style={{ fontWeight: 600, ...nameStyle }}>{tool.name}</span>
      <Tooltip title="重命名">
        <Button type="text" size="small" style={{ background: 'transparent' }} icon={<EditOutlined style={{ fontSize: 12 }} />} onClick={start} />
      </Tooltip>
    </>
  )
}
