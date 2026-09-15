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

import React, { useCallback, useEffect, useState } from 'react'
import { App as AntdApp, Button, Space, Switch, Tag, Tooltip } from 'antd'
import { ClockCircleOutlined, DeleteOutlined, EditOutlined, PlayCircleOutlined, HistoryOutlined, PlusOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { useNavigationStore } from '../../stores/navigationStore'
import { checkCron } from '../../../../shared/schedule/cron'
import { describeCron } from '../../utils/schedule-text'
import { describeRelativeTimeText } from '../../utils/relative-time'
import { RoutineWorkspace, RUN_STATUS_TAG } from './RoutineWorkspace'
import type { Routine, RoutineRun } from '../../../../shared/types/routine'

export interface RoutineCenterProps {
  /** Deep link (e.g. the welcome page's routine card): open the run-history
   *  workspace for this routine instead of the card grid. */
  runHistoryOf?: string
}

function RoutineCenter({ runHistoryOf }: RoutineCenterProps): React.ReactElement {
  const { t } = useTranslation()
  const { modal, message } = AntdApp.useApp()
  const navigate = useNavigationStore((s) => s.navigate)
  const [routines, setRoutines] = useState<Routine[]>([])
  const [recentRuns, setRecentRuns] = useState<RoutineRun[]>([])
  /** When recentRuns were fetched — render stays pure by not calling Date.now(). */
  const [runsFetchedAt, setRunsFetchedAt] = useState(0)
  /** Non-null = the run workspace is open for this task (three-pane mode). */
  const [historyOfId, setHistoryOfId] = useState<string | null>(runHistoryOf ?? null)
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

  const runNow = async (routine: Routine): Promise<void> => {
    const params: Record<string, string> = {}
    for (const p of routine.params ?? []) params[p.key] = p.default ?? ''
    await window.electronAPI.routineRun(routine.id, params)
    message.success(`已开始执行「${routine.name}」，完成后会通知你`)
    // 跳到三栏运行历史：默认选中刚发起的这次运行，右侧实时展示执行过程。
    setHistoryOfId(routine.id)
    setRunNonce((n) => n + 1)
    void reload()
  }

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

  return (
    <div style={{ height: '100%', background: '#fff', overflow: 'hidden' }}>
      {historyOfId != null ? (
        <RoutineWorkspace
          routines={routines}
          initialRoutineId={historyOfId}
          activeRunNonce={runNonce}
          onBack={() => { setHistoryOfId(null); void reload() }}
          onEdit={(r) => openEditor(r)}
          onRunNow={(r) => void runNow(r)}
        />
      ) : (
        <div style={{ height: '100%', overflow: 'auto', padding: 24 }}>
          <style>{`
        .routine-card { transition: box-shadow 0.2s, border-color 0.2s; }
        .routine-card:hover { box-shadow: 0 2px 12px rgba(0,0,0,0.08); border-color: #d9d9d9; }
        .routine-pill { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 6px; background: #f5f5f5; color: #666; font-size: 11px; line-height: 18px; white-space: nowrap; }
      `}</style>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <span style={{ fontSize: 18, fontWeight: 700 }}>{t('viewTitle.routines')}</span>
            <Space>
              <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor()}>
                新建任务
              </Button>
            </Space>
          </div>

          {routines.length === 0 && (
            <div style={{ color: '#999', padding: '32px 0', fontSize: 13 }}>
              还没有日常工作。新建一个提示词任务，或从一段对话中提炼；可以立即执行，也可以设定每天/每周等固定时间自动跑。
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
              style={{ display: 'flex', flexDirection: 'column', borderRadius: 12, border: '1px solid #f0f0f0', padding: '14px 16px' }}
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
                  fontSize: 12, color: '#888', marginTop: 6, minHeight: 36,
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
              <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginTop: 10, paddingTop: 10, borderTop: '1px solid #f5f5f5' }}>
                <Switch
                  size="small"
                  checked={routine.enabled}
                  onChange={(checked) => void window.electronAPI.routineToggle(routine.id, checked).then(reload)}
                />
                <span style={{ flex: 1 }} />
                <Tooltip title="立即运行">
                  <Button type="text" icon={<PlayCircleOutlined style={{ fontSize: 17 }} />} onClick={() => void runNow(routine)} />
                </Tooltip>
                <Tooltip title="运行历史">
                  <Button type="text" icon={<HistoryOutlined style={{ fontSize: 16 }} />} onClick={() => setHistoryOfId(routine.id)} />
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
      </div>
        </div>
      )}
    </div>
  )
}

export default RoutineCenter
