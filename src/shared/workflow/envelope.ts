// PLAN-workflow-context：阶段信封（隐式上下文注入，shared 纯逻辑）。
//
// 节点 prompt 语义收窄为「本阶段任务 + 完成标准」；信封（位置 / 全局目标 /
// 运行输入 / 上游交接）与契约尾注由引擎自动拼装。主进程（pipeline-engine）与
// 渲染进程（节点面板「预览完整提示词」）共用同一个 composeStagePrompt——预览
// 与实际注入必须出自同一份代码，否则预览就是假的。
//
// 去重（plan §3.3）：node.prompt 显式引用 {{objective}} / {{prev*}} 的，对应块
// 整个省略——**显式引用仍是原语义**（{{prevSummary}} 注入 summary 文本、
// {{prevArtifacts}} 注入交付物全文），隐式只给路径；输入变量按变量粒度去重，
// 全部被引用则整块省略。{{visit}}/{{workspace}}/builtins 不影响信封。判定沿用
// renderNodePrompt 同一条正则，保证「什么算引用」两边定义一致。
//
// 预算（plan §3.6）：envelopeCapChars 缺省 32k，只防 objective / inputs 异常长。
// 裁剪优先级（先裁 → 后裁）：全局目标 → 运行输入 → 上游交接；「本阶段任务」与
// 「完成方式」永不裁剪。裁掉就明说（marker 行），不留白。
//
// 顶部那句分工声明和「本阶段任务」标题是整个方案的承重墙——不显式划定边界，
// 模型看到全局目标就会想替全流程干活。

import { PREFIX } from './contract'
import { formatHandoffContract, type WorkflowHandoff } from './handoff'
import { renderNodePrompt, resolveObjective, type RenderVars } from './render'
import type { WorkflowInputDef, WorkflowNode } from './types'

/** 信封字符预算缺省（防护性上限）。 */
export const DEFAULT_ENVELOPE_CAP_CHARS = 32_000

export type EnvelopeBlockId = 'position' | 'objective' | 'inputs' | 'upstream'

export interface EnvelopeBlock {
  id: EnvelopeBlockId
  heading: string
  body: string
}

/** 上游交接块的一行素材（引擎从 StageUpstreamRef 映射；预览端合成示例值）。 */
export interface EnvelopeUpstream {
  title: string
  verdict: string
  /** 上游节点 verdictDefs 里对该状态的释义（有才渲染括号）。 */
  verdictDef?: string
  /** 上游 handoff 的工作区相对路径（引擎铸造；预览端合成示例值）。 */
  handoffRel: string
  /** RETRY 自环重入：上游就是本节点上一次的运行（块头改「上次交接」）。 */
  self?: boolean
}

export interface EnvelopeContext {
  workflowName: string
  /** 1 起的序号（按 nodes 声明序；分支图里它是「第几个声明的节点」）。 */
  stageIndex: number
  stageTotal: number
  /** 工作流声明的输入变量（渲染端 def.inputs；缺席/空 = 无输入块）。 */
  inputs?: WorkflowInputDef[]
  /** 上游交接（入口节点/无入边 = 缺席 ⇒ 上游块整体不渲染，而不是「（无）」）。 */
  upstreams?: EnvelopeUpstream[]
  /** handoff 目录（缺席 = 「完成方式」段不含交接契约）。 */
  handoff?: WorkflowHandoff
  /** 信封字符预算（防护性上限；缺省 32k）。 */
  envelopeCapChars?: number
}

const heading = (title: string): string => `── ${title} ──`

export const POSITION_HEADING = heading('你在这个工作流里的位置')
export const OBJECTIVE_HEADING = heading('全局目标')
export const INPUTS_HEADING = heading('本次运行的输入')
export const TASK_HEADING = heading('本阶段任务（你只负责这一部分）')
export const DONE_HEADING = heading('完成方式')

/** 与 renderNodePrompt 同一条正则（render.ts）——「什么算引用」两边定义一致。 */
const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g

function referencedKeys(prompt: string): Set<string> {
  return new Set(Array.from(prompt.matchAll(PLACEHOLDER_RE), (m) => m[1]))
}

function positionBody(node: WorkflowNode, ctx: EnvelopeContext): string {
  const title = node.title || node.id
  if (ctx.stageTotal <= 1) {
    return [
      `工作流：${ctx.workflowName} · 单阶段「${title}」`,
      '整个工作流只有你这一个阶段，完成「本阶段任务」里的工作即可，不要输出不属于本阶段的交付物。',
    ].join('\n')
  }
  return [
    `工作流：${ctx.workflowName} · 第 ${ctx.stageIndex}/${ctx.stageTotal} 阶段「${title}」`,
    '你是其中一个阶段。只完成「本阶段任务」里的工作，其余阶段由其他会话负责——不要代做，也不要输出不属于本阶段的交付物。',
  ].join('\n')
}

function buildInputsBlock(
  node: WorkflowNode,
  vars: RenderVars,
  ctx: EnvelopeContext,
  referenced: Set<string>,
): EnvelopeBlock | null {
  if (node.context?.inputs === false) return null
  const declared = (ctx.inputs ?? []).filter((i) => i && typeof i.key === 'string' && i.key.trim())
  if (declared.length === 0) return null
  const values = vars.vars ?? {}
  const lines = declared
    .filter((i) => !referenced.has(i.key)) // 显式引用的变量按粒度省略
    .map((i) => {
      const value = values[i.key]
      return `${i.label || i.key}：${typeof value === 'string' && value.trim() ? value : '（未填）'}`
    })
  if (lines.length === 0) return null // 全部被显式引用 ⇒ 整块省略，不留空节
  return { id: 'inputs', heading: INPUTS_HEADING, body: lines.join('\n') }
}

/** 上游交接提示语：守住「只给路径」，不注入 notes/summary 正文；「交接过于
 *  简略自行核查」是回填兜底（只有骨架没有细节）的对冲。 */
const UPSTREAM_HINT =
  '（交接文件内含 状态 / 结论 / 关键数据 / 产物清单 / 下游须知；若交接过于简略，用 read 打开自行核查产物）'

function buildUpstreamBlock(
  node: WorkflowNode,
  vars: RenderVars,
  ctx: EnvelopeContext,
  referenced: Set<string>,
): EnvelopeBlock | null {
  if (node.context?.upstream === false) return null
  // 任一 prev* 被显式引用 ⇒ 整块省略（显式引用走 renderNodePrompt 的全文语义）
  if (['prevVerdict', 'prevSummary', 'prevArtifacts'].some((k) => referenced.has(k))) return null
  const upstreams = (ctx.upstreams ?? []).filter((u) => u && typeof u.handoffRel === 'string' && u.handoffRel)
  if (upstreams.length === 0) return null // 入口节点：整体不渲染
  if (upstreams.length === 1) {
    const u = upstreams[0]
    const head = u.self
      ? `上游交接 · 本节点第 ${vars.visit ?? 1} 次运行 · 上次交接`
      : `上游交接 · 来自「${u.title}」`
    const def = u.verdictDef?.trim() ? `（按上游定义：${u.verdictDef.trim()}）` : ''
    return {
      id: 'upstream',
      heading: heading(head),
      body: [`verdict：${u.verdict}${def}`, `交接文件：${u.handoffRel}`, UPSTREAM_HINT].join('\n'),
    }
  }
  const body = [
    ...upstreams.map((u) => {
      const def = u.verdictDef?.trim() ? `（${u.verdictDef.trim()}）` : ''
      return `· 来自「${u.title}」 verdict：${u.verdict}${def}\n  交接文件：${u.handoffRel}`
    }),
    UPSTREAM_HINT,
  ].join('\n')
  return { id: 'upstream', heading: heading(`上游交接（${upstreams.length} 个上游已汇合）`), body }
}

/** 预算裁剪：先裁 → 后裁 = 全局目标 → 运行输入 → 上游交接。位置块是分工声明
 *  的承重墙，永不裁。整块裁（上游路径逐条保留的价值抵不过分支复杂度），marker
 *  点名省了什么、去哪找——裁掉就明说，不留白。 */
function applyBudget(blocks: EnvelopeBlock[], dropped: string[], cap: number, ctx: EnvelopeContext): void {
  const total = (): number => blocks.reduce((n, b) => n + b.heading.length + b.body.length + 2, 0)
  if (total() <= cap) return
  const dropWhole = (id: EnvelopeBlockId, marker: string): void => {
    const at = blocks.findIndex((b) => b.id === id)
    if (at === -1) return
    blocks.splice(at, 1)
    dropped.push(marker)
  }
  if (total() > cap) {
    dropWhole('objective', `[全局目标超出信封预算（上限 ${cap} 字符），已省略——完整目标见工作流定义]`)
  }
  if (total() > cap) {
    const at = blocks.findIndex((b) => b.id === 'inputs')
    if (at !== -1) {
      const count = blocks[at].body.split('\n').length
      blocks.splice(at, 1)
      dropped.push(`[运行输入超出信封预算，已省略 ${count} 项输入——完整取值见启动表单]`)
    }
  }
  if (total() > cap) {
    const at = blocks.findIndex((b) => b.id === 'upstream')
    if (at !== -1) {
      const count = ctx.upstreams?.length ?? 0
      const dir = ctx.handoff?.dirRel ?? '.pulsemind/workflows/'
      blocks.splice(at, 1)
      dropped.push(`[上游交接超出预算：已省略 ${count} 个交接文件路径，见 ${dir}]`)
    }
  }
}

/** 只产出「本节点还没显式引用」的块 + 被预算裁掉的部分。 */
export function buildEnvelope(
  node: WorkflowNode,
  vars: RenderVars,
  ctx: EnvelopeContext,
): { blocks: EnvelopeBlock[]; dropped: string[] } {
  const referenced = referencedKeys(node.prompt)
  const blocks: EnvelopeBlock[] = []
  const dropped: string[] = []

  blocks.push({ id: 'position', heading: POSITION_HEADING, body: positionBody(node, ctx) })
  if (node.context?.objective !== false && !referenced.has('objective')) {
    blocks.push({ id: 'objective', heading: OBJECTIVE_HEADING, body: resolveObjective(vars) || '（未提供全局目标）' })
  }
  const inputs = buildInputsBlock(node, vars, ctx, referenced)
  if (inputs) blocks.push(inputs)
  const upstream = buildUpstreamBlock(node, vars, ctx, referenced)
  if (upstream) blocks.push(upstream)

  applyBudget(blocks, dropped, Math.max(0, Math.floor(ctx.envelopeCapChars ?? DEFAULT_ENVELOPE_CAP_CHARS)), ctx)
  return { blocks, dropped }
}

/** 出口状态词汇表注入（user 2026-11-09 自定义结果状态）。原 pipeline-engine
 *  内联函数，PLAN-workflow-context 迁入 shared——渲染端预览要拼出与实际相同的
 *  尾部契约，而渲染端不能 import 主进程模块。
 *  默认单出口 ['pass'] 的工作流**一个字节都不加**；自定义了词汇表时把合法状态
 *  与契约行模板补在指令末尾。状态**定义**（verdictDefs）一起带上：只给名字的
 *  话 success / failed 的分界线全靠模型猜，而这条出口是调度键——猜错就走错
 *  分支。没有定义的状态只列名字。 */
export function stageContractNote(node: WorkflowNode): string {
  if (node.verdicts.length <= 1 && (node.verdicts[0] ?? 'pass') === 'pass') return ''
  const example = node.verdicts[0] ?? 'pass'
  const defined = node.verdicts.some((v) => (node.verdictDefs?.[v] ?? '').trim().length > 0)
  const list = defined
    ? [
        '本阶段的结果状态只能取下面这些，按定义判断该报哪一个：',
        ...node.verdicts.map((v) => {
          const def = (node.verdictDefs?.[v] ?? '').trim()
          return def ? `- ${v}：${def}` : `- ${v}`
        }),
      ].join('\n')
    : `本阶段的结果状态只能取：${node.verdicts.join(' / ')}。`
  return [
    '',
    '---',
    list,
    '完成本阶段时调用 `finish_stage` 工具声明结果，verdict 必须逐字取自上面的状态名（大小写照抄）；调用成功后本阶段立即结算，不要再用普通文本声明完成。',
    '如果工具不可用（或网关不转发工具调用），才在最后一条消息末尾单独输出一行契约作为兜底：',
    `${PREFIX} {"verdict":"${example}","summary":"<一句话总结>","artifacts":["<交付物相对路径>"]}`,
  ].join('\n')
}

/** 信封 + 任务 + 契约尾注 = 完整提示词。引擎与预览面板共用这一个入口。 */
export function composeStagePrompt(node: WorkflowNode, vars: RenderVars, ctx: EnvelopeContext): string {
  const { blocks, dropped } = buildEnvelope(node, vars, ctx)
  const parts: string[] = []
  for (const b of blocks) parts.push(`${b.heading}\n${b.body}`)
  for (const d of dropped) parts.push(d)
  parts.push(`${TASK_HEADING}\n${renderNodePrompt(node.prompt, vars)}`)
  const done = [stageContractNote(node), ctx.handoff ? formatHandoffContract(ctx.handoff, node) : '']
    .filter((s) => s.length > 0)
    .join('\n')
  parts.push(`${DONE_HEADING}\n${done}`)
  return parts.join('\n\n')
}
