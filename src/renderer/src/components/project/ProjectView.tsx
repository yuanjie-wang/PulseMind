// ── Project view (PLAN-0.4.0 M3.7 / M3.8) ──
// List of projects → project detail (workspace, sandbox policy, its
// conversations). Creating a conversation here binds it to the project; the
// main chat area then runs it under the project's workspace + sandbox.

import React, { useEffect, useState } from 'react'
import { Button, Card, Tag, Tooltip, App as AntdApp } from 'antd'
import { PlusOutlined, FolderOpenOutlined, DeleteOutlined, ArrowLeftOutlined, EditOutlined, SettingOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { useNavigationStore } from '../../stores/navigationStore'
import { useProjectStore } from '../../stores/projectStore'
import type { Project } from '../../../../shared/types/project'
import type { ProjectSandboxPolicy } from '../../../../shared/sandbox/policy'
import { ProjectDrawer, SandboxControls, FS_OPTIONS, NETWORK_OPTIONS, APPROVAL_OPTIONS } from './ProjectDrawer'
import type { ConversationListItem } from '../../types/conversation'

export interface ProjectViewProps {
  conversations: ConversationListItem[]
  onSelectConversation: (key: string) => void
  /** Create a conversation bound to this project and switch to the chat view. */
  onCreateConversation: (projectId: string) => void
}

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

export default function ProjectView({ conversations, onSelectConversation, onCreateConversation }: ProjectViewProps): React.ReactElement {
  const { t } = useTranslation()
  const { modal } = AntdApp.useApp()
  const view = useNavigationStore((s) => s.view)
  const navigate = useNavigationStore((s) => s.navigate)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editing, setEditing] = useState<Project | null>(null)
  const [hardIsolationSupported, setHardIsolationSupported] = useState<boolean | null>(null)

  // Which project's detail is open lives in the navigation store, not local
  // state: the sidebar's project list deep-links straight into a project, and
  // the open project survives leaving the view and coming back.
  const detailId = view.kind === 'project' ? (view.projectId ?? null) : null
  const openDetail = (id: string | null): void => {
    navigate(id ? { kind: 'project', projectId: id } : { kind: 'project' })
  }

  // Projects come from the shared store, so sidebar/welcome stay in sync with
  // edits made here.
  const projects = useProjectStore((s) => s.projects)
  const reload = useProjectStore((s) => s.reload)

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
        openDetail(null)
        void reload()
      },
    })
  }

  // ── Detail ──
  if (detail) {
    return (
      <div style={{ height: '100%', overflow: 'auto', padding: 24, background: '#fff' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => openDetail(null)} />
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
