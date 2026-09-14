// ── Welcome quick entry: project cards (project mode) ──
// A fixed heading over the cards; clicking a card targets that project for the
// conversation started by the next message (still nothing is created until it
// is sent, M8.4); the chip in the meta row jumps straight to the project's
// latest conversation. Visual language mirrors the chat-mode cards: soft
// filled surfaces, one 952px column.

import React, { useEffect, useState } from 'react'
import { Tooltip } from 'antd'
import { ArrowRightOutlined, CheckOutlined, FolderOutlined, PlusOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { useProjectStore } from '../../stores/projectStore'
import { useNewTaskStore } from '../../stores/newTaskStore'
import { ProjectDrawer } from '../project/ProjectDrawer'
import { DEFAULT_PROJECT_ID } from '../../../../shared/types/project'
import type { Project } from '../../../../shared/types/project'
import type { ConversationListItem } from '../../types/conversation'

/** Soft surface shared with the chat-mode cards. */
const CARD_BG = '#f7f7f8'
const CARD_BG_HOVER = '#efeff1'
const SELECTED_RING = 'inset 0 0 0 2px #1a1a1a'

export function ProjectCards({ conversations, onOpenConversation }: {
  conversations: ConversationListItem[]
  onOpenConversation: (key: string) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const projects = useProjectStore((s) => s.projects)
  const reload = useProjectStore((s) => s.reload)
  const projectId = useNewTaskStore((s) => s.projectId)
  const setProjectId = useNewTaskStore((s) => s.setProjectId)
  const [drawerOpen, setDrawerOpen] = useState(false)

  useEffect(() => { void reload() }, [reload])

  const userProjects = projects.filter((p) => p.id !== DEFAULT_PROJECT_ID)

  return (
    <div style={{ width: '100%' }}>
      {/* Sticky heading: pinned to the top of the quick band while the cards
          scroll under it (band bg is the chat area's white). */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 1, background: '#fff',
        display: 'flex', alignItems: 'center', gap: 6,
        margin: '0 -12px', padding: '8px 12px 10px',
        fontSize: 15, fontWeight: 600, color: '#333',
      }}>
        {t('welcome.pickProjectTitle')}
        {/* Trailing action of the row: the column's right edge is the flex
            content edge, so the pill lines up with the cards below it. */}
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          style={{
            marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6,
            border: 'none', background: 'transparent', cursor: 'pointer',
            padding: '5px 10px', borderRadius: 999,
            fontSize: 13, fontWeight: 500, color: '#888',
            transition: 'background 0.15s, color 0.15s',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = CARD_BG; e.currentTarget.style.color = '#333' }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#888' }}
        >
          <PlusOutlined style={{ fontSize: 12 }} />
          {t('welcome.newProject')}
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 14 }}>
        {userProjects.map((project) => (
          <ProjectCard
            key={project.id}
            project={project}
            conversations={conversations}
            selected={projectId === project.id}
            onSelect={() => setProjectId(project.id)}
            onOpenConversation={onOpenConversation}
          />
        ))}

        {userProjects.length === 0 && (
          <div style={{ gridColumn: '1 / -1', background: CARD_BG, borderRadius: 16, padding: '18px 20px 16px' }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: '#666' }}>{t('welcome.noProjects')}</div>
            <div style={{ marginTop: 6, fontSize: 13, lineHeight: '19px', color: '#999' }}>
              {t('welcome.noProjectsHint')}
            </div>
          </div>
        )}

        {userProjects.length > 0 && (
          <div
            onClick={() => setDrawerOpen(true)}
            style={{
              border: '1px dashed #c8c8cc', borderRadius: 16, padding: '18px 20px 16px',
              cursor: 'pointer', userSelect: 'none', textAlign: 'left', minHeight: 96,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              gap: 8, fontSize: 14, color: '#888',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#666'; e.currentTarget.style.color = '#444' }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#c8c8cc'; e.currentTarget.style.color = '#888' }}
          >
            <PlusOutlined />
            {t('welcome.newProject')}
          </div>
        )}
      </div>
      <ProjectDrawer
        open={drawerOpen}
        editing={null}
        onClose={() => setDrawerOpen(false)}
        onSaved={(project) => {
          void reload()
          if (project) setProjectId(project.id)
        }}
      />
    </div>
  )
}

/**
 * One project card: name over workspace path over a meta row (conversation
 * count + a jump to the latest conversation). Clicking the card targets the
 * project; the ring marks the selection without shifting layout.
 */
function ProjectCard({ project, conversations, selected, onSelect, onOpenConversation }: {
  project: Project
  conversations: ConversationListItem[]
  selected: boolean
  onSelect: () => void
  onOpenConversation: (key: string) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const inProject = conversations.filter((c) => c.projectId === project.id)
  const latest = inProject
    .slice()
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))[0]

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        onSelect()
      }}
      title={project.workspaceDir}
      style={{
        background: CARD_BG, borderRadius: 16, padding: '18px 20px 16px',
        cursor: 'pointer', userSelect: 'none', textAlign: 'left',
        display: 'flex', flexDirection: 'column', gap: 8, minHeight: 118,
        boxShadow: selected ? SELECTED_RING : 'none',
        transition: 'background 0.15s',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = CARD_BG_HOVER }}
      onMouseLeave={(e) => { e.currentTarget.style.background = CARD_BG }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {project.icon && <span style={{ fontSize: 16, lineHeight: '22px' }}>{project.icon}</span>}
        <span style={{
          flex: 1, minWidth: 0, fontSize: 16, fontWeight: 600, color: '#333',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {project.name}
        </span>
        {selected && <CheckOutlined style={{ fontSize: 14, color: '#1a1a1a', flexShrink: 0 }} />}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <FolderOutlined style={{ fontSize: 12, color: '#bbb', flexShrink: 0 }} />
        <code style={{ fontSize: 12, color: '#999', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {project.workspaceDir}
        </code>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 'auto', fontSize: 12, color: '#aaa' }}>
        <span style={{ flexShrink: 0 }}>{t('welcome.projectConvCount', { count: inProject.length })}</span>
        {latest && (
          <Tooltip title={t('welcome.openLatest')}>
            <span
              onClick={(e) => { e.stopPropagation(); onOpenConversation(latest.key) }}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0,
                fontSize: 12, color: '#888', cursor: 'pointer',
                padding: '2px 8px', borderRadius: 999,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(0, 0, 0, 0.07)'; e.currentTarget.style.color = '#333' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#888' }}
            >
              <ArrowRightOutlined style={{ fontSize: 10, flexShrink: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{latest.label}</span>
            </span>
          </Tooltip>
        )}
      </div>
    </div>
  )
}
