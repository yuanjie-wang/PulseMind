// PLAN-workflow-engine：流水线 IPC 面。PIPELINE_WORKFLOWS（list/save/delete）、
// PIPELINE_RUN（启动表单：工作流 + objective + plans + workspaceDir → 逐
// plan 铸 run 入队）、PIPELINE_STOP、PIPELINE_RUNS（行 = plan 实例，展开 =
// 节点行）。
//
// 2026-11-08 起工作流助手不再是独立的一次性管道（PIPELINE_ASSIST 已撤）：
// 向导里的助手栏与对话式任务共用 FormAssistColumn 的会话形态，提案走
// ```form-patch 围栏 + 校验门，主进程侧不需要第二个入口。

import { ipcMain } from 'electron'
import { logMain } from '../main-log'
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
  // 启动恢复（user 2026-11-15 实测：git 启动门挂住 + 应用重启，运行行孤儿在
  // running 停了 9 小时）。上一进程的 FIFO/停止钩子已随进程消失，遗留的
  // running 行没人结算——启动时统一落为 failed，用户在运行记录里能看到
  // 「应用重启，运行中断」而不是一条永远转圈的假运行。
  const stale = pipelineRunStore.failStaleRunning('应用重启，运行中断')
  // 打包 GUI 无终端，事后归因只能靠 logs/main.log（[Hooks] 2026-11-05 教训）
  if (stale > 0) logMain('WARN', 'pipeline', `startup recovery: settled ${stale} orphaned running run(s) as failed`)

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
    const id = String(runId)
    // 在飞实例：停当前阶段（阶段按失败结算、实例收口）。排队中的实例没有
    // 停止钩子（stop 返回 false）——直接撤销队列并结算 run 行，否则点停止
    // 只会静默无反应、行还挂在 running 上转圈（2026-11-18 运行视图停止钮）。
    if (pipelineEngine.stop(id)) return true
    return pipelineEngine.cancel(id, '已停止（未启动）')
  })

  // 重跑/续跑（2026-11-18）：「本次运行失败了怎么办」的两条出路。
  // fresh = 同一输入（目标/plan/变量/工作区）整条重跑；resume = 复用前一次
  // 实例**已结算阶段**，从失败节点接着跑（引擎按阶段行播种调度状态）。
  ipcMain.handle(IPC_CHANNELS.PIPELINE_RERUN, (_e, runId: string, mode: 'fresh' | 'resume' = 'fresh') => {
    const id = String(runId ?? '')
    if (!id.startsWith('prun_')) throw new Error('无效的运行 id')
    const prev = pipelineRunStore.getRun(id)
    if (!prev) throw new Error(`运行记录不存在：${id}`)
    if (prev.status === 'running') throw new Error('该运行还在进行中，先停止再重跑')
    const workflow = workflowStore.get(prev.workflowId)
    if (!workflow) throw new Error(`工作流不存在：${prev.workflowId}（可能已被删除）`)
    let resume: { fromRunId: string; nodeId: string } | undefined
    if (mode === 'resume') {
      const nodeId = prev.currentNode
      if (!nodeId) throw new Error('这次运行没有停在某个节点上，无从续跑')
      // 失败时回滚过基线 = 前序阶段的产物已被 reset/clean 清掉。此时续跑会
      // 拿着空的上游上下文往下跑——静默产出错误结果，比不允许更糟。
      if (prev.baselineCommit) {
        throw new Error('本次运行失败时工作区已回滚到基线，前序阶段的产物不在盘上——请选择「重跑本次」')
      }
      const settledBefore = pipelineRunStore
        .listStagesOf(id)
        .some((s) => s.nodeId !== nodeId && !!s.verdict && !s.error)
      if (!settledBefore) throw new Error('没有可复用的已完成阶段，续跑与重跑没有区别')
      resume = { fromRunId: id, nodeId }
    }
    // 授权档/模型 pin 不在 run 行上（运行级覆盖不落库）——重跑按工作流定义/
    // 激活档重新解析，与「从卡片再点一次运行」同一口径。
    const runIds = launchWorkflowRun({
      workflow,
      objective: prev.objective,
      plans: prev.planPath ? [prev.planPath] : [],
      workspaceDir: prev.workspaceDir,
      vars: prev.inputs,
      trigger: 'manual',
      ...(resume ? { resume } : {}),
    })
    return { runId: runIds[0] }
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
