// PLAN-workflow-engine：工作流校验纯函数。
//
// 「保存 / 启动 / 助手应用三处同一校验门」——workflow-store.save、pipeline
// 启动表单、workflow-assistant 的输出在落盘前全部走 validateWorkflow。
// 纯函数、无 IO：错误分级为 errors（阻断）与 warnings（不阻断，如不可达节点）。

import { WORKFLOW_RESERVED_TARGETS, type WorkflowDefinition } from './types'

export interface WorkflowValidation {
  ok: boolean
  errors: string[]
  warnings: string[]
}

const ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

function isNodeTarget(def: WorkflowDefinition, to: string): boolean {
  return def.nodes.some((n) => n.id === to)
}

/** 图可达性：entry 出发、边表走图（RETRY 回本节点、DONE/FAILED 是终点），
 *  收集从不可达的节点。 */
function unreachableNodes(def: WorkflowDefinition): string[] {
  if (!def.nodes.some((n) => n.id === def.entry)) return []
  const reached = new Set<string>([def.entry])
  const queue = [def.entry]
  while (queue.length > 0) {
    const from = queue.shift()!
    for (const e of def.edges) {
      if (e.from !== from) continue
      if (e.to === 'RETRY') continue // 回本节点，不引入新面
      if (e.to === 'DONE' || e.to === 'FAILED') continue
      if (isNodeTarget(def, e.to) && !reached.has(e.to)) {
        reached.add(e.to)
        queue.push(e.to)
      }
    }
  }
  return def.nodes.filter((n) => !reached.has(n.id)).map((n) => n.id)
}

export function validateWorkflow(def: unknown): WorkflowValidation {
  const errors: string[] = []
  const warnings: string[] = []
  if (!def || typeof def !== 'object') {
    return { ok: false, errors: ['工作流必须是 JSON 对象'], warnings }
  }
  const wf = def as Partial<WorkflowDefinition>

  if (typeof wf.id !== 'string' || !wf.id.trim()) errors.push('缺少 id')
  if (typeof wf.name !== 'string' || !wf.name.trim()) errors.push('缺少 name')
  if (typeof wf.entry !== 'string' || !wf.entry) errors.push('缺少 entry（入口节点 id）')
  if (!Array.isArray(wf.nodes) || wf.nodes.length === 0) errors.push('缺少 nodes（至少一个节点）')
  if (!Array.isArray(wf.edges)) errors.push('缺少 edges（出边表，可为空数组）')
  if (errors.length > 0) return { ok: false, errors, warnings }

  const nodes = wf.nodes as WorkflowDefinition['nodes']
  const edges = wf.edges as WorkflowDefinition['edges']

  // 节点形态：id 合法且唯一、title/prompt 非空、verdicts 非空、保留字冲突。
  const seenIds = new Set<string>()
  for (const n of nodes) {
    if (!n || typeof n !== 'object') {
      errors.push('存在非对象节点')
      continue
    }
    if (typeof n.id !== 'string' || !ID_RE.test(n.id)) {
      errors.push(`节点 id 非法：「${String(n.id)}」（字母开头，字母/数字/-/_，≤64 字符）`)
      continue
    }
    if (seenIds.has(n.id)) errors.push(`节点 id 重复：「${n.id}」`)
    seenIds.add(n.id)
    if (WORKFLOW_RESERVED_TARGETS.includes(n.id as never)) errors.push(`节点 id 不得使用保留字：「${n.id}」`)
    if (typeof n.title !== 'string' || !n.title.trim()) errors.push(`节点 ${n.id} 缺少 title`)
    if (typeof n.prompt !== 'string' || !n.prompt.trim()) errors.push(`节点 ${n.id} 缺少 prompt`)
    if (!Array.isArray(n.verdicts) || n.verdicts.length === 0) errors.push(`节点 ${n.id} 的 verdicts 为空（出口词汇表必须声明）`)
  }

  // entry 存在
  if (wf.entry && seenIds.size > 0 && !seenIds.has(wf.entry) && !nodes.some((n) => n.id === wf.entry)) {
    errors.push(`entry 指向不存在的节点：「${wf.entry}」`)
  }

  // 边形态：端点合法、when 属于 from 节点的 verdicts（越表 = 坏边）、重复边。
  const seenEdges = new Set<string>()
  for (const e of edges) {
    if (!e || typeof e !== 'object') {
      errors.push('存在非对象边')
      continue
    }
    const label = `边 ${String(e.from)}·${String(e.when)}→${String(e.to)}`
    if (typeof e.from !== 'string' || !seenIds.has(e.from)) {
      errors.push(`${label}：from 不是已声明节点`)
      continue
    }
    if (e.to !== 'DONE' && e.to !== 'FAILED' && e.to !== 'RETRY' && !seenIds.has(e.to)) {
      errors.push(`${label}：to 不是已声明节点或保留字（DONE/FAILED/RETRY）`)
      continue
    }
    const fromNode = nodes.find((n) => n.id === e.from)
    const verdicts = Array.isArray(fromNode?.verdicts) ? fromNode.verdicts : []
    if (typeof e.when !== 'string' || !verdicts.includes(e.when)) {
      errors.push(`${label}：when「${String(e.when)}」不在节点 ${e.from} 的 verdicts 内`)
      continue
    }
    const key = `${e.from}\u0000${e.when}`
    if (seenEdges.has(key)) errors.push(`${label}：重复边（同一 from+when 只能有一条出边）`)
    seenEdges.add(key)
  }

  // params 形态（宽容：数值型字段非正数才报）
  const params = wf.params
  if (params && typeof params === 'object') {
    const p = params as WorkflowDefinition['params']
    for (const key of ['maxStageContinues', 'defaultMaxVisits'] as const) {
      const v = p?.[key]
      if (v !== undefined && (!Number.isFinite(v) || (v as number) < 0)) {
        errors.push(`params.${key} 必须是非负数`)
      }
    }
    const timeout = p?.stageTimeoutMinutes
    if (timeout !== undefined && (!Number.isFinite(timeout) || (timeout as number) <= 0)) {
      errors.push('params.stageTimeoutMinutes 必须是正数')
    }
    if (p?.gitCheckpoint !== undefined && typeof p.gitCheckpoint !== 'boolean') {
      errors.push('params.gitCheckpoint 必须是布尔值')
    }
  }

  // 警告级：不可达节点；终局节点无出边（它的任何 verdict 都默认 FAILED——
  // 可能是刻意的，只提醒）。
  for (const id of unreachableNodes({ ...(wf as WorkflowDefinition), nodes, edges })) {
    warnings.push(`节点 ${id} 从 entry 不可达`)
  }

  return { ok: errors.length === 0, errors, warnings }
}
