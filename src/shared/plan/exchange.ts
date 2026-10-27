/**
 * Plan data-exchange scaffolding (PLAN-plan-exchange). Every plan owns a
 * dedicated exchange directory under the conversation workspace's `.pulsemind/`
 * hygiene dir (2026-10-01: plans and scratch share one dot-dir so a project
 * workspace — the user's own files — stays unpolluted; plans minted before the
 * move keep their `.plan/` dirs on disk AND their `.plan/` paths in persisted
 * `node.reportPath`, which is what downstream reads go through, so nothing is
 * migrated); report PATHS
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
  const dir = `${workspaceDir.replace(/[/\\]+$/, '')}/.pulsemind/plans/${plan.id}`
  return { dir, reportPath: (nodeId: string) => `${dir}/${nodeId.replace(/^n/, '')}-report.md` }
}

export function mintPlanId(): string {
  return `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`
}

export type DeclaredStatus = 'success' | 'partial' | 'failed'

/** Verdict keywords on a verdict line, worst-first: when several match the
 *  same line the most pessimistic declaration wins (see
 *  extractDeclaredStatus). Used only when the line does not LEAD with a
 *  verdict — see LEADING_STATUS_KEYWORDS. */
const STATUS_KEYWORDS: Array<[DeclaredStatus, RegExp]> = [
  ['failed', /失败|\bfailed\b/i],
  ['partial', /部分成功|部分完成|\bpartial\b/i],
  ['success', /成功|\bsuccess(?:ful)?\b|\bcompleted\b/i],
]

/** The same vocabulary anchored at the head of the verdict line. The skeleton
 *  mandates the verdict LEAD its line (「成功 / 部分成功 / 失败 —— 选一个，
 *  后跟一句原因」), so a keyword at the head IS the declaration, and any later
 *  keyword on the line is subject matter riding the one-line reason — evidence
 *  (n1: 「成功 —— 新增测试在旧实现上实测失败、在新实现上全绿」) or branch
 *  naming (n2: 「成功 —— 覆盖「…失败即 false」分支」); both declared 成功 and
 *  both recorded failed under the whole-line worst-first scan
 *  (plan_mvoyoit7, 2026-10-26). */
const LEADING_STATUS_KEYWORDS: Array<[DeclaredStatus, RegExp]> = [
  ['failed', /^失败|^failed\b/i],
  ['partial', /^部分成功|^部分完成|^partial\b/i],
  ['success', /^成功|^success(?:ful)?\b|^completed\b/i],
]

function scanStatus(line: string): DeclaredStatus | undefined {
  // The head of the line, minus the usual decorations: a list marker, a bold
  // opener, and a redundant status label (「执行结果：」 restated under a 状态
  // heading). What remains should start with the verdict.
  const head = line
    .replace(/^[ \t]*(?:[-*+][ \t]+)?(?:\*\*)?/, '')
    .replace(/^(?:执行|任务|最终)?(?:状态|结果|status|result)(?:\*\*)?[：:][ \t]*/i, '')
  for (const [status, re] of LEADING_STATUS_KEYWORDS) {
    if (re.test(head)) return status
  }
  for (const [status, re] of STATUS_KEYWORDS) {
    if (re.test(line)) return status
  }
  // `error` is a verdict only ON a verdict line (a line the writer framed as
  // the status); the digit lookbehind keeps "0 errors"/"2 errors" counts out
  // even there.
  if (/(?<!\d )\berrors?\b/i.test(line)) return 'failed'
  return undefined
}

/** The one line a text states its verdict on: a 状态-family heading (the
 *  report skeleton's `## 状态`, the reply duty's `## 执行结果` — verdict on
 *  the heading itself or on the first line under it) or a `状态：…` /
 *  `执行结果：…` / `Status: …` label line. Same word family both forms —
 *  one vocabulary, so a model cannot be compliant in one shape and unread
 *  in the other. */
function statusLineOf(text: string): string | undefined {
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i].match(/^[ \t]*#{1,6}[ \t]*(?:执行|任务|最终)?(?:状态|结果|status)[ \t]*(?:[：:][ \t]*(.*))?$/i)
    if (heading) {
      const inline = (heading[1] ?? '').trim()
      if (inline) return inline
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim()) return lines[j].trim()
      }
      return undefined
    }
  }
  for (const line of lines) {
    const labelled = line.match(/^[ \t]*(?:[-*+][ \t]+)?(?:\*\*)?(?:执行|任务|最终)?(?:状态|结果|status|result)(?:\*\*)?[：:][ \t]*(.+)$/i)
    if (labelled) return labelled[1].trim()
  }
  return undefined
}

/** Extract the self-declared outcome from a verdict-bearing text — advisory
 *  data for the downstream reader, never plan state. The CALLER owns the
 *  source order (spawn-tool: the delivered report's head first, the reply's
 *  status line second); this function reads the verdict LINE and nothing
 *  else — prose never votes. A code-review reply describing 「Office 写入无
 *  失败兜底」 is stating its subject, not its verdict, and the old full-text
 *  keyword scan declared a fully-successful node failed off exactly that
 *  (conv_20261005114823 n8: the report said 成功, the prose scan overrode
 *  it). No verdict line → undefined: an honest "no declaration" (no chip) —
 *  a hidden failure surfaces when the downstream reader opens the report,
 *  which the exchange contract already makes it do. The verdict is read off
 *  the HEAD of the line first (the skeleton puts it there): a leading keyword
 *  IS the declaration and later keywords on the line are subject matter
 *  (evidence, branch naming) — the old whole-line worst-first scan turned two
 *  成功-declaring nodes into declared-failed off exactly that. Lines that do
 *  not lead with a verdict keep the pessimistic rule: within the line the
 *  WORST match wins (failed before partial before success), a line naming
 *  several reads pessimistic, and a passing negation (「不是失败」) is priced
 *  in — the model states its verdict plainly, the scan only reads it.
 *  English synonyms count (weak models mix); `error` on a verdict line is a
 *  verdict, "0 errors" is a count. */
export function extractDeclaredStatus(text: string): DeclaredStatus | undefined {
  const line = statusLineOf(text)
  return line ? scanStatus(line) : undefined
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
