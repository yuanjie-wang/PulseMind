/**
 * Plan data-exchange scaffolding (PLAN-plan-exchange). Every plan owns a
 * dedicated exchange directory under the conversation workspace; report PATHS
 * are minted by the system (never parsed from model prose), the admission
 * contract text is composed here next to the skeleton it enforces, and the
 * declared-status extraction is the one bounded bit of natural-language
 * tolerance in the whole spec. DOM-free and host-free: imported by the spawn
 * executor (main process) and by tests.
 */

import type { Plan, PlanNode } from '../types/plan'

/** The standard report skeleton — the default 准入 format. Four mandated
 *  sections; a node's `reportSpec` appends or overrides inside 状态/结论 but
 *  the section headings stay stable so a downstream reader always knows where
 *  to look. */
export const REPORT_SKELETON = `# <节点名> 报告

## 状态
成功 / 部分成功 / 失败 —— 选一个，后跟一句原因

## 结论
3-5 句：本节点回答了什么、给下游的最重要的判断是什么

## 关键数据
下游节点需要的事实、数字、清单——写全，不要只写摘要；引用其他产物写相对路径

## 产物清单
本节点写入工作区的其他文件（相对路径一行一个）；没有则写「无」`

export interface PlanExchange {
  /** Absolute exchange directory for THIS plan instance. */
  dir: string
  /** The system-minted report path for one node — the only path the exit
   *  check ever looks at. */
  reportPath(nodeId: string): string
}

/** Resolve the plan's exchange area; null when there is nothing to scaffold
 *  over (no workspace — tool-studio-like sessions — or a plan that has not
 *  been given an id yet; PlanManager lazily mints ids at dispatch). */
export function resolvePlanExchange(workspaceDir: string | undefined, plan: Plan): PlanExchange | null {
  if (!workspaceDir || !plan.id) return null
  const dir = `${workspaceDir.replace(/[/\\]+$/, '')}/.plan/${plan.id}`
  return { dir, reportPath: (nodeId: string) => `${dir}/${nodeId.replace(/^n/, '')}-report.md` }
}

export function mintPlanId(): string {
  return `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`
}

export type DeclaredStatus = 'success' | 'partial' | 'failed'

/** Extract the sub-agent's self-declared outcome from its reply — advisory
 *  data for the downstream reader, never plan state. Priority failed > partial
 *  > success so a negation in passing ("不是失败") cannot flip a mostly-clean
 *  report, and English synonyms count (weak models mix). */
export function extractDeclaredStatus(text: string): DeclaredStatus | undefined {
  if (/失败|failed|error/i.test(text)) return 'failed'
  if (/部分成功|部分完成|partial/i.test(text)) return 'partial'
  if (/成功|success|completed/i.test(text)) return 'success'
  return undefined
}

/** The 准入 contract injected into a plan-node spawn's task message (E2):
 *  the minted report path, the skeleton, the node's authored spec (if any),
 *  and the reply duty. Everything downstream needs in order to trust and read
 *  the report is decided HERE, at dispatch, by code. */
export function formatReportContract(exchange: PlanExchange, node: PlanNode): string {
  const reportPath = exchange.reportPath(node.id)
  const spec = (node.reportSpec ?? '').trim()
  const lines = [
    '## 报告契约（Report Contract）',
    '',
    `- 你的报告必须写入：${reportPath} （目录不存在会自动创建；不要另选路径或文件名）`,
    '- 报告按以下骨架书写（覆盖不了的场景在对应小节内说明）：',
    '',
    '```',
    REPORT_SKELETON,
    '```',
  ]
  if (spec) lines.push('', `- 本节点的补充格式要求：${spec}`)
  lines.push(
    '',
    '- 下游节点会直接读取该报告文件——把下游需要的一切写进去，不要只给摘要。',
    '- 最终回复中说明：执行结果（成功 / 部分成功 / 失败 + 一句原因）与报告要点。',
  )
  return lines.join('\n')
}
