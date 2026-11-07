// PLAN-workflow-engine：工作流定义与运行行类型（shared 纯逻辑，单测覆盖）。
//
// 一条工作流 = 节点 + 出口转移表：每个节点是「一次独立 agent 会话的阶段」，
// 完成时按契约行报一个 verdict，出边表决定下一跳。边目标是节点 id / DONE
// （实例成功）/ FAILED（实例失败）/ RETRY（重进本节点，占 visit）。某 verdict
// 无出边 = 默认 FAILED（fail-safe）。画布就绪：nodes[].layout 透传保留——
// 未来拖拽编辑器的坐标，与节点属性面板一一对应，零迁移。

/** 保留字边目标。节点 id 不得与之冲突（validate.ts 钉）。 */
export const WORKFLOW_RESERVED_TARGETS = ['DONE', 'FAILED', 'RETRY'] as const
export type WorkflowReservedTarget = (typeof WORKFLOW_RESERVED_TARGETS)[number]

export interface WorkflowNodeLayout {
  x: number
  y: number
}

export interface WorkflowNode {
  id: string
  title: string
  /** 节点工作内容（占位符见 render.ts）。 */
  prompt: string
  /** 节点完成定义（出口词汇表）：契约行 verdict 必须在其中。 */
  verdicts: string[]
  /** 预留画布坐标（v1 原样透传）。 */
  layout?: WorkflowNodeLayout
}

export interface WorkflowEdge {
  from: string
  when: string
  to: string
}

export interface WorkflowParams {
  /** 单阶段硬超时（分钟）。 */
  stageTimeoutMinutes?: number
  /** 早停后同一会话的激发次数上限。 */
  maxStageContinues?: number
  /** 节点访问上限（防死循环）。 */
  defaultMaxVisits?: number
  /** 缺省 true；非 git 仓库启动即报错。 */
  gitCheckpoint?: boolean
}

export interface WorkflowDefinition {
  id: string
  name: string
  /** 全局目标。解析序：运行级 > 工作流级 > 空（render.ts）。 */
  objective?: string
  entry: string
  params?: WorkflowParams
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

// ── 运行行（pipeline-run-store 的行形态，RoutineCenter 的行渲染读它）──

export type PipelineRunStatus = 'running' | 'success' | 'failed'

export interface PipelineRun {
  id: string
  workflowId: string
  workflowName: string
  /** 本实例的目标（运行级覆盖后的最终值）。 */
  objective: string
  /** git checkpoint 基线 commit（gitCheckpoint: false 时缺席）。 */
  baselineCommit?: string
  /** 工作目录（节点会话的 workspaceDir）。 */
  workspaceDir: string
  status: PipelineRunStatus
  /** 当前/最后停留的节点 id（展开行的定位面）。 */
  currentNode?: string
  startedAt: string
  finishedAt?: string
  error?: string
}

export interface PipelineStageRun {
  id: string
  runId: string
  nodeId: string
  /** 该阶段的最终 verdict（激发耗尽/超时/事件网失败时可能缺席）。 */
  verdict?: string
  /** 早停激发次数。 */
  continues: number
  /** 阶段会话 id（转写跳转走 run-history 同款打开路径）。 */
  conversationId?: string
  startedAt: string
  finishedAt?: string
  error?: string
  /** 契约声明的交付物（工作区相对路径）。 */
  artifacts?: string[]
}

/** 阶段执行的最终结算形态（runStage 的返回，引擎与测试的接缝）。 */
export type StageOutcome =
  | { kind: 'settled'; verdict: string; summary: string; artifacts: string[]; conversationId: string; continues: number }
  | { kind: 'failed'; reason: string; conversationId?: string; continues: number }
