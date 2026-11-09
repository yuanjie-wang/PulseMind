// ── 工作流启动模态（P3 任务中心：自 WorkflowSection 抽出，列表已并入
// RoutineCenter 混排卡片；本文件只承载「运行一个工作流」的表单）──
// objective + 动态 inputs + 授权/模型参数级覆盖 + plan 列表（可空）+
// workspaceDir → pipelineRun（P1 launch 路径）。启动后由调用方刷新。

import React, { useCallback, useState } from 'react'
import { App as AntdApp, Input, Modal, Select } from 'antd'
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
  const [runObjective, setRunObjective] = useState('')
  const [runPlans, setRunPlans] = useState('')
  const [runWorkspace, setRunWorkspace] = useState('')
  // 自定义输入变量取值（plan 去预设化：按工作流的 inputs 声明动态渲染）。
  const [runVars, setRunVars] = useState<Record<string, string>>({})
  // 授权档/模型的参数级覆盖（P1 任务共享内核：空 = 用工作流定义/缺省）。
  const [runApproval, setRunApproval] = useState<string | undefined>()
  const [runProfileId, setRunProfileId] = useState<string | undefined>()
  const { settings } = useSettings()
  const models = settings.profiles.map((p) => ({ id: p.id, name: p.name, providerName: p.providerName }))
  const activeModelId = settings.activeProfileId

  const startRun = useCallback((workflow: WorkflowDefinition): void => {
    // 参数级覆盖每次打开都从空起（= 用定义/缺省）。
    setRunApproval(undefined)
    setRunProfileId(undefined)
    // 变量默认值预填（user 2026-11-08：两种模式的变量声明同形，default 同义）。
    setRunVars(Object.fromEntries((workflow.inputs ?? []).filter((i) => i.default).map((i) => [i.key, i.default as string])))
    setRunObjective('')
    setRunPlans('')
    setRunWorkspace('')
    setRunWorkflowState(workflow)
    setRunOpen(true)
  }, [])

  const submitRun = useCallback(async () => {
    // plan 可选（工作流没用到 plan 占位符时留空即可）——只有工作区目录与
    // required 输入是硬门（主进程同门再过一遍）。
    const plans = runPlans
      .split('\n')
      .map((p) => p.trim())
      .filter(Boolean)
    if (!runWorkflow || !runWorkspace.trim()) {
      message.warning(t('workflow.runFormIncomplete'))
      return
    }
    const missing = (runWorkflow.inputs ?? []).find((i) => i.required && !(runVars[i.key] ?? '').trim())
    if (missing) {
      message.warning(t('workflow.runInputRequired', { label: missing.label || missing.key }))
      return
    }
    try {
      await window.electronAPI.pipelineRun({ workflowId: runWorkflow.id, objective: runObjective.trim() || undefined, plans, workspaceDir: runWorkspace.trim(), vars: runVars, approvalMode: runApproval, profileId: runProfileId })
      setRunOpen(false)
      message.success(t('workflow.runStarted'))
      onStarted?.()
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    }
  }, [runWorkflow, runObjective, runPlans, runVars, runWorkspace, runApproval, runProfileId, message, t, onStarted])

  const runModal = (
    <Modal
      open={runOpen}
      title={t('workflow.runTitle')}
      okText={t('workflow.run')}
      cancelText={t('common.cancel')}
      onOk={() => void submitRun()}
      onCancel={() => setRunOpen(false)}
    >
      <div style={{ display: 'grid', gap: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{runWorkflow?.name ?? ''}</div>
        <Input value={runObjective} onChange={(e) => setRunObjective(e.target.value)} placeholder={t('workflow.objectivePlaceholder')} allowClear />
        <div style={{ display: 'flex', gap: 10 }}>
          {/* 授权/模型是参数级覆盖（P1 任务共享内核）：留空 = 工作流定义的
              值，定义也没有 = 缺省（全部允许 / 当前模型）。 */}
          <label style={{ flex: 1, display: 'grid', gap: 3, fontSize: 12, color: 'var(--pm-text-secondary)' }}>
            {t('workflow.approvalLabel')}
            <Select
              style={{ width: '100%' }}
              value={runApproval}
              allowClear
              placeholder={t('workflow.approvalDefault')}
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
              placeholder={models.find((p) => p.id === activeModelId)?.name ? `${t('workflow.modelCurrent')}（${models.find((p) => p.id === activeModelId)?.name}）` : t('workflow.modelCurrent')}
              onChange={(v) => setRunProfileId(v ?? undefined)}
              options={models.map((p) => ({ value: p.id, label: p.id === activeModelId ? `${p.name}（当前）` : p.name }))}
            />
          </label>
        </div>
        {(runWorkflow?.inputs?.length ?? 0) > 0 && (
          <div style={{ display: 'grid', gap: 6 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--pm-text-strong)' }}>{t('workflow.runInputsSection')}</div>
            {runWorkflow!.inputs!.map((inp) => (
              <label key={inp.key} style={{ display: 'grid', gap: 3, fontSize: 12, color: 'var(--pm-text-secondary)' }}>
                {inp.label || inp.key}
                {inp.required && <span style={{ color: 'var(--pm-error)' }}>*</span>}
                {inp.multiline ? (
                  <Input.TextArea
                    value={runVars[inp.key] ?? ''}
                    onChange={(e) => setRunVars((prev) => ({ ...prev, [inp.key]: e.target.value }))}
                    rows={3}
                  />
                ) : (
                  <Input
                    value={runVars[inp.key] ?? ''}
                    onChange={(e) => setRunVars((prev) => ({ ...prev, [inp.key]: e.target.value }))}
                    allowClear
                  />
                )}
              </label>
            ))}
          </div>
        )}
        <Input.TextArea value={runPlans} onChange={(e) => setRunPlans(e.target.value)} placeholder={t('workflow.plansPlaceholder')} rows={4} />
        <Input value={runWorkspace} onChange={(e) => setRunWorkspace(e.target.value)} placeholder={t('workflow.workspacePlaceholder')} allowClear />
        <div style={{ fontSize: 12, color: 'var(--pm-text-muted)' }}>{t('workflow.runHint')}</div>
      </div>
    </Modal>
  )

  return { startRun, runModal }
}
