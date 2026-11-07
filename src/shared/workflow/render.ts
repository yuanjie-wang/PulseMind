// PLAN-workflow-engine：节点 prompt 渲染 + 占位符替换（shared 纯逻辑）。
//
// 占位符：{{objective}}、{{planContent}}（120k 字符帽、超限显式标注——
// sop-runner EVIDENCE_BUDGET 先例）、{{planPath}}、{{workspace}}、
// {{prevVerdict}}、{{prevSummary}}、{{prevArtifacts}}（上阶段交付物内容，
// 单文件 20k 帽）、{{visit}}。
//
// 全局目标解析序：运行级（启动表单传入）> 工作流级 objective > 空字符串。

import type { WorkflowNode } from './types'

/** {{planContent}} 的字符帽（超限截断 + 显式标注，绝不静默）。 */
export const PLAN_CONTENT_CAP = 120_000
/** {{prevArtifacts}} 单文件内容帽。 */
export const ARTIFACT_CONTENT_CAP = 20_000

export interface RenderVars {
  /** 运行级目标（启动表单传入，可空）。 */
  runObjective?: string
  /** 工作流级目标（WorkflowDefinition.objective，可空）。 */
  workflowObjective?: string
  planPath?: string
  planContent?: string
  workspace?: string
  prevVerdict?: string
  prevSummary?: string
  /** 上阶段交付物：路径 → 内容（引擎读盘后注入，单文件 20k 帽在引擎侧或此处裁）。 */
  prevArtifacts?: Array<{ path: string; content: string }>
  /** 当前节点的第几次访问（1 起）。 */
  visit?: number
}

/** objective 的最终值：运行级 > 工作流级 > 空。 */
export function resolveObjective(vars: RenderVars): string {
  return (vars.runObjective ?? vars.workflowObjective ?? '').trim()
}

function capText(text: string, cap: number, label: string): string {
  if (text.length <= cap) return text
  return `${text.slice(0, cap)}\n\n[……${label}超过 ${cap} 字符帽，已截断（原长 ${text.length} 字符）]`
}

function formatPrevArtifacts(vars: RenderVars): string {
  const arts = vars.prevArtifacts ?? []
  if (arts.length === 0) return '（上阶段未声明或未产出交付物）'
  return arts.map((a) => `--- ${a.path} ---\n${capText(a.content, ARTIFACT_CONTENT_CAP, `交付物 ${a.path}`)}`).join('\n\n')
}

/** 单节点 prompt 渲染。未知占位符原样保留（诚实缺位——模型看得到模板变量
 *  没被替换，比静默吞掉更可诊断）；值缺席的已知占位符替换为明确的空态标注。 */
export function renderNodePrompt(prompt: string, vars: RenderVars): string {
  const objective = resolveObjective(vars)
  const planContent = vars.planContent !== undefined ? capText(vars.planContent, PLAN_CONTENT_CAP, 'plan 内容') : '（未提供 plan 内容）'
  const replacements: Record<string, string> = {
    objective: objective || '（未提供全局目标）',
    planContent,
    planPath: vars.planPath ?? '（未提供 plan 路径）',
    workspace: vars.workspace ?? '（未提供工作区）',
    prevVerdict: vars.prevVerdict ?? '（无——本阶段是入口）',
    prevSummary: vars.prevSummary ?? '（无——本阶段是入口）',
    prevArtifacts: formatPrevArtifacts(vars),
    visit: String(vars.visit ?? 1),
  }
  return prompt.replace(/\{\{(\w+)\}\}/g, (raw, key: string) => {
    const value = replacements[key]
    return value !== undefined ? value : raw
  })
}

/** 节点渲染的完整入参（引擎侧 runStage 调它）。 */
export function renderStagePrompt(node: WorkflowNode, vars: RenderVars): string {
  return renderNodePrompt(node.prompt, vars)
}
