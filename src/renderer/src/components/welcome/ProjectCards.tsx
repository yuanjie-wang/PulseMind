// ── Welcome quick entry: project cards (project mode) ──
// Two forms, derived purely from newTaskStore.projectId (2026-11-04 两形态
// 裁定): nothing picked = the full picker (heading + card grid, the composer
// is hidden entirely while this form holds); a project picked = one compact
// strip wearing the selected card's wash, hugging the composer that just
// appeared, plus the 试试 prompts. 更换 = setProjectId(null) — back to the
// full picker, pick any card to compress again. No extra state anywhere.
// A fixed heading over the cards; clicking a card targets that project for the
// conversation started by the next message (still nothing is created until it
// is sent, M8.4); the trailing play button in the meta row is the only action
// of its own — it opens the project's latest conversation, or, for a project
// with none to quote, starts the first one (the row then reads 立即开始).
// Visual language mirrors the chat-mode cards: soft filled surfaces, one 952px
// column.
// The 新建项目 card is the grid's LAST cell whenever there is a project to
// list. On an empty page the explanation and the create action are merged into
// ONE full-row card wearing the create card's transparent + dashed recipe, so
// the first run ends on a single actionable card rather than a dead grey panel
// (user request 2026-09-18: 「把【还没有项目】这个卡片和【新建项目】的卡片
// 合并，透明背景、灰色虚线边框，把【还没有项目】改为【立即创建项目】」).

import React, { useEffect, useRef, useState } from 'react'
import { Button, Tooltip } from 'antd'
import { ArrowRightOutlined, CheckOutlined, EditOutlined, FolderOutlined, PlayCircleOutlined, PlusOutlined, SwapOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { StarterPrompts } from './StarterPrompts'
import { useProjectStore, projectHue } from '../../stores/projectStore'
import { useNewTaskStore } from '../../stores/newTaskStore'
import { useWelcomeShake, playWelcomeEnter } from '../../utils/welcome-shake'
import { ProjectModal } from '../project/ProjectModal'
import { CLOCK_TICK_MS, describeRelativeTimeText } from '../../utils/relative-time'
import { hsvToCss } from '../../../../shared/hash-color'
import { DEFAULT_PROJECT_ID } from '../../../../shared/types/project'
import type { Project } from '../../../../shared/types/project'
import type { ConversationListItem } from '../../types/conversation'

/** Soft surface shared with the chat-mode cards. The values ride the theme
 *  sheet (PLAN-dark-mode M3/T1): light is byte-identical to the old literals,
 *  dark lifts the card above the ground instead of below it. */
const CARD_BG = 'var(--pm-card-soft)'
const CARD_BG_HOVER = 'var(--pm-card-soft-hover)'
/** The meta row's action ink — the play button — and the ink of 立即开始, the
 *  prompt that stands in the row's text slot: label and button must read as one
 *  control, so they are one constant rather than two literals that happen to
 *  agree. A quote is darker (QUOTE_INK): it is the user's own words, not a
 *  prompt, and the button is the action on it. */
const ACTION_INK = 'var(--pm-text-muted)'
const ACTION_INK_HOVER = 'var(--pm-text-secondary)'
const QUOTE_INK = 'var(--pm-text-quiet)'
/** The dashed create/empty card's recipe. */
const DASH_BORDER = 'var(--pm-dash-border)'
/** Selection wears the project's identity color (the stored `colorHue`, see
 *  `projectHue`) as a diagonal wash, chip-style: near-white at one corner
 *  deepening into the hue at the other — livelier than a flat fill. Hover
 *  shifts both stops up; the check icon takes the hue at full strength. */
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
 *  project was last touched, then whatever was last said in it. A project with
 *  nothing to quote keeps the same line, text and play button alike, with
 *  立即开始 in the text slot instead: the row is one shape across both states,
 *  and the only thing that changes is what the button means — start this
 *  project's first task rather than reopen a conversation. Pure display either
 *  way: the line itself is a log line, not a button — the trailing play button
 *  is the only click target in it. The line still reports hover so the card
 *  suppresses its workspace-path tooltip while the pointer is aiming at the
 *  button. */
function MetaLine({
  time,
  text,
  prompt,
  playHint,
  onAction,
  onHover,
}: {
  /** Relative stamp, or null when there is no conversation to stamp (or the
   *  conversation carries no timestamp). */
  time: string | null
  /** Last user message, falling back to the conversation title — or 立即开始,
   *  the prompt that stands in for both. */
  text: string
  /** Read `text` as a prompt rather than a quote: nothing was actually said, so
   *  the line is dimmer than a quote — it takes the action ink below, which is
   *  what makes the label and its play button read as one control — and it is
   *  inviting the first message. */
  prompt?: boolean
  /** Tooltip and accessible name of the play button. */
  playHint: string
  onAction: () => void
  onHover: (hovered: boolean) => void
}): React.ReactElement {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        minWidth: 0,
        fontSize: 12,
        color: prompt ? ACTION_INK : QUOTE_INK,
      }}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
    >
      {time && <span style={{ flexShrink: 0, color: 'var(--pm-text-faint)' }}>{time}：</span>}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{text}</span>
      <Tooltip title={playHint}>
        <Button
          type="text"
          size="small"
          aria-label={playHint}
          icon={<PlayCircleOutlined />}
          style={{
            width: 20,
            height: 20,
            minWidth: 20,
            padding: 0,
            marginLeft: 2,
            flexShrink: 0,
            fontSize: 13,
            color: ACTION_INK,
          }}
          // Inline ink beats antd's hover rule, so the darker ink has to be
          // written here too — otherwise the icon never reacts to the pointer.
          onMouseEnter={(e) => {
            e.currentTarget.style.color = ACTION_INK_HOVER
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = ACTION_INK
          }}
          onClick={(e) => {
            e.stopPropagation()
            onAction()
          }}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </Tooltip>
    </span>
  )
}

export function ProjectCards({
  conversations,
  onOpenConversation,
  onStarterSend,
}: {
  conversations: ConversationListItem[]
  onOpenConversation: (key: string) => void
  /** 试试 chips 的发送通道（2026-11-04 裁定：点一下即发送）。缺省 = 整行不渲染。 */
  onStarterSend?: (text: string) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const projects = useProjectStore((s) => s.projects)
  const reload = useProjectStore((s) => s.reload)
  const projectId = useNewTaskStore((s) => s.projectId)
  const setProjectId = useNewTaskStore((s) => s.setProjectId)
  // The picker's half of the 新建任务 guidance shake: project mode with nothing
  // picked owes a card choice, so the whole region — heading row AND cards,
  // this root — wiggles once per click (user ruling 2026-09-23: option 2, the
  // one-line heading alone is too quiet to steer the eye).
  const pickerShakeRef = useRef<HTMLDivElement | null>(null)
  useWelcomeShake('projectPicker', pickerShakeRef)
  const [modalOpen, setModalOpen] = useState(false)
  // The project being edited (a card's hover edit affordance). The same
  // ProjectModal serves create and edit via `editing`.
  const [editTarget, setEditTarget] = useState<Project | null>(null)
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
  const projectStarters = [t('welcome.projectStarter1'), t('welcome.projectStarter2'), t('welcome.projectStarter3')]
  // 压缩形态（2026-11-04 两形态裁定）的主体：当前选中的项目。选中后卡片网格
  // 整组退场，压成一条项目色横条贴住 composer；「更换」= setProjectId(null)
  // 回完整选择形态——形态完全由 projectId 派生，零新增状态。
  const selectedProject = projectId ? projects.find((p) => p.id === projectId) : undefined
  // 陈旧选择自愈：选中的项目在别处被删（项目中心/另一窗口）后 projectId 悬空
  // ——压缩形态没有横条主体可渲染。守卫 loaded：列表在途时 projects 还是空
  // 数组，不判死。
  const loaded = useProjectStore((s) => s.loaded)
  useEffect(() => {
    if (loaded && projectId && !projects.some((p) => p.id === projectId)) setProjectId(null)
  }, [loaded, projectId, projects, setProjectId])

  // 形态切换的一次性入场（2026-11-04 追加）：project id 就是形态 token——变化
  // 即在 picker root 上播 220ms 淡入+位移（选中 = 横条从下方浮入，更换 = 网格
  // 从上方落定）。**挂载首跑刻意不播**：入场是「原地换形」的过渡，不是挂载
  // 动画——新挂载的 picker root 必须静止（从历史列表打开空会话不得自己动，
  // probe-welcome-focus 的宽限窗用例按「无动画」钉住）；root 本身在换形时
  // 不卸载，所以换形仍会播。transform+opacity 不动布局，探针的几何测量在
  // ≥300ms 等待后读到的都是已落定位置。
  const formKey = selectedProject?.id ?? null
  const formMountedRef = useRef(false)
  useEffect(() => {
    if (!formMountedRef.current) {
      formMountedRef.current = true
      return
    }
    playWelcomeEnter(pickerShakeRef.current, formKey === null ? 'above' : 'below')
  }, [formKey])

  return (
    <div
      ref={pickerShakeRef}
      data-welcome-shake="projectPicker"
      style={{ width: '100%', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', justifyContent: selectedProject ? 'flex-end' : undefined }}
    >
      {selectedProject ? (
        <>
          {/* 压缩形态：一条项目色横条（选中卡的 wash 配方）+ 试试 prompts，
              整体贴住下方的输入框（根 justifyContent flex-end）——输入框已
              出现，横条是它的上下文。prompts 点一下即发送（2026-11-04 裁定）。「更换」
              胶囊沿用标题行「新建项目」的配方（透明底、hover 泛起软面）。 */}
          <div style={{ maxWidth: CARDS_COLUMN_WIDTH, width: '100%', margin: '0 auto', flexShrink: 0 }}>
            <div
              data-welcome-project-strip
              style={{
                background: selectedWash(projectHue(selectedProject), WASH),
                borderRadius: 16,
                padding: '12px 16px',
                boxSizing: 'border-box',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
              }}
            >
              {selectedProject.icon && <span style={{ fontSize: 18, lineHeight: '24px', flexShrink: 0 }}>{selectedProject.icon}</span>}
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  textAlign: 'left',
                  fontSize: 16,
                  fontWeight: 600,
                  lineHeight: '24px',
                  color: 'var(--pm-text-strong)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {selectedProject.name}
              </span>
              <button
                type="button"
                onClick={() => setProjectId(null)}
                style={{
                  flexShrink: 0,
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
                  color: 'var(--pm-text-quiet)',
                  transition: 'background 0.15s, color 0.15s',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = CARD_BG
                  e.currentTarget.style.color = 'var(--pm-text-strong)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                  e.currentTarget.style.color = 'var(--pm-text-quiet)'
                }}
              >
                <SwapOutlined style={{ fontSize: 12 }} />
                {t('welcome.changeProject')}
              </button>
            </div>
          </div>
          <div style={{ maxWidth: CARDS_COLUMN_WIDTH, width: '100%', margin: '14px auto 0', flexShrink: 0 }}>
            <StarterPrompts labels={projectStarters} onSend={onStarterSend} />
          </div>
        </>
      ) : (
        <>
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
                color: 'var(--pm-text-strong)',
              }}
            >
              {t('welcome.pickProjectTitle')}
              <ArrowRightOutlined style={{ fontSize: 13, color: 'var(--pm-text-muted)' }} />
              {/* Trailing action of the row: the column's right edge is the flex
            content edge, so the pill lines up with the cards below it. */}
              <button
                type="button"
                onClick={() => {
                  setEditTarget(null) // create mode, even if an edit modal just closed
                  setModalOpen(true)
                }}
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
                  color: 'var(--pm-text-quiet)',
                  transition: 'background 0.15s, color 0.15s',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = CARD_BG
                  e.currentTarget.style.color = 'var(--pm-text-strong)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                  e.currentTarget.style.color = 'var(--pm-text-quiet)'
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
                    onEdit={() => setEditTarget(project)}
                    cardRef={projectId === project.id ? selectedCardRef : undefined}
                  />
                ))}

                {/* Empty state: ONE card, not two — the explanation and the create
                action are the same affordance now, so the page never shows a
                grey panel beside a dashed cell that say the same thing. It
                spans the whole row and wears the create card's transparent +
                dashed recipe (user request 2026-09-18: 「把【还没有项目】这个
                卡片和【新建项目】的卡片合并，透明背景、灰色虚线边框，把
                【还没有项目】改为【立即创建项目】」). A real <button>, so it
                takes focus and answers Enter/Space. */}
                {userProjects.length === 0 ? (
                  <button
                    type="button"
                    data-project-empty
                    data-action="create-project"
                    onClick={() => setModalOpen(true)}
                    style={{
                      gridColumn: 'span 3',
                      border: `1px dashed ${DASH_BORDER}`,
                      borderRadius: 16,
                      padding: '18px 20px 16px',
                      boxSizing: 'border-box',
                      background: 'transparent',
                      font: 'inherit',
                      textAlign: 'center',
                      cursor: 'pointer',
                      userSelect: 'none',
                      minHeight: CARD_MIN_HEIGHT,
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'center',
                      alignItems: 'center',
                      gap: 6,
                      color: 'var(--pm-text-secondary)',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.borderColor = 'var(--pm-text-secondary)'
                      e.currentTarget.style.color = 'var(--pm-row-ink)'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.borderColor = DASH_BORDER
                      e.currentTarget.style.color = 'var(--pm-text-secondary)'
                    }}
                  >
                    <div style={{ fontSize: 16, fontWeight: 600 }}>{t('welcome.createProjectNow')}</div>
                    <div style={{ fontSize: 13, lineHeight: '19px', color: 'var(--pm-text-muted)' }}>{t('welcome.noProjectsHint')}</div>
                  </button>
                ) : (
                  /* The create card — the last cell whenever projects are listed.
                 A real <button> (like the routine page's 新建任务 card) rather
                 than the clickable div it used to be: `font: inherit` keeps the
                 label on this page's type scale — a bare <button> would fall
                 back to the UA's 13.33px Arial — and the transparent background
                 undoes the UA's grey face. The dashed recipe is the same one the
                 routine page wears. */
                  <button
                    type="button"
                    data-action="create-project"
                    onClick={() => setModalOpen(true)}
                    style={{
                      border: `1px dashed ${DASH_BORDER}`,
                      borderRadius: 16,
                      padding: CARD_PADDING,
                      boxSizing: 'border-box',
                      background: 'transparent',
                      font: 'inherit',
                      cursor: 'pointer',
                      userSelect: 'none',
                      minHeight: CARD_MIN_HEIGHT,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 8,
                      fontSize: 14,
                      color: 'var(--pm-text-quiet)',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.borderColor = 'var(--pm-text-secondary)'
                      e.currentTarget.style.color = 'var(--pm-row-ink)'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.borderColor = DASH_BORDER
                      e.currentTarget.style.color = 'var(--pm-text-quiet)'
                    }}
                  >
                    <PlusOutlined />
                    {t('welcome.newProject')}
                  </button>
                )}
              </div>
              {/* 试试 prompts 刻意只属于压缩形态（2026-11-04 追加裁定）：选择
              形态没有输入框，chips 点了无处可落——starter 的一次性通道在无
              消费者时只排队不显示，点了就是「没反应」。已选形态 composer 已
              挂载，chips 点一下落进输入框（见上方压缩分支）。 */}
            </div>
          </div>
        </>
      )}
      <ProjectModal
        open={modalOpen || editTarget !== null}
        editing={editTarget}
        onClose={() => {
          setModalOpen(false)
          setEditTarget(null)
        }}
        onSaved={(project) => {
          void reload()
          // Created (or directory-adopted) → select it; an edit save reports
          // no project and must not touch the selection.
          if (project) setProjectId(project.id)
        }}
      />
    </div>
  )
}

/**
 * One project card: the project name over its latest conversation, read as a
 * chat line — "1天前：你好". Clicking the card targets the project; only the
 * meta line's play button acts on its own — it opens that conversation, and for
 * a project with none to quote (its row reads 立即开始) it targets the project,
 * exactly as the card's click does. A gradient wash of the project's identity
 * color marks the selection without shifting layout.
 * The workspace path is not on the face — long, rarely read, and it cost a
 * whole row — it rides the hover tooltip instead.
 */
function ProjectCard({
  project,
  conversations,
  now,
  selected,
  onSelect,
  onOpenConversation,
  onEdit,
  cardRef,
}: {
  project: Project
  conversations: ConversationListItem[]
  /** Clock the meta line's relative time is rendered against. */
  now: number
  selected: boolean
  onSelect: () => void
  onOpenConversation: (key: string) => void
  /** Open the project's edit modal — the card's hover edit affordance. */
  onEdit: () => void
  /** Attached only while selected — lets the parent scroll the card into view. */
  cardRef?: React.Ref<HTMLDivElement>
}): React.ReactElement {
  const { t } = useTranslation()
  const inProject = conversations.filter((c) => c.projectId === project.id)
  const latest = inProject.slice().sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))[0]
  const latestKey = latest?.key
  // The edit affordance rides card hover, alongside the background swap.
  const [hovered, setHovered] = useState(false)

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

  // Identity color: the project's own hue (its stored colorHue, via the project
  // store, so the composer's send button wears the same one) — spread across
  // the wheel so neighbors rarely collide.
  const hue = projectHue(project)
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
          setHovered(true)
          e.currentTarget.style.background = selected ? selectedWash(hue, WASH_HOVER) : CARD_BG_HOVER
        }}
        onMouseLeave={(e) => {
          setHovered(false)
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
              color: 'var(--pm-text-strong)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {project.name}
          </span>
          {/* Edit affordance: rides card hover, sits in the pinned 22px row —
              exactly 22px tall so hover never shifts the row. Its own stopPropagation
              keeps the click from also targeting the project. */}
          {hovered && (
            <button
              type="button"
              aria-label={t('appLayout.editProject')}
              title={t('appLayout.editProject')}
              onClick={(e) => {
                e.stopPropagation()
                onEdit()
              }}
              onKeyDown={(e) => e.stopPropagation()}
              style={{
                width: 22,
                height: 22,
                flexShrink: 0,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: 'none',
                background: 'transparent',
                borderRadius: 4,
                cursor: 'pointer',
                color: 'var(--pm-text-muted)',
                padding: 0,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = 'var(--pm-text-strong)'
                e.currentTarget.style.background = 'var(--pm-hover)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = 'var(--pm-text-muted)'
                e.currentTarget.style.background = 'transparent'
              }}
            >
              <EditOutlined style={{ fontSize: 13 }} />
            </button>
          )}
          {selected && <CheckOutlined style={{ fontSize: 14, color: accent, flexShrink: 0 }} />}
        </div>
        {/* Second line: the project's last conversation when there is one to
            quote, 立即开始 in the text slot otherwise — a project nothing was
            ever said in must not read as a card with a row missing. Without a
            quote there is no time to stamp either, and the play button means
            "start this project's first task" rather than "reopen". */}
        {latest && metaText ? (
          <MetaLine
            time={timeText}
            text={metaText}
            playHint={t('welcome.continueConversation')}
            onAction={() => onOpenConversation(latest.key)}
            onHover={setOnMeta}
          />
        ) : (
          <MetaLine
            time={null}
            text={t('welcome.startNow')}
            prompt
            playHint={t('welcome.startNowHint')}
            // The same action as the card's own click: target this project, so
            // the next message starts its first conversation (nothing is
            // created until that message — the deferred-creation contract).
            onAction={onSelect}
            onHover={setOnMeta}
          />
        )}
      </div>
    </Tooltip>
  )
}
