// ── Project view (PLAN-0.4.0 M3.7 / M3.8) ──
// List of projects → project detail (workspace, sandbox policy, its
// conversations). Creating a conversation here binds it to the project; the
// main chat area then runs it under the project's workspace + sandbox.

import React, { useCallback, useEffect, useState } from 'react'
import { Button, Card, Drawer, Input, Modal, Select, Space, Switch, Tag, Tooltip, App as AntdApp } from 'antd'
import { PlusOutlined, FolderOpenOutlined, DeleteOutlined, ArrowLeftOutlined, EditOutlined, SettingOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { useNavigationStore } from '../../stores/navigationStore'
import type { Project, ProjectCreateInput, ProjectUpdateInput } from '../../../../shared/types/project'
import { DEFAULT_SANDBOX_POLICY, type ProjectSandboxPolicy } from '../../../../shared/sandbox/policy'
import type { ConversationListItem } from '../../types/conversation'

export interface ProjectViewProps {
  conversations: ConversationListItem[]
  onSelectConversation: (key: string) => void
  /** Create a conversation bound to this project and switch to the chat view. */
  onCreateConversation: (projectId: string) => void
}

const FS_OPTIONS = [
  { value: 'workspace-write', label: '工作区可写（推荐）' },
  { value: 'read-only', label: '只读' },
  { value: 'full-access', label: '完全访问' },
]
const NETWORK_OPTIONS = [
  { value: 'allow', label: '允许联网' },
  { value: 'deny', label: '禁止联网' },
]
const APPROVAL_OPTIONS = [
  { value: 'outside-ask', label: '越界询问（推荐）' },
  { value: 'auto', label: '自动执行' },
  { value: 'always-ask', label: '每次询问' },
]

function sandboxTags(policy: ProjectSandboxPolicy): React.ReactNode {
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      <Tag>{FS_OPTIONS.find((o) => o.value === policy.fs)?.label ?? policy.fs}</Tag>
      <Tag>{NETWORK_OPTIONS.find((o) => o.value === policy.network)?.label}</Tag>
      <Tag>{APPROVAL_OPTIONS.find((o) => o.value === policy.approval)?.label}</Tag>
      {policy.hardIsolation && <Tag color="green">硬隔离</Tag>}
    </span>
  )
}

function SandboxControls({ value, onChange }: {
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
        <span style={{ fontSize: 12, color: '#888' }}>命令审批</span>
        <Select size="small" options={APPROVAL_OPTIONS} value={value.approval} onChange={(approval) => onChange({ ...value, approval })} style={{ minWidth: 170 }} />
        <Tooltip title="开启后命令在 OS 沙箱内运行（macOS sandbox-exec / Linux bwrap）；平台不支持时自动降级为软沙箱（仅审批+审计）">
          <span style={{ fontSize: 12, color: '#888' }}>硬隔离</span>
        </Tooltip>
        <Switch size="small" checked={value.hardIsolation} onChange={(hardIsolation) => onChange({ ...value, hardIsolation })} />
      </Space>
    </div>
  )
}

function ProjectDrawer({ open, editing, onClose, onSaved }: {
  open: boolean
  editing: Project | null
  onClose: () => void
  onSaved: () => void
}): React.ReactElement {
  const [name, setName] = useState('')
  const [workspaceDir, setWorkspaceDir] = useState('')
  const [sandbox, setSandbox] = useState<ProjectSandboxPolicy>({ ...DEFAULT_SANDBOX_POLICY })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setName(editing?.name ?? '')
    setWorkspaceDir(editing?.workspaceDir ?? '')
    setSandbox(editing?.sandbox ?? { ...DEFAULT_SANDBOX_POLICY })
  }, [open, editing])

  const pickDir = async (): Promise<void> => {
    const res = await window.electronAPI.showOpenDialog({ properties: ['openDirectory'] })
    if (!res.canceled && res.filePaths[0]) setWorkspaceDir(res.filePaths[0])
  }

  const save = async (): Promise<void> => {
    if (!name.trim() || !workspaceDir.trim()) return
    setSaving(true)
    try {
      if (editing) {
        const patch: ProjectUpdateInput = { name, workspaceDir, sandbox }
        await window.electronAPI.projectUpdate(editing.id, patch)
      } else {
        const input: ProjectCreateInput = { name, workspaceDir, sandbox }
        await window.electronAPI.projectCreate(input)
      }
      onSaved()
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Drawer title={editing ? '项目设置' : '新建项目'} open={open} onClose={onClose} width={480}
      footer={
        <div style={{ textAlign: 'right' }}>
          <Button onClick={onClose} style={{ marginInlineEnd: 8 }}>取消</Button>
          <Button type="primary" loading={saving} disabled={!name.trim() || !workspaceDir.trim()} onClick={save}>
            {editing ? '保存' : '创建'}
          </Button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <div style={{ marginBottom: 6, fontSize: 13 }}>项目名称</div>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：my-app" autoFocus />
        </div>
        <div>
          <div style={{ marginBottom: 6, fontSize: 13 }}>固定工作区（对话的文件读写都锁定在这里）</div>
          <Space.Compact style={{ width: '100%' }}>
            <Input value={workspaceDir} onChange={(e) => setWorkspaceDir(e.target.value)} placeholder="/path/to/workspace" />
            <Button icon={<FolderOpenOutlined />} onClick={pickDir} />
          </Space.Compact>
        </div>
        <div>
          <div style={{ marginBottom: 6, fontSize: 13 }}>沙箱策略</div>
          <SandboxControls value={sandbox} onChange={setSandbox} />
        </div>
      </div>
    </Drawer>
  )
}

export default function ProjectView({ conversations, onSelectConversation, onCreateConversation }: ProjectViewProps): React.ReactElement {
  const { t } = useTranslation()
  const { modal } = AntdApp.useApp()
  const navigate = useNavigationStore((s) => s.navigate)
  const [projects, setProjects] = useState<Project[]>([])
  const [detailId, setDetailId] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editing, setEditing] = useState<Project | null>(null)
  const [hardIsolationSupported, setHardIsolationSupported] = useState<boolean | null>(null)

  const reload = useCallback(async () => {
    try {
      setProjects(await window.electronAPI.projectList())
    } catch (err) {
      console.warn('[ProjectView] load failed:', err)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])
  useEffect(() => {
    window.electronAPI.sandboxDetect().then(setHardIsolationSupported).catch(() => setHardIsolationSupported(null))
  }, [])

  // Recent sandbox audit entries (M3.12) — refreshed with the project list.
  const [audit, setAudit] = useState<Array<{ id: string; ts: string; action: string; target?: string; decision: string }>>([])
  useEffect(() => {
    if (!detailId) return
    window.electronAPI.auditList?.(30)
      .then((entries) => setAudit(entries))
      .catch(() => {})
  }, [detailId, projects])

  const detail = projects.find((p) => p.id === detailId) ?? null
  const projectConversations = detail
    ? conversations.filter((c) => (c.projectId || 'default') === detail.id)
    : []

  const openDetail = (id: string): void => setDetailId(id)

  const removeProject = (project: Project): void => {
    if (project.id === 'default') return
    const count = conversations.filter((c) => (c.projectId || 'default') === project.id).length
    modal.confirm({
      title: `删除项目「${project.name}」？`,
      content: count > 0 ? `项目内的 ${count} 个会话将一并删除，且不可恢复。` : '该项目没有会话。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await window.electronAPI.projectDelete(project.id)
        setDetailId(null)
        void reload()
      },
    })
  }

  // ── Detail ──
  if (detail) {
    return (
      <div style={{ height: '100%', overflow: 'auto', padding: 24, background: '#fff' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => setDetailId(null)} />
          <span style={{ fontSize: 18, fontWeight: 700 }}>{detail.name}</span>
          {detail.id !== 'default' && (
            <>
              <Button type="text" icon={<EditOutlined />} onClick={() => { setEditing(detail); setDrawerOpen(true) }} />
              <Button type="text" danger icon={<DeleteOutlined />} onClick={() => removeProject(detail)} />
            </>
          )}
        </div>

        <Card size="small" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, color: '#888', width: 70 }}>工作区</span>
              <code style={{ fontSize: 12 }}>{detail.workspaceDir}</code>
              <Tooltip title="打开工作区目录">
                <Button type="text" size="small" icon={<FolderOpenOutlined />} onClick={() => window.electronAPI.openFolder(detail.workspaceDir)} />
              </Tooltip>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, color: '#888', width: 70 }}>沙箱</span>
              {sandboxTags(detail.sandbox)}
              {detail.sandbox.hardIsolation && hardIsolationSupported === false && (
                <Tooltip title="当前平台不支持 OS 级硬隔离，已降级为软沙箱（仅审批+审计）">
                  <Tag color="orange">已降级</Tag>
                </Tooltip>
              )}
            </div>
            {detail.id !== 'default' && (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <span style={{ fontSize: 12, color: '#888', width: 70, paddingTop: 2 }}><SettingOutlined /></span>
                <SandboxControls
                  value={detail.sandbox}
                  onChange={(next) => {
                    void window.electronAPI.projectUpdate(detail.id, { sandbox: next }).then(reload)
                  }}
                />
              </div>
            )}
          </div>
        </Card>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>会话（{projectConversations.length}）</span>
          <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => onCreateConversation(detail.id)}>
            新建对话
          </Button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {projectConversations.length === 0 && (
            <div style={{ color: '#999', fontSize: 13, padding: '16px 0' }}>还没有会话，点「新建对话」开始。</div>
          )}
          {projectConversations.map((conv) => (
            <Card
              key={conv.key}
              size="small"
              hoverable
              style={{ borderRadius: 8 }}
              onClick={() => { navigate({ kind: 'chat' }); onSelectConversation(conv.key) }}
            >
              <span style={{ fontWeight: 500 }}>{conv.label}</span>
            </Card>
          ))}
        </div>

        <Card size="small" style={{ marginBottom: 16, marginTop: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>沙箱审计（最近 {audit.length} 条）</div>
          {audit.length === 0 && <div style={{ color: '#999', fontSize: 12 }}>暂无记录。</div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 220, overflow: 'auto' }}>
            {audit.map((entry) => (
              <div key={entry.id} style={{ display: 'flex', gap: 8, fontSize: 11, alignItems: 'baseline' }}>
                <span style={{ color: entry.decision === 'denied' ? '#cf1322' : '#bbb', width: 64, flexShrink: 0 }}>
                  {entry.decision === 'denied' ? '⛔ 拒绝' : entry.decision === 'sandboxed' ? '🛡 隔离' : '✓ 允许'}
                </span>
                <span style={{ color: '#666', width: 70, flexShrink: 0 }}>{entry.action}</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#999' }}>{entry.target}</span>
                <span style={{ color: '#ccc', flexShrink: 0 }}>{new Date(entry.ts).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </Card>

        <ProjectDrawer
          open={drawerOpen}
          editing={editing}
          onClose={() => setDrawerOpen(false)}
          onSaved={reload}
        />
      </div>
    )
  }

  // ── List ──
  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 24, background: '#fff' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <span style={{ fontSize: 18, fontWeight: 700 }}>{t('viewTitle.project')}</span>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditing(null); setDrawerOpen(true) }}>
          新建项目
        </Button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
        {projects.map((project) => {
          const count = conversations.filter((c) => (c.projectId || 'default') === project.id).length
          return (
            <Card
              key={project.id}
              hoverable
              style={{ borderRadius: 10 }}
              onClick={() => openDetail(project.id)}
              title={<span style={{ fontSize: 14 }}>{project.name}</span>}
              extra={project.id === 'default' ? <Tag>默认</Tag> : null}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <code style={{ fontSize: 11, color: '#888', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {project.workspaceDir}
                </code>
                {sandboxTags(project.sandbox)}
                <span style={{ fontSize: 12, color: '#999' }}>{count} 个会话</span>
              </div>
            </Card>
          )
        })}
      </div>

      <ProjectDrawer
        open={drawerOpen}
        editing={editing}
        onClose={() => setDrawerOpen(false)}
        onSaved={reload}
      />
    </div>
  )
}
