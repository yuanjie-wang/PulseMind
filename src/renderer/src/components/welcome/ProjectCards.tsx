// ── Welcome quick entry: project cards (project mode) ──
// A fixed heading over the cards; clicking a card targets that project for the
// conversation started by the next message (still nothing is created until it
// is sent, M8.4); the chip in the meta row jumps straight to the project's
// latest conversation. Visual language mirrors the chat-mode cards: soft
// filled surfaces, one 952px column.

import React, { useEffect, useRef, useState } from 'react'
import { Tooltip } from 'antd'
import { ArrowRightOutlined, CheckOutlined, FolderOutlined, PlusOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { useProjectStore } from '../../stores/projectStore'
import { useNewTaskStore } from '../../stores/newTaskStore'
import { ProjectModal } from '../project/ProjectModal'
import { stringToHue, hsvToCss } from '../../utils/hash-color'
import { DEFAULT_PROJECT_ID } from '../../../../shared/types/project'
import type { Project } from '../../../../shared/types/project'
import type { ConversationListItem } from '../../types/conversation'

/** Soft surface shared with the chat-mode cards. */
const CARD_BG = '#f7f7f8'
const CARD_BG_HOVER = '#efeff1'
/** Selection wears the project's identity color (hue hashed from its name)
 *  as a diagonal wash, chip-style: near-white at one corner deepening into
 *  the hue at the other — livelier than a flat fill. Hover shifts both stops
 *  up; the check icon takes the hue at full strength. */
const WASH = { from: 0.03, to: 0.2 }
const WASH_HOVER = { from: 0.08, to: 0.28 }
const ACCENT_S = 0.85
const ACCENT_V = 0.9

function selectedWash(hue: number, { from, to }: { from: number; to: number }): string {
  return `linear-gradient(135deg, ${hsvToCss(hue, ACCENT_S, ACCENT_V, from)}, ${hsvToCss(hue, ACCENT_S, ACCENT_V, to)})`
}
/** The cards' column — the same 952px content column WelcomeContent centers
 *  its band on (its 12px side gutters stay clear for the scrollbar). */
const CARDS_COLUMN_WIDTH = 952

export function ProjectCards({
  conversations,
  onOpenConversation,
}: {
  conversations: ConversationListItem[]
  onOpenConversation: (key: string) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const projects = useProjectStore((s) => s.projects)
  const reload = useProjectStore((s) => s.reload)
  const projectId = useNewTaskStore((s) => s.projectId)
  const setProjectId = useNewTaskStore((s) => s.setProjectId)
  const [modalOpen, setModalOpen] = useState(false)

  useEffect(() => {
    void reload()
  }, [reload])

  // A selection made elsewhere (e.g. the sidebar's project-row 新建任务) can
  // leave the selected card outside the visible band — reveal it, fully.
  // block:'nearest' is a no-op when the card is already on screen, so a
  // hand-clicked selection never scrolls.
  const selectedCardRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    selectedCardRef.current?.scrollIntoView({ block: 'nearest' })
  }, [projectId])

  const userProjects = projects.filter((p) => p.id !== DEFAULT_PROJECT_ID)

  return (
    <div style={{ width: '100%', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {/* Heading sits OUTSIDE the scroll region below, so the scrollbar starts
          at the cards instead of spanning this row. It follows the cards'
          952px column so the 新建项目 pill keeps lining up with their edge. */}
      <div style={{ flexShrink: 0 }}>
        <div
          style={{
            maxWidth: CARDS_COLUMN_WIDTH,
            margin: '0 auto',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '8px 0 10px',
            fontSize: 15,
            fontWeight: 600,
            color: '#333',
          }}
        >
          {t('welcome.pickProjectTitle')}
          <ArrowRightOutlined style={{ fontSize: 13, color: '#999' }} />
          {/* Trailing action of the row: the column's right edge is the flex
            content edge, so the pill lines up with the cards below it. */}
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            style={{
              marginLeft: 'auto',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              padding: '5px 10px',
              borderRadius: 999,
              fontSize: 13,
              fontWeight: 500,
              color: '#888',
              transition: 'background 0.15s, color 0.15s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = CARD_BG
              e.currentTarget.style.color = '#333'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
              e.currentTarget.style.color = '#888'
            }}
          >
            <PlusOutlined style={{ fontSize: 12 }} />
            {t('welcome.newProject')}
          </button>
        </div>
      </div>
      {/* Scroll region: only the cards — heading row above stays fixed. */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
        <div style={{ maxWidth: CARDS_COLUMN_WIDTH, margin: '0 auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 14 }}>
            {userProjects.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                conversations={conversations}
                selected={projectId === project.id}
                onSelect={() => setProjectId(project.id)}
                onOpenConversation={onOpenConversation}
                cardRef={projectId === project.id ? selectedCardRef : undefined}
              />
            ))}

            {userProjects.length === 0 && (
              <div style={{ gridColumn: '1 / -1', background: CARD_BG, borderRadius: 16, padding: '18px 20px 16px' }}>
                <div style={{ fontSize: 16, fontWeight: 600, color: '#666' }}>{t('welcome.noProjects')}</div>
                <div style={{ marginTop: 6, fontSize: 13, lineHeight: '19px', color: '#999' }}>{t('welcome.noProjectsHint')}</div>
              </div>
            )}

            {userProjects.length > 0 && (
              <div
                onClick={() => setModalOpen(true)}
                style={{
                  border: '1px dashed #c8c8cc',
                  borderRadius: 16,
                  padding: '18px 20px 16px',
                  cursor: 'pointer',
                  userSelect: 'none',
                  textAlign: 'left',
                  minHeight: 96,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  fontSize: 14,
                  color: '#888',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = '#666'
                  e.currentTarget.style.color = '#444'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = '#c8c8cc'
                  e.currentTarget.style.color = '#888'
                }}
              >
                <PlusOutlined />
                {t('welcome.newProject')}
              </div>
            )}
          </div>
        </div>
      </div>
      <ProjectModal
        open={modalOpen}
        editing={null}
        onClose={() => setModalOpen(false)}
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
 * project; a gradient wash of the project's name-hashed color marks the
 * selection without shifting layout.
 */
function ProjectCard({
  project,
  conversations,
  selected,
  onSelect,
  onOpenConversation,
  cardRef,
}: {
  project: Project
  conversations: ConversationListItem[]
  selected: boolean
  onSelect: () => void
  onOpenConversation: (key: string) => void
  /** Attached only while selected — lets the parent scroll the card into view. */
  cardRef?: React.Ref<HTMLDivElement>
}): React.ReactElement {
  const { t } = useTranslation()
  const inProject = conversations.filter((c) => c.projectId === project.id)
  const latest = inProject.slice().sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))[0]

  // Identity color: hue hashed from the project name — stable per project,
  // spread across the wheel so neighbors rarely collide.
  const hue = stringToHue(project.name)
  const accent = hsvToCss(hue, ACCENT_S, ACCENT_V)

  return (
    <div
      ref={cardRef}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        onSelect()
      }}
      style={{
        background: selected ? selectedWash(hue, WASH) : CARD_BG,
        borderRadius: 16,
        padding: '18px 20px 16px',
        cursor: 'pointer',
        userSelect: 'none',
        textAlign: 'left',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        minHeight: 118,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = selected ? selectedWash(hue, WASH_HOVER) : CARD_BG_HOVER
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = selected ? selectedWash(hue, WASH) : CARD_BG
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {project.icon && <span style={{ fontSize: 16, lineHeight: '22px' }}>{project.icon}</span>}
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 16,
            fontWeight: 600,
            color: '#333',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {project.name}
        </span>
        {selected && <CheckOutlined style={{ fontSize: 14, color: accent, flexShrink: 0 }} />}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <FolderOutlined style={{ fontSize: 12, color: '#bbb', flexShrink: 0 }} />
        {/* Head-truncated: direction:rtl keeps the path's TAIL visible and puts
            the ellipsis at the start; textAlign:left re-anchors short paths to
            the icon. Title carries the full path — the only tooltip on a card. */}
        <code
          title={project.workspaceDir}
          style={{
            fontSize: 12,
            color: '#999',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            direction: 'rtl',
            textAlign: 'left',
          }}
        >
          {project.workspaceDir}
        </code>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 'auto', fontSize: 12, color: '#aaa' }}>
        {latest && (
          <Tooltip title={t('welcome.openLatest')}>
            <span
              onClick={(e) => {
                e.stopPropagation()
                onOpenConversation(latest.key)
              }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                minWidth: 0,
                fontSize: 12,
                color: '#888',
                cursor: 'pointer',
                padding: '2px 8px',
                borderRadius: 999,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(0, 0, 0, 0.07)'
                e.currentTarget.style.color = '#333'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent'
                e.currentTarget.style.color = '#888'
              }}
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
