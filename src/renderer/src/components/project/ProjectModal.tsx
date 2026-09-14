// ── Project create/edit modal (PLAN-0.4.0 M3.7, extracted from ProjectView
// for M8.4 so the welcome page's project panel can reuse it; M8.x revision:
// the side drawer became a modal and creation only collects name + workspace
// — the sandbox policy starts at its defaults and is tuned in 项目设置) ──

import React, { useState } from 'react'
import { App as AntdApp, Button, Input, Modal, Select, Space, Switch, Tooltip } from 'antd'
import { FolderOpenOutlined } from '@ant-design/icons'
import { DEFAULT_SANDBOX_POLICY, type ProjectSandboxPolicy } from '../../../../shared/sandbox/policy'
import type { Project, ProjectCreateInput, ProjectUpdateInput } from '../../../../shared/types/project'

export const FS_OPTIONS = [
  { value: 'workspace-write', label: '工作区可写（推荐）' },
  { value: 'read-only', label: '只读' },
  { value: 'full-access', label: '完全访问' },
]
export const NETWORK_OPTIONS = [
  { value: 'allow', label: '允许联网' },
  { value: 'deny', label: '禁止联网' },
]

export function SandboxControls({ value, onChange }: {
  value: ProjectSandboxPolicy
  onChange: (next: ProjectSandboxPolicy) => void
}): React.ReactElement {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Space wrap>
        <span style={{ fontSize: 12, color: '#888' }}>文件</span>
        <Select size="small" options={FS_OPTIONS} value={value.fs} onChange={(fs) => onChange({ ...value, fs })} style={{ minWidth: 170 }} />
        <span style={{ fontSize: 12, color: '#888' }}>网络</span>
        <Select size="small" options={NETWORK_OPTIONS} value={value.network} onChange={(network) => onChange({ ...value, network })} style={{ minWidth: 120 }} />
      </Space>
      <Space wrap>
        <Tooltip title="开启后命令在 OS 沙箱内运行（macOS sandbox-exec / Linux bwrap）；平台不支持时自动降级为软沙箱（仅审批+审计）">
          <span style={{ fontSize: 12, color: '#888' }}>硬隔离</span>
        </Tooltip>
        <Switch size="small" checked={value.hardIsolation} onChange={(hardIsolation) => onChange({ ...value, hardIsolation })} />
      </Space>
    </div>
  )
}

export function ProjectModal({ open, editing, onClose, onSaved }: {
  open: boolean
  editing: Project | null
  onClose: () => void
  /** Called after a successful save with the created/updated project (create only). */
  onSaved: (project?: Project) => void
}): React.ReactElement {
  const { message } = AntdApp.useApp()
  const [name, setName] = useState('')
  const [workspaceDir, setWorkspaceDir] = useState('')
  const [sandbox, setSandbox] = useState<ProjectSandboxPolicy>({ ...DEFAULT_SANDBOX_POLICY })
  const [saving, setSaving] = useState(false)

  // Form fields repopulate from `editing` when the modal finishes opening —
  // an event callback rather than a state-resetting effect.
  const afterOpenChange = (open: boolean): void => {
    if (!open) return
    setName(editing?.name ?? '')
    setWorkspaceDir(editing?.workspaceDir ?? '')
    setSandbox(editing?.sandbox ?? { ...DEFAULT_SANDBOX_POLICY })
  }

  const pickDir = async (): Promise<void> => {
    const res = await window.electronAPI.showOpenDialog({ properties: ['openDirectory'] })
    if (!res.canceled && res.filePaths[0]) setWorkspaceDir(res.filePaths[0])
  }

  const save = async (): Promise<void> => {
    if (!name.trim() || (!editing && !workspaceDir.trim())) return
    setSaving(true)
    try {
      if (editing) {
        // workspaceDir is fixed at creation — renames/sandbox edits only.
        const patch: ProjectUpdateInput = { name, sandbox }
        await window.electronAPI.projectUpdate(editing.id, patch)
        onSaved()
      } else {
        // 目录即身份 (M8.4): one directory backs at most one project. Creating
        // against an occupied directory would silently fork its conversations,
        // so adopt the existing project instead.
        const projects = await window.electronAPI.projectList()
        const existing = projects.find((p) => p.id !== 'default' && p.workspaceDir === workspaceDir)
        if (existing) {
          message.info(`该目录已被项目「${existing.name}」使用，已为你选中它。`)
          onSaved(existing)
          onClose()
          return
        }
        const input: ProjectCreateInput = { name, workspaceDir, sandbox }
        const project = await window.electronAPI.projectCreate(input)
        onSaved(project)
      }
      onClose()
    } catch (err) {
      // Duplicate names / unusable workspace dirs surface from the main process.
      message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const canSubmit = Boolean(name.trim() && (editing || workspaceDir.trim()))

  return (
    <Modal
      title={editing ? '项目设置' : '新建项目'}
      open={open}
      onCancel={onClose}
      onOk={save}
      afterOpenChange={afterOpenChange}
      width={480}
      cancelText="取消"
      okText={editing ? '保存' : '创建'}
      okButtonProps={{ loading: saving, disabled: !canSubmit }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 4 }}>
        <div>
          <div style={{ marginBottom: 6, fontSize: 13 }}>项目名称</div>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：my-app" autoFocus />
        </div>
        {editing ? (
          <>
            <div>
              <div style={{ marginBottom: 6, fontSize: 13 }}>固定工作区（创建后不可修改）</div>
              <code style={{ fontSize: 12, color: '#666', wordBreak: 'break-all' }}>{editing.workspaceDir}</code>
            </div>
            <div>
              <div style={{ marginBottom: 6, fontSize: 13 }}>沙箱策略</div>
              <SandboxControls value={sandbox} onChange={setSandbox} />
            </div>
          </>
        ) : (
          <div>
            <div style={{ marginBottom: 6, fontSize: 13 }}>固定工作区（对话的文件读写都锁定在这里）</div>
            <Space.Compact style={{ width: '100%' }}>
              <Input value={workspaceDir} onChange={(e) => setWorkspaceDir(e.target.value)} placeholder="/path/to/workspace" />
              <Button icon={<FolderOpenOutlined />} onClick={pickDir} />
            </Space.Compact>
          </div>
        )}
      </div>
    </Modal>
  )
}
