// ── Sidebar project list ──
// The 项目 tab of the sidebar's history area: conversations grouped per created
// project, the group header named after the project workspace's folder.
// Clicking a header opens the project's detail; clicking a row opens that
// conversation. Pre-0.4.0 conversations (the synthesized default project) are
// not listed here — they have no workspace of their own.

import React, { useEffect, useState } from 'react'
import { FolderOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { DEFAULT_PROJECT_ID, type Project } from '../../../../shared/types/project'
import type { ConversationListItem } from '../../types/conversation'

interface ProjectSidebarListProps {
  conversations: ConversationListItem[]
  onOpenProject: (projectId: string) => void
  onOpenConversation: (key: string) => void
}

/** Last path segment of a workspace dir, whichever separator the platform uses. */
function folderName(workspaceDir: string): string {
  return workspaceDir.split(/[\\/]/).filter(Boolean).pop() ?? workspaceDir
}

function ProjectSidebarList({ conversations, onOpenProject, onOpenConversation }: ProjectSidebarListProps): React.ReactElement {
  const { t } = useTranslation()
  const [projects, setProjects] = useState<Project[]>([])

  // Mounts only while the 项目 tab is active, so every tab switch reloads
  // without needing a refresh channel from ProjectView's create/delete.
  useEffect(() => {
    window.electronAPI.projectList?.()
      .then(setProjects)
      .catch(() => {})
  }, [])

  const groups = projects
    .filter((p) => p.id !== DEFAULT_PROJECT_ID)
    .map((project) => ({
      project,
      folder: folderName(project.workspaceDir),
      conversations: conversations
        .filter((c) => c.projectId === project.id)
        .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
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
      {groups.map(({ project, folder, conversations: convs }) => (
        <div key={project.id}>
          <div
            onClick={() => onOpenProject(project.id)}
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
              {folder}
            </span>
            <span style={{ color: '#bbb', fontSize: 11, flexShrink: 0 }}>{convs.length}</span>
          </div>
          {convs.length === 0 ? (
            <div style={{ padding: '2px 8px 6px 30px', color: '#bbb', fontSize: 12 }}>
              {t('appLayout.noProjectConversations')}
            </div>
          ) : (
            convs.map((conv) => (
              <div
                key={conv.key}
                onClick={() => onOpenConversation(conv.key)}
                style={{
                  padding: '6px 8px 6px 30px', borderRadius: 6, cursor: 'pointer',
                  fontSize: 13, color: '#444', userSelect: 'none',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(0, 0, 0, 0.05)' }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                title={conv.label}
              >
                {conv.label}
              </div>
            ))
          )}
        </div>
      ))}
    </div>
  )
}

export default ProjectSidebarList
