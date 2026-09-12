// ── Tool center (工具中心, M5R) ──
// Two-state shell driven entirely by navigation params — no business state:
//   {kind:'tools'}                            → ToolListPage (browse: 列表 + 空态)
//   {kind:'tools', toolId}                    → ToolListPage (run: 列表 + 工具区)
//   {kind:'tools', toolId?, toolEditing:true} → ToolWorkspace (工作室)
// No in-page title: the global header's centers switcher is the page title.

import React from 'react'
import { useNavigationStore } from '../../stores/navigationStore'
import { ToolListPage } from './ToolListPage'
import { ToolWorkspace } from './ToolWorkspace'

export default function ToolCenter(): React.ReactElement {
  const view = useNavigationStore((s) => s.view)
  if (view.kind !== 'tools') return <div style={{ height: '100%' }} />
  // key 按工具区分:切换目标工具时工作区整体重挂载,本地状态随之归零。
  if (view.toolEditing) return <ToolWorkspace key={view.toolId ?? 'create'} toolId={view.toolId ?? null} />
  return <ToolListPage selectedId={view.toolId ?? null} />
}
