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
import { CLOCK_TICK_MS, describeRelativeTimeText } from '../../utils/relative-time'
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

/** Card box: the face carries two lines (name + meta) and the grid row is sized
 *  by the tallest card, so any slack here is spent by every card in the row.
 *  Measured under the app's metrics the two lines want ~71px, which is what the
 *  floor rounds to — and it is a *border-box* floor, the ambient box model here
 *  being content-box, where 72 would silently mean a 98px card. The 20px side
 *  padding stays put: it is shared with the band's cards above, and the two
 *  grids read as one column. */
const CARD_PADDING = '14px 20px 12px'
/** Space between the two lines — the only space between them, since the floor
 *  above leaves no slack for the flex column to distribute. */
const CARD_GAP = 4
const CARD_MIN_HEIGHT = 72

/** The card's hidden second line — folder icon + full workspace path — shown on
 *  hover. antd portals it, so the reveal neither reflows the grid nor covers
 *  the meta row's own click target (an in-card overlay would do both). */
function WorkspacePath({ path }: { path: string }): React.ReactElement {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'flex-start', gap: 6 }}>
      <FolderOutlined style={{ fontSize: 12, lineHeight: '18px', opacity: 0.7 }} />
      <code style={{ fontSize: 12, lineHeight: '18px', wordBreak: 'break-all' }}>{path}</code>
    </span>
  )
}

/** The card's second line, read as a chat line: "1天前：你好" — the time the
 *  project was last touched, then whatever was last said in it. The time is
 *  pinned so only the quote ellipsizes, and the line itself is the click
 *  target (no pill: it is a log line, not a button). */
function MetaLine({
  time,
  text,
  hint,
  onOpen,
  onHover,
}: {
  /** Relative stamp, or null when the conversation carries no timestamp. */
  time: string | null
  /** Last user message, falling back to the conversation title. */
  text: string | undefined
  hint: string
  onOpen: () => void
  onHover: (hovered: boolean) => void
}): React.ReactElement | null {
  if (!text) return null
  return (
    <Tooltip title={hint}>
      <span
        onClick={(e) => {
          e.stopPropagation()
          onOpen()
        }}
        style={{ display: 'inline-flex', alignItems: 'baseline', minWidth: 0, fontSize: 12, color: '#888', cursor: 'pointer' }}
        onMouseEnter={(e) => {
          onHover(true)
          e.currentTarget.style.color = '#333'
        }}
        onMouseLeave={(e) => {
          onHover(false)
          e.currentTarget.style.color = '#888'
        }}
      >
        {time && <span style={{ flexShrink: 0, color: '#bbb' }}>{time}：</span>}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{text}</span>
      </span>
    </Tooltip>
  )
}

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
  // The cards' meta line is a relative time, so the grid holds the clock all
  // such lines are rendered against — same tick as the sidebar and the band.
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
    return () => clearInterval(timer)
  }, [])

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
                now={now}
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
                  padding: CARD_PADDING,
                  boxSizing: 'border-box',
                  cursor: 'pointer',
                  userSelect: 'none',
                  textAlign: 'left',
                  minHeight: CARD_MIN_HEIGHT,
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
 * One project card: the project name over its latest conversation, read as a
 * chat line — "1天前：你好". Clicking the card targets the project; a gradient
 * wash of the project's name-hashed color marks the selection without shifting
 * layout. The workspace path is not on the face — long, rarely read, and it
 * cost a whole row — it rides the hover tooltip instead.
 */
function ProjectCard({
  project,
  conversations,
  now,
  selected,
  onSelect,
  onOpenConversation,
  cardRef,
}: {
  project: Project
  conversations: ConversationListItem[]
  /** Clock the meta line's relative time is rendered against. */
  now: number
  selected: boolean
  onSelect: () => void
  onOpenConversation: (key: string) => void
  /** Attached only while selected — lets the parent scroll the card into view. */
  cardRef?: React.Ref<HTMLDivElement>
}): React.ReactElement {
  const { t } = useTranslation()
  const inProject = conversations.filter((c) => c.projectId === project.id)
  const latest = inProject.slice().sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))[0]
  const latestKey = latest?.key

  // The meta line quotes the conversation's last user message, which the list
  // item does not carry — one lookup per card, falling back to the title while
  // it is in flight (and for conversations nothing was ever said in).
  const [quote, setQuote] = useState<string | null>(null)
  useEffect(() => {
    if (!latestKey) return
    let cancelled = false
    window.electronAPI
      .getConversationLastUserMessage(latestKey)
      .then((text) => {
        if (!cancelled) setQuote(text)
      })
      .catch(() => {
        /* the titles still say something useful */
      })
    return () => {
      cancelled = true
    }
  }, [latestKey])

  // Two tooltips live on this card — the workspace path (whole card) and the
  // latest-conversation hint (the meta line). The pointer is only ever really
  // on one of them, so the meta line suppresses the path; otherwise the card's
  // own tooltip pops up behind the one you are aiming at.
  const [onMeta, setOnMeta] = useState(false)

  // Identity color: hue hashed from the project name — stable per project,
  // spread across the wheel so neighbors rarely collide.
  const hue = stringToHue(project.name)
  const accent = hsvToCss(hue, ACCENT_S, ACCENT_V)

  const timeText = describeRelativeTimeText(latest?.updatedAt, now, t)
  const metaText = quote ?? latest?.label

  return (
    <Tooltip
      title={onMeta ? null : <WorkspacePath path={project.workspaceDir} />}
      placement="bottom"
      mouseEnterDelay={0.25}
      styles={{ root: { maxWidth: 420 } }}
    >
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
          padding: CARD_PADDING,
          boxSizing: 'border-box',
          cursor: 'pointer',
          userSelect: 'none',
          textAlign: 'left',
          display: 'flex',
          flexDirection: 'column',
          gap: CARD_GAP,
          minHeight: CARD_MIN_HEIGHT,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = selected ? selectedWash(hue, WASH_HOVER) : CARD_BG_HOVER
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = selected ? selectedWash(hue, WASH) : CARD_BG
        }}
      >
        {/* lineHeight pins the row so a card with an icon is the same height as
            one without — otherwise the emoji's taller line box pushes that
            card's meta line (and everything under it) 4px down. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, lineHeight: '22px' }}>
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
        {/* Absent for a project nothing was said in yet — the gap between the
            two lines must not survive it as a stray 4px. */}
        {latest && (
          <MetaLine time={timeText} text={metaText} onOpen={() => onOpenConversation(latest.key)} onHover={setOnMeta} hint={t('welcome.openLatest')} />
        )}
      </div>
    </Tooltip>
  )
}
