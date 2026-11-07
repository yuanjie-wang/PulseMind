// PLAN-workflow-engine：流水线 IPC 面。PIPELINE_WORKFLOWS（list/save/delete）、
// PIPELINE_RUN（启动表单：工作流 + objective + plans + workspaceDir → 逐
// plan 铸 run 入队）、PIPELINE_STOP、PIPELINE_RUNS（行 = plan 实例，展开 =
// 节点行）、PIPELINE_ASSIST（工作流助手，校验门 + 回喂重试一次）。

import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { prefixedId } from '../utils/id'
import { workflowStore, seedWorkflowTemplates } from '../storage/workflow-store'
import { pipelineRunStore } from '../storage/pipeline-run-store'
import { pipelineEngine } from '../pipeline/pipeline-engine'
import { assistWorkflow } from '../pipeline/workflow-assistant'
import { validateWorkflow } from '../../shared/workflow/validate'
import type { WorkflowDefinition } from '../../shared/workflow/types'

export function registerPipelineHandlers(): void {
  seedWorkflowTemplates()

  ipcMain.handle(IPC_CHANNELS.PIPELINE_WORKFLOWS, (_e, op: string, arg?: unknown) => {
    switch (op) {
      case 'list':
        return workflowStore.list()
      case 'get':
        return workflowStore.get(String(arg ?? ''))
      case 'save': {
        const def = arg as WorkflowDefinition
        const v = validateWorkflow(def)
        if (!v.ok) throw new Error(v.errors.join('；'))
        return workflowStore.save(def)
      }
      case 'delete':
        workflowStore.remove(String(arg ?? ''))
        return true
      default:
        throw new Error(`unknown workflows op: ${String(op)}`)
    }
  })

  ipcMain.handle(IPC_CHANNELS.PIPELINE_RUN, (_e, params: { workflowId: string; objective?: string; plans: string[]; workspaceDir: string }) => {
    const workflow = workflowStore.get(params.workflowId)
    if (!workflow) throw new Error(`工作流不存在：${params.workflowId}`)
    if (!params.workspaceDir?.trim()) throw new Error('工作区目录必填')
    const plans = (params.plans ?? []).map((p) => String(p).trim()).filter(Boolean)
    if (plans.length === 0) throw new Error('至少提供一个 plan 文件路径')
    const runIds: string[] = []
    for (const planPath of plans) {
      // run 行先建（running），引擎队列空转/失败由引擎行内改写——「失败不挡后续」。
      const runId = prefixedId('prun')
      runIds.push(runId)
      pipelineRunStore.createRun({
        id: runId,
        workflowId: workflow.id,
        workflowName: workflow.name,
        objective: (params.objective ?? workflow.objective ?? '').trim(),
        workspaceDir: params.workspaceDir.trim(),
        status: 'running',
        currentNode: workflow.entry,
        startedAt: new Date().toISOString(),
      })
      pipelineEngine.enqueue(runId, {
        runId,
        workflow,
        planPath,
        workspaceDir: params.workspaceDir.trim(),
        runObjective: params.objective,
      })
    }
    return { runIds }
  })

  ipcMain.handle(IPC_CHANNELS.PIPELINE_STOP, (_e, runId: string) => {
    // run 行 id 前缀守卫——防注入的同一习惯（routines 的 `.json` 穿越教训）。
    if (!String(runId ?? '').startsWith('prun_')) return false
    return pipelineEngine.stop(String(runId))
  })

  ipcMain.handle(IPC_CHANNELS.PIPELINE_RUNS, (_e, runId?: string, limit?: number) => {
    if (runId) {
      const run = pipelineRunStore.getRun(String(runId))
      return { run, stages: run ? pipelineRunStore.listStagesOf(String(runId)) : [] }
    }
    const runs = pipelineRunStore.listRuns(typeof limit === 'number' ? Math.min(Math.max(limit, 1), 200) : 50)
    return { runs, stages: runs.flatMap((r) => pipelineRunStore.listStagesOf(r.id)) }
  })

  ipcMain.handle(IPC_CHANNELS.PIPELINE_ASSIST, (_e, params: { userNeed: string; currentJson: string }) =>
    assistWorkflow(String(params?.userNeed ?? ''), String(params?.currentJson ?? '')),
  )
}
