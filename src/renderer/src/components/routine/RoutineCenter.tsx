// ── 任务中心（P3 混排，user 2026-11-08 裁定「单列混排，不用区分是哪一种」）──
// routine 与 workflow 的卡片**同壳混排**（无 kind 徽标），按名称排序；右侧
// UnifiedRunsSidebar 是两类运行记录的统一时间线。新建入口 = 向导
// （TaskWizardPage，kind 在向导第一步选）；推荐模板保留（→ 向导 kind=routine）。
// 编辑分叉：routine 走 view.routineEditing（既有参数），workflow 走
// view.workflowEditing——见 navigation/types。
//
// 存储双轨不动：两个 store 的列表在本页组装成一个网格；运行记录的归并/展开/
// 停止都在 UnifiedRunsSidebar 内。

import React, { useCallback, useEffect, useState } from 'react'
import { App as AntdApp, Button, Switch, Tooltip } from 'antd'
import { ClockCircleOutlined, DatabaseOutlined, DeleteOutlined, EditOutlined, ExportOutlined, ImportOutlined, PlayCircleOutlined, PlusOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { notify } from '../../utils/notify'
import { useNavigationStore } from '../../stores/navigationStore'
import { WORKFLOW_TASKS_UI } from '../../feature-flags'
import { checkCron } from '../../../../shared/schedule/cron'
import { describeCron } from '../../utils/schedule-text'
import { RoutineWorkspace } from './RoutineWorkspace'
import { useRoutineRunNow } from './RoutineRunModal'
import { useRoutineBatchRun } from './BatchRunModal'
import { WorkflowBatchModal } from './WorkflowBatchModal'
import { useWorkflowRun } from './WorkflowRunModal'
import { UnifiedRunsSidebar } from './UnifiedRunsSidebar'
import { ShareImportModal } from './ShareImportModal'
import { ROUTINE_TEMPLATES, routineScheduleLabel } from './routine-templates'
import { discardAssistConversation } from '../form-assist/session-lifecycle'
import { formAssistConversationId } from '../form-assist/form-assist'
import { ROUTINE_ASSIST_SPEC } from './routine-assist'
import type { Routine } from '../../../../shared/types/routine'
import type { WorkflowDefinition } from '../../../../shared/workflow/types'
import type { SharePreviewItem } from '../../../../shared/share/types'

export interface RoutineCenterProps {
  /** Deep link (e.g. the welcome page's routine card): open the run-history
   *  workspace for this routine instead of the card grid. */
  runHistoryOf?: string
}

/** Page styles. `.routine-card` / `.routine-template` keep their treatment —
 *  now worn by BOTH kinds (P3 混排同壳). */
const CENTER_STYLES = `
  .routine-card { transition: box-shadow 0.2s, border-color 0.2s; cursor: pointer; min-width: 0; }
  .routine-card:hover { box-shadow: var(--pm-shadow-soft); border-color: var(--pm-border); }
  .routine-pill { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 6px; background: var(--pm-fill); color: var(--pm-text-secondary); font-size: 11px; line-height: 18px; white-space: nowrap; }
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

const TEMPLATE_GRID = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 } as const

/** 执行计划标签（user 2026-11-09：标签只留「执行计划」「批量数据」两个）：
 *  有效 cron 且启用 → 「下次运行：<时刻>」；否则「手动执行」。
 *  `scheduled` 同时决定卡片出不出启用开关——没设定时计划就没有可开关的东西。
 *  停用的定时任务按「手动执行」展示：它此刻确实不会自动跑，停用状态由开关
 *  自身（关）表达，不必再占一个标签。 */
function planOf(enabled: boolean, cron?: string): { scheduled: boolean; planText: string } {
  const expr = cron?.trim() ?? ''
  if (!expr || !checkCron(expr).valid) return { scheduled: false, planText: '手动执行' }
  return { scheduled: true, planText: enabled ? `下次运行：${describeCron(expr) ?? expr}` : '手动执行' }
}

/** One head per section. */
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
  const { modal, message } = AntdApp.useApp()
  const navigate = useNavigationStore((s) => s.navigate)
  const [routines, setRoutines] = useState<Routine[]>([])
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([])
  /** Non-null = the run workspace is open for this task (three-pane mode). */
  const [historyOfId, setHistoryOfId] = useState<string | null>(runHistoryOf ?? null)
  /** A specific run to preselect on first workspace mount. */
  const [initialRunIdForWorkspace, setInitialRunIdForWorkspace] = useState<string | undefined>(undefined)
  const [runNonce, setRunNonce] = useState(0)
  const [batchWorkflow, setBatchWorkflow] = useState<WorkflowDefinition | null>(null)
  // 分享导入（kind 无关：routine 与工作流同一模态）。两阶段——预览拿 token，
  // 提交只回传 token + 分辨率（消毒 payload 留在主进程）。
  const [importOpen, setImportOpen] = useState(false)
  const [importToken, setImportToken] = useState('')
  const [importItems, setImportItems] = useState<SharePreviewItem[]>([])
  const [importError, setImportError] = useState<string | undefined>(undefined)

  const reload = useCallback(async () => {
    try {
      setRoutines(await window.electronAPI.routineList())
      // WORKFLOW_TASKS_UI=false：不拉 workflow 列表（也不渲染卡片/入口）。
      // 数据与 IPC 都还在，翻转开关即恢复。
      if (WORKFLOW_TASKS_UI) {
        const wf = (await window.electronAPI.pipelineWorkflows('list')) as WorkflowDefinition[]
        setWorkflows(wf ?? [])
      }
    } catch (err) {
      console.warn('[RoutineCenter] load failed:', err)
    }
  }, [])

  // eslint-disable-next-line react-hooks/set-state-in-effect -- async data load, setState lands after await
  useEffect(() => { void reload() }, [reload])

  /** Open the wizard (absent id = create; kind 在向导第一步选）。 */
  const openEditor = (routine?: Routine): void => {
    navigate(routine
      ? { kind: 'routines', routineId: routine.id, routineEditing: true }
      : { kind: 'routines', routineEditing: true })
  }
  const openWorkflowEditor = (wf: WorkflowDefinition): void => {
    navigate({ kind: 'routines', workflowId: wf.id, workflowEditing: true })
  }

  const openTemplate = (templateId: string): void => {
    navigate({ kind: 'routines', routineEditing: true, routineTemplateId: templateId })
  }

  /** 分享导入：主进程开文件对话框 → 解析/消毒/校验 → 预览行 + importToken。 */
  const openImport = useCallback(async () => {
    setImportError(undefined)
    const res = await window.electronAPI.shareImportPreview()
      .catch((err: unknown) => ({ canceled: false, error: err instanceof Error ? err.message : String(err) }))
    if (res.canceled) return
    const r = res as { error?: string; importToken?: string; items?: SharePreviewItem[] }
    if (r.error && !r.importToken) {
      message.error(r.error)
      return
    }
    setImportToken(r.importToken ?? '')
    setImportItems(r.items ?? [])
    setImportError(r.error)
    setImportOpen(true)
  }, [message])

  /** 关闭预览：提交与取消都落到这里——重拉一次列表，导入过的行立刻出现。 */
  const closeImport = (): void => {
    setImportOpen(false)
    void reload()
  }

  const openHistory = (routineId: string, runId?: string): void => {
    setInitialRunIdForWorkspace(runId)
    setHistoryOfId(routineId)
  }

  const { runNow, modal: runModal } = useRoutineRunNow((started) => {
    setHistoryOfId(started.id)
    setRunNonce((n) => n + 1)
    void reload()
  })
  const { runBatch, modal: batchModal } = useRoutineBatchRun((started) => {
    setHistoryOfId(started.id)
    setRunNonce((n) => n + 1)
    void reload()
  })
  const { startRun: runWorkflowNow, runModal: workflowRunModal } = useWorkflowRun(() => {
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
        try {
          await window.electronAPI.routineDelete(routine.id)
        } catch (err) {
          notify.error(err instanceof Error ? err.message : '删除失败')
          return
        }
        // The assistant thread dies with its routine — dispose the live
        // main-side session first or a stale engine would hold the context
        // (the editor page did the same before P3 folded it into the wizard).
        await discardAssistConversation(formAssistConversationId(ROUTINE_ASSIST_SPEC.conversationPrefix, routine.id)).catch(() => {})
        void reload()
      },
    })
  }

  const removeWorkflow = (wf: WorkflowDefinition): void => {
    modal.confirm({
      title: `删除「${wf.name}」？`,
      content: '运行历史会一并删除。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await window.electronAPI.pipelineWorkflows('delete', wf.id).catch(() => {})
        void reload()
      },
    })
  }

  const exportItem = (kind: 'routine' | 'workflow', id: string): void => {
    void window.electronAPI.shareExport([{ kind, id }]).then((res) => {
      if (!res.canceled) notify.success(res.path ? `已导出到 ${res.path}` : '已导出')
    }).catch((err: unknown) => notify.error(err instanceof Error ? err.message : String(err)))
  }

  // ── 混排卡片：两类同壳，按名称排序（不区分是哪一种，user 2026-11-08）。 ──
  // 标签只有两个（user 2026-11-09）：执行计划（手动执行 / 下次运行时间）与
  // 批量数据（配了 CSV 才出现）。其余的定时 Tag、最近运行、变量列表一律不展示。
  interface TaskCard {
    key: string
    name: string
    description: string
    /** 标签一「执行计划」。 */
    planText: string
    /** 标签二「批量数据」——只在配了 CSV 时出现。 */
    batchPill: boolean
    /** 设定了有效的定时执行计划 → 卡片才出启用开关（user 2026-11-09）。 */
    scheduled: boolean
    enabled: boolean
    onToggle: (checked: boolean) => void
    onRun: () => void
    onBatch?: () => void
    onEdit: () => void
    onExport: () => void
    onDelete: () => void
    onOpen: () => void
  }
  const cards: TaskCard[] = []
  for (const routine of routines) {
    const plan = planOf(routine.enabled, routine.schedule?.cron)
    cards.push({
      key: `routine:${routine.id}`,
      name: routine.name,
      description: routine.description || (routine.prompt ? `提示词：${routine.prompt}` : ''),
      planText: plan.planText,
      batchPill: !!routine.batch?.csvPath,
      scheduled: plan.scheduled,
      enabled: routine.enabled,
      onToggle: (checked) => {
        window.electronAPI.routineToggle(routine.id, checked)
          .then(() => reload())
          .catch((err: unknown) => {
            notify.error(err instanceof Error ? err.message : '切换启用状态失败')
            reload()
          })
      },
      onRun: () => runNow(routine),
      onBatch: routine.batch?.csvPath ? () => runBatch(routine) : undefined,
      onEdit: () => openEditor(routine),
      onExport: () => exportItem('routine', routine.id),
      onDelete: () => removeRoutine(routine),
      onOpen: () => openHistory(routine.id),
    })
  }
  // WORKFLOW_TASKS_UI=false：workflow 卡片整段不进网格——列表里的既有定义
  // （只在开发机/0.5.x 预览产生过）因此不可见、不可编辑、不可运行。
  if (WORKFLOW_TASKS_UI) for (const wf of workflows) {
    const enabled = wf.enabled !== false
    const plan = planOf(enabled, wf.schedule?.cron)
    cards.push({
      key: `workflow:${wf.id}`,
      name: wf.name,
      description: wf.description || wf.objective || `${wf.nodes.length} 个环节`,
      planText: plan.planText,
      batchPill: !!wf.batch?.csvPath,
      scheduled: plan.scheduled,
      enabled,
      onToggle: (checked) => {
        window.electronAPI.pipelineWorkflows('toggle', { id: wf.id, enabled: checked })
          .then(() => reload())
          .catch((err: unknown) => {
            notify.error(err instanceof Error ? err.message : '切换启用状态失败')
            reload()
          })
      },
      onRun: () => runWorkflowNow(wf),
      onBatch: wf.batch?.csvPath ? () => setBatchWorkflow(wf) : undefined,
      onEdit: () => openWorkflowEditor(wf),
      onExport: () => exportItem('workflow', wf.id),
      onDelete: () => removeWorkflow(wf),
      onOpen: () => openWorkflowEditor(wf),
    })
  }
  cards.sort((a, b) => a.name.localeCompare(b.name))

  return (
    /* flex column：workspace 分支整页接管（height:100% 百分比高度照旧解析）。 */
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--pm-bg)', overflow: 'hidden' }}>
      <style>{CENTER_STYLES}</style>
      {runModal}
      {batchModal}
      {WORKFLOW_TASKS_UI && workflowRunModal}
      {WORKFLOW_TASKS_UI && (
        <WorkflowBatchModal
          workflow={batchWorkflow}
          open={batchWorkflow != null}
          onClose={() => setBatchWorkflow(null)}
          onStarted={() => notify.success(t('workflow.runStarted'))}
        />
      )}
      {/* 分享导入预览（kind 无关：routine 与工作流共用） */}
      <ShareImportModal
        open={importOpen}
        importToken={importToken}
        items={importItems}
        error={importError}
        onClose={closeImport}
      />
      {historyOfId != null ? (
        <RoutineWorkspace
          routines={routines}
          initialRoutineId={historyOfId}
          initialRunId={initialRunIdForWorkspace}
          activeRunNonce={runNonce}
          onBack={() => { setHistoryOfId(null); setInitialRunIdForWorkspace(undefined); void reload() }}
          onEdit={(r) => openEditor(r)}
          onRunNow={runNow}
          onRunBatch={runBatch}
        />
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          {/* ── 左：混排卡片网格 + 推荐模板（列内滚动，user 2026-09-24 裁定） ── */}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0, overflowY: 'auto' }}>
            <section data-section="tasks" style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', padding: '24px 24px 0' }}>
              <SectionHead
                title={t('routine.myTasks')}
                note={cards.length > 0 ? String(cards.length) : undefined}
                action={(
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {/* 导入分享（user 2026-11-09：放在「新建任务」左侧）——空列表
                        也要在：从分享文件起步是这个入口最自然的时刻。空态下没有
                        「新建任务」按钮（卡片是创建面），所以这里只剩导入一颗。 */}
                    <Button icon={<ImportOutlined />} data-action="share-import" onClick={() => void openImport()}>
                      {t('share.import')}
                    </Button>
                    {cards.length > 0 && (
                      <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor()}>
                        {t('routine.createTask')}
                      </Button>
                    )}
                  </div>
                )}
              />
              {cards.length === 0 && (
                <div style={{ color: 'var(--pm-text-muted)', padding: '0 0 16px', fontSize: 13 }}>
                  {t('routine.emptyHint')}
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
                {cards.map((card) => (
                  <div
                    key={card.key}
                    className="routine-card"
                    style={{ display: 'flex', flexDirection: 'column', borderRadius: 12, border: '1px solid var(--pm-border-hairline)', padding: '14px 16px' }}
                    onClick={card.onOpen}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {card.name}
                      </span>
                    </div>
                    <Tooltip title={card.description} styles={{ root: { maxWidth: 420 } }}>
                      <div
                        data-routine-desc
                        style={{
                          fontSize: 12, color: 'var(--pm-text-quiet)', marginTop: 6, minHeight: 36,
                          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                        }}
                      >
                        {card.description}
                      </div>
                    </Tooltip>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                      <span className="routine-pill" data-pill="plan"><ClockCircleOutlined />{card.planText}</span>
                      {card.batchPill && <span className="routine-pill" data-pill="batch"><DatabaseOutlined />批量数据</span>}
                    </div>
                    <div
                      style={{ display: 'flex', alignItems: 'center', gap: 2, marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--pm-border-faint)' }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {card.scheduled && (
                        <Switch size="small" checked={card.enabled} onChange={card.onToggle} data-action="task-toggle" />
                      )}
                      <span style={{ flex: 1 }} />
                      <Tooltip title={card.enabled === false ? '已停用' : '立即运行'}>
                        <Button type="text" disabled={card.enabled === false} icon={<PlayCircleOutlined style={{ fontSize: 17 }} />} onClick={card.onRun} />
                      </Tooltip>
                      {card.onBatch && (
                        <Tooltip title="批量运行（按 CSV 逐行执行）">
                          <Button type="text" icon={<DatabaseOutlined style={{ fontSize: 15 }} />} data-action="batch-run" onClick={card.onBatch} />
                        </Tooltip>
                      )}
                      <Tooltip title="编辑">
                        <Button type="text" icon={<EditOutlined style={{ fontSize: 15 }} />} onClick={card.onEdit} />
                      </Tooltip>
                      <Tooltip title="导出">
                        <Button type="text" icon={<ExportOutlined style={{ fontSize: 15 }} />} data-action="share-export" onClick={card.onExport} />
                      </Tooltip>
                      <Tooltip title="删除">
                        <Button type="text" danger icon={<DeleteOutlined style={{ fontSize: 15 }} />} onClick={card.onDelete} />
                      </Tooltip>
                    </div>
                  </div>
                ))}

                {cards.length === 0 && (
                  <button type="button" data-action="create-task" className="routine-new-card" onClick={() => openEditor()}>
                    <PlusOutlined />
                    {t('routine.createTask')}
                  </button>
                )}
              </div>
            </section>

            <section data-section="templates" style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', padding: '24px 24px 20px' }}>
              <SectionHead title={t('routine.templates')} note={t('routine.templatesHint')} />
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
            </section>
          </div>

          {/* ── 右：统一运行时间线（两类任务归并） ── */}
          <UnifiedRunsSidebar
            routines={routines}
            onOpenRoutineRun={openHistory}
            onRoutineChanged={reload}
          />
        </div>
      )}
    </div>
  )
}

export default RoutineCenter
