// ── Sidebar project list ──
// The 项目 tab of the sidebar's history area: conversations grouped per created
// project, the group header showing the project's name (the workspace dir it
// points to is unrelated to the name and shown as the header's tooltip).
// Clicking a header opens the project's detail; clicking a row opens that
// conversation. Conversation rows are the shared ConversationRows, so they
// look and behave exactly like the 对话 tab's (relative time, task-status
// light, pin / rename / delete). Pre-0.4.0 conversations (the synthesized
// default project) are not listed here — they have no workspace of their own.

import React, { useEffect } from 'react'
import { FolderOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { useProjectStore } from '../../stores/projectStore'
import ConversationRows from './ConversationRows'
import { DEFAULT_PROJECT_ID } from '../../../../shared/types/project'
import type { ConversationListItem } from '../../types/conversation'

interface ProjectSidebarListProps {
  conversations: ConversationListItem[]
  activeKey: string | undefined
  activeLoopConvIds?: string[]
  retryingConvIds?: string[]
  onOpenProject: (projectId: string) => void
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
  onOpenProject,
  onOpenConversation,
  onDelete,
  onRename,
  onTogglePin
}: ProjectSidebarListProps): React.ReactElement {
  const { t } = useTranslation()
  const projects = useProjectStore((s) => s.projects)
  const reload = useProjectStore((s) => s.reload)

  // Mounts only while the 项目 tab is active, so every tab switch reloads
  // through the shared store (which also carries renames made elsewhere).
  useEffect(() => { void reload() }, [reload])

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
      {groups.map(({ project, conversations: convs }) => (
        <div key={project.id}>
          <div
            onClick={() => onOpenProject(project.id)}
            title={project.workspaceDir}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '7px 8px', borderRadius: 6, cursor: 'pointer',
              fontSize: 12, fontWeight: 600, color: '#444', userSelect: 'none'
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(0, 0, 0, 0.05)' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
          >
            <FolderOutlined style={{ fontSize: 13, color: '#999', flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {project.name}
            </span>
            <span style={{ color: '#bbb', fontSize: 11, flexShrink: 0 }}>{convs.length}</span>
          </div>
          {convs.length === 0 ? (
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
          )}
        </div>
      ))}
    </div>
  )
}

export default ProjectSidebarList
