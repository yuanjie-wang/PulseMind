// ── 工作流启动模态（P3 任务中心：自 WorkflowSection 抽出，列表已并入
// RoutineCenter 混排卡片；本文件只承载「运行一个工作流」的表单）──
// 字段按权重排：workspaceDir（唯一硬门，带目录浏览）→ 动态 inputs →
// 授权/模型参数级覆盖 → pipelineRun（P1 launch 路径）。
// plans 输入区已撤（user 2026-11-18）：手动启动恒单实例（plans: []）；
// plan 实例仍活在续跑/运行视图那条线上，不从这张表单进。
// 全局目标栏位同日撤除：运行不带 objective，引擎解析序（运行级 > 工作流级
// > 空）原样保留，工作流级目标照常生效。启动后由调用方刷新。

import React, { useCallback, useState } from 'react'
import { App as AntdApp, Button, Input, Modal, Select } from 'antd'
import { useTranslation } from '../../i18n/useTranslation'
import { useSettings } from '../../hooks/SettingsContext'
import type { WorkflowDefinition } from '../../../../shared/workflow/types'

/** 授权档三档（RoutineForm 同表、同文案）。 */
export const WORKFLOW_APPROVAL_OPTIONS = [
  { value: 'always-ask', label: '始终询问' },
  { value: 'outside-ask', label: '按需确认' },
  { value: 'auto', label: '全部允许' },
]

export function useWorkflowRun(onStarted?: () => void): { startRun: (workflow: WorkflowDefinition) => void; runModal: React.ReactNode } {
  const { t } = useTranslation()
  const { message } = AntdApp.useApp()
  const [runOpen, setRunOpen] = useState(false)
  const [runWorkflow, setRunWorkflowState] = useState<WorkflowDefinition | undefined>()
  const [runWorkspace, setRunWorkspace] = useState('')
  // 自定义输入变量取值（plan 去预设化：按工作流的 inputs 声明动态渲染）。
  const [runVars, setRunVars] = useState<Record<string, string>>({})
  // 授权档/模型的参数级覆盖（P1 任务共享内核：空 = 用工作流定义/缺省）。
  const [runApproval, setRunApproval] = useState<string | undefined>()
  const [runProfileId, setRunProfileId] = useState<string | undefined>()
  // 提交在途 + 首次尝试标记：前者给 confirmLoading 的视觉与重入门（await
  // 主进程校验/建会话的慢路径上双击「运行」不能铸两个实例），后者让必填
  // 标红只作为提交反馈出现——浮窗打开时工作区必然是空的，常红是噪音。
  const [runSubmitting, setRunSubmitting] = useState(false)
  const [runAttempted, setRunAttempted] = useState(false)
  const { settings } = useSettings()
  const models = settings.profiles.map((p) => ({ id: p.id, name: p.name, providerName: p.providerName }))
  const activeModelId = settings.activeProfileId
  const currentModelName = models.find((p) => p.id === activeModelId)?.name

  const startRun = useCallback((workflow: WorkflowDefinition): void => {
    // 参数级覆盖每次打开都从空起（= 用定义/缺省）。
    setRunApproval(undefined)
    setRunProfileId(undefined)
    // 变量默认值预填（user 2026-11-08：两种模式的变量声明同形，default 同义）。
    setRunVars(Object.fromEntries((workflow.inputs ?? []).filter((i) => i.default).map((i) => [i.key, i.default as string])))
    setRunWorkspace('')
    setRunSubmitting(false)
    setRunAttempted(false)
    setRunWorkflowState(workflow)
    setRunOpen(true)
  }, [])

  // 目录浏览与 RoutineForm/ProjectModal 同一惯例（best-effort：弹窗失败
  // 不动输入框，手输永远是兜底）。
  const pickWorkspaceDir = async (): Promise<void> => {
    try {
      const res = await window.electronAPI.showOpenDialog({ properties: ['openDirectory'] })
      if (!res.canceled && res.filePaths[0]) setRunWorkspace(res.filePaths[0])
    } catch { /* dialog is best-effort; the input stays hand-editable */ }
  }

  const submitRun = useCallback(async () => {
    if (runSubmitting) return
    setRunAttempted(true)
    // 只有工作区目录与 required 输入是硬门（主进程同门再过一遍）。
    if (!runWorkflow || !runWorkspace.trim()) {
      message.warning(t('workflow.runFormIncomplete'))
      return
    }
    const missing = (runWorkflow.inputs ?? []).find((i) => i.required && !(runVars[i.key] ?? '').trim())
    if (missing) {
      message.warning(t('workflow.runInputRequired', { label: missing.label || missing.key }))
      return
    }
    setRunSubmitting(true)
    try {
      await window.electronAPI.pipelineRun({ workflowId: runWorkflow.id, plans: [], workspaceDir: runWorkspace.trim(), vars: runVars, approvalMode: runApproval, profileId: runProfileId })
      setRunOpen(false)
      message.success(t('workflow.runStarted'))
      onStarted?.()
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setRunSubmitting(false)
    }
  }, [runSubmitting, runWorkflow, runVars, runWorkspace, runApproval, runProfileId, message, t, onStarted])

  // 留空的生效值（launch.ts 同序：运行级覆盖 → 工作流定义 → 缺省）：
  // placeholder 照实显示工作流定义的值，不写死「缺省」误导。
  const pinnedApproval = WORKFLOW_APPROVAL_OPTIONS.find((o) => o.value === runWorkflow?.approvalMode)
  const pinnedModel = models.find((p) => p.id === runWorkflow?.profileId)
  const workspaceBlank = runWorkspace.trim() === ''

  const runModal = (
    <Modal
      open={runOpen}
      title={t('workflow.runTitle')}
      okText={t('workflow.run')}
      cancelText={t('common.cancel')}
      confirmLoading={runSubmitting}
      onOk={() => void submitRun()}
      onCancel={() => setRunOpen(false)}
    >
      <div style={{ display: 'grid', gap: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{runWorkflow?.name ?? ''}</div>
        <label style={{ display: 'grid', gap: 3, fontSize: 12, color: 'var(--pm-text-secondary)' }}>
          <span>
            <span style={{ color: 'var(--pm-error)', marginRight: 2 }}>*</span>
            {t('workflow.workspaceLabel')}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <Input
              style={{ flex: 1 }}
              value={runWorkspace}
              status={runAttempted && workspaceBlank ? 'error' : undefined}
              onChange={(e) => setRunWorkspace(e.target.value)}
              placeholder={t('workflow.workspacePlaceholder')}
              allowClear
            />
            <Button onClick={() => void pickWorkspaceDir()}>{t('workflow.workspaceBrowse')}</Button>
          </div>
        </label>
        {(runWorkflow?.inputs?.length ?? 0) > 0 && (
          <div style={{ display: 'grid', gap: 6 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--pm-text-strong)' }}>{t('workflow.runInputsSection')}</div>
            {runWorkflow!.inputs!.map((inp) => {
              const blank = (runVars[inp.key] ?? '').trim() === ''
              return (
                <label key={inp.key} style={{ display: 'grid', gap: 3, fontSize: 12, color: 'var(--pm-text-secondary)' }}>
                  <span>
                    {inp.required && <span style={{ color: 'var(--pm-error)', marginRight: 2 }}>*</span>}
                    {inp.label || inp.key}
                  </span>
                  {inp.multiline ? (
                    <Input.TextArea
                      value={runVars[inp.key] ?? ''}
                      status={runAttempted && inp.required && blank ? 'error' : undefined}
                      onChange={(e) => setRunVars((prev) => ({ ...prev, [inp.key]: e.target.value }))}
                      rows={3}
                    />
                  ) : (
                    <Input
                      value={runVars[inp.key] ?? ''}
                      status={runAttempted && inp.required && blank ? 'error' : undefined}
                      onChange={(e) => setRunVars((prev) => ({ ...prev, [inp.key]: e.target.value }))}
                      allowClear
                    />
                  )}
                </label>
              )
            })}
          </div>
        )}
        <div style={{ display: 'flex', gap: 10 }}>
          {/* 授权/模型是参数级覆盖（P1 任务共享内核）：留空 = 工作流定义的
              值，定义也没有 = 缺省（全部允许 / 当前模型）——placeholder 按
              真实生效值显示（launch.ts 同序），不写死。 */}
          <label style={{ flex: 1, display: 'grid', gap: 3, fontSize: 12, color: 'var(--pm-text-secondary)' }}>
            {t('workflow.approvalLabel')}
            <Select
              style={{ width: '100%' }}
              value={runApproval}
              allowClear
              placeholder={pinnedApproval ? t('workflow.approvalPlaceholderWorkflow', { label: pinnedApproval.label }) : t('workflow.approvalDefault')}
              onChange={(v) => setRunApproval(v)}
              options={WORKFLOW_APPROVAL_OPTIONS}
            />
          </label>
          <label style={{ flex: 1, display: 'grid', gap: 3, fontSize: 12, color: 'var(--pm-text-secondary)' }}>
            {t('workflow.modelLabel')}
            <Select
              style={{ width: '100%' }}
              value={runProfileId}
              allowClear
              placeholder={pinnedModel ? t('workflow.modelPlaceholderWorkflow', { name: pinnedModel.name }) : currentModelName ? `${t('workflow.modelCurrent')}（${currentModelName}）` : t('workflow.modelCurrent')}
              onChange={(v) => setRunProfileId(v ?? undefined)}
              options={models.map((p) => ({ value: p.id, label: p.id === activeModelId ? `${p.name}（当前）` : p.name }))}
            />
          </label>
        </div>
      </div>
    </Modal>
  )

  return { startRun, runModal }
}
