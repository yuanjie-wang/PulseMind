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

/** 结果状态的**语义**（user 2026-11-17「你是不是写死了把 pass 作为成功态」）：
 *  只决定运行视图的上色（success 绿 / failure 红 / neutral 中性），**不参与
 *  调度**——调度键永远是状态名本身。状态名是用户自定义词表（成功/失败/需修订
 *  …），词面不携带任何语义，所以颜色只能来自显式声明或拓扑推导（run-view.ts
 *  的 verdictKindOf：未声明的状态按出边终点推——→DONE 成功、→FAILED 或没有
 *  出边失败、其余中性）。 */
export type WorkflowVerdictKind = 'success' | 'failure' | 'neutral'

export interface WorkflowNode {
  id: string
  title: string
  /** 节点工作内容（占位符见 render.ts）。 */
  prompt: string
  /** 节点完成定义（出口词汇表）：契约行 verdict 必须在其中。 */
  verdicts: string[]
  /** 每个结果状态**是什么意思**（状态名 → 什么时候该报这个状态，user
   *  2026-11-09「定义结果状态时还需要明确状态定义」）。只是状态名的话，模型
   *  只能猜 success/failed 的边界，调度键就形同虚设。键必须是 verdicts 里的
   *  一项（simplify 裁掉孤儿键）；缺席/空串 = 该状态没有额外说明。 */
  verdictDefs?: Record<string, string>
  /** 每个结果状态的语义（状态名 → 成功/失败/中性），只影响运行视图配色。
   *  键必须是 verdicts 里的一项（simplify 裁掉孤儿键）；缺席的状态按拓扑
   *  推导（见 WorkflowVerdictKind 注释）——旧定义零迁移、落盘形态不变。 */
  verdictKinds?: Record<string, WorkflowVerdictKind>
  /** 预留画布坐标（v1 原样透传）。 */
  layout?: WorkflowNodeLayout
  /** 隐式上下文开关（PLAN-workflow-context）：整个字段缺席 = 全开——存量工作流
   *  不加任何字段即获得信封行为。显式引用占位符（{{objective}}/{{prev*}}）的
   *  去重规则独立于这里的开关（见 envelope.ts）。 */
  context?: {
    /** 缺省 true；false = 不注入「全局目标」块（{{objective}} 显式引用仍可用）。 */
    objective?: boolean
    /** 缺省 true；false = 不注入「上游交接」块（{{prev*}} 显式引用仍可用）。
     *  只关进向的上游块——本节点自己的 handoff 仍照常写。 */
    upstream?: boolean
    /** 缺省 true；false = 不注入「本次运行的输入」块。 */
    inputs?: boolean
  }
}

export interface WorkflowEdge {
  from: string
  when: string
  to: string
}

/**
 * 用户自定义输入变量（user 2026-11-08 二期裁定：plan 不预设，工作流怎么工作
 * 由用户自己决定）。prompt 里 {{key}} 引用；启动表单按声明动态渲染字段；
 * plan 文件因此只是其中一种可能的输入，不再是硬性前置。
 */
export interface WorkflowInputDef {
  /** 占位符键：{{key}} 引用；不得与保留占位符重名（validate 钉）。 */
  key: string
  /** 启动表单的字段标签。 */
  label: string
  /** 启动时必须非空。 */
  required?: boolean
  /** 启动表单的预填值（user 2026-11-08：变量声明与 routine 参数同形）。 */
  default?: string
  /** 启动表单渲染为多行文本域。 */
  multiline?: boolean
}

export interface WorkflowParams {
  /** 单阶段硬超时（分钟）；0 = 永不超时（不武装计时器，2026-11-17）。 */
  stageTimeoutMinutes?: number
  /** 早停后同一会话的激发次数上限。 */
  maxStageContinues?: number
  /** 节点访问上限（防死循环）。 */
  defaultMaxVisits?: number
  /** 缺省 true；非 git 仓库启动即报错。 */
  gitCheckpoint?: boolean
  /** 信封字符预算（防护性上限，PLAN-workflow-context）；缺省 32k——只防
   *  objective / inputs 异常长，「本阶段任务」与「完成方式」永不裁剪。 */
  envelopeCapChars?: number
}

export interface WorkflowDefinition {
  id: string
  name: string
  /** 一句话说明（混排卡片的描述行；P3 向导「基本信息」步编辑）。 */
  description?: string
  /** 全局目标。解析序：运行级 > 工作流级 > 空（render.ts）。 */
  objective?: string
  /** 用户自定义输入变量声明（prompt 用 {{key}} 引用）。 */
  inputs?: WorkflowInputDef[]
  entry: string
  params?: WorkflowParams
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  // ── 任务共享内核 P1（user 2026-11-08）：运行上下文 + cron 定时。缺省链：
  // 启动表单参数 > 定义字段 > 缺省（授权缺省 'auto'、模型缺省激活档、
  // 工作区缺省 = 表单传入 / 定时触发 mint 会话夹具）。 ──
  approvalMode?: SandboxApprovalMode
  profileId?: string
  workspaceDir?: string
  /** cron 定时（RoutineSchedule 同形态）；cron 空/缺席 = 不定时。 */
  schedule?: { cron: string; timezone?: string; catchUp?: 'once' | 'skip' }
  /** 启用静默开关（与对话式任务的 `Routine.enabled` 同一语义，user 2026-11-09
   *  卡片统一点：只有设定了定时计划才在卡片上出开关）。缺席 = 启用；false 时
   *  调度器与事件触发（文件 / webhook）都不再自动跑，只留手动运行。 */
  enabled?: boolean
  /** 批量数据（与对话式任务同一份配置：CSV/Excel、并发、单次超时、定时也
   *  跑批量）。工作流侧的执行形态仍是串行 FIFO——gitCheckpoint 每阶段
   *  commit，多实例并发会撞仓，所以 wizard 把并发选择锁在 1 并说明原因，
   *  存储层原样保存（换执行策略时不必迁移数据）。 */
  batch?: RoutineBatchConfig
  /** 事件触发（routineTriggerManager 的同一套本机事件源：文件变化 / 回环
   *  webhook）。webhook token 由主进程归档时铸造（workflow-store）。 */
  triggers?: RoutineTrigger[]
  /** 终态芯片的画布落点（user 2026-11-08：开始/结束可拖动；缺席 = 派生位——
   *  开始在入口左侧、结束在最右节点右侧）。 */
  terminalLayout?: { start?: { x: number; y: number }; done?: { x: number; y: number } }
}

// ── 运行行（pipeline-run-store 的行形态，RoutineCenter 的行渲染读它）──

import type { SandboxApprovalMode } from '../sandbox/policy'
import type { RoutineBatchConfig, RoutineTrigger } from '../types/routine'

export type PipelineRunStatus = 'running' | 'success' | 'failed'

export interface PipelineRun {
  id: string
  workflowId: string
  workflowName: string
  /** 本实例的目标（运行级覆盖后的最终值）。 */
  objective: string
  /** 自定义输入变量的实际取值（inputs_json 列；缺省 = 未记录）。 */
  inputs?: Record<string, string>
  /** git checkpoint 基线 commit（gitCheckpoint: false 时缺席）。 */
  baselineCommit?: string
  /** 工作目录（节点会话的 workspaceDir）。 */
  workspaceDir: string
  status: PipelineRunStatus
  /** 触发来源（P1 任务共享内核）：手动 / cron 定时 / 文件变化 / webhook
   *  （后两者由本机事件触发，与对话式任务同一套）。 */
  trigger?: 'manual' | 'schedule' | 'file' | 'webhook'
  /** 批量归属 id（P2：同一次 CSV 批量铸的实例行共享，运行记录归组/停止面）。 */
  batchId?: string
  /** 当前/最后停留的节点 id（展开行的定位面）。 */
  currentNode?: string
  startedAt: string
  finishedAt?: string
  error?: string
  /** 运行级最终结论（到达 DONE 时引擎写入 = 最后完成阶段的摘要）——面板
   *  「最终结果」的一等数据面，不再是借用最后阶段摘要的近似。 */
  conclusion?: string
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
  /** 结算摘要（finish_stage/契约行的 summary）——运行视图「节点做了什么/
   *  最终结果」的数据面；旧行/早停缺席。 */
  summary?: string
}

/** 阶段执行的最终结算形态（runStage 的返回，引擎与测试的接缝）。
 *  notes 随 finish_stage/契约行透传（handoff 兜底回填的「下游须知」来源）。 */
export type StageOutcome =
  | {
      kind: 'settled'
      verdict: string
      summary: string
      artifacts: string[]
      notes?: string
      conversationId: string
      continues: number
    }
  | { kind: 'failed'; reason: string; conversationId?: string; continues: number }
