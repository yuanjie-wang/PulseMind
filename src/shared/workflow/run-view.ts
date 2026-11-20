// PLAN-workflow-run-view：运行视图的纯推导（画布 run 态叠加层的数据面）。
//
// 运行视图 = WorkflowCanvas 的 run 态叠加：节点按 stage 状态着色、走过的边
// 高亮、DONE 芯片显示实例终态。这里的两个纯函数把 pipeline_stage_runs 的行
// 折成画布要的形态——画布只管画，不猜语义。
//
// 一个节点可能被访问多次（RETRY 自环 / 回边）：**最近一次 stage 行赢**——
// 用户关心的是「现在它怎么样了」，不是历史每次。

import type { PipelineStageRun, WorkflowDefinition, WorkflowEdge, WorkflowVerdictKind } from './types'

export type RunNodeStatus = 'running' | 'settled' | 'failed'

export interface RunNodeState {
  status: RunNodeStatus
  /** 最近一次结算的 verdict（settled 才有）——徽标原样展示（结果状态是
   *  用户自定义词表，pass/fail 只是常见值，不做语义翻译）。 */
  verdict?: string
  /** 失败原因（failed 才有）——悬停 title 与徽标的原材料。 */
  error?: string
}

/** stage 行 → 每节点最新状态。running 的判定：有 startedAt、没 finishedAt
 *  也没 verdict（激发臂的中间态）；error 在场 = failed 优先于 verdict。 */
export function runNodeStates(stages: PipelineStageRun[]): Map<string, RunNodeState> {
  const latest = new Map<string, PipelineStageRun>()
  for (const s of stages) {
    const prev = latest.get(s.nodeId)
    if (!prev || prev.startedAt <= s.startedAt) latest.set(s.nodeId, s)
  }
  const out = new Map<string, RunNodeState>()
  for (const [nodeId, s] of latest) {
    if (s.error) {
      out.set(nodeId, { status: 'failed', error: s.error })
      continue
    }
    if (s.verdict) {
      out.set(nodeId, { status: 'settled', verdict: s.verdict })
      continue
    }
    out.set(nodeId, { status: 'running' })
  }
  return out
}

/** 结果状态的语义（user 2026-11-17「你是不是写死了把 pass 作为成功态」）：
 *  运行视图的配色只问这里，不再认词面——`pass`/`fail` 只是常见拼写，用户
 *  完全可能写「成功/失败/需修订」。解析序：
 *   1. 节点上的显式声明 `verdictKinds[verdict]` 赢；
 *   2. 否则按**拓扑**推（旧定义零迁移）：该状态有出边指向 DONE → success，
 *      指向 FAILED → failure；
 *   3. 该状态**一条出边都没有** → failure——引擎的 fail-safe 就是这样结算的
 *      （verdict 匹配不到出边 = 实例 FAILED），画布必须和引擎说同一句话；
 *   4. 其余（只连到中间节点）= neutral：它在流程里只是「往哪走」，不是终局
 *      成败的判词。 */
export function verdictKindOf(
  def: Pick<WorkflowDefinition, 'nodes' | 'edges'>,
  nodeId: string,
  verdict: string,
): WorkflowVerdictKind {
  const declared = def.nodes.find((n) => n.id === nodeId)?.verdictKinds?.[verdict]
  if (declared) return declared
  const targets = def.edges.filter((e) => e.from === nodeId && e.when === verdict).map((e) => e.to)
  if (targets.includes('DONE')) return 'success'
  if (targets.includes('FAILED')) return 'failure'
  if (targets.length === 0) return 'failure'
  return 'neutral'
}

/** 边键与画布的 edgeIdOf 同格式：`edge:from|when|to`。 */export function runEdgeKey(from: string, when: string, to: string): string {
  return `edge:${from}|${when}|${to}`
}

/** 走过的边：存在一条该源节点的 stage 行、以这条边的 when 结算 ⇒ 这条边被
 *  走过（fan-out 同状态多目标一起亮——结算面没有「目标」信息，按状态亮是
 *  诚实的近似）。start-entry 派生边不在此列（画布按入口节点是否启动过
 *  单独判）。 */
export function runTakenEdges(edges: WorkflowEdge[], stages: PipelineStageRun[]): Set<string> {
  const settledByNode = new Map<string, Set<string>>()
  for (const s of stages) {
    if (!s.verdict) continue
    const set = settledByNode.get(s.nodeId) ?? new Set<string>()
    set.add(s.verdict)
    settledByNode.set(s.nodeId, set)
  }
  const taken = new Set<string>()
  for (const e of edges) {
    if (settledByNode.get(e.from)?.has(e.when)) taken.add(runEdgeKey(e.from, e.when, e.to))
  }
  return taken
}

/** 执行链（user 2026-11-20「右栏前进/后退顺着执行链路走」）：stage 行按开始
 *  时间正序 = 执行序（与运行页 orderedStages 同一把尺子），逐行给该节点的
 *  第 N 次出现编号（visit 1 起）——RETRY/回边让同节点出现多行时，每行都是
 *  链上独立的一步。返回新数组，不重排入参。 */
export interface RunChainStep {
  stageId: string
  nodeId: string
  /** 该节点第几次执行（1 起）。 */
  visit: number
}

export function runExecutionChain(stages: PipelineStageRun[]): RunChainStep[] {
  const visits = new Map<string, number>()
  return [...stages]
    .sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1))
    .map((s) => {
      const visit = (visits.get(s.nodeId) ?? 0) + 1
      visits.set(s.nodeId, visit)
      return { stageId: s.id, nodeId: s.nodeId, visit }
    })
}

/** 节点执行次数（user 2026-11-20 二刀「右上角展示执行次数」）：stage 行数 =
 *  该节点跑过的次数（含正在跑的那次）——RETRY/回边的重入直接累加。 */
export function runVisitCounts(stages: PipelineStageRun[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const s of stages) counts.set(s.nodeId, (counts.get(s.nodeId) ?? 0) + 1)
  return counts
}
