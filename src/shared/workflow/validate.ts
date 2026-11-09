// PLAN-workflow-engine：工作流校验纯函数。
//
// 「保存 / 启动 / 助手应用三处同一校验门」——workflow-store.save、pipeline
// 启动表单、表单助手的提案落地（2026-11-08 起一次性管道助手退场，改由
// TaskWizardPage 在 applyWorkflowAssistantPatch 之后校验）在落盘前全部走
// validateWorkflow。
// 纯函数、无 IO：错误分级为 errors（阻断）与 warnings（不阻断，如不可达节点）。

import { WORKFLOW_RESERVED_TARGETS, type WorkflowDefinition, type WorkflowNode } from './types'
import { RESERVED_PLACEHOLDER_KEYS } from './render'

export interface WorkflowValidation {
  ok: boolean
  errors: string[]
  warnings: string[]
}

/** 校验口径开关（user 2026-11-09「状态定义是必填的」）：只有**写门**（编辑器的
 *  保存与助手提案落地）传 `requireVerdictDefs`。读取（workflow-store.readWorkflow
 *  对不过门的工作流整只丢弃）、启动（pipeline-engine 的 enqueue，存量定义照常要
 *  能跑）与分享预览刻意不带——这条要求只有编辑器能满足，挂到读/跑面上等于让存量
 *  工作流从列表消失或停跑。 */
export interface WorkflowValidateOptions {
  requireVerdictDefs?: boolean
}

const ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
/** 输入变量键：{{key}} 占位符形态（\w+ 与 render 的替换正则同源）。 */
const INPUT_KEY_RE = /^\w+$/
/** 结果状态名（user 2026-11-09 自定义出口状态）：它同时是画布线头 id 的尾段
 *  （`out:<verdict>`）、边 id 的中段（`edge:from|when|to`，所以不能有竖线）、
 *  以及 prompt 契约里的 JSON 字符串值（所以不能有引号/花括号）。空白一律不
 *  许——运行时的 `verdict` 是模型逐字吐出来的，前后空格会让匹配静默失败。 */
const VERDICT_RE = /^[^\s|"'`\\{}:]{1,24}$/

function isNodeTarget(def: WorkflowDefinition, to: string): boolean {
  return def.nodes.some((n) => n.id === to)
}

/** 某状态的定义文本（缺席/非字符串/纯空白一律算没写）。写门与「缺什么」
 *  清单共用这一份判定，两处各写必然漂移。 */
function verdictDefTextOf(defs: WorkflowNode['verdictDefs'] | undefined, verdict: string): string | undefined {
  const text = defs && typeof defs === 'object' ? (defs as Record<string, unknown>)[verdict] : undefined
  return typeof text === 'string' && text.trim() ? text.trim() : undefined
}

/** 缺定义的 (节点, 状态) 清单——写门判定的**单一真源**：`validateWorkflow`
 *  在 `requireVerdictDefs` 时逐条报错，助手的表单快照用它告诉模型「还差哪
 *  几处要补」。起因是 user 2026-11-09 反馈「让它补完成定义，然后它就啥了，
 *  开始改流程」：模型只看得见「这张图缺东西」，看不见究竟缺哪几格，于是把
 *  补齐当成一次重新设计。给了清单，补齐就是机械任务。
 *
 *  状态名非法的项不进表（那里已有自己的错误，再列一遍是噪音）。 */
export function missingVerdictDefs(def: WorkflowDefinition): Array<{ node: string; verdict: string }> {
  const out: Array<{ node: string; verdict: string }> = []
  // 助手每轮都拿**活定义**跑这个函数，而活定义的 nodes 恒为数组；这里仍做形态
  // 守卫，是因为导出面会被探针/测试直接喂畸形输入——一个 TypeError 会顶掉整轮
  // 快照，比漏报一条缺口糟得多。
  const nodes = Array.isArray(def?.nodes) ? def.nodes : []
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue
    if (typeof n.id !== 'string' || !ID_RE.test(n.id)) continue
    if (!Array.isArray(n.verdicts)) continue
    for (const v of n.verdicts) {
      if (typeof v !== 'string' || !VERDICT_RE.test(v)) continue
      if (!verdictDefTextOf(n.verdictDefs, v)) out.push({ node: n.id, verdict: v })
    }
  }
  return out
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

export function validateWorkflow(def: unknown, opts: WorkflowValidateOptions = {}): WorkflowValidation {
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
    if (!Array.isArray(n.verdicts) || n.verdicts.length === 0) {
      errors.push(`节点 ${n.id} 的 verdicts 为空（出口词汇表必须声明）`)
    } else {
      // 结果状态是调度键：字符集/长度越界会让线头 id、边 id、prompt 契约一起
      // 变形；重名则两条出口共用一个 when，画布上画两根线头、运行时分不清。
      const seenVerdicts = new Set<string>()
      for (const raw of n.verdicts) {
        const v = typeof raw === 'string' ? raw : String(raw)
        if (typeof raw !== 'string' || !VERDICT_RE.test(raw)) {
          errors.push(`节点 ${n.id} 的结果状态非法：「${v}」（不能含空格/竖线/引号/反引号/花括号/冒号，≤24 字符）`)
          continue
        }
        if (seenVerdicts.has(v)) errors.push(`节点 ${n.id} 的结果状态重复：「${v}」`)
        seenVerdicts.add(v)
        // 写门额外要求每个状态都有一句定义（「什么时候报这个状态」）：只有名字
        // 的话 pass/fail 的边界全靠模型猜，而这条出口决定下一跳走哪根线。定义在
        // 卡面悬停可见、逐字注进阶段 prompt（stageContractNote）。名字非法的项
        // 上面已经 continue 掉了，这里不会再补一条噪音。
        if (opts.requireVerdictDefs && !verdictDefTextOf(n.verdictDefs, v)) {
          errors.push(`节点 ${n.id} 的结果状态「${v}」缺少定义（必填：写清什么情况下报这个状态）`)
        }
      }
    }
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
    const key = `${e.from}\u0000${e.when}\u0000${e.to}`
    if (seenEdges.has(key)) errors.push(`${label}：重复边（同一起点/出口/终点的连线只能有一条）`)
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

  // inputs 形态（宁窄勿严：workflow-store.readWorkflow 对不过门的工作流整只
  // 丢弃，误杀存盘定义比放行怪键更糟）。key 必须 \w+（{{key}} 替换正则同源）、
  // 不得撞保留占位符、唯一；label 非空。
  if (wf.inputs !== undefined) {
    if (!Array.isArray(wf.inputs)) {
      errors.push('inputs 必须是数组')
    } else {
      const seenKeys = new Set<string>()
      for (const input of wf.inputs) {
        if (!input || typeof input !== 'object') {
          errors.push('存在非对象输入声明')
          continue
        }
        const { key, label } = input as { key?: unknown; label?: unknown }
        if (typeof key !== 'string' || !INPUT_KEY_RE.test(key)) {
          errors.push(`输入变量 key 非法：「${String(key)}」（字母/数字/下划线）`)
          continue
        }
        if ((RESERVED_PLACEHOLDER_KEYS as readonly string[]).includes(key)) {
          errors.push(`输入变量 key 不得使用保留占位符：「${key}」`)
          continue
        }
        if (seenKeys.has(key)) errors.push(`输入变量 key 重复：「${key}」`)
        seenKeys.add(key)
        if (typeof label !== 'string' || !label.trim()) errors.push(`输入变量 ${key} 缺少 label`)
      }
    }
  }

  // 警告级：不可达节点；终局节点无出边（它的任何 verdict 都默认 FAILED——
  // 可能是刻意的，只提醒）。
  for (const id of unreachableNodes({ ...(wf as WorkflowDefinition), nodes, edges })) {
    warnings.push(`节点 ${id} 从 entry 不可达`)
  }

  return { ok: errors.length === 0, errors, warnings }
}
