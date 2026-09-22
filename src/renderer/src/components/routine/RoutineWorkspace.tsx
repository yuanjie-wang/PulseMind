// ── Routine run workspace (PLAN-0.4.0 M4.3 revision) ──
// Three-pane run inspector entered from the card grid's 运行历史 action or
// right after 立即运行: task list · run history (latest selected by default) ·
// the selected run's conversation. The conversation pane is a real hosted
// session view: a running run streams in live via the session event mirror,
// and the composer underneath lets the user continue the conversation after
// the automated prompt — same transcript/composer components as the main chat.

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { App as AntdApp, Button, Dropdown, Progress, Spin, Tooltip } from 'antd'
import {
  ArrowLeftOutlined,
  CheckCircleFilled,
  ClearOutlined,
  CloseCircleFilled,
  DatabaseOutlined,
  DeleteOutlined,
  EditOutlined,
  ExclamationCircleFilled,
  LoadingOutlined,
  MinusCircleOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
} from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { notify } from '../../utils/notify'
import { useSettings } from '../../hooks/SettingsContext'
import { retentionOptions } from '../settings/retention-options'
import { useHostedAgentSession } from '../../hooks/useHostedAgentSession'
import { TranscriptView } from '../chat/TranscriptView'
import { InputArea } from '../chat/InputArea'
import { describeRelativeTimeText } from '../../utils/relative-time'
import { PANE_ROW_STYLES } from './pane-styles'
import type { Routine, RoutineRun } from '../../../../shared/types/routine'
import type { MenuProps } from 'antd'

/** How often run rows (statuses, newly fired scheduled runs) are refreshed. */
const RUNS_POLL_MS = 3000

// Retention choices are shared with conversation management and the settings page's 数据清理.

export const RUN_STATUS_TAG: Record<RoutineRun['status'], { color?: string; text: string }> = {
  running: { color: 'processing', text: '运行中' },
  success: { color: 'success', text: '成功' },
  failed: { color: 'error', text: '失败' },
  skipped: { text: '已跳过' },
  // Batch parents only: some rows succeeded, some failed — neither 全绿 nor
  // 全红 is honest about that.
  partial: { color: 'warning', text: '部分成功' },
}

/** Status as a glyph — a run list scans better as a column of icons than as
 *  text tags; the wording survives in the tooltip. Exported so the routines
 *  landing page's "recent runs" sidebar can reuse the same column of glyphs
 *  without duplicating the colour/shape vocabulary. */
// The success/failure glyph hues stay literals on purpose (the same judgment
// as the plan graph's): antd's green-6/red-5 carry enough contrast on a dark
// ground as-is, and the run list's status column must not shift hue with the
// theme — only the neutral ink around it does.
export const RUN_STATUS_ICONS: Record<RoutineRun['status'], React.ReactNode> = {
  running: <LoadingOutlined spin style={{ color: 'var(--pm-link)' }} />,
  success: <CheckCircleFilled style={{ color: '#52c41a' }} />,
  failed: <CloseCircleFilled style={{ color: '#ff4d4f' }} />,
  skipped: <MinusCircleOutlined style={{ color: 'var(--pm-text-faint)' }} />,
  partial: <ExclamationCircleFilled style={{ color: '#faad14' }} />,
}

export function RunStatusIcon({ status }: { status: RoutineRun['status'] }): React.ReactElement {
  return (
    <Tooltip title={RUN_STATUS_TAG[status].text}>
      <span style={{ fontSize: 15, lineHeight: 1, display: 'inline-flex', cursor: 'default' }}>
        {RUN_STATUS_ICONS[status]}
      </span>
    </Tooltip>
  )
}

export interface RoutineWorkspaceProps {
  routines: Routine[]
  /** Task preselected when entering the workspace (the card that was clicked). */
  initialRoutineId: string
  /** A specific run to preselect on first mount — passed when the user clicks a
   *  run row in the landing sidebar. If absent (or no longer present), the
   *  newest run is selected, matching the "open a card" path. */
  initialRunId?: string
  /** Bumped by the parent whenever a new run starts — refetch and select the
   *  fresh run (the card-grid 立即运行 can fire while this pane is open). */
  activeRunNonce?: number
  onBack: () => void
  onEdit: (routine: Routine) => void
  onRunNow: (routine: Routine) => void
  /** Opens the batch start dialog (BatchRunModal) — the workspace only hosts
   *  the entry; the dialog and the IPC live with the landing page's hook. */
  onRunBatch: (routine: Routine) => void
}

export function RoutineWorkspace({ routines, initialRoutineId, initialRunId, activeRunNonce, onBack, onEdit, onRunNow, onRunBatch }: RoutineWorkspaceProps): React.ReactElement {
  const { t } = useTranslation()
  const { modal } = AntdApp.useApp()
  const { settings, saveSettings } = useSettings()
  const [routineId, setRoutineId] = useState(initialRoutineId)
  const [runs, setRuns] = useState<RoutineRun[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  /** When runs were fetched — render stays pure by not calling Date.now(). */
  const [runsFetchedAt, setRunsFetchedAt] = useState(0)

  const routine = routines.find((r) => r.id === routineId) ?? null
  const selectedRun = runs.find((r) => r.id === selectedRunId) ?? null
  const selectedConvId = selectedRun?.conversationId
  /** The runner-driven phase owns the loop; the composer parks while it runs. */
  const unattended = selectedRun?.status === 'running'
  const retentionDays = settings.routineRunRetentionDays ?? 0

  /** Fetch a task's runs, selecting `preferRunId` when still present, else the
   *  newest (list comes back newest-first). */
  const openRuns = useCallback(async (id: string, preferRunId?: string): Promise<void> => {
    const list = await window.electronAPI.routineRuns(id, 30).catch(() => [] as RoutineRun[])
    setRuns(list)
    setRunsFetchedAt(Date.now())
    const next = (preferRunId ? list.find((r) => r.id === preferRunId) : undefined) ?? list[0] ?? null
    setSelectedRunId(next?.id ?? null)
  }, [])

  // First mount honours an `initialRunId` (a run-row click from the landing
  // sidebar) — selecting that run if it is still present, else the newest.
  // Subsequent routine switches from the left pane fall back to the newest, so
  // a stale initialRunId from the entry card never leaks onto another task.
  const didInitRef = useRef(false)
  // eslint-disable-next-line react-hooks/set-state-in-effect -- async run-list load, setState lands after await
  useEffect(() => {
    const prefer = !didInitRef.current ? initialRunId : undefined
    didInitRef.current = true
    void openRuns(routineId, prefer)
  }, [routineId, openRuns, initialRunId])

  // Light poll of the runs list: status transitions and scheduled fires show
  // up without a manual refresh.
  useEffect(() => {
    const timer = setInterval(() => { void openRuns(routineId, selectedRunId ?? undefined) }, RUNS_POLL_MS)
    return () => clearInterval(timer)
  }, [routineId, selectedRunId, openRuns])

  // A run started from elsewhere (card grid 立即运行 / scheduler while open):
  // jump to the newest run.
  const lastNonceRef = useRef(activeRunNonce ?? 0)
  useEffect(() => {
    const nonce = activeRunNonce ?? 0
    if (nonce === lastNonceRef.current) return
    lastNonceRef.current = nonce
    void openRuns(routineId)
  }, [activeRunNonce, routineId, openRuns])

  const refresh = (): void => {
    setRefreshing(true)
    void openRuns(routineId, selectedRunId ?? undefined).finally(() => setRefreshing(false))
  }

  /** Refetch keeping the current selection when it survived (falls back to the
   *  newest run when it was the one just deleted). */
  const refreshKeeping = (goneRunId?: string): Promise<void> =>
    openRuns(routineId, goneRunId && goneRunId === selectedRunId ? undefined : selectedRunId ?? undefined)

  // ── Cleanup (手动清理 + 保留策略) ──

  const removeRun = (run: RoutineRun): void => {
    modal.confirm({
      title: '删除这条运行记录？',
      content: '该次运行产生的对话也会一并删除。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await window.electronAPI.routineRunDelete(run.id)
        await refreshKeeping(run.id)
      },
    })
  }

  const clearRuns = (): void => {
    modal.confirm({
      title: `清空「${routine?.name ?? '当前任务'}」的运行历史？`,
      content: '已结束的运行记录和它们的对话都会被删除；进行中的运行会保留（批量则连同其全部行）。',
      okText: '清空',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        const removed = await window.electronAPI.routineRunsClear(routineId)
        notify.success(`已清理 ${removed} 条运行记录`)
        await openRuns(routineId)
      },
    })
  }

  /** Persist the retention policy — enforced at every app start (see
   *  routine-scheduler), so the saved value is the whole contract. */
  const setRetention = async (days: number): Promise<void> => {
    if (days === retentionDays) return
    try {
      await saveSettings({ ...settings, routineRunRetentionDays: days })
      notify.success(days === 0 ? '已改为永久保留运行记录' : `启动时自动清理 ${days} 天前的运行记录`)
    } catch (err) {
      notify.error(err instanceof Error ? err.message : String(err))
    }
  }

  const pruneNow = async (): Promise<void> => {
    const removed = await window.electronAPI.routineRunsPrune().catch(() => 0)
    notify.success(removed > 0 ? `已清理 ${removed} 条过期记录` : '没有需要清理的过期记录')
    await refreshKeeping()
  }

  const cleanupMenu: MenuProps = {
    items: [
      {
        key: 'retention',
        type: 'group',
        label: '自动清理（全部任务）',
        children: retentionOptions(t).map((o) => ({
          key: `retention:${o.days}`,
          label: o.days === retentionDays ? `✓ ${o.label}` : o.label,
        })),
      },
      { type: 'divider' },
      { key: 'prune', label: '立即清理过期记录', icon: <ClearOutlined />, disabled: retentionDays === 0 },
      { key: 'clear', label: '清空当前任务的记录', icon: <DeleteOutlined />, danger: true },
    ],
    onClick: ({ key }) => {
      if (key.startsWith('retention:')) void setRetention(Number(key.slice('retention:'.length)))
      else if (key === 'prune') void pruneNow()
      else if (key === 'clear') clearRuns()
    },
  }

  const scheduleText = (r: Routine): string =>
    r.enabled ? (r.schedule ? '定时' : '手动') : '已停用'

  return (
    <div style={{ height: '100%', display: 'flex', background: 'var(--pm-bg)', overflow: 'hidden' }}>
      <style>{PANE_ROW_STYLES}</style>
      {/* Left — task list */}
      <div style={{ width: 232, borderRight: '1px solid var(--pm-border-hairline)', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '12px 12px 8px' }}>
          <Tooltip title="返回任务卡片">
            <Button type="text" size="small" icon={<ArrowLeftOutlined />} onClick={onBack} />
          </Tooltip>
          <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>日常任务</span>
        </div>
        {/* 运行/批量/编辑在每一行内（悬停显示），按钮作用于它所在的那一行，
            不再放在列表头部作用于「当前选中」而引起误解。 */}
        <div style={{ flex: 1, overflow: 'auto', padding: '0 8px 12px' }}>
          {routines.map((r) => {
            const active = r.id === routineId
            return (
              <div
                key={r.id}
                className={`pane-row${active ? ' pane-row--active' : ''}`}
                style={{ marginBottom: 2 }}
                onClick={() => setRoutineId(r.id)}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                  <div style={{
                    flex: 1, minWidth: 0,
                    fontSize: 13, fontWeight: active ? 600 : 400,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {r.name}
                  </div>
                  <Tooltip title="立即运行">
                    <Button
                      className="pane-row-action"
                      type="text"
                      size="small"
                      icon={<PlayCircleOutlined style={{ fontSize: 12 }} />}
                      onClick={(e) => { e.stopPropagation(); setRoutineId(r.id); onRunNow(r) }}
                    />
                  </Tooltip>
                  {!!r.batch?.csvPath && (
                    <Tooltip title="批量运行（按 CSV 逐行执行）">
                      <Button
                        className="pane-row-action"
                        type="text"
                        size="small"
                        icon={<DatabaseOutlined style={{ fontSize: 12 }} />}
                        onClick={(e) => { e.stopPropagation(); setRoutineId(r.id); onRunBatch(r) }}
                      />
                    </Tooltip>
                  )}
                  <Tooltip title="编辑">
                    <Button
                      className="pane-row-action"
                      type="text"
                      size="small"
                      icon={<EditOutlined style={{ fontSize: 12 }} />}
                      onClick={(e) => { e.stopPropagation(); onEdit(r) }}
                    />
                  </Tooltip>
                </div>
                <div style={{ fontSize: 11, color: 'var(--pm-text-soft)', marginTop: 2 }}>{scheduleText(r)}</div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Middle — run history of the selected task */}
      <div style={{ width: 300, borderRight: '1px solid var(--pm-border-hairline)', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '12px 14px 8px' }}>
          <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>运行历史</span>
          <Tooltip title="刷新运行记录">
            <Button type="text" size="small" icon={refreshing ? <Spin size="small" /> : <ReloadOutlined />} onClick={refresh} />
          </Tooltip>
          <Dropdown menu={cleanupMenu} trigger={['click']} placement="bottomRight">
            <Button type="text" size="small" title="清理运行历史与保留策略" icon={<ClearOutlined />} />
          </Dropdown>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: '0 10px 12px' }}>
          {runs.length === 0 && <div style={{ color: 'var(--pm-text-muted)', fontSize: 12, padding: '8px 4px' }}>还没有运行记录。</div>}
          {runs.map((run) => {
            const active = run.id === selectedRunId
            return (
              <div
                key={run.id}
                className={`pane-row${active ? ' pane-row--active' : ''}`}
                style={{ marginBottom: 4 }}
                onClick={() => setSelectedRunId(run.id)}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <RunStatusIcon status={run.status} />
                  <span style={{ fontSize: 13, color: 'var(--pm-ink)' }}>
                    {run.batch ? `批量 · ${run.batch.totalRows} 行` : run.trigger === 'schedule' ? '定时' : '手动'}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--pm-text-faint)', marginInlineStart: 'auto' }}>
                    {describeRelativeTimeText(run.startedAt, runsFetchedAt, t) ?? new Date(run.startedAt).toLocaleString()}
                  </span>
                  <Tooltip title={run.status === 'running' ? '运行中，结束后可删除' : '删除这条记录'}>
                    <Button
                      className="pane-row-action"
                      type="text"
                      size="small"
                      danger
                      disabled={run.status === 'running'}
                      icon={<DeleteOutlined style={{ fontSize: 12 }} />}
                      onClick={(e) => { e.stopPropagation(); removeRun(run) }}
                    />
                  </Tooltip>
                </div>
                {run.error && (
                  <div style={{
                    fontSize: 11, color: 'var(--pm-error)', marginTop: 4,
                    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                  }}>
                    {run.error}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Right — the selected run: a batch parent shows its per-row table
          (clicking a row drills into that row's conversation); a single run
          goes straight to the conversation (live while running, and the user
          can continue it once the automated prompt is done). */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {selectedRun?.batch ? (
          <BatchRunView key={selectedRun.id} run={selectedRun} routine={routine} />
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 20px', borderBottom: '1px solid var(--pm-border-hairline)' }}>
              {selectedRun ? (
                <>
                  <RunStatusIcon status={selectedRun.status} />
                  <span style={{ fontSize: 12, color: 'var(--pm-text-quiet)' }}>{selectedRun.trigger === 'schedule' ? '定时触发' : '手动触发'}</span>
                  <span style={{ fontSize: 12, color: 'var(--pm-text-faint)' }}>{new Date(selectedRun.startedAt).toLocaleString()}</span>
                </>
              ) : (
                <span style={{ fontSize: 12, color: 'var(--pm-text-muted)' }}>选择一次运行记录查看对话</span>
              )}
            </div>
            <RunTranscript
              key={selectedConvId ?? 'none'}
              convId={selectedConvId}
              routine={routine}
              unattended={unattended}
            />
          </>
        )}
      </div>
    </div>
  )
}

interface RunTranscriptProps {
  /** The run's conversation; undefined = nothing inspectable. */
  convId: string | undefined
  /** Owning task (session title + persistence label). */
  routine: Routine | null
  /** True while the runner owns the loop — composer parked, stop hidden. */
  unattended: boolean
}

/** The selected run's conversation: a session-mirror view of the main-hosted
 *  engine plus a composer to continue it. Keyed by conversation id upstream, so
 *  switching runs mounts a fresh mirror instead of leaking the previous
 *  session's transcript. The attach/restore/persist protocol lives in the
 *  shared useHostedAgentSession; this component only adds the run-specific
 *  view (unattended parking, empty hints). */
function RunTranscript({ convId, routine, unattended }: RunTranscriptProps): React.ReactElement {
  const { settings, switchProfile } = useSettings()
  const title = routine ? `[日常] ${routine.name}` : '[日常] 任务'
  const session = useHostedAgentSession({
    convId: convId ?? null,
    title,
    createOptions: { clientId: 'routine' },
  })
  const isBusy = session.isBusy

  const emptyHint = session.restoring
    ? ''
    : unattended && session.messages.length === 0
      ? '任务已启动，等待模型输出…'
      : convId ? '该记录没有保存对话内容。' : '该记录没有可回看的对话。'

  return (
    <>
      <TranscriptView
        messages={session.messages}
        agentStatus={session.agentStatus}
        streamingBlocks={session.streamingBlocks}
        isRequesting={isBusy}
        restoring={session.restoring}
        emptyHint={emptyHint}
        onApproveTool={(id) => session.engineCall('approveTool', id)}
        onRejectTool={(id) => session.engineCall('rejectTool', id)}
        onKillTool={(id) => session.engineCall('killTool', id)}
        onRespondToTool={(id, response) => session.engineCall('respondToTool', id, response)}
        onClearError={() => session.engineCall('clearError')}
        onRetry={() => session.engineCall('retryLastTurn')}
      />
      {convId && (
        unattended ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 24px 20px', fontSize: 12, color: 'var(--pm-text-muted)' }}>
            <Spin size="small" />
            任务执行中，结束后可以继续追问
          </div>
        ) : (
          <div style={{ padding: '8px 24px 20px' }}>
            <InputArea
              layout="inline"
              isRequesting={isBusy}
              isStreaming={isBusy}
              isAwaitingApproval={session.agentStatus.status === 'awaiting_approval'}
              isAwaitingInput={session.agentStatus.status === 'awaiting_user_input'}
              hasMessages={session.messages.length > 0}
              onSendMessage={(content) => session.send(content)}
              onCancel={session.cancel}
              profiles={settings.profiles}
              activeProfileId={settings.activeProfileId}
              onSelectProfile={(profileId) => {
                // The engine rebuilds its options main-side; signal the
                // session so the next ask uses the newly selected model.
                void switchProfile(profileId).then(() => session.refreshOptions())
              }}
              features={{ modelPicker: true, authorization: true }}
              approvalMode={session.approvalMode}
              onChangeApprovalMode={session.setApprovalMode}
            />
          </div>
        )
      )}
    </>
  )
}

// ── Batch run view (PLAN-routine-batch M6) ──
// A batch PARENT run's pane: live progress over the per-row table, stop while
// running, and a drill-in — clicking a row swaps the table for that row's
// conversation (the same RunTranscript a single run gets, so a streaming row
// is live here too). Items refresh on the same 3s poll as the runs list; the
// parent row in the middle pane carries `batchProgress` computed main-side.

function BatchRunView({ run, routine }: { run: RoutineRun; routine: Routine | null }): React.ReactElement {
  const { t } = useTranslation()
  const { modal } = AntdApp.useApp()
  const [items, setItems] = useState<RoutineRun[]>([])
  const [itemsFetchedAt, setItemsFetchedAt] = useState(0)
  /** The drilled-in row, tagged with the run it belongs to — a run switch
   *  therefore resets the view by derivation, without an effect writing state. */
  const [selection, setSelection] = useState<{ runId: string; itemId: string } | null>(null)

  const openItems = useCallback(async (parentId: string): Promise<void> => {
    const list = await window.electronAPI.routineBatchItems(parentId).catch(() => [] as RoutineRun[])
    setItems(list)
    setItemsFetchedAt(Date.now())
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async item load, setState lands after the IPC await
    void openItems(run.id)
  }, [run.id, openItems])

  const running = run.status === 'running'
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => { void openItems(run.id) }, RUNS_POLL_MS)
    return () => clearInterval(timer)
  }, [running, run.id, openItems])

  const selectedChild = selection?.runId === run.id
    ? items.find((i) => i.id === selection.itemId) ?? null
    : null
  const progress = run.batchProgress
  const total = progress?.total ?? run.batch?.totalRows ?? 0
  const settledCount = total - (progress?.running ?? 0)
  const percent = total > 0 ? Math.round((settledCount / total) * 100) : 0

  const stop = (): void => {
    modal.confirm({
      title: '停止这次批量运行？',
      content: '未开始的行将标记为已跳过，正在运行的行会被中止。',
      okText: '停止',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await window.electronAPI.routineBatchStop(run.id)
        await openItems(run.id)
      },
    })
  }

  /** Re-run one failed row with the values it originally ran with (the
   *  snapshot, not the CSV — the file may have changed). It comes back as an
   *  ordinary single run in the history, not a member of this batch. */
  const retryRow = (item: RoutineRun): void => {
    if (!routine) return
    void window.electronAPI.routineRun(routine.id, item.paramsSnapshot)
      .then(() => notify.success(`已重新运行第 ${(item.rowIndex ?? 0) + 1} 行，可在运行历史中查看`))
      .catch((err) => notify.error(err instanceof Error ? err.message : String(err)))
  }

  const durationText = (item: RoutineRun): string => {
    if (!item.finishedAt) return '—'
    const seconds = Math.round((Date.parse(item.finishedAt) - Date.parse(item.startedAt)) / 1000)
    return seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`
  }

  const summaryOf = (item: RoutineRun): string => {
    const params = routine?.params ?? []
    const pairs: string[] = []
    for (const p of params) {
      const value = item.paramsSnapshot?.[p.key]
      if (value) pairs.push(value)
      if (pairs.length >= 2) break
    }
    return pairs.join(' · ')
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {/* Header — status, batch meta, live progress, and 停止 while running */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 20px', borderBottom: '1px solid var(--pm-border-hairline)' }} data-batch-header>
        {selectedChild ? (
          <Tooltip title="返回行列表">
            <Button type="text" size="small" icon={<ArrowLeftOutlined />} onClick={() => setSelection(null)} />
          </Tooltip>
        ) : (
          <RunStatusIcon status={run.status} />
        )}
        <span style={{ fontSize: 12, color: 'var(--pm-text-quiet)' }}>
          {selectedChild
            ? `第 ${(selectedChild.rowIndex ?? 0) + 1} 行 · ${run.batch?.csvName ?? ''}`
            : `批量运行 · ${run.batch?.csvName ?? ''} · 并发 ${run.batch?.concurrency ?? '—'}`}
        </span>
        {!selectedChild && total > 0 && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }} data-batch-progress>
            <Progress percent={percent} size="small" showInfo={false} style={{ width: 140, margin: 0 }} />
            <span style={{ fontSize: 12, color: 'var(--pm-text-muted)', whiteSpace: 'nowrap' }}>
              成功 {progress?.success ?? 0} / 失败 {progress?.failed ?? 0}
              {(progress?.skipped ?? 0) > 0 ? ` / 跳过 ${progress!.skipped}` : ''}
              {running ? ` · 共 ${total} 行` : ` · 共 ${total} 行`}
            </span>
          </span>
        )}
        {!selectedChild && <span style={{ flex: 1 }} />}
        {selectedChild && <span style={{ flex: 1 }} />}
        {!selectedChild && running && (
          <Button size="small" icon={<PauseCircleOutlined />} onClick={stop}>停止批量</Button>
        )}
      </div>

      {selectedChild ? (
        <RunTranscript
          key={selectedChild.conversationId ?? 'none'}
          convId={selectedChild.conversationId}
          routine={routine}
          unattended={selectedChild.status === 'running'}
        />
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '10px 20px 16px' }} data-batch-items>
          {items.length === 0 && (
            <div style={{ color: 'var(--pm-text-muted)', fontSize: 12, padding: '8px 4px' }}>
              {running ? '正在派发…' : '没有行记录。'}
            </div>
          )}
          {items.map((item) => {
            const rowNo = (item.rowIndex ?? 0) + 1
            return (
              <div
                key={item.id}
                className="pane-row"
                style={{ marginBottom: 4, padding: '7px 10px' }}
                onClick={() => item.conversationId && setSelection({ runId: run.id, itemId: item.id })}
                data-batch-row={rowNo}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <RunStatusIcon status={item.status} />
                  <span style={{ fontSize: 13, color: 'var(--pm-ink)', flexShrink: 0 }}>第 {rowNo} 行</span>
                  <span style={{ fontSize: 12, color: 'var(--pm-text-soft)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                    {summaryOf(item)}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--pm-text-faint)', flexShrink: 0 }}>
                    {describeRelativeTimeText(item.startedAt, itemsFetchedAt, t) ?? ''}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--pm-text-faint)', flexShrink: 0 }}>{durationText(item)}</span>
                  {item.status === 'failed' && (
                    <Tooltip title="用该行参数重新运行（单次运行）">
                      <Button
                        className="pane-row-action"
                        type="text"
                        size="small"
                        icon={<ReloadOutlined style={{ fontSize: 12 }} />}
                        onClick={(e) => { e.stopPropagation(); retryRow(item) }}
                      />
                    </Tooltip>
                  )}
                </div>
                {item.error && (
                  <div style={{
                    fontSize: 11, color: 'var(--pm-error)', marginTop: 4,
                    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                  }}>
                    {item.error}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
