// ── 工作流启动路径（P1 任务共享内核）──
// 手动（启动表单）、定时（routine-scheduler tick）与事件触发（文件变化 /
// webhook，task/task-triggers 两族共用）共用的唯一入口：required 输入门、
// 授权档白名单、上下文三级合并（启动参数 > 工作流定义 > 缺省 'auto'/激活档/
// mint）、per plan 铸 run 行（记 trigger）+ 入队。plans 空 = 单实例（plan
// 去预设化后的形态）。

import { prefixedId } from '../utils/id'
import { pipelineRunStore } from '../storage/pipeline-run-store'
import { pipelineEngine } from './pipeline-engine'
import { assertApprovalMode } from '../task/run-context'
import type { WorkflowDefinition } from '../../shared/workflow/types'

/** 触发来源与 routine 的 RoutineRunTrigger 同一词汇表。 */
export type WorkflowRunTrigger = 'manual' | 'schedule' | 'file' | 'webhook'

/** 无法向用户追问的触发来源（required 输入门因此不能抛——没人在等表单）。 */
const UNATTENDED_TRIGGERS: ReadonlySet<WorkflowRunTrigger> = new Set(['schedule', 'file', 'webhook'] as const)

const TRIGGER_LABEL: Record<WorkflowRunTrigger, string> = {
  manual: '手动',
  schedule: '定时',
  file: '文件变化',
  webhook: 'webhook',
}

export interface LaunchWorkflowRunOptions {
  workflow: WorkflowDefinition
  /** 运行级目标（空 = 工作流级 objective）。 */
  objective?: string
  /** plan 文件路径列表；空 = 单实例无 plan。 */
  plans?: string[]
  /** 显式工作区（启动表单）；缺席时实例级 mint（定时路径）。 */
  workspaceDir?: string
  /** 自定义输入变量取值。 */
  vars?: Record<string, string>
  /** 授权档/模型 pin 的**参数级**覆盖（优先于工作流定义字段）。 */
  approvalMode?: string
  profileId?: string
  trigger?: WorkflowRunTrigger
  /** 批量面（P2）：行号（内置 {{row}}）与批次归组 id。 */
  row?: string
  batchId?: string
}

/**
 * 启动一个（或逐 plan 多个）工作流实例。返回 run id 列表；门不过时抛错
 * （手动路径透出表单、定时路径由调度器捕获落 failed run 行——但 required
 * 输入门对定时路径**不抛**，见下）。
 */
export function launchWorkflowRun(opts: LaunchWorkflowRunOptions): string[] {
  const { workflow } = opts
  const approvalMode = assertApprovalMode(opts.approvalMode ?? workflow.approvalMode ?? 'auto')
  const profileId = opts.profileId?.trim() || workflow.profileId?.trim() || undefined
  const plans = (opts.plans ?? []).map((p) => String(p).trim()).filter(Boolean)

  // required 输入门。无人值守的触发（定时/文件变化/webhook）没有人可问：
  // 与其抛错让调度器吞掉，不如如实落一条 failed run 行，错误文案指向运行
  // 设置（用户在运行记录里看得到）。
  const vars: Record<string, string> = {}
  for (const [k, v] of Object.entries(opts.vars ?? {})) {
    if (typeof v === 'string') vars[k] = v
  }
  const missingRequired = (workflow.inputs ?? []).filter((input) => input.required && !vars[input.key]?.trim())
  const trigger = opts.trigger ?? 'manual'
  if (missingRequired.length > 0 && UNATTENDED_TRIGGERS.has(trigger)) {
    const runId = prefixedId('prun')
    pipelineRunStore.createRun({
      id: runId,
      workflowId: workflow.id,
      workflowName: workflow.name,
      objective: (opts.objective ?? workflow.objective ?? '').trim(),
      workspaceDir: opts.workspaceDir?.trim() ?? '',
      status: 'failed',
      trigger,
      currentNode: workflow.entry,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      error: `${TRIGGER_LABEL[trigger]}运行缺少必填输入：${missingRequired.map((i) => i.label || i.key).join('、')}——请在画布「运行设置」里改为非必填，或改用手动运行填写`,
    })
    return [runId]
  }
  for (const input of missingRequired) {
    throw new Error(`输入变量「${input.label || input.key}」必填`)
  }

  const instances: Array<{ planPath?: string }> = plans.length > 0 ? plans.map((planPath) => ({ planPath })) : [{}]
  const runIds: string[] = []
  for (const { planPath } of instances) {
    // run 行先建（running），引擎队列空转/失败由引擎行内改写——「失败不挡后续」。
    const runId = prefixedId('prun')
    runIds.push(runId)
    pipelineRunStore.createRun({
      id: runId,
      workflowId: workflow.id,
      workflowName: workflow.name,
      objective: (opts.objective ?? workflow.objective ?? '').trim(),
      workspaceDir: opts.workspaceDir?.trim() ?? '',
      status: 'running',
      trigger,
      batchId: opts.batchId,
      currentNode: workflow.entry,
      startedAt: new Date().toISOString(),
      inputs: vars,
    })
    pipelineEngine.enqueue(runId, {
      runId,
      workflow,
      planPath,
      workspaceDir: opts.workspaceDir?.trim() || undefined,
      runObjective: opts.objective,
      vars,
      approvalMode,
      profileId,
      row: opts.row,
    })
  }
  return runIds
}
