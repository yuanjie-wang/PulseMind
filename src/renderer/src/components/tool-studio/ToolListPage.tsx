// ── Tool list page (M5R browse/run state) ──
// Left ToolList + right ToolRunner (or the empty-state CTA when no tool is
// selected). Owns the tools state + ops; selection lives in the navigation
// params so it survives detours to other centers (navigateKind memory).

import React, { useCallback, useEffect, useState } from 'react'
import { App as AntdApp, Button } from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import { useNavigationStore } from '../../stores/navigationStore'
import type { UserTool } from '../../../../shared/types/user-tool'
import { ToolList } from './ToolList'
import { ToolRunner } from './ToolRunner'
import { exportToolHtml } from './tool-export'

export function ToolListPage({ selectedId }: { selectedId: string | null }): React.ReactElement {
  const { modal, message } = AntdApp.useApp()
  const navigate = useNavigationStore((s) => s.navigate)
  const [tools, setTools] = useState<UserTool[]>([])
  const [deletedPresets, setDeletedPresets] = useState<string[]>([])

  const load = useCallback((): Promise<void> => {
    return Promise.all([
      window.electronAPI.toolList(),
      window.electronAPI.toolGetDeletedPresets(),
    ])
      .then(([list, deleted]) => {
        setTools(list)
        setDeletedPresets(deleted)
      })
      .catch((err) => console.warn('[ToolListPage] load failed:', err))
  }, [])

  useEffect(() => { void load() }, [load])

  const openTool = useCallback((id: string) => navigate({ kind: 'tools', toolId: id }), [navigate])
  const createNew = useCallback(() => navigate({ kind: 'tools', toolEditing: true }), [navigate])
  const editTool = useCallback((tool: UserTool) => navigate({ kind: 'tools', toolId: tool.id, toolEditing: true }), [navigate])

  const duplicateTool = useCallback(async (tool: UserTool) => {
    try {
      const copy = await window.electronAPI.toolDuplicate(tool.id)
      await load()
      if (copy) {
        message.success(`已创建副本「${copy.name}」`)
        openTool(copy.id)
      }
    } catch (err) {
      message.error(`复制失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }, [message, openTool, load])

  const removeTool = useCallback((tool: UserTool) => {
    modal.confirm({
      title: `删除「${tool.name}」？`,
      content: tool.preset
        ? '预置工具也可删除；之后可在列表底部「恢复预置工具」找回当前分发版本（编辑内容不可找回）。'
        : '工具文件与会话记录会一并删除，不可恢复。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await window.electronAPI.toolDelete(tool.id)
        if (tool.id === selectedId) navigate({ kind: 'tools' })
        await load()
      },
    })
  }, [modal, navigate, load, selectedId])

  const restorePresets = useCallback(async () => {
    try {
      const restored = await window.electronAPI.toolRestorePresets()
      await load()
      message.success(restored.length > 0 ? `已恢复 ${restored.length} 个预置工具` : '预置工具已是最新，没有需要恢复的')
    } catch (err) {
      message.error(`恢复失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }, [message, load])

  const selected = tools.find((t) => t.id === selectedId) ?? null

  return (
    <div style={{ height: '100%', display: 'flex', overflow: 'hidden', background: '#fff' }}>
      <ToolList
        tools={tools}
        selectedId={selectedId}
        hasDeletedPresets={deletedPresets.length > 0}
        onOpen={openTool}
        onCreate={createNew}
        onEdit={editTool}
        onDuplicate={(tool) => void duplicateTool(tool)}
        onExport={(tool) => void exportToolHtml(tool).catch((err) => message.warning(err instanceof Error ? err.message : String(err)))}
        onDelete={removeTool}
        onRestorePresets={() => void restorePresets()}
      />
      <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
        {selected ? (
          <ToolRunner key={selected.id} tool={selected} onEdit={editTool} />
        ) : (
          <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
            <div style={{ fontSize: 16, fontWeight: 600 }}>创造你的第一个工具</div>
            <div style={{ fontSize: 13, color: '#999', maxWidth: 380, textAlign: 'center', lineHeight: 1.8 }}>
              用一句话描述需求，工作室对话会生成一个可直接使用的 HTML 小工具。
              左侧预置工具（计算器、番茄钟等）开箱即用，也可以就地编辑或复制一份改造。
            </div>
            <Button type="primary" icon={<PlusOutlined />} onClick={createNew}>新建工具</Button>
          </div>
        )}
      </div>
    </div>
  )
}
