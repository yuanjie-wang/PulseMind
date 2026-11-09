// ── 统一运行时间线（P3 任务中心）──
// routine_runs + pipeline_runs 两份 feed 归并成一个「最近发生了什么」：
// startedAt 倒序、bucketRunByDate 分组、帽 50、3s 轮询（对齐 RoutineWorkspace
// 的轮询档）。行 = 状态图标（RUN_STATUS_TAG 词汇表，pipeline 状态子集映射进
// 同表）+ 名称 + 触发文案 + 相对时间 + running 停止钮（按 kind 路由：
// routine 走 stop-run.ts，workflow 走 pipelineStop）。
// 点击：routine 行 → openHistory（RoutineWorkspace deep-link 语义不变）；
// workflow 行 → 行内展开（stage 行 + inputs，原 WorkflowSection 展开面迁入）。

import React, { useCallback, useEffect, useState } from 'react'
import { Button, Tooltip } from 'antd'
import { PauseCircleOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { WORKFLOW_TASKS_UI } from '../../feature-flags'
import { App as AntdApp } from 'antd'
import { RunStatusIcon, RUN_STATUS_TAG } from './RoutineWorkspace'
import { stopRunConfirm, stopRoutineRun } from './stop-run'
import { describeRelativeTimeText, bucketRunByDate, type DateBucket } from '../../utils/relative-time'
import type { Routine, RoutineRun } from '../../../../shared/types/routine'
import type { PipelineRun, PipelineStageRun } from '../../../../shared/workflow/types'

const RUNS_POLL_MS = 3_000
const MAX_ROWS = 50

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
  // workflow 行内展开面
  inputs?: Record<string, string>
  objective?: string
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
  const [pipelineStages, setPipelineStages] = useState<PipelineStageRun[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [fetchedAt, setFetchedAt] = useState(0)

  const routineNameById = new Map(routines.map((r) => [r.id, r.name]))

  const reload = useCallback(async (): Promise<void> => {
    // WORKFLOW_TASKS_UI=false：workflow 行整族退场（行内展开、停止路由都只在
    // kind='workflow' 的行上），pipeline 那份 feed 也就不必拉——隐藏的功能不该
    // 在时间线上留下可点开的尾巴。
    if (WORKFLOW_TASKS_UI) {
      try {
        const res = (await window.electronAPI.pipelineRuns(undefined, 50)) as { runs?: PipelineRun[]; stages?: PipelineStageRun[] }
        setPipelineRuns(res.runs ?? [])
        setPipelineStages(res.stages ?? [])
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
      inputs: run.inputs,
      objective: run.objective,
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

  const stagesOf = (runId: string): PipelineStageRun[] => pipelineStages.filter((s) => s.runId === runId)

  return (
    <aside
      data-section="runs"
      style={{
        width: 300, flexShrink: 0, minHeight: 0, display: 'flex', flexDirection: 'column',
        borderLeft: '1px solid var(--pm-border-hairline)', padding: '24px 16px',
      }}
    >
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
                            else setExpanded(expanded === row.key ? null : row.key)
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
                        {/* workflow 行内展开（stage 行 + inputs） */}
                        {row.kind === 'workflow' && expanded === row.key && (
                          <div style={{ margin: '4px 0 6px 24px', display: 'grid', gap: 4, fontSize: 12 }}>
                            {row.inputs && Object.keys(row.inputs).length > 0 && (
                              <div style={{ color: 'var(--pm-text-quiet)' }}>
                                {t('workflow.runInputsSection')}：{Object.entries(row.inputs).map(([k, v]) => `${k}=${v}`).join(' · ')}
                              </div>
                            )}
                            {stagesOf(row.id).map((s) => (
                              <div key={s.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                <span style={{ color: 'var(--pm-text-secondary)' }}>{s.nodeId}</span>
                                {s.verdict && <span style={{ color: s.verdict === 'pass' ? 'var(--pm-success, #52c41a)' : 'var(--pm-warn, #faad14)' }}>{s.verdict}</span>}
                                {s.error && <span style={{ color: 'var(--pm-error, #cf1322)' }}>{s.error}</span>}
                              </div>
                            ))}
                            {stagesOf(row.id).length === 0 && (
                              <span style={{ color: 'var(--pm-text-quiet)' }}>{t('workflow.noStages')}</span>
                            )}
                          </div>
                        )}
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
