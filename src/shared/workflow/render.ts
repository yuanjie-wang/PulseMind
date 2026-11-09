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
  /** 用户自定义输入变量的取值（WorkflowDefinition.inputs 声明的键）；
   *  合并进 replacements 时在已知键之后——保留占位符不可被覆盖。 */
  vars?: Record<string, string>
  /** 任务共享内核（P2）内置变量（date/time/datetime/weekday/workspace/row，
   *  引擎侧由 shared/routine/params 的 builtinRoutineVars 产出）。
   *  合并序：builtins 最低 < 用户输入 vars < 已知键——用户显式输入可覆盖
   *  builtin（如自定义日期格式），已知键最高。 */
  builtins?: Record<string, string>
}

/** 用户自定义变量不得占用的键（render 的已知词汇表 + 系统注入面；validate
 *  同源钉）。row 由批量实例注入（1-based 行号），单次运行 token 保持可见。 */
export const RESERVED_PLACEHOLDER_KEYS = [
  'objective',
  'planContent',
  'planPath',
  'workspace',
  'prevVerdict',
  'prevSummary',
  'prevArtifacts',
  'visit',
  'row',
] as const

/** 环节指令里可插入的占位符，按属性面板「插入变量」菜单的分组列出——只含
 *  键与分组，显示文案在渲染端（i18n 的 workflow.var<Key>）。
 *
 *  键集 = RESERVED_PLACEHOLDER_KEYS（renderNodePrompt 的已知词汇表）+
 *  builtinRoutineVars 的六个内置变量（date/time/datetime/weekday/workspace/row，
 *  引擎侧随 builtins 注入——pipeline-engine 调 renderStagePrompt 时带
 *  builtinRoutineVars，所以它们对环节指令是真的可用）。运行期 replacements
 *  增键而这里漏增，用户就永远插不进那个 token（菜单是唯一入口，静态提示行已
 *  撤），等价性由 tests/workflow-canvas 钉死。{{row}} 只在批量实例里有值，
 *  单次运行按 render 的既有语义原样保留（与 routine 侧同）。 */
export const STAGE_PLACEHOLDER_GROUPS = [
  { group: 'stage', keys: ['prevVerdict', 'prevSummary', 'prevArtifacts', 'visit'] },
  { group: 'run', keys: ['objective', 'planContent', 'planPath'] },
  { group: 'builtin', keys: ['date', 'time', 'datetime', 'weekday', 'workspace', 'row'] },
] as const

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
    // 用户自定义输入先展开、已知键在后：撞保留名时已知键赢（validate 也会拒，
    // 这里是防御臂）。未声明的占位符保持原样（诚实缺位）。
    // 合并序（P2）：builtins 最低 < 用户输入 vars < 已知键。
    ...vars.builtins,
    ...vars.vars,
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
