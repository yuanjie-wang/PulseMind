// ── Tool center (工具中心, M5R) ──
// Two-state shell driven entirely by navigation params — no business state:
//   {kind:'tools'}                            → ToolListPage (browse: 列表 + 空态)
//   {kind:'tools', toolId}                    → ToolListPage (run: 列表 + 工具区)
//   {kind:'tools', toolId, toolEditing:true}  → ToolWorkspace (工作室)
// No in-page title: the global header's centers switcher is the page title.

import React from 'react'
import { useNavigationStore } from '../../stores/navigationStore'
import { ToolListPage } from './ToolListPage'
import { ToolWorkspace } from './ToolWorkspace'

export default function ToolCenter(): React.ReactElement {
  const view = useNavigationStore((s) => s.view)
  if (view.kind !== 'tools') return <div style={{ height: '100%' }} />
  // Tool id, not a key: the workspace stays mounted for the whole edit session,
  // and 新建工具 names the tool before opening, so there is no id-less create
  // state to remount through. Editing without an id is not a reachable state —
  // fall back to the list rather than inventing one.
  if (view.toolEditing && view.toolId) return <ToolWorkspace toolId={view.toolId} />
  return <ToolListPage selectedId={view.toolId ?? null} />
}
