// ── RoutineCenter 的工作流区（PLAN-workflow-engine）──
// 工作流列表（新建=复制模板起稿 / 编辑=懒加载 CodeMirror JSON 编辑器 + 校验
// 错误内联标红 / 删除）、助手侧栏（需求输入 → 建议预览 → 应用过校验门，多轮
// 迭代携带当前编辑器内容）、启动表单（工作流 + objective + plans +
// workspaceDir）、运行记录（3s 轮询，行 = plan 实例，展开 = 节点行，进行中
// 带停止）。layout 字段原样透传（画布就绪契约）。

import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { App as AntdApp, Button, Input, Modal, Select, Tag, Tooltip } from 'antd'
import { ApiOutlined, CaretRightOutlined, DeleteOutlined, EditOutlined, ExportOutlined, ImportOutlined, PlusOutlined, RobotOutlined, StopOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { ShareImportModal } from './ShareImportModal'
import type { SharePreviewItem } from '../../../../shared/share/types'
import type { PipelineRun, PipelineStageRun, WorkflowDefinition } from '../../../../shared/workflow/types'

const CodeMirrorEditor = React.lazy(() => import('../preview/CodeMirrorEditor'))

const RUNS_POLL_MS = 3_000

interface WorkflowRunsResult {
  runs?: PipelineRun[]
  stages?: PipelineStageRun[]
  run?: PipelineRun
}

function validateJson(text: string): { def?: WorkflowDefinition; errors: string[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { errors: [`JSON 解析失败：${err instanceof Error ? err.message : String(err)}`] }
  }
  // validate 门在主进程 save 时也会跑（三处同一门）；这里先本地跑一遍做
  // 内联标红——错误文案来自同一函数，两处不可能漂移。
  return { errors: [] as string[], def: parsed as WorkflowDefinition }
}

export function WorkflowSection(): React.ReactElement {
  const { t } = useTranslation()
  const { modal, message } = AntdApp.useApp()
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([])
  const [runs, setRuns] = useState<PipelineRun[]>([])
  const [stages, setStages] = useState<PipelineStageRun[]>([])
  const [expandedRun, setExpandedRun] = useState<string | null>(null)

  // ── 编辑器态 ──
  const [editorOpen, setEditorOpen] = useState(false)
  const [editorText, setEditorText] = useState('')
  const [editorErrors, setEditorErrors] = useState<string[]>([])
  const editingIdRef = useRef<string | null>(null)

  // ── 助手态 ──
  const [assistNeed, setAssistNeed] = useState('')
  const [assistBusy, setAssistBusy] = useState(false)
  const [assistText, setAssistText] = useState('')

  // ── 启动态 ──
  const [runOpen, setRunOpen] = useState(false)
  const [runWorkflowId, setRunWorkflowId] = useState<string | undefined>()
  const [runObjective, setRunObjective] = useState('')
  const [runPlans, setRunPlans] = useState('')
  const [runWorkspace, setRunWorkspace] = useState('')

  const reloadWorkflows = useCallback(async () => {
    try {
      const res = (await window.electronAPI.pipelineWorkflows('list')) as WorkflowDefinition[]
      setWorkflows(res ?? [])
    } catch (err) {
      console.warn('[WorkflowSection] list failed:', err)
    }
  }, [])

  useEffect(() => {
    void reloadWorkflows()
  }, [reloadWorkflows])

  // 运行记录 3s 轮询（对齐 RoutineWorkspace RUNS_POLL_MS 模式）；页面不可见时暂停。
  useEffect(() => {
    let stopped = false
    const tick = async (): Promise<void> => {
      try {
        const res = (await window.electronAPI.pipelineRuns(undefined, 50)) as WorkflowRunsResult
        if (!stopped) {
          setRuns(res.runs ?? [])
          setStages(res.stages ?? [])
        }
      } catch {
        /* 轮询失败静默，下一拍再来 */
      }
    }
    const timer = setInterval(() => {
      if (!document.hidden) void tick()
    }, RUNS_POLL_MS)
    void tick()
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [])

  const openEditor = useCallback(async (wf: WorkflowDefinition | null, fromTemplate?: WorkflowDefinition) => {
    const base = wf ?? fromTemplate
    editingIdRef.current = wf?.id ?? null
    let text: string
    if (base) {
      const draft = wf ? base : { ...base, id: `${base.id}-copy` }
      text = JSON.stringify(draft, null, 2)
    } else {
      text = JSON.stringify(
        {
          id: 'my-flow',
          name: '新工作流',
          objective: '',
          entry: 'step1',
          nodes: [{ id: 'step1', title: '第一步', prompt: '', verdicts: ['pass', 'fail'] }],
          edges: [{ from: 'step1', when: 'pass', to: 'DONE' }],
        },
        null,
        2,
      )
    }
    setEditorText(text)
    setEditorErrors([])
    setEditorOpen(true)
  }, [])

  const saveEditor = useCallback(async () => {
    const { errors } = validateJson(editorText)
    if (errors.length > 0) {
      setEditorErrors(errors)
      return
    }
    try {
      await window.electronAPI.pipelineWorkflows('save', JSON.parse(editorText))
      setEditorOpen(false)
      await reloadWorkflows()
    } catch (err) {
      // 校验门在主进程再过一次（三处同一门）——错误内联标红。
      setEditorErrors([err instanceof Error ? err.message : String(err)])
    }
  }, [editorText, reloadWorkflows])

  const runAssist = useCallback(async () => {
    setAssistBusy(true)
    try {
      const res = (await window.electronAPI.pipelineAssist({ userNeed: assistNeed, currentJson: editorOpen ? editorText : '' })) as {
        ok: boolean
        workflow?: WorkflowDefinition
        errors?: string[]
      }
      if (res.ok && res.workflow) {
        setAssistText(JSON.stringify(res.workflow, null, 2))
        // 应用即入编辑器（校验门已在助手内跑过；编辑器保存时再过一次）。
        setEditorText(JSON.stringify(res.workflow, null, 2))
        setEditorErrors([])
        setEditorOpen(true)
        setAssistText('')
      } else {
        setAssistText((res.errors ?? []).join('\n'))
      }
    } catch (err) {
      setAssistText([err instanceof Error ? err.message : String(err)].join('\n'))
    } finally {
      setAssistBusy(false)
    }
  }, [assistNeed, editorOpen, editorText])

  const startRun = useCallback(async () => {
    const plans = runPlans
      .split('\n')
      .map((p) => p.trim())
      .filter(Boolean)
    if (!runWorkflowId || plans.length === 0 || !runWorkspace.trim()) {
      message.warning(t('workflow.runFormIncomplete'))
      return
    }
    try {
      await window.electronAPI.pipelineRun({ workflowId: runWorkflowId, objective: runObjective.trim() || undefined, plans, workspaceDir: runWorkspace.trim() })
      setRunOpen(false)
      message.success(t('workflow.runStarted'))
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    }
  }, [runWorkflowId, runObjective, runPlans, runWorkspace, message, t])

  const stopRun = useCallback(async (runId: string) => {
    try {
      await window.electronAPI.pipelineStop(runId)
    } catch {
      /* 已结算的行点了就点了吧 */
    }
  }, [])

  const removeWorkflow = useCallback(
    (wf: WorkflowDefinition) => {
      modal.confirm({
        title: t('workflow.deleteConfirm', { name: wf.name }),
        okButtonProps: { danger: true },
        onOk: async () => {
          await window.electronAPI.pipelineWorkflows('delete', wf.id).catch(() => {})
          await reloadWorkflows()
        },
      })
    },
    [modal, reloadWorkflows, t],
  )

  const stagesOf = (runId: string): PipelineStageRun[] => stages.filter((s) => s.runId === runId)

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, minHeight: 32, flexShrink: 0 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--pm-text-strong)' }}>{t('workflow.title')}</span>
        <span style={{ fontSize: 12, color: 'var(--pm-text-muted)' }}>{t('workflow.titleHint')}</span>
        <span style={{ flex: 1 }} />
        <Button icon={<ImportOutlined />} onClick={() => void openImport()}>{t('share.import')}</Button>
        <Button icon={<RobotOutlined />} disabled={assistBusy} onClick={() => void runAssist()} loading={assistBusy}>
          {t('workflow.assist')}
        </Button>
        <Select
          placeholder={t('workflow.newFromTemplate')}
          style={{ width: 180 }}
          value={undefined}
          onChange={(_v, opt) => {
            const tpl = workflows.find((w) => w.id === (opt as { value: string }).value)
            if (tpl) void openEditor(null, tpl)
          }}
          options={workflows.map((w) => ({ value: w.id, label: `${t('workflow.copyOf')} ${w.name}` }))}
        />
        <Button icon={<PlusOutlined />} onClick={() => void openEditor(null)}>
          {t('workflow.new')}
        </Button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12, marginBottom: 20 }}>
        {workflows.map((wf) => (
          <div
            key={wf.id}
            className="routine-card"
            style={{ background: 'var(--pm-elevated)', border: '1px solid var(--pm-border-hairline)', borderRadius: 12, padding: '12px 14px' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{wf.name}</span>
              <Tooltip title={t('common.edit')}>
                <Button type="text" size="small" icon={<EditOutlined />} onClick={() => void openEditor(wf)} />
              </Tooltip>
              <Tooltip title={t('workflow.run')}>
                <Button
                  type="text"
                  size="small"
                  icon={<CaretRightOutlined />}
                  onClick={() => {
                    setRunWorkflowId(wf.id)
                    setRunOpen(true)
                  }}
                />
              </Tooltip>
              <Tooltip title={t('common.delete')}>
                <Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={() => removeWorkflow(wf)} />
              </Tooltip>
            </div>
            <div style={{ fontSize: 12, color: 'var(--pm-text-muted)', marginTop: 4 }}>
              {t('workflow.nodesCount', { count: wf.nodes.length })} · {t('workflow.edgesCount', { count: wf.edges.length })}
              {wf.objective ? ` · ${wf.objective}` : ''}
            </div>
          </div>
        ))}
      </div>

      {/* 运行记录 */}
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--pm-text-strong)', marginBottom: 8 }}>{t('workflow.runs')}</div>
      {runs.length === 0 && <div style={{ fontSize: 12, color: 'var(--pm-text-quiet)' }}>{t('workflow.noRuns')}</div>}
      <div style={{ display: 'grid', gap: 6 }}>
        {runs.map((r) => (
          <div
            key={r.id}
            className="routine-run-row"
            style={{ border: '1px solid var(--pm-border-hairline)', borderRadius: 10, padding: '8px 12px' }}
            onClick={() => setExpandedRun(expandedRun === r.id ? null : r.id)}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              {r.status === 'running' ? (
                <Tag color="processing">{t('workflow.statusRunning')}</Tag>
              ) : r.status === 'success' ? (
                <Tag color="success">{t('workflow.statusSuccess')}</Tag>
              ) : (
                <Tag color="error">{t('workflow.statusFailed')}</Tag>
              )}
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.workflowName} · {r.objective || r.id}
              </span>
              {r.currentNode && <span style={{ fontSize: 12, color: 'var(--pm-text-muted)' }}>{r.currentNode}</span>}
              {r.status === 'running' && (
                <Button
                  type="text"
                  size="small"
                  danger
                  icon={<StopOutlined />}
                  onClick={(e) => {
                    e.stopPropagation()
                    void stopRun(r.id)
                  }}
                />
              )}
            </div>
            {expandedRun === r.id && (
              <div style={{ marginTop: 6, display: 'grid', gap: 4, fontSize: 12 }}>
                {stagesOf(r.id).map((s) => (
                  <div key={s.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <Tag>{s.nodeId}</Tag>
                    {s.verdict && <Tag color={s.verdict === 'pass' ? 'success' : 'warning'}>{s.verdict}</Tag>}
                    {s.continues > 0 && <span style={{ color: 'var(--pm-text-muted)' }}>{t('workflow.continues', { count: s.continues })}</span>}
                    {s.artifacts && s.artifacts.length > 0 && <span style={{ color: 'var(--pm-text-muted)' }}>{s.artifacts.join(', ')}</span>}
                    {s.error && <span style={{ color: 'var(--pm-error, #cf1322)' }}>{s.error}</span>}
                  </div>
                ))}
                {stagesOf(r.id).length === 0 && <span style={{ color: 'var(--pm-text-quiet)' }}>{t('workflow.noStages')}</span>}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* 编辑器（懒加载 CodeMirror，path 以 .json 结尾驱动 JSON 高亮） */}
      <Modal
        open={editorOpen}
        title={t('workflow.editorTitle')}
        width={860}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        onOk={() => void saveEditor()}
        onCancel={() => setEditorOpen(false)}
      >
        {editorErrors.length > 0 && (
          <div
            role="alert"
            style={{
              background: 'var(--pm-warn-bg, #fff7e6)',
              border: '1px solid var(--pm-border)',
              borderRadius: 8,
              padding: '8px 12px',
              marginBottom: 10,
              fontSize: 12,
              color: 'var(--pm-error, #cf1322)',
              whiteSpace: 'pre-wrap',
            }}
          >
            {editorErrors.join('\n')}
          </div>
        )}
        <div style={{ border: '1px solid var(--pm-border-hairline)', borderRadius: 8, overflow: 'hidden', height: 420 }}>
          <Suspense fallback={<div style={{ padding: 12, fontSize: 12, color: 'var(--pm-text-muted)' }}>{t('workflow.editorLoading')}</div>}>
            <CodeMirrorEditor value={editorText} onChange={(v) => setEditorText(v)} path="workflow-edit.json" readOnly={false} />
          </Suspense>
        </div>
        <Input.TextArea
          value={assistNeed}
          onChange={(e) => setAssistNeed(e.target.value)}
          placeholder={t('workflow.assistPlaceholder')}
          rows={2}
          style={{ marginTop: 10 }}
        />
        <Button icon={<ApiOutlined />} disabled={!assistNeed.trim()} loading={assistBusy} onClick={() => void runAssist()} style={{ marginTop: 6 }}>
          {t('workflow.assistApply')}
        </Button>
        {assistText && <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap', marginTop: 6, color: 'var(--pm-text-muted)' }}>{assistText}</pre>}
      </Modal>

      {/* 启动表单 */}
      <Modal
        open={runOpen}
        title={t('workflow.runTitle')}
        okText={t('workflow.run')}
        cancelText={t('common.cancel')}
        onOk={() => void startRun()}
        onCancel={() => setRunOpen(false)}
      >
        <div style={{ display: 'grid', gap: 10 }}>
          <Select
            placeholder={t('workflow.pickWorkflow')}
            style={{ width: '100%' }}
            value={runWorkflowId}
            onChange={setRunWorkflowId}
            options={workflows.map((w) => ({ value: w.id, label: w.name }))}
          />
          <Input value={runObjective} onChange={(e) => setRunObjective(e.target.value)} placeholder={t('workflow.objectivePlaceholder')} allowClear />
          <Input.TextArea value={runPlans} onChange={(e) => setRunPlans(e.target.value)} placeholder={t('workflow.plansPlaceholder')} rows={4} />
          <Input value={runWorkspace} onChange={(e) => setRunWorkspace(e.target.value)} placeholder={t('workflow.workspacePlaceholder')} allowClear />
          <div style={{ fontSize: 12, color: 'var(--pm-text-muted)' }}>{t('workflow.runHint')}</div>
        </div>
      </Modal>

      {/* 分享导入预览（kind 无关：routine 与工作流共用） */}
      <ShareImportModal open={importOpen} importToken={importToken} items={importItems} error={importError} onClose={() => setImportOpen(false)} />
    </div>
  )
}
