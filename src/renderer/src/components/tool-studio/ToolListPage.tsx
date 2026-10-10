// ── Tool list page (M5R browse/run state) ──
// Left ToolList + right ToolRunner (or the empty-state CTA when no tool is
// selected). Owns the tools state + ops; selection lives in the navigation
// params so it survives detours to other centers (navigateKind memory).

import React, { useCallback, useEffect, useState } from 'react'
import { App as AntdApp, Button, Input, Modal, theme } from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import { useNavigationStore } from '../../stores/navigationStore'
import { studioConversationId } from '../../tool-studio/tool-prompt'
import { notify } from '../../utils/notify'
import type { UserTool } from '../../../../shared/types/user-tool'
import { ToolList } from './ToolList'
import { ToolRunner } from './ToolRunner'

export function ToolListPage({ selectedId }: { selectedId: string | null }): React.ReactElement {
  const { modal } = AntdApp.useApp()
  const { token } = theme.useToken()
  const navigate = useNavigationStore((s) => s.navigate)
  const [tools, setTools] = useState<UserTool[]>([])
  const [deletedPresets, setDeletedPresets] = useState<string[]>([])
  // Create flow: the tool is named first, so it exists before the workspace
  // opens (no unnamed record, no name guessed from the prompt).
  const [nameModalOpen, setNameModalOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)

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
  const editTool = useCallback((tool: UserTool) => navigate({ kind: 'tools', toolId: tool.id, toolEditing: true }), [navigate])

  // A rename in the run view's header updates the manifest; mirror it into the
  // list so the row and the runner's iframe title agree without a reload.
  const handleRenamed = useCallback((updated: UserTool) => {
    setTools((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
  }, [])

  const openCreateModal = useCallback(() => {
    setNewName('')
    setNameModalOpen(true)
  }, [])

  const confirmCreate = useCallback(async () => {
    const name = newName.trim()
    if (!name) {
      notify.warning('请输入工具名')
      return
    }
    setCreating(true)
    try {
      const tool = await window.electronAPI.toolCreate({ name })
      setNameModalOpen(false)
      await load()
      navigate({ kind: 'tools', toolId: tool.id, toolEditing: true })
    } catch (err) {
      notify.error(`创建失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setCreating(false)
    }
  }, [newName, notify, load, navigate])

  const duplicateTool = useCallback(async (tool: UserTool) => {
    try {
      const copy = await window.electronAPI.toolDuplicate(tool.id)
      await load()
      if (copy) {
        notify.success(`已创建副本「${copy.name}」`)
        openTool(copy.id)
      }
    } catch (err) {
      notify.error(`复制失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }, [notify, openTool, load])

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
        // 删除失败给 toast（full_20261011 M3-P2-3/X5）：无 try/catch 时失败
        // 只是 console 里一行 unhandled rejection，界面无反应。
        try {
          await window.electronAPI.toolDelete(tool.id)
        } catch (err) {
          notify.error(`删除失败：${err instanceof Error ? err.message : String(err)}`)
          return
        }
        // Drop the tool's build session with it — the conversation row is gone,
        // so a live engine would only keep writing into nothing.
        void window.electronAPI
          .agentSessionEngineCall(studioConversationId(tool.id), 'dispose', [])
          .catch(() => { /* no session was ever opened */ })
        if (tool.id === selectedId) navigate({ kind: 'tools' })
        await load()
      },
    })
  }, [modal, navigate, load, selectedId])

  const restorePresets = useCallback(async () => {
    try {
      const restored = await window.electronAPI.toolRestorePresets()
      await load()
      notify.success(restored.length > 0 ? `已恢复 ${restored.length} 个预置工具` : '预置工具已是最新，没有需要恢复的')
    } catch (err) {
      notify.error(`恢复失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }, [notify, load])

  const selected = tools.find((t) => t.id === selectedId) ?? null

  return (
    <div style={{ height: '100%', display: 'flex', overflow: 'hidden', background: token.colorBgContainer }}>
      <ToolList
        tools={tools}
        selectedId={selectedId}
        hasDeletedPresets={deletedPresets.length > 0}
        onOpen={openTool}
        onCreate={openCreateModal}
        onRestorePresets={() => void restorePresets()}
      />
      <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
        {selected ? (
          <ToolRunner
            key={selected.id}
            tool={selected}
            onEdit={editTool}
            onDuplicate={(tool) => void duplicateTool(tool)}
            onDelete={removeTool}
            onRenamed={handleRenamed}
          />
        ) : (
          <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
            <div style={{ fontSize: 16, fontWeight: 600 }}>创造你的个人专属工具</div>
            <div style={{ fontSize: 13, color: token.colorTextTertiary, maxWidth: 380, textAlign: 'center', lineHeight: 1.8 }}>
              先给工具起个名字，再用一句话描述需求，工作室对话会生成一个可直接使用的小工具。
              预置工具开箱即用，也可以就地编辑或复制一份改造。
            </div>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreateModal}>新建工具</Button>
          </div>
        )}
      </div>

      <Modal
        title="新建工具"
        open={nameModalOpen}
        okText="创建"
        cancelText="取消"
        confirmLoading={creating}
        onOk={() => void confirmCreate()}
        onCancel={() => setNameModalOpen(false)}
        width={360}
      >
        <Input
          autoFocus
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onPressEnter={() => void confirmCreate()}
          placeholder="工具名，例如：接口调试器"
          maxLength={40}
        />
      </Modal>
    </div>
  )
}
