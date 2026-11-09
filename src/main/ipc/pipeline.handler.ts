// PLAN-workflow-engine：流水线 IPC 面。PIPELINE_WORKFLOWS（list/save/delete）、
// PIPELINE_RUN（启动表单：工作流 + objective + plans + workspaceDir → 逐
// plan 铸 run 入队）、PIPELINE_STOP、PIPELINE_RUNS（行 = plan 实例，展开 =
// 节点行）。
//
// 2026-11-08 起工作流助手不再是独立的一次性管道（PIPELINE_ASSIST 已撤）：
// 向导里的助手栏与对话式任务共用 FormAssistColumn 的会话形态，提案走
// ```form-patch 围栏 + 校验门，主进程侧不需要第二个入口。

import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { workflowStore, seedWorkflowTemplates } from '../storage/workflow-store'
import { pipelineRunStore } from '../storage/pipeline-run-store'
import { launchWorkflowRun } from '../pipeline/launch'
import { startWorkflowBatch, stopWorkflowBatch } from '../pipeline/batch-feeder'
import { pipelineEngine } from '../pipeline/pipeline-engine'
import { taskTriggerManager } from '../task/task-triggers'
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
        const saved = workflowStore.save(def)
        // 事件触发（文件变化 / webhook）与对话式任务同一套 runtime：保存后
        // 立即重建 watcher（路径/令牌可能已改）。唯一的建档口在这里，向导与
        // 助手应用都走它。
        taskTriggerManager.sync()
        return saved
      }
      case 'delete':
        workflowStore.remove(String(arg ?? ''))
        taskTriggerManager.sync()
        return true
      case 'toggle': {
        // 卡片开关（user 2026-11-09）：与 ROUTINE_TOGGLE 同一语义，只改启用位、
        // 不动定义其余字段。sync() 让文件/webhook 触发的 watcher 立即随之来去；
        // 定时侧的 workflowNextRunAt 由调度器自己按 enabled 短路，不在这里动。
        const { id, enabled } = arg as { id: string; enabled: boolean }
        const wf = workflowStore.get(String(id ?? ''))
        if (!wf) throw new Error(`工作流不存在：${String(id ?? '')}`)
        const saved = workflowStore.save({ ...wf, enabled: !!enabled })
        taskTriggerManager.sync()
        return saved
      }
      default:
        throw new Error(`unknown workflows op: ${String(op)}`)
    }
  })

  ipcMain.handle(
    IPC_CHANNELS.PIPELINE_RUN,
    (_e, params: { workflowId: string; objective?: string; plans: string[]; workspaceDir: string; vars?: Record<string, string>; approvalMode?: string; profileId?: string }) => {
      const workflow = workflowStore.get(params.workflowId)
      if (!workflow) throw new Error(`工作流不存在：${params.workflowId}`)
      if (!params.workspaceDir?.trim()) throw new Error('工作区目录必填')
      // 启动路径抽到 pipeline/launch.ts（P1 任务共享内核）：required 输入门、
      // 授权白名单、上下文合并（参数 > 定义 > 缺省）、per plan 铸行入队。
      return { runIds: launchWorkflowRun({ workflow, objective: params.objective, plans: params.plans, workspaceDir: params.workspaceDir, vars: params.vars, approvalMode: params.approvalMode, profileId: params.profileId, trigger: 'manual' }) }
    },
  )

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

  ipcMain.handle(IPC_CHANNELS.PIPELINE_BATCH_RUN, (_e, params: { workflowId: string; csvPath?: string }) => {
    const workflow = workflowStore.get(params?.workflowId ?? '')
    if (!workflow) throw new Error(`工作流不存在：${String(params?.workflowId ?? '')}`)
    return startWorkflowBatch({ workflow, csvPath: params?.csvPath, trigger: 'manual' })
  })

  ipcMain.handle(IPC_CHANNELS.PIPELINE_BATCH_STOP, (_e, batchId: string) => stopWorkflowBatch(String(batchId ?? '')))
}
