// ── Sidebar project list ──
// The 项目 tab of the sidebar's history area: conversations grouped per created
// project, the group header showing the project's name (the workspace dir it
// points to is unrelated to the name and shown as the header's tooltip).
// Clicking a header collapses/expands that group's conversation list; the
// project detail itself lives in the project center (sidebar 管理 → 项目),
// not behind this row. Conversation rows are the shared ConversationRows, so
// they look and behave exactly like the 对话 tab's (relative time, task-status
// light, pin / rename / delete). Pre-0.4.0 conversations (the synthesized
// default project) are not listed here — they have no workspace of their own.

import React, { useEffect, useState } from 'react'
import { App as AntdApp, Button, Tooltip } from 'antd'
import { DeleteOutlined, FolderOutlined, PlusOutlined, RightOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { useProjectStore } from '../../stores/projectStore'
import ConversationRows from './ConversationRows'
import { DEFAULT_PROJECT_ID } from '../../../../shared/types/project'
import type { Project } from '../../../../shared/types/project'
import type { ConversationListItem } from '../../types/conversation'

interface ProjectSidebarListProps {
  conversations: ConversationListItem[]
  activeKey: string | undefined
  activeLoopConvIds?: string[]
  retryingConvIds?: string[]
  /** Start a new task bound to the project (AppLayout's onCreateProjectConversation). */
  onCreateTask?: (projectId: string) => void
  onOpenConversation: (key: string) => void
  onDelete: (key: string) => void
  onRename: (key: string, newLabel: string) => void
  onTogglePin: (key: string, pinned: boolean) => void
}

function ProjectSidebarList({
  conversations,
  activeKey,
  activeLoopConvIds,
  retryingConvIds,
  onCreateTask,
  onOpenConversation,
  onDelete,
  onRename,
  onTogglePin
}: ProjectSidebarListProps): React.ReactElement {
  const { t } = useTranslation()
  const { modal } = AntdApp.useApp()
  const projects = useProjectStore((s) => s.projects)
  const reload = useProjectStore((s) => s.reload)
  // Collapsed group headers — a Set so toggling is O(1) and unknown ids read
  // as expanded. Local state: a fresh mount (each tab switch) starts expanded.
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set())
  // The hovered group header — its hover actions swap in for the conv count.
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  // Mounts only while the 项目 tab is active, so every tab switch reloads
  // through the shared store (which also carries renames made elsewhere).
  useEffect(() => { void reload() }, [reload])

  // Toggle a group's conversation list; unknown ids read as expanded.
  const toggleCollapse = (projectId: string): void => {
    setCollapsedIds((prev) => {
      const next = new Set(prev)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      return next
    })
  }

  // Mirrors ProjectView's delete flow: confirm, then the DB cascade removes the
  // project's conversations — each onDelete call drops them from the in-memory
  // list (and disposes engines) so the sidebar never shows ghosts.
  const removeProject = (project: Project, convs: ConversationListItem[]): void => {
    modal.confirm({
      title: `确定要删除「${project.name}」吗？`,
      content: convs.length > 0
        ? `项目内的 ${convs.length} 个会话会一并删除，删除后将无法找回，请谨慎操作。`
        : '这是一个空项目，删除后将无法恢复。',
      okText: '确认删除',
      okButtonProps: { danger: true },
      cancelText: '再想想',
      onOk: async () => {
        await window.electronAPI.projectDelete(project.id)
        convs.forEach((c) => onDelete(c.key))
        void reload()
      },
    })
  }

  const groups = projects
    .filter((p) => p.id !== DEFAULT_PROJECT_ID)
    .map((project) => ({
      project,
      conversations: conversations.filter((c) => c.projectId === project.id)
    }))

  if (groups.length === 0) {
    return (
      <div style={{ padding: '16px 0', color: '#999', fontSize: 12, textAlign: 'center' }}>
        {t('appLayout.noProjects')}
      </div>
    )
  }

  return (
    <div style={{ padding: '2px 8px 8px' }}>
      {groups.map(({ project, conversations: convs }) => {
        const collapsed = collapsedIds.has(project.id)
        return (
          <div key={project.id}>
            <div
              onClick={() => toggleCollapse(project.id)}
              title={project.workspaceDir}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '5px 8px', marginBottom: 2, borderRadius: 6, cursor: 'pointer',
                fontSize: 14, fontWeight: 600, color: '#444', userSelect: 'none',
                lineHeight: '20px'
              }}
              onMouseEnter={(e) => { setHoveredId(project.id); e.currentTarget.style.background = 'rgba(0, 0, 0, 0.05)' }}
              onMouseLeave={(e) => { setHoveredId(null); e.currentTarget.style.background = 'transparent' }}
            >
              <RightOutlined
                style={{
                  fontSize: 10, color: '#bbb', flexShrink: 0,
                  transition: 'transform 0.15s',
                  transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)'
                }}
              />
              <FolderOutlined style={{ fontSize: 13, color: '#999', flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {project.name}
              </span>
              {/* Hover: the row actions (新建任务 / 删除项目). The cluster stops
                  propagation so the row click stays collapse-only. */}
              {hoveredId === project.id && (
                <span
                  onClick={(e) => e.stopPropagation()}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 2, flexShrink: 0 }}
                >
                  <Tooltip title={t('menu.newTask')}>
                    <Button
                      type="text"
                      className="project-row-action"
                      icon={<PlusOutlined style={{ fontSize: 13 }} />}
                      disabled={!onCreateTask}
                      onClick={() => onCreateTask?.(project.id)}
                    />
                  </Tooltip>
                  <Tooltip title={t('appLayout.deleteProject')}>
                    <Button
                      type="text"
                      className="project-row-action project-row-action-danger"
                      icon={<DeleteOutlined style={{ fontSize: 13 }} />}
                      onClick={() => removeProject(project, convs)}
                    />
                  </Tooltip>
                </span>
              )}
            </div>
            {!collapsed && (convs.length === 0 ? (
              <div style={{ padding: '2px 8px 6px 24px', color: '#bbb', fontSize: 12 }}>
                {t('appLayout.noProjectConversations')}
              </div>
            ) : (
              <ConversationRows
                conversations={convs}
                activeKey={activeKey}
                activeLoopConvIds={activeLoopConvIds}
                retryingConvIds={retryingConvIds}
                onSelect={onOpenConversation}
                onDelete={onDelete}
                onRename={onRename}
                onTogglePin={onTogglePin}
              />
            ))}
          </div>
        )
      })}
      <style>{`
        /* Project-row hover actions: icon-only, sized to the row's 20px line box
           so hovering never grows the row. */
        .project-row-action {
          background: transparent !important;
          border: none !important;
          box-shadow: none !important;
          width: 20px !important;
          height: 20px !important;
          padding: 0 !important;
          display: inline-flex !important;
          align-items: center !important;
          justify-content: center !important;
          color: #999 !important;
        }
        .project-row-action:hover {
          color: #000 !important;
          background: rgba(0, 0, 0, 0.06) !important;
        }
        .project-row-action:disabled {
          color: #ccc !important;
        }
        .project-row-action-danger:hover {
          color: #cf1322 !important;
        }
      `}</style>
    </div>
  )
}

export default ProjectSidebarList
