// ── Sidebar project list ──
// The 项目 tab of the sidebar's history area: conversations grouped per created
// project, the group header showing the project's name (the workspace dir it
// points to is unrelated to the name and shown as the header's tooltip).
// Clicking a header collapses/expands that group's conversation list (the
// former project center page is gone; creating is the welcome page's picker,
// deletion lives in the group header's hover actions). Headers are drag
// sources: dropping one commits the visual order to `projects.sort_order` and
// flips the sort mode to 'manual', so the arrangement sticks. Conversation rows
// are the shared ConversationRows, so
// they look and behave exactly like the 对话 tab's (relative time, task-status
// light, pin / rename / delete). Pre-0.4.0 conversations (the synthesized
// default project) are not listed here — they have no workspace of their own.

import React, { useEffect, useRef, useState } from 'react'
import { App as AntdApp, Button, Tooltip } from 'antd'
import { DeleteOutlined, EditOutlined, FolderOutlined, PlusOutlined, RightOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { notify } from '../../utils/notify'
import { useProjectStore } from '../../stores/projectStore'
import ConversationRows from './ConversationRows'
import { sortProjectGroups } from './project-sort'
import { DEFAULT_PROJECT_ID } from '../../../../shared/types/project'
import type { Project, ProjectSortMode } from '../../../../shared/types/project'
import type { ConversationListItem } from '../../types/conversation'

interface ProjectSidebarListProps {
  conversations: ConversationListItem[]
  activeKey: string | undefined
  activeLoopConvIds?: string[]
  retryingConvIds?: string[]
  /** Group order — the AppLayout dropdown writes it to settings.projectSortMode. */
  sortMode?: ProjectSortMode
  /** A drop committed a new visual order — AppLayout flips
   *  settings.projectSortMode to 'manual' so the arrangement is what shows. */
  onManualOrder?: () => void
  /** Start a new task bound to the project (AppLayout's onCreateProjectConversation). */
  onCreateTask?: (projectId: string) => void
  /** Open the project's edit modal (AppLayout owns the ProjectModal). */
  onEditProject?: (project: Project) => void
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
  sortMode = 'created',
  onManualOrder,
  onCreateTask,
  onEditProject,
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
  // HTML5 drag state: which header is being dragged, and where it would land.
  // The half-of-the-row the pointer is over picks before/after; the indicator
  // is an inset box-shadow so the insertion line never shifts the row 2px.
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<{ id: string; after: boolean } | null>(null)
  const dragIdRef = useRef<string | null>(null)

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

  // ── drag-to-reorder ──
  // The order committed is the CURRENT visual order (whatever sort mode
  // produced it) with the dragged row moved — so dragging inside a 'name'
  // sort freezes that order as the manual one, which is what "put this one
  // here" means. Order matters: the DB write first, then the mode flip, then
  // the store reload re-reads the persisted order.
  const handleDrop = async (): Promise<void> => {
    const dragged = dragIdRef.current
    const target = dropAt
    setDragId(null)
    setDropAt(null)
    dragIdRef.current = null
    if (!dragged || !target || dragged === target.id) return
    const ids = sorted.map((g) => g.project.id)
    const from = ids.indexOf(dragged)
    let insertAt = ids.indexOf(target.id)
    if (from < 0 || insertAt < 0) return
    ids.splice(from, 1)
    // After the splice the target's own index shifts when it sat BELOW the
    // dragged row; recompute rather than reuse the pre-splice one.
    insertAt = ids.indexOf(target.id) + (target.after ? 1 : 0)
    ids.splice(insertAt, 0, dragged)
    try {
      await window.electronAPI.projectReorder(ids)
      onManualOrder?.()
      await reload()
    } catch (err) {
      notify.error(err instanceof Error ? err.message : String(err))
    }
  }
  const handleDragOver = (e: React.DragEvent, projectId: string): void => {
    if (!dragIdRef.current || dragIdRef.current === projectId) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = e.currentTarget.getBoundingClientRect()
    const after = e.clientY > rect.top + rect.height / 2
    setDropAt((prev) => (prev && prev.id === projectId && prev.after === after ? prev : { id: projectId, after }))
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

  const sorted = sortProjectGroups(
    projects
      .filter((p) => p.id !== DEFAULT_PROJECT_ID)
      .map((project) => ({
        project,
        conversations: conversations.filter((c) => c.projectId === project.id)
      })),
    sortMode
  )

  if (sorted.length === 0) {
    return (
      <div style={{ padding: '16px 0', color: 'var(--pm-text-muted)', fontSize: 12, textAlign: 'center' }}>
        {t('appLayout.noProjects')}
      </div>
    )
  }

  return (
    <div style={{ padding: '2px 8px 8px' }}>
      {sorted.map(({ project, conversations: convs }, idx) => {
        const collapsed = collapsedIds.has(project.id)
        return (
          <div key={project.id}>
            {/* 项目行的上下边距：组间留白是 marginTop 与上一组末行 2px
                marginBottom 的折叠（取 max，不叠加），首组头不加——列表起点
                须与对话 Tab 的 2px wrapper padding 对齐，切换 Tab 不跳动。 */}
            <div
              data-project-header={project.id}
              onClick={() => toggleCollapse(project.id)}
              title={project.workspaceDir}
              draggable
              onDragStart={(e) => {
                dragIdRef.current = project.id
                setDragId(project.id)
                e.dataTransfer.effectAllowed = 'move'
                // Firefox requires data to be set for a drag to start at all;
                // Electron/Chromium starts regardless, the payload is just
                // never read back — the ref above is the source of truth.
                e.dataTransfer.setData('text/plain', project.id)
              }}
              onDragEnd={() => { dragIdRef.current = null; setDragId(null); setDropAt(null) }}
              onDragOver={(e) => handleDragOver(e, project.id)}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                  setDropAt((prev) => (prev?.id === project.id ? null : prev))
                }
              }}
              onDrop={(e) => { e.preventDefault(); void handleDrop() }}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '6px 8px', margin: idx === 0 ? '0 0 2px' : '8px 0 2px', borderRadius: 6, cursor: 'pointer',
                fontSize: 12, fontWeight: 600, color: 'var(--pm-text-muted)', userSelect: 'none',
                lineHeight: '20px',
                opacity: dragId === project.id ? 0.4 : undefined,
                boxShadow: dropAt?.id === project.id
                  ? `inset 0 ${dropAt?.after ? '-' : ''}2px 0 var(--pm-link)`
                  : undefined
              }}
              onMouseEnter={(e) => { setHoveredId(project.id); e.currentTarget.style.background = 'var(--pm-hover-weak)' }}
              onMouseLeave={(e) => { setHoveredId(null); e.currentTarget.style.background = 'transparent' }}
            >
              <RightOutlined
                style={{
                  fontSize: 10, color: 'var(--pm-text-faint)', flexShrink: 0,
                  transition: 'transform 0.15s',
                  transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)'
                }}
              />
              <FolderOutlined style={{ fontSize: 13, color: 'var(--pm-text-muted)', flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {project.name}
              </span>
              {/* Hover: the row actions (新建任务 / 编辑 / 删除项目). The cluster
                  stops propagation so the row click stays collapse-only. */}
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
                  <Tooltip title={t('appLayout.editProject')}>
                    <Button
                      type="text"
                      className="project-row-action"
                      icon={<EditOutlined style={{ fontSize: 13 }} />}
                      onClick={() => onEditProject?.(project)}
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
              <div style={{ padding: '2px 8px 6px 24px', color: 'var(--pm-text-faint)', fontSize: 12 }}>
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
          color: var(--pm-text-muted) !important;
        }
        .project-row-action:hover {
          color: var(--pm-ink) !important;
          background: var(--pm-hover) !important;
        }
        .project-row-action:disabled {
          color: var(--pm-text-disabled) !important;
        }
        .project-row-action-danger:hover {
          /* Grey, not red: destructive actions stay neutral (matches the
             Button.colorError grey in buildAntdTheme). */
          color: var(--pm-text-secondary) !important;
        }
      `}</style>
    </div>
  )
}

export default ProjectSidebarList
