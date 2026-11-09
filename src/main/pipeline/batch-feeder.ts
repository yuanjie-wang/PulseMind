// ── 工作流批量喂送器（P2 任务共享内核）──
// CSV 一行 = 一次实例，串行 FIFO（pipelineEngine 的 drain 即串行批量；并发
// 裁定的硬理由：实例内部是多会话串行链 + gitCheckpoint 每阶段 commit，同
// 工作区多实例并发会撞仓）。CSV 读取/映射与 routine 共用一个面
// （batch-source.loadTableSource / shared/workflow/batch）。
//
// 行级预检：required input 在该行的值必须非空（列存在由 analyze 门在整批层
// 保证；空格子集如实落 failed 行、不入队——routine 的 assertRunnableParams
// 同款方向）。stop = 撤销未启动（engine.cancel）+ 停止在飞（engine.stop）。

import { prefixedId } from '../utils/id'
import { loadTableSource } from '../routine/batch-source'
import { workflowRowVars } from '../../shared/workflow/batch'
import { pipelineRunStore } from '../storage/pipeline-run-store'
import { pipelineEngine } from './pipeline-engine'
import { launchWorkflowRun } from './launch'
import type { WorkflowRunTrigger } from './launch'
import { assertApprovalMode } from '../task/run-context'
import type { WorkflowDefinition } from '../../shared/workflow/types'

export interface WorkflowBatchHandle {
  batchId: string
  csvName: string
  totalRows: number
  enqueued: number
  failedRows: number
}

/** 内存注册表：batchId → 该批次的全部 run 行（停止面）。运行记录的归组靠
 *  行上的 batch_id 列，这里只服务「停止这一批」——进程重启即失效，与
 *  engine.stopHooks 同一生命周期档。 */
const batches = new Map<string, { workflowId: string; runIds: string[] }>()

export function startWorkflowBatch(opts: { workflow: WorkflowDefinition; trigger?: WorkflowRunTrigger; csvPath?: string }): Promise<WorkflowBatchHandle> {
  return startAsync(opts)
}

async function startAsync(opts: { workflow: WorkflowDefinition; trigger?: WorkflowRunTrigger; csvPath?: string }): Promise<WorkflowBatchHandle> {
  const { workflow } = opts
  const csvPath = opts.csvPath?.trim() || workflow.batch?.csvPath?.trim()
  if (!csvPath) throw new Error('未配置批量数据文件')
  const approvalMode = assertApprovalMode(workflow.approvalMode ?? 'auto')
  const profileId = workflow.profileId?.trim() || undefined
  // required 输入的列存在性在整批层拒绝（loadTableSource 门）；行实例的
  // required 值在预检层拒绝（见下）。
  const source = await loadTableSource(csvPath, workflow.inputs)

  const batchId = prefixedId('pbatch')
  const state = { workflowId: workflow.id, runIds: [] as string[] }
  batches.set(batchId, state)

  let enqueued = 0
  let failedRows = 0
  for (let i = 0; i < source.rows.length; i++) {
    const vars = workflowRowVars(source.headers, source.rows, workflow.inputs, i)
    const rowNo = String(i + 1)
    const missing = (workflow.inputs ?? []).filter((input) => input.required && !vars[input.key]?.trim())
    if (missing.length > 0) {
      // 空格子集如实落 failed 行（无引擎调用），批量继续——「失败不挡后续」。
      const runId = prefixedId('prun')
      state.runIds.push(runId)
      pipelineRunStore.createRun({
        id: runId,
        workflowId: workflow.id,
        workflowName: workflow.name,
        objective: (workflow.objective ?? '').trim(),
        workspaceDir: workflow.workspaceDir?.trim() ?? '',
        status: 'failed',
        trigger: opts.trigger ?? 'manual',
        batchId,
        currentNode: workflow.entry,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        error: `第 ${rowNo} 行缺少必填输入：${missing.map((inp) => inp.label || inp.key).join('、')}`,
        inputs: vars,
      })
      failedRows += 1
      continue
    }
    // launch 的 required 门对已过预检的行恒过；plans=[] = 单实例无 plan。
    const runIds = launchWorkflowRun({
      workflow,
      plans: [],
      workspaceDir: workflow.workspaceDir,
      vars,
      approvalMode,
      profileId,
      trigger: opts.trigger ?? 'manual',
      row: rowNo,
      batchId,
    })
    state.runIds.push(...runIds)
    enqueued += runIds.length
  }

  return { batchId, csvName: source.csvName, totalRows: source.rows.length, enqueued, failedRows }
}

/** 停止一批：撤销尚未启动的排队实例 + 停止在飞实例。返回实际停到的在飞数。 */
export function stopWorkflowBatch(batchId: string): number {
  const state = batches.get(batchId)
  if (!state) return 0
  batches.delete(batchId)
  let stoppedInFlight = 0
  for (const runId of state.runIds) {
    if (pipelineEngine.cancel(runId)) continue
    if (pipelineEngine.stop(runId)) stoppedInFlight += 1
  }
  return stoppedInFlight
}
