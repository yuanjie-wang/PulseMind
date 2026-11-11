// 流水线阶段的完成协议工具（shared 纯逻辑：定义 + 参数校验）。
//
// 2026-11-11：完成信号从「assistant 正文里的 PIPELINE_RESULT 契约行」升级为
// 一次真正的工具调用。文本契约仍是兜底（弱模型 / 网关剥掉 tool_use 时），但
// 主通道是 finish_stage：schema 的 verdict enum 是模型的约束面，参数不合法
// 以工具错误回到同一回合（模型可自纠，不消耗 maxStageContinues），合法则被
// 引擎记为本阶段结算并立即收回合——「说完成」因此成为可机检的事件，而不是
// 一句散文。
//
// 这个文件只服务流水线阶段会话（AgentSessionCreateOptions.stageFinish 存在
// 时才合并进工具表）；普通聊天永远看不到 finish_stage。

import { artifactPathError, type PipelineContract } from './contract'

export const STAGE_FINISH_TOOL = 'finish_stage'

/** 阶段会话的完成协议配置（create session 时由 pipeline-engine 注入）。 */
export interface StageFinishConfig {
  /** 本阶段允许的出口状态（validateWorkflow 保证非空）。 */
  verdicts: string[]
  /** 状态定义：进工具说明，让模型有依据选状态。 */
  verdictDefs?: Record<string, string>
}

export interface StageFinishValidation {
  ok: boolean
  /** 只有 ok 时存在。 */
  contract?: PipelineContract
  /** 只有 !ok 时存在——一句可直接回给模型的可行动文案。 */
  error?: string
}

/** 与 ToolDefinition 结构兼容的最小定义（shared 不反向依赖 renderer 类型）。 */
export interface StageFinishToolDefinition {
  name: string
  description: string
  category: string
  input_schema: {
    type: 'object'
    properties: Record<
      string,
      {
        type: string
        description: string
        enum?: string[]
        items?: Record<string, unknown>
      }
    >
    required?: string[]
  }
  instructions: string
  builtIn?: boolean
}

function verdictVocabulary(config: StageFinishConfig): string[] {
  return config.verdicts.length > 0 ? config.verdicts : ['pass']
}

/** 校验一次 finish_stage 调用。verdict 必须逐字在词汇表内；summary 必填；
 *  artifacts 可省略（= []），但给了就必须每一项都是工作区相对路径。 */
export function validateStageFinishArgs(input: unknown, config: StageFinishConfig): StageFinishValidation {
  const verdicts = verdictVocabulary(config)
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: '参数必须是对象：{ verdict, summary, artifacts }' }
  }
  const obj = input as Record<string, unknown>

  const verdict = typeof obj.verdict === 'string' ? obj.verdict.trim() : ''
  if (!verdict) {
    return { ok: false, error: `verdict 不能为空，必须逐字取：${verdicts.join(' / ')}` }
  }
  if (!verdicts.includes(verdict)) {
    return {
      ok: false,
      error: `verdict「${verdict}」不在本阶段出口词汇表内，只能是：${verdicts.join(' / ')}`,
    }
  }

  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : ''
  if (!summary) {
    return { ok: false, error: 'summary 不能为空：用一句话说明本阶段做了什么、结论是什么' }
  }

  const rawArtifacts = obj.artifacts
  if (rawArtifacts !== undefined && !Array.isArray(rawArtifacts)) {
    return { ok: false, error: 'artifacts 必须是字符串数组；没有交付物就传 []' }
  }
  const artifacts: string[] = []
  for (const [i, raw] of (rawArtifacts ?? []).entries()) {
    if (typeof raw !== 'string') {
      return { ok: false, error: `artifacts 第 ${i + 1} 项不是字符串` }
    }
    const path = raw.trim()
    const err = artifactPathError(path)
    if (err) return { ok: false, error: `artifacts 第 ${i + 1} 项不合法：${err}` }
    artifacts.push(path)
  }

  return { ok: true, contract: { verdict, summary, artifacts } }
}

/** 阶段工具定义。description 是模型在工具列表里看到的短约束；instructions
 *  是工具协议段（buildToolProtocols 注入系统提示），承载 schema 说不出的
 *  完成语义——「何时可调用」「调用后立即收工」「错误怎么恢复」。 */
export function buildStageFinishTool(config: StageFinishConfig): StageFinishToolDefinition {
  const verdicts = verdictVocabulary(config)
  const defOf = (v: string): string => (config.verdictDefs?.[v] ?? '').trim()
  const hasDefs = verdicts.some((v) => defOf(v).length > 0)
  const verdictLines = [
    hasDefs
      ? 'verdict 是本阶段的调度键，必须逐字取自下面的状态名（按定义判断该报哪一个）：'
      : 'verdict 是本阶段的调度键，必须逐字取自下面的状态名（大小写照抄，不能自造）：',
    ...verdicts.map((v) => (defOf(v) ? `- ${v}：${defOf(v)}` : `- ${v}`)),
  ].join('\n')

  return {
    name: STAGE_FINISH_TOOL,
    description: `结束当前流水线阶段并声明结果。完成本阶段工作后调用一次；verdict 必须逐字取自：${verdicts.join(' / ')}，summary 一句话总结，artifacts 是交付物的工作区相对路径。`,
    category: 'workflow',
    input_schema: {
      type: 'object',
      properties: {
        verdict: {
          type: 'string',
          description: `本阶段的结果状态，必须逐字取以下之一：${verdicts.join(' / ')}`,
          enum: verdicts,
        },
        summary: {
          type: 'string',
          description: '一句话总结本阶段做了什么、结论是什么（不能为空，下游阶段会读到它）。',
        },
        artifacts: {
          type: 'array',
          description: '本阶段交付物的工作区相对路径（如 pipeline/review.md）；没有就传 []。不能是绝对路径，不能含 .. 或反斜杠。',
          items: { type: 'string' },
        },
      },
      required: ['verdict', 'summary'],
    },
    instructions: [
      '## finish_stage — 阶段完成协议',
      '',
      '完成本阶段工作后，调用一次 `finish_stage` 声明结果；这是本阶段唯一的完成信号。',
      '',
      verdictLines,
      '- summary：一句话说明本阶段做了什么、结论是什么；不能为空。',
      '- artifacts：交付物的**工作区相对路径**（如 `pipeline/review.md`）；没有交付物就传 `[]`。',
      '',
      '调用成功后本阶段立即结算、本回合结束：不要再用其它工具继续工作，也不要把待办步骤留给用户。',
      '本阶段还没完成时不要调用它——继续用工具推进工作。',
      '如果调用返回错误，按错误信息修正参数后重试；不要用普通文本冒充完成。',
    ].join('\n'),
    builtIn: true,
  }
}
