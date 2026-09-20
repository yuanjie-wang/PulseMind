// ── Routine center (日常工作) ──
// PLAN-0.4.0 M4.3 / M4.4: card grid, and a three-pane run workspace (task
// list · run history · run transcript — see RoutineWorkspace) entered from a
// card's 运行历史 action or directly after 立即运行 (which preselects the
// fresh, still-running run for live viewing). Routines are user-triggered /
// scheduled prompt tasks (D3), distinct from skills. Create/edit lives in the
// dedicated three-column editor page (RoutineEditorPage), reached via the
// `routineEditing` view params; Schedules are configured in friendly terms
// (每天/每周/每月/每隔) via utils/schedule-builder; raw cron is the "高级"
// escape hatch.
//
// Landing-page layout (user ruling 2026-09-18): two columns split by a rule —
// the LEFT is what the user owns and can start, the RIGHT is what has already
// happened. Left is stacked: 我的任务 (whose 新建任务 affordance is a dashed card
// closing the task grid — it was a button in the section head until the
// follow-up ruling of the same day) above 推荐模板 (the five workplace starters
// from routine-templates.ts). The page's own title row is GONE — the window
// title bar already names the view, so a second 日常 • 自动化 above the content
// was pure chrome. Right is the recent-runs list: unchanged in content, now a
// bordered column of its own.

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { App as AntdApp, Button, Switch, Tag, Tooltip } from 'antd'
import { ClockCircleOutlined, DeleteOutlined, EditOutlined, PlayCircleOutlined, PlusOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { useNavigationStore } from '../../stores/navigationStore'
import { checkCron } from '../../../../shared/schedule/cron'
import { describeCron } from '../../utils/schedule-text'
import { describeRelativeTimeText, bucketRunByDate, type DateBucket } from '../../utils/relative-time'
import { RoutineWorkspace, RUN_STATUS_TAG, RunStatusIcon } from './RoutineWorkspace'
import { useRoutineRunNow } from './RoutineRunModal'
import { ROUTINE_TEMPLATES, routineScheduleLabel } from './routine-templates'
import type { Routine, RoutineRun } from '../../../../shared/types/routine'

export interface RoutineCenterProps {
  /** Deep link (e.g. the welcome page's routine card): open the run-history
   *  workspace for this routine instead of the card grid. */
  runHistoryOf?: string
}

/** Order the sidebar buckets render in — newest first. */
const BUCKET_ORDER: DateBucket[] = ['today', 'yesterday', 'thisWeek', 'earlier']

/** Width of the 近期运行 column. Fixed rather than proportional: a run row is
 *  one line of name + meta, so the list wants a constant measure and the half
 *  the user works in takes the rest. */
const RUNS_COLUMN_WIDTH = 300

/** Page styles. `.routine-card` / `.routine-run-row` keep their treatment;
 *  `.routine-template` is the template card, wearing the same hover recipe as a
 *  task card so the two halves read as one page. It is a real `<button>` (the
 *  task cards are clickable divs) so the starters are keyboard-reachable and a
 *  click is unambiguous.
 *  `.routine-new-card` is the 新建任务 card — the same dashed recipe the welcome
 *  page's 新建项目 card wears, in this page's card metrics (radius 12, so it sits
 *  in the task grid's rhythm rather than the project grid's). Hover lives in CSS
 *  here rather than in the inline handlers the project page uses, so the
 *  computed border/label colours are what a probe can read. */
const CENTER_STYLES = `
  .routine-card { transition: box-shadow 0.2s, border-color 0.2s; cursor: pointer; }
  .routine-card:hover { box-shadow: var(--pm-shadow-soft); border-color: var(--pm-border); }
  .routine-pill { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 6px; background: var(--pm-fill); color: var(--pm-text-secondary); font-size: 11px; line-height: 18px; white-space: nowrap; }
  .routine-run-row { transition: background 0.15s; cursor: pointer; }
  .routine-run-row:hover { background: var(--pm-fill); }
  .routine-template { display: flex; flex-direction: column; align-items: stretch; gap: 4px;
    text-align: left; font: inherit; color: inherit; background: var(--pm-elevated); cursor: pointer;
    border: 1px solid var(--pm-border-hairline); border-radius: 12px; padding: 12px 14px;
    transition: box-shadow 0.2s, border-color 0.2s; }
  .routine-template:hover { box-shadow: var(--pm-shadow-soft); border-color: var(--pm-border); }
  .routine-new-card { display: flex; align-items: center; justify-content: center; gap: 8px;
    min-height: 72px; font: inherit; font-size: 14px; color: var(--pm-text-quiet); background: transparent; cursor: pointer;
    border: 1px dashed var(--pm-dash-border); border-radius: 12px; padding: 14px 16px;
    transition: border-color 0.2s, color 0.2s; }
  .routine-new-card:hover { border-color: var(--pm-text-secondary); color: var(--pm-row-ink); }
`

/** The template grid: the task grid's rhythm one notch narrower, and it reflows
 *  down to a single column on a half-screen window. */
const TEMPLATE_GRID: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
  gap: 12,
}

/** Head shared by the three sections: a title, an optional count/hint beside
 *  it, and the section's own action pinned right. The note is #999 rather than
 *  the pill grey because the template half carries a whole sentence in it — a
 *  hint nobody can read is not a hint. */
/** One head per section, and its `minHeight` is load-bearing: it is what makes
 *  the title sit 17px above its own content (5px of centred slack inside the
 *  32px box + the 12px margin below it) and makes all three heads the same box,
 *  so the three titles sit identically. The 32px was originally reserved for the
 *  新建任务 button that used to live here; the button is now a card in the task
 *  grid (see the tasks section), and the height stayed because it *is* the
 *  spacing — dropping it measures 12px instead of the 17px the user signed off
 *  on (user request 2026-09-18: 「【我的任务】与【任务卡片】的间距要和【推荐模版】
 *  与【模版卡片】的间距保持一致」). */
function SectionHead({ title, note, action }: { title: string; note?: string; action?: React.ReactNode }): React.ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, minHeight: 32, flexShrink: 0 }}>
      <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--pm-text-strong)' }}>{title}</span>
      {note && <span style={{ fontSize: 12, color: 'var(--pm-text-muted)' }}>{note}</span>}
      <span style={{ flex: 1 }} />
      {action}
    </div>
  )
}

function RoutineCenter({ runHistoryOf }: RoutineCenterProps): React.ReactElement {
  const { t, locale } = useTranslation()
  const { modal } = AntdApp.useApp()
  const navigate = useNavigationStore((s) => s.navigate)
  const [routines, setRoutines] = useState<Routine[]>([])
  const [recentRuns, setRecentRuns] = useState<RoutineRun[]>([])
  /** When recentRuns were fetched — render stays pure by not calling Date.now(). */
  const [runsFetchedAt, setRunsFetchedAt] = useState(0)
  /** Non-null = the run workspace is open for this task (three-pane mode). */
  const [historyOfId, setHistoryOfId] = useState<string | null>(runHistoryOf ?? null)
  /** A specific run to preselect on first workspace mount — set when the user
   *  clicks a run row in the sidebar; cleared (select-newest) on a card click. */
  const [initialRunIdForWorkspace, setInitialRunIdForWorkspace] = useState<string | undefined>(undefined)
  // A deep link arriving while already mounted (e.g. remembered view re-entry)
  // switches the workspace to the linked task.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reacting to a navigation-store deep link, not derived state
    if (runHistoryOf) setHistoryOfId(runHistoryOf)
  }, [runHistoryOf])
  /** Bumped on every 立即运行 so an already-open workspace refetches and
   *  selects the fresh run (a fresh mount selects the newest on its own). */
  const [runNonce, setRunNonce] = useState(0)

  const reload = useCallback(async () => {
    try {
      setRoutines(await window.electronAPI.routineList())
      setRecentRuns(await window.electronAPI.routineRuns(undefined, 200))
      setRunsFetchedAt(Date.now())
    } catch (err) {
      console.warn('[RoutineCenter] load failed:', err)
    }
  }, [])

  // eslint-disable-next-line react-hooks/set-state-in-effect -- async data load, setState lands after await
  useEffect(() => { void reload() }, [reload])

  // Runs come back newest-first; the first hit per routine is its latest run.
  const lastRunByRoutine = new Map<string, RoutineRun>()
  for (const run of recentRuns) {
    if (!lastRunByRoutine.has(run.routineId)) lastRunByRoutine.set(run.routineId, run)
  }

  /** Open the three-column editor page for a routine (absent id = create). */
  const openEditor = (routine?: Routine): void => {
    navigate(routine
      ? { kind: 'routines', routineId: routine.id, routineEditing: true }
      : { kind: 'routines', routineEditing: true })
  }

  /** Open the editor prefilled with a recommended template. Nothing is stored by
   *  this click — the editor's 保存 is what creates the routine, so a template
   *  the user tries and abandons leaves no trace. */
  const openTemplate = (templateId: string): void => {
    navigate({ kind: 'routines', routineEditing: true, routineTemplateId: templateId })
  }

  /** Open the run-history workspace for a routine. When `runId` is supplied
   *  (a sidebar row click) that run is preselected; a card click leaves it
   *  undefined so the workspace selects the newest run. */
  const openHistory = (routineId: string, runId?: string): void => {
    setInitialRunIdForWorkspace(runId)
    setHistoryOfId(routineId)
  }

  /** Shared 立即运行: params → fill-in dialog first, none → straight away
   *  (RoutineRunModal). A started run jumps into the three-pane workspace with
   *  the fresh run preselected for live viewing. */
  const { runNow, modal: runModal } = useRoutineRunNow((started) => {
    setHistoryOfId(started.id)
    setRunNonce((n) => n + 1)
    void reload()
  })

  const removeRoutine = (routine: Routine): void => {
    modal.confirm({
      title: `删除「${routine.name}」？`,
      content: '运行历史会一并删除。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await window.electronAPI.routineDelete(routine.id)
        void reload()
      },
    })
  }

  // routineId → name, so the sidebar can label a run without another lookup.
  const routineNameById = useMemo(() => {
    const m = new Map<string, string>()
    for (const r of routines) m.set(r.id, r.name)
    return m
  }, [routines])

  // Group recent runs into the four date buckets, newest-first within each.
  // Capped at 50 rows so a long-running install does not paint an unbounded list.
  const groupedRuns = useMemo(() => {
    const groups: Record<DateBucket, RoutineRun[]> = { today: [], yesterday: [], thisWeek: [], earlier: [] }
    let count = 0
    for (const run of recentRuns) {
      if (count >= 50) break
      groups[bucketRunByDate(run.startedAt, runsFetchedAt)].push(run)
      count += 1
    }
    return groups
  }, [recentRuns, runsFetchedAt])

  const bucketLabel: Record<DateBucket, string> = {
    today: t('routine.bucketToday'),
    yesterday: t('routine.bucketYesterday'),
    thisWeek: t('routine.bucketThisWeek'),
    earlier: t('routine.bucketEarlier'),
  }

  return (
    <div style={{ height: '100%', background: 'var(--pm-bg)', overflow: 'hidden' }}>
      {runModal}
      {historyOfId != null ? (
        <RoutineWorkspace
          routines={routines}
          initialRoutineId={historyOfId}
          initialRunId={initialRunIdForWorkspace}
          activeRunNonce={runNonce}
          onBack={() => { setHistoryOfId(null); setInitialRunIdForWorkspace(undefined); void reload() }}
          onEdit={(r) => openEditor(r)}
          onRunNow={runNow}
        />
      ) : (
        <div style={{ height: '100%', display: 'flex', minHeight: 0 }}>
          <style>{CENTER_STYLES}</style>

          {/* ── Left: 我的任务 (upper) over 推荐模板 (lower) ── */}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            {/* Upper — the tasks the user already has. It HUGS its content
                (`flex: 0 1 auto`, not `flex: 1`): the lower half must sit
                directly under the last card with no blank band between them
                (user ruling 2026-09-18 — 「上下两部分间不用留白」), so any
                leftover height goes below both halves, never between them.
                It still shrinks (`minHeight: 0`) when the list is longer than
                the column, and the scroller below takes the overflow. */}
            <section
              data-section="tasks"
              style={{ flex: '0 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', padding: '24px 24px 0' }}
            >
              <SectionHead
                title={t('routine.myTasks')}
                note={routines.length > 0 ? String(routines.length) : undefined}
              />
              <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
                {/* The empty explanation stays a line of copy (it explains what
                    a routine is and points at the templates) — the ACTION is the
                    card at the end of the grid below, which every state shows
                    (user request 2026-09-18: 「在【日常 自动化】页面中，也同样用
                    卡片的方式呈现新建任务按钮」, i.e. the same shape the welcome
                    page's 新建项目 card has). The 24px it used to carry above was
                    the gap to a section head that no longer has a button in it;
                    16px below is what keeps it off the first card. */}
                {routines.length === 0 && (
                  <div style={{ color: 'var(--pm-text-muted)', padding: '0 0 16px', fontSize: 13 }}>
                    {t('routine.emptyHint')}
                  </div>
                )}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
                  {routines.map((routine) => {
                    const scheduleText = routine.enabled && routine.schedule
                      ? `下次运行：${describeCron(routine.schedule.cron)}`
                      : routine.enabled ? '手动执行' : '已停用'
                    const lastRun = lastRunByRoutine.get(routine.id)
                    const lastRunText = lastRun
                      ? `${RUN_STATUS_TAG[lastRun.status].text} · ${describeRelativeTimeText(lastRun.startedAt, runsFetchedAt, t) ?? ''}`
                      : null
                    const description = routine.description || (routine.prompt ? `提示词：${routine.prompt}` : '')
                    return (
                      <div
                        key={routine.id}
                        className="routine-card"
                        style={{ display: 'flex', flexDirection: 'column', borderRadius: 12, border: '1px solid var(--pm-border-hairline)', padding: '14px 16px' }}
                        onClick={() => openHistory(routine.id)}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {routine.name}
                          </span>
                          {routine.schedule?.cron && checkCron(routine.schedule.cron).valid && <Tag color="black">定时</Tag>}
                        </div>
                        <div
                          title={description}
                          style={{
                            fontSize: 12, color: 'var(--pm-text-quiet)', marginTop: 6, minHeight: 36,
                            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                          }}
                        >
                          {description}
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                          <span className="routine-pill"><ClockCircleOutlined />{scheduleText}</span>
                          {lastRunText && <span className="routine-pill">{lastRunText}</span>}
                          {(routine.params?.length ?? 0) > 0 && (
                            <span className="routine-pill">参数 {routine.params!.map((p) => p.key).join(' · ')}</span>
                          )}
                        </div>
                        {/* Action row isolates its own clicks (stopPropagation) so
                            toggling / running / editing / deleting does not also
                            open the run-history workspace like a card click does. */}
                        <div
                          style={{ display: 'flex', alignItems: 'center', gap: 2, marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--pm-border-faint)' }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Switch
                            size="small"
                            checked={routine.enabled}
                            onChange={(checked) => void window.electronAPI.routineToggle(routine.id, checked).then(reload)}
                          />
                          <span style={{ flex: 1 }} />
                          <Tooltip title="立即运行">
                            <Button type="text" icon={<PlayCircleOutlined style={{ fontSize: 17 }} />} onClick={() => runNow(routine)} />
                          </Tooltip>
                          <Tooltip title="编辑">
                            <Button type="text" icon={<EditOutlined style={{ fontSize: 15 }} />} onClick={() => openEditor(routine)} />
                          </Tooltip>
                          <Tooltip title="删除">
                            <Button type="text" danger icon={<DeleteOutlined style={{ fontSize: 15 }} />} onClick={() => removeRoutine(routine)} />
                          </Tooltip>
                        </div>
                      </div>
                    )
                  })}

                  {/* 新建任务 as a card, in the last cell of the grid — the same
                      affordance the welcome page gives 新建项目 (user request
                      2026-09-18: 「也同样用卡片的方式呈现新建任务按钮」). A real
                      <button> like the template cards, so it is keyboard-
                      reachable and the whole card is one unambiguous target; the
                      click creates nothing — it opens the editor, and 保存 is
                      what writes. */}
                  <button
                    type="button"
                    data-action="create-task"
                    className="routine-new-card"
                    onClick={() => openEditor()}
                  >
                    <PlusOutlined />
                    {t('routine.createTask')}
                  </button>
                </div>
              </div>
            </section>

            {/* Lower — 推荐模板. It follows the task list directly, separated
                only by this top padding (24px → a 29px band measured from the
                last card to the title, a little wider than the ~17px a head
                leaves inside its own half, per 「略微增加两大块的间距」; the
                user asked for more again on 2026-09-18 — 「略微增加…间距」 —
                so it went 12 → 16 → 24, and 24 matches the page's own 24px
                gutter on the tasks and runs columns), capped
                at 52% so that on a narrow window, where the grid wraps, it
                scrolls instead of pushing the task list off screen.
                `boxSizing: border-box` is what makes the cap mean what it says —
                antd only sets border-box on its own classes, so a content-box
                slab would add its 36px of padding ON TOP of the 52% (measured
                58% before the fix).
                No rule at the seam either: the two halves abut directly (user
                ruling, 2026-09-18 — 「不用硬分隔…直接接壤」); the section head
                is what separates them. The vertical rule against the runs
                column is a different thing and stays. */}
            <section
              data-section="templates"
              style={{
                flexShrink: 0, maxHeight: '52%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column',
                padding: '24px 24px 20px',
              }}
            >
              <SectionHead title={t('routine.templates')} note={t('routine.templatesHint')} />
              <div style={{ overflowY: 'auto' }}>
                <div style={TEMPLATE_GRID}>
                  {ROUTINE_TEMPLATES.map((template) => (
                    <button
                      key={template.id}
                      type="button"
                      data-template={template.id}
                      className="routine-template"
                      onClick={() => openTemplate(template.id)}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--pm-text-strong)' }}>
                          {template.name[locale] || template.name.zh}
                        </span>
                        {template.cron && (
                          <span className="routine-pill">
                            <ClockCircleOutlined />{routineScheduleLabel(template.cron, locale)}
                          </span>
                        )}
                      </span>
                      <span style={{ fontSize: 12, color: 'var(--pm-text-quiet)', lineHeight: '18px' }}>
                        {template.description[locale] || template.description.zh}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </section>
          </div>

          {/* ── Right: recent runs — grouped by 今天 / 昨天 / 本周 / 更早, ruled
              off from the left column ── */}
          <aside
            data-section="runs"
            style={{
              width: RUNS_COLUMN_WIDTH, flexShrink: 0, minHeight: 0, display: 'flex', flexDirection: 'column',
              borderLeft: '1px solid var(--pm-border-hairline)', padding: '24px 16px',
            }}
          >
            <SectionHead title={t('routine.recentRuns')} />
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
              {recentRuns.length === 0 ? (
                <div style={{ color: 'var(--pm-text-faint)', fontSize: 12, padding: '12px 0' }}>
                  {t('routine.recentRunsEmpty')}
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {BUCKET_ORDER.map((bucket) => {
                    const runs = groupedRuns[bucket]
                    if (runs.length === 0) return null
                    return (
                      <div key={bucket}>
                        <div style={{ fontSize: 11, color: 'var(--pm-text-muted)', fontWeight: 600, padding: '10px 4px 6px', textTransform: 'uppercase', letterSpacing: 0.3 }}>
                          {bucketLabel[bucket]}
                        </div>
                        {runs.map((run) => {
                          const name = routineNameById.get(run.routineId) ?? run.routineId
                          const triggerText = run.trigger === 'schedule' ? t('routine.triggerSchedule') : t('routine.triggerManual')
                          const timeText = describeRelativeTimeText(run.startedAt, runsFetchedAt, t) ?? ''
                          const isRunning = run.status === 'running'
                          return (
                            <div
                              key={run.id}
                              className="routine-run-row"
                              style={{
                                display: 'flex', alignItems: 'center', gap: 8,
                                padding: '7px 8px', borderRadius: 8,
                              }}
                              onClick={() => openHistory(run.routineId, run.id)}
                            >
                              <RunStatusIcon status={run.status} />
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{
                                  fontSize: 12.5, color: isRunning ? 'var(--pm-link)' : 'var(--pm-text-strong)',
                                  fontWeight: isRunning ? 600 : 500,
                                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                }}>
                                  {name}
                                </div>
                                <div style={{ fontSize: 11, color: 'var(--pm-text-muted)', display: 'flex', gap: 6, alignItems: 'center' }}>
                                  <span>{triggerText}</span>
                                  {timeText && <span>· {timeText}</span>}
                                </div>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}

export default RoutineCenter
