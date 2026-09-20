// ── Welcome cards ──
// The welcome page's proactive band: three cards on one line, each answering a
// different "what next" question — 继续对话 (resume the last conversation),
// 开始日常 (how the last routine run went), 知识沉淀 (what just entered the
// knowledge base). Each slice loads independently, so a slow or failed one
// shows a skeleton or its own guidance instead of blanking the band. Starter
// prompts stay underneath, prefilling the composer in one click.

import React, { useEffect, useState } from 'react'
import { Button, Tooltip } from 'antd'
import {
  ArrowRightOutlined,
  ClockCircleOutlined,
  DatabaseOutlined,
  ImportOutlined,
  MessageOutlined,
  PlayCircleOutlined,
} from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { StarterPrompts } from './StarterPrompts'
import { useRoutineRunNow } from '../routine/RoutineRunModal'
import { useNavigationStore } from '../../stores/navigationStore'
import { CLOCK_TICK_MS, describeRelativeTimeText } from '../../utils/relative-time'
import { describeCron } from '../../utils/schedule-text'
import {
  isRunOverdue,
  pickLatestRun,
  pickNewestKnowledge,
  pickNextScheduledRoutine,
  pickResumeConversation,
} from '../../utils/welcome-slices'
import type { Routine, RoutineRun, RoutineRunStatus } from '../../../../shared/types/routine'
import type { KnowledgeFile } from '../../../../shared/types/knowledge'

/** Recent runs to inspect — only the newest matters, the rest is slack for filtering. */
const RUN_FETCH_LIMIT = 5

// The values ride the theme sheet (PLAN-dark-mode M3/T1), light byte-identical.
const CARD_BG = 'var(--pm-card-soft)'
const CARD_BG_HOVER = 'var(--pm-card-soft-hover)'
const LINE_CLAMP: React.CSSProperties = {
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
}/** Relative stamp for a card's meta line, or null when the stamp is unusable. */
function relativeText(timestamp: string | null | undefined, now: number, t: (p: string, v?: Record<string, string | number>) => string): string | null {
  return describeRelativeTimeText(timestamp ?? undefined, now, t)
}

/** Short human text for a future stamp: 今天/明天 HH:mm, else M/D HH:mm. */
function nextRunText(nextRunAt: string | undefined, t: (path: string, values?: Record<string, string | number>) => string): string | null {
  if (!nextRunAt) return null
  const at = new Date(nextRunAt)
  if (Number.isNaN(at.getTime())) return null
  const hm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diffDays = Math.round((startOfDay(at) - startOfDay(new Date())) / 86_400_000)
  if (diffDays === 0) return t('welcome.runToday', { time: hm })
  if (diffDays === 1) return t('welcome.runTomorrow', { time: hm })
  return `${at.getMonth() + 1}/${at.getDate()} ${hm}`
}

const RUN_STATUS_COLOR: Record<RoutineRunStatus, string> = {
  success: 'var(--pm-success)',
  failed: 'var(--pm-error)',
  running: 'var(--pm-link)',
  skipped: 'var(--pm-text-muted)',
}

// ── Card frame ──

/**
 * One card in a shared frame: a small label row (with room for a status or
 * action on the right) above a free-form body. A card with `onClick` becomes
 * a real button — pointer plus Enter/Space — so the whole surface is the hit
 * target rather than a trailing arrow.
 */
function CardShell({ icon, label, onClick, badge, children }: {
  icon: React.ReactNode
  label: string
  onClick?: () => void
  badge?: React.ReactNode
  children: React.ReactNode
}): React.ReactElement {
  const activate = onClick
  return (
    <div
      role={activate ? 'button' : undefined}
      tabIndex={activate ? 0 : undefined}
      onClick={activate}
      onKeyDown={(e) => {
        if (!activate || (e.key !== 'Enter' && e.key !== ' ')) return
        e.preventDefault()
        activate()
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = activate ? CARD_BG_HOVER : CARD_BG }}
      onMouseLeave={(e) => { e.currentTarget.style.background = CARD_BG }}
      style={{
        flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10,
        background: CARD_BG, borderRadius: 16, padding: '18px 20px 16px',
        textAlign: 'left', userSelect: 'none', cursor: activate ? 'pointer' : 'default',
        transition: 'background 0.15s',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, fontWeight: 600, color: 'var(--pm-text-muted)' }}>
        <span style={{ fontSize: 13, display: 'inline-flex' }}>{icon}</span>
        <span>{label}</span>
        <span style={{ flex: 1 }} />
        {badge}
      </div>
      {children}
    </div>
  )
}

/** Card body: a one-line headline, an optional clamped second line, and a meta line. */
function CardBody({ headline, detail, meta, muted = false }: {
  headline: string
  detail?: string | null
  meta?: string | null
  muted?: boolean
}): React.ReactElement {
  return (
    <>
      <div style={{
        fontSize: 16, fontWeight: 600, lineHeight: '22px', color: muted ? 'var(--pm-text-muted)' : 'var(--pm-text-strong)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {headline}
      </div>
      <div style={{ ...LINE_CLAMP, flex: 1, fontSize: 13, lineHeight: '19px', color: muted ? 'var(--pm-text-haze)' : 'var(--pm-text-quiet)', minHeight: 38 }}>
        {detail}
      </div>
      {meta && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--pm-text-soft)' }}>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{meta}</span>
          {!muted && <ArrowRightOutlined style={{ fontSize: 11, flexShrink: 0 }} />}
        </div>
      )}
    </>
  )
}

/** Loading placeholder shaped like a card, so the band doesn't jump when data lands. */
function SkeletonCard(): React.ReactElement {
  const bar = (width: number | string, height: number): React.CSSProperties => ({
    width, height, borderRadius: 5, background: 'var(--pm-skeleton)',
  })
  return (
    <div style={{
      flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10,
      background: CARD_BG, borderRadius: 16, padding: '18px 20px 16px',
    }}>
      <div style={bar(64, 12)} />
      <div style={bar('100%', 14)} />
      <div style={bar('72%', 14)} />
      <div style={{ flex: 1 }} />
      <div style={bar(92, 12)} />
    </div>
  )
}

// ── Slices ──

/** The newest non-empty conversation plus the user's last input in it. */
interface ChatSlice {
  key: string
  title: string
  updatedAt?: string
  quote: string | null
}

export function WelcomeSuggestions({ activeLoopConvIds = [], onOpenConversation }: {
  /** Conversations with a running loop get a status light, like the sidebar. */
  activeLoopConvIds?: string[]
  onOpenConversation: (key: string) => void
}): React.ReactElement {
  const { t } = useTranslation()
  
  const [now, setNow] = useState(() => Date.now())
  // undefined = still loading, null = nothing to suggest; the two render differently.
  const [chat, setChat] = useState<ChatSlice | null | undefined>(undefined)
  const [routines, setRoutines] = useState<Routine[] | null | undefined>(undefined)
  const [runs, setRuns] = useState<RoutineRun[]>([])
  const [knowledge, setKnowledge] = useState<KnowledgeFile[] | null | undefined>(undefined)

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
    return () => clearInterval(timer)
  }, [])

  // Chat slice: the sidebar's list has no message count, and an empty
  // conversation has no "last thing you said" to resume into, so the richer
  // index decides which conversation the card offers.
  useEffect(() => {
    let cancelled = false
    window.electronAPI.listConversations()
      .then((list) => {
        const latest = pickResumeConversation(list)
        if (!latest) {
          if (!cancelled) setChat(null)
          return
        }
        if (!cancelled) setChat({ key: latest.id, title: latest.title, updatedAt: latest.updatedAt, quote: null })
        window.electronAPI.getConversationLastUserMessage(latest.id)
          .then((quote) => { if (!cancelled) setChat((prev) => (prev ? { ...prev, quote } : prev)) })
          .catch(() => { /* the card still works without the quote */ })
      })
      .catch(() => { if (!cancelled) setChat(null) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    Promise.all([window.electronAPI.routineList(), window.electronAPI.routineRuns(undefined, RUN_FETCH_LIMIT)])
      .then(([list, runList]) => {
        if (cancelled) return
        setRoutines(list)
        setRuns(runList)
      })
      .catch(() => { if (!cancelled) setRoutines(null) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    window.electronAPI.knowledgeListFiles()
      .then((files) => { if (!cancelled) setKnowledge(files) })
      .catch(() => { if (!cancelled) setKnowledge(null) })
    return () => { cancelled = true }
  }, [])

  // 立即运行 via the shared entry (RoutineRunModal): params → fill-in dialog,
  // none → straight away. No history jump here — the card's own slice refreshes.
  const { runNow, modal: runModal } = useRoutineRunNow()

  const starters = [t('welcome.starter1'), t('welcome.starter2'), t('welcome.starter3')]

  return (
    <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 14 }}>
      {runModal}
      <div style={{ display: 'flex', gap: 14, alignItems: 'stretch', minHeight: 158 }}>
        <ChatCard chat={chat} now={now} activeLoopConvIds={activeLoopConvIds} onOpenConversation={onOpenConversation} />
        <RoutineCard routines={routines} runs={runs} now={now} onRunNow={runNow} />
        <KnowledgeCard files={knowledge} now={now} />
      </div>

      {/* Starter prompts: one click drops the question into the composer. */}
      <StarterPrompts labels={starters} />
    </div>
  )
}

// ── 继续对话 ──

function ChatCard({ chat, now, activeLoopConvIds, onOpenConversation }: {
  chat: ChatSlice | null | undefined
  now: number
  activeLoopConvIds: string[]
  onOpenConversation: (key: string) => void
}): React.ReactElement | null {
  const { t } = useTranslation()

  if (chat === undefined) return <SkeletonCard />
  // Nothing to resume: the composer and starter prompts already say "start here".
  if (!chat) return null

  const running = activeLoopConvIds.includes(chat.key)
  const elapsed = relativeText(chat.updatedAt, now, t)

  return (
    <CardShell
      icon={<MessageOutlined />}
      label={t('welcome.cardChat')}
      onClick={() => onOpenConversation(chat.key)}
      badge={running ? (
        <span style={{
          width: 6, height: 6, borderRadius: '50%', background: 'var(--pm-link)',
          animation: 'ant-status-processing 1.2s infinite ease-in-out',
        }} />
      ) : undefined}
    >
      <CardBody
        headline={chat.title}
        detail={chat.quote ? t('welcome.lastYouSaid', { text: chat.quote }) : null}
        meta={elapsed}
      />
    </CardShell>
  )
}

// ── 开始日常 ──

type RoutineRunLike = Pick<RoutineRun, 'routineId' | 'conversationId' | 'status' | 'startedAt' | 'error'>

function RoutineCard({ routines, runs, now, onRunNow }: {
  routines: Routine[] | null | undefined
  runs: RoutineRunLike[]
  now: number
  onRunNow: (routine: Routine) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigationStore((s) => s.navigate)

  if (routines === undefined) return <SkeletonCard />

  const goRoutines = (): void => { navigate({ kind: 'routines' }) }
  /** Latest run exists → the run-history workspace for its task (the newest
   *  run is preselected and streams live when still running). */
  const goRunHistory = (routineId: string): void => { navigate({ kind: 'routines', runHistoryOf: routineId }) }
  const goRoutinesLink = (
    <a onClick={goRoutines} style={{ cursor: 'pointer' }}>{t('welcome.createRoutine')}</a>
  )
  if (routines === null || routines.length === 0) {
    return (
      <CardShell icon={<ClockCircleOutlined />} label={t('welcome.cardRoutine')}>
        <CardBody headline={t('welcome.noRoutinesTitle')} detail={t('welcome.noRoutinesHint')} muted />
        <div style={{ fontSize: 12 }}>{goRoutinesLink}</div>
      </CardShell>
    )
  }

  const latestRun = pickLatestRun(runs)
  const runRoutine = latestRun ? routines.find((r) => r.id === latestRun.routineId) : undefined
  if (latestRun && runRoutine) {
    const when = relativeText(latestRun.startedAt, now, t)
    return (
      <CardShell
        icon={<ClockCircleOutlined />}
        label={t('welcome.cardRoutine')}
        onClick={() => goRunHistory(latestRun.routineId)}
        badge={(
          <>
            <RunStatusBadge status={latestRun.status} />
            <RunNowButton routine={runRoutine} onRunNow={onRunNow} />
          </>
        )}
      >
        <CardBody
          headline={`${runRoutine.icon ? `${runRoutine.icon} ` : ''}${runRoutine.name}`}
          detail={runResultText(latestRun, t)}
          meta={when}
        />
      </CardShell>
    )
  }

  // No history yet: surface the next scheduled routine (or the first one to run by hand).
  const scheduled = pickNextScheduledRoutine(routines)
  const routine = scheduled ?? routines.find((r) => r.enabled) ?? routines[0]
  const overdue = isRunOverdue(scheduled?.nextRunAt, now)
  const nextRun = scheduled ? nextRunText(scheduled.nextRunAt, t) : null
  return (
    <CardShell
      icon={<ClockCircleOutlined />}
      label={t('welcome.cardRoutine')}
      onClick={goRoutines}
      badge={(
        <>
          {overdue && <span style={{ color: RUN_STATUS_COLOR.running }}>{t('welcome.dueRun')}</span>}
          {routine.enabled && <RunNowButton routine={routine} onRunNow={onRunNow} />}
        </>
      )}
    >
      <CardBody
        headline={`${routine.icon ? `${routine.icon} ` : ''}${routine.name}`}
        detail={scheduled && nextRun ? t('welcome.nextRun', { when: nextRun }) : t('welcome.manualOnly')}
        meta={scheduled ? describeCron(scheduled.schedule!.cron) : null}
      />
    </CardShell>
  )
}

/** Status word for a finished/running run, coloured by outcome. */
function RunStatusBadge({ status }: { status: RoutineRunStatus }): React.ReactElement {
  const { t } = useTranslation()
  return <span style={{ color: RUN_STATUS_COLOR[status] }}>{t(`welcome.runStatus.${status}`)}</span>
}

/** One sentence of what happened, or what the failure was. */
function runResultText(run: RoutineRunLike, t: (p: string, v?: Record<string, string | number>) => string): string {
  if (run.status === 'failed') return t('welcome.runResultFail', { error: run.error || t('welcome.runResultFailedShort') })
  if (run.status === 'success') return t('welcome.runResultOk')
  if (run.status === 'running') return t('welcome.runResultRunning')
  return t('welcome.runResultSkipped')
}

/** Secondary action: start this routine now, without leaving the welcome page. */
function RunNowButton({ routine, onRunNow }: {
  routine: Routine
  onRunNow: (routine: Routine) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const label = t('welcome.runNow')
  return (
    <Tooltip title={label}>
      <Button
        type="text"
        size="small"
        aria-label={label}
        icon={<PlayCircleOutlined />}
        style={{ width: 22, height: 22, minWidth: 22, padding: 0, color: 'var(--pm-text-muted)', fontSize: 13 }}
        onClick={(e) => { e.stopPropagation(); onRunNow(routine) }}
      />
    </Tooltip>
  )
}

// ── 知识沉淀 ──

function KnowledgeCard({ files, now }: {
  files: KnowledgeFile[] | null | undefined
  now: number
}): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigationStore((s) => s.navigate)

  if (files === undefined) return <SkeletonCard />
  const newest = files ? pickNewestKnowledge(files) : null
  if (!newest) {
    return (
      <CardShell icon={<DatabaseOutlined />} label={t('welcome.cardKnowledge')}>
        <CardBody headline={t('welcome.noKnowledgeTitle')} detail={t('welcome.noKnowledgeHint')} muted />
        <div style={{ fontSize: 12 }}>
          <a onClick={() => navigate({ kind: 'knowledge' })} style={{ cursor: 'pointer' }}>
            <ImportOutlined /> {t('welcome.goImport')}
          </a>
        </div>
      </CardShell>
    )
  }

  const wikiCount = newest.wikiOutputs?.length ?? 0
  const detail = newest.status === 'compiled'
    ? t('welcome.knowledgeCompiled', { count: wikiCount })
    : t('welcome.knowledgePending')
  const source = t(`welcome.source.${newest.sourceType}`)
  const elapsed = relativeText(newest.createdAt, now, t)

  return (
    <CardShell
      icon={<DatabaseOutlined />}
      label={t('welcome.cardKnowledge')}
      onClick={() => navigate({ kind: 'knowledge' })}
    >
      <CardBody
        headline={newest.title}
        detail={detail}
        meta={elapsed ? `${source} · ${elapsed}` : source}
      />
    </CardShell>
  )
}
