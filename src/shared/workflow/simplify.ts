// 画布简化模型归一（user 2026-11-08 三期裁定：画布只有 开始/结束/空白任务
// 三类节点，其它抽象不要；2026-11-09 放开结果状态：每个节点自带一组出口
// 状态，一个状态可以连多条线）。
//
// 任务节点的出口词汇表 = 节点自己的 `verdicts`（user 2026-11-09「让用户自定义
// 成功、失败等结果状态，因为这会涉及到流程调度」）：画布上每个状态一根出口
// 线头，边 `when` 就是这个状态名。终态芯片只留 DONE——阶段失败仍由引擎
// fail-safe 兜底（verdict 不在词汇表 / 事件网失败 / 没有匹配的出边 = 实例
// FAILED，用户不需要在画布上摆失败芯片）。打开画布 / 助手应用 / 保存前 三处
// 归一：
//  - 缺 verdicts（旧定义）或全为空 → ['pass']，**已自定义的词汇表原样保留**；
//  - 出边丢弃两类：端点不在图里、目标为 FAILED/RETRY（这两个终态随多 verdict
//    抽象退役，引擎里仍是保留字）；`when` 不在起点词汇表里的边也丢——留着它
//    校验必红、运行时也永远走不到；
//  - 去重键是 (from, when, to) 三元组：同一起点可以按不同状态连多个目标，完全
//    重复的连线才丢。
//  - 每个状态的**定义**（`verdictDefs`）只留还在词表里的键——状态改名/删除后
//    的孤儿说明会随旧名字一起消失，不会继续注进阶段 prompt。

import type { WorkflowDefinition, WorkflowNode } from './types'

export const DEFAULT_VERDICTS: readonly string[] = ['pass']

/** 节点出口词汇表：去空去重，空表回落 ['pass']。 */
export function nodeVerdicts(node: { verdicts?: string[] }): string[] {
  const clean = [...new Set((node.verdicts ?? []).map((v) => v.trim()).filter((v) => v.length > 0))]
  return clean.length > 0 ? clean : [...DEFAULT_VERDICTS]
}

/** 结果状态的定义表归一（user 2026-11-09「定义结果状态时还需要明确状态定义」）：
 *  只留**当前词汇表里还在**的键（改名/删状态后的孤儿说明会误导模型）、值去空，
 *  全空返回 undefined（不写空对象，旧定义落盘形态逐字节不变）。键与值都 trim
 *  ——手改 JSON 的 `" done "` 不该与词表里的 `done` 失配。 */
export function nodeVerdictDefs(node: { verdictDefs?: Record<string, string> }, verdicts: string[]): Record<string, string> | undefined {
  const source = node.verdictDefs
  if (!source || typeof source !== 'object') return undefined
  const byName = new Map<string, string>()
  for (const [rawKey, rawValue] of Object.entries(source)) {
    const key = rawKey.trim()
    const value = typeof rawValue === 'string' ? rawValue.trim() : ''
    if (key.length === 0 || value.length === 0 || byName.has(key)) continue
    byName.set(key, value)
  }
  const out: Record<string, string> = {}
  for (const verdict of verdicts) {
    const value = byName.get(verdict)
    if (value !== undefined) out[verdict] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export function normalizeSimpleWorkflow(def: WorkflowDefinition): WorkflowDefinition {
  const nodes: WorkflowNode[] = def.nodes.map((n) => {
    const verdicts = nodeVerdicts(n)
    const verdictDefs = nodeVerdictDefs(n, verdicts)
    const next: WorkflowNode = { ...n, verdicts }
    if (verdictDefs) next.verdictDefs = verdictDefs
    else delete next.verdictDefs
    return next
  })
  const ids = new Set(nodes.map((n) => n.id))
  const verdictsOf = new Map(nodes.map((n) => [n.id, n.verdicts]))
  const seen = new Set<string>()
  const edges = def.edges
    // 端点活着、目标只能是节点或 DONE（FAILED/RETRY 出边随多 verdict 抽象一起退役）
    .filter((e) => ids.has(e.from) && (e.to === 'DONE' || ids.has(e.to)))
    // 调度键必须是起点声明的状态之一（改状态名时画布已级联改写连线；这里兜住
    // 手改 JSON / 助手代建送进来的悬空 when）。
    .filter((e) => (verdictsOf.get(e.from) ?? []).includes(e.when))
    .filter((e) => {
      const key = `${e.from}\u0000${e.when}\u0000${e.to}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map((e) => ({ from: e.from, when: e.when, to: e.to }))
  return { ...def, nodes, edges }
}
