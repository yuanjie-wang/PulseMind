// ── 统一运行时间线（P3 任务中心）──
// routine_runs + pipeline_runs 两份 feed 归并成一个「最近发生了什么」：
// startedAt 倒序、bucketRunByDate 分组、帽 50、3s 轮询（对齐 RoutineWorkspace
// 的轮询档）。行 = 状态图标（RUN_STATUS_TAG 词汇表，pipeline 状态子集映射进
// 同表）+ 名称 + 触发文案 + 相对时间 + running 停止钮（按 kind 路由：
// routine 走 stop-run.ts，workflow 走 pipelineStop）。
// 点击：两类行都直达详情（user 2026-11-17「工作流模式的执行任务不用展开，直接
// 进详情页」）——routine 行 → openHistory（RoutineWorkspace deep-link 语义不变）；
// workflow 行 → 运行详情页（workflowRunViewId，行内展开面整块退场）。

import React, { useCallback, useEffect, useState } from 'react'
import { Button, Tooltip } from 'antd'
import { PauseCircleOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { WORKFLOW_TASKS_UI } from '../../feature-flags'
import { App as AntdApp } from 'antd'
import { RunStatusIcon, RUN_STATUS_TAG } from './RoutineWorkspace'
import { stopRunConfirm, stopRoutineRun } from './stop-run'
import { useNavigationStore } from '../../stores/navigationStore'
import { describeRelativeTimeText, bucketRunByDate, type DateBucket } from '../../utils/relative-time'
import type { Routine, RoutineRun } from '../../../../shared/types/routine'
import type { PipelineRun } from '../../../../shared/workflow/types'

const RUNS_POLL_MS = 3_000
const MAX_ROWS = 50

// 行悬停 = pane-row 同一款惯例（pane-styles.ts）：可点行的 hover 背景 +
// pointer；停止钮是行动作，hover 才显形（.pane-row-action 同款语义）。
// 之前 className 挂了名却没有样式——悬停零反馈，点得动也看不出来。
const SIDEBAR_STYLES = `
  .routine-run-row { cursor: pointer; transition: background 0.15s; }
  .routine-run-row:hover { background: var(--pm-hover-faint); }
  .routine-run-stop { opacity: 0; pointer-events: none; transition: opacity 0.15s; }
  .routine-run-row:hover .routine-run-stop { opacity: 1; pointer-events: auto; }
`

const BUCKET_ORDER: DateBucket[] = ['today', 'yesterday', 'thisWeek', 'earlier']

/** 归并行：两类 run 的公共投影。 */
interface UnifiedRunRow {
  key: string
  kind: 'routine' | 'workflow'
  id: string
  entityId: string
  name: string
  status: RoutineRun['status']
  triggerText: string
  startedAt: string
  running: boolean
}



export interface UnifiedRunsSidebarProps {
  routines: Routine[]
  onOpenRoutineRun: (routineId: string, runId: string) => void
  /** routine 运行停止后的刷新（routine 行的 settlement 由父级轮询吸收）。 */
  onRoutineChanged: () => void
}

export function UnifiedRunsSidebar({ routines, onOpenRoutineRun, onRoutineChanged }: UnifiedRunsSidebarProps): React.ReactElement {
  const { t } = useTranslation()
  const { modal } = AntdApp.useApp()
  const [routineRuns, setRoutineRuns] = useState<RoutineRun[]>([])
  const [pipelineRuns, setPipelineRuns] = useState<PipelineRun[]>([])
  const [fetchedAt, setFetchedAt] = useState(0)
  const navigate = useNavigationStore((s) => s.navigate)

  const routineNameById = new Map(routines.map((r) => [r.id, r.name]))

  const reload = useCallback(async (): Promise<void> => {
    // WORKFLOW_TASKS_UI=false：workflow 行整族退场（详情路由、停止路由都只在
    // kind='workflow' 的行上），pipeline 那份 feed 也就不必拉——隐藏的功能不该
    // 在时间线上留下可点开的尾巴。
    if (WORKFLOW_TASKS_UI) {
      try {
        const res = (await window.electronAPI.pipelineRuns(undefined, 50)) as { runs?: PipelineRun[] }
        setPipelineRuns(res.runs ?? [])
      } catch { /* 轮询失败静默，下一拍再来 */ }
    }
    try {
      const runs = (await window.electronAPI.routineRuns(undefined, 200)) as RoutineRun[]
      setRoutineRuns(runs ?? [])
      setFetchedAt(Date.now())
    } catch { /* 同上 */ }
  }, [])

  useEffect(() => {
    void reload()
    const timer = setInterval(() => {
      if (!document.hidden) void reload()
    }, RUNS_POLL_MS)
    return () => clearInterval(timer)
  }, [reload])

  // ── 归并：routine 行 + workflow 行，startedAt 倒序，帽 50 ──
  const rows: UnifiedRunRow[] = []
  for (const run of routineRuns) {
    if (run.parentRunId) continue // 批量子行不进时间线（routine 侧既有规则）
    const name = routineNameById.get(run.routineId) ?? run.routineId
    rows.push({
      key: `routine:${run.id}`,
      kind: 'routine',
      id: run.id,
      entityId: run.routineId,
      name,
      status: run.status,
      triggerText: run.batch
        ? `批量 · 成功 ${run.batchProgress?.success ?? 0}/${run.batch.totalRows}`
        : run.trigger === 'schedule' ? t('routine.triggerSchedule') : t('routine.triggerManual'),
      startedAt: run.startedAt,
      running: run.status === 'running',
    })
  }
  for (const run of pipelineRuns) {
    rows.push({
      key: `workflow:${run.id}`,
      kind: 'workflow',
      id: run.id,
      entityId: run.workflowId,
      name: run.workflowName,
      status: run.status, // running/success/failed 是 RUN_STATUS_TAG 的子集
      triggerText: run.trigger === 'schedule' ? t('routine.triggerSchedule') : t('routine.triggerManual'),
      startedAt: run.startedAt,
      running: run.status === 'running',
    })
  }
  rows.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
  // 分组照 RoutineCenter 侧的既有口径：帽 50 + bucketRunByDate 四桶。
  const groups: Record<DateBucket, UnifiedRunRow[]> = { today: [], yesterday: [], thisWeek: [], earlier: [] }
  let count = 0
  for (const row of rows) {
    if (count >= MAX_ROWS) break
    groups[bucketRunByDate(row.startedAt, fetchedAt)].push(row)
    count += 1
  }

  const stopRoutine = (run: RoutineRun): void => {
    modal.confirm({ ...stopRunConfirm(run), okButtonProps: { danger: true }, onOk: () => void stopRoutineRun(run).then(onRoutineChanged).catch(() => {}) })
  }
  const stopWorkflow = async (runId: string): Promise<void> => {
    await window.electronAPI.pipelineStop(runId).catch(() => {})
  }

  return (
    <aside
      data-section="runs"
      style={{
        width: 300, flexShrink: 0, minHeight: 0, display: 'flex', flexDirection: 'column',
        borderLeft: '1px solid var(--pm-border-hairline)', padding: '24px 16px',
      }}
    >
      <style>{SIDEBAR_STYLES}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, minHeight: 32 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--pm-text-strong)' }}>{t('routine.recentRuns')}</span>
      </div>
      <div className="auto-hide-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {rows.length === 0 ? (
          <div style={{ color: 'var(--pm-text-faint)', fontSize: 12, padding: '12px 0' }}>
            {t('routine.recentRunsEmpty')}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {BUCKET_ORDER.map((bucket) => {
              const bucketRows = groups[bucket]
              if (bucketRows.length === 0) return null
              return (
                <div key={bucket}>
                  <div style={{ fontSize: 11, color: 'var(--pm-text-muted)', fontWeight: 600, padding: '10px 4px 6px', textTransform: 'uppercase', letterSpacing: 0.3 }}>
                    {t(bucket === 'today' ? 'routine.bucketToday' : bucket === 'yesterday' ? 'routine.bucketYesterday' : bucket === 'thisWeek' ? 'routine.bucketThisWeek' : 'routine.bucketEarlier')}
                  </div>
                  {bucketRows.map((row) => {
                    const timeText = describeRelativeTimeText(row.startedAt, fetchedAt, t) ?? ''
                    return (
                      <div key={row.key}>
                        <div
                          className="routine-run-row"
                          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 8px', borderRadius: 8 }}
                          onClick={() => {
                            if (row.kind === 'routine') onOpenRoutineRun(row.entityId, row.id)
                            else navigate({ kind: 'routines', workflowRunViewId: row.id })
                          }}
                        >
                          <RunStatusIcon status={row.status} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{
                              fontSize: 12.5, color: row.running ? 'var(--pm-link)' : 'var(--pm-text-strong)',
                              fontWeight: row.running ? 600 : 500,
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            }}>
                              {row.name}
                            </div>
                            <div style={{ fontSize: 11, color: 'var(--pm-text-muted)', display: 'flex', gap: 6, alignItems: 'center' }}>
                              <span>{row.triggerText}</span>
                              {timeText && <span>· {timeText}</span>}
                            </div>
                          </div>
                          {row.running && (
                            <Tooltip title={row.kind === 'routine' ? '停止这次运行' : '停止这次运行'}>
                              <Button
                                type="text"
                                size="small"
                                className="routine-run-stop"
                                icon={<PauseCircleOutlined />}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  if (row.kind === 'routine') {
                                    const run = routineRuns.find((r) => r.id === row.id)
                                    if (run) stopRoutine(run)
                                  } else void stopWorkflow(row.id)
                                }}
                              />
                            </Tooltip>
                          )}
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
      {/* RUN_STATUS_TAG 词汇表被本组件消费（pipeline 状态是其子集）；保留引用
          以防 tree-shaking 把文案表从 RoutineWorkspace 的公共面剥掉。 */}
      <span hidden>{Object.keys(RUN_STATUS_TAG).length}</span>
    </aside>
  )
}
