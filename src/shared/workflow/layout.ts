// 工作流画布的自动布局纯函数（renderer 画布编辑器的落位面）。
//
// nodes[].layout 是预留的画布坐标（types.ts 画布就绪契约）：助手代建可能带
// 坐标、store 透传保存——已有 layout 的节点永远原样保留；只有缺坐标的节点
// （历史数据/新建/助手漏产）由这里按 BFS 层级落位。纯函数、不可变：返回新
// def，输入不被触碰。

import type { WorkflowDefinition, WorkflowNode } from './types'

/** 画布网格步长（px）：**纵向分层**（user 2026-11-09「工作流默认用垂直布局，
 *  不要用水平」）——一层一行（深度 → y），同层兄弟横向排开（→ x）。
 *
 *  两个数都对着任务卡的实际尺寸取：卡宽 240 / 卡高 ~82（WorkflowCanvas 的
 *  `.wf-stage-card`），留 60~78 的净距给连线拐弯。方向也跟线头语言一致：
 *  出口恒在卡的下缘、入口在上/左/右，横向分层会让每条边都从下缘绕回顶部。 */
const COLUMN_STEP_X = 300
const LAYER_STEP_Y = 160
const ORIGIN = { x: 80, y: 80 }

/** BFS 分层：entry 深度 0，出边走图（RETRY 回本节点不引入新层、
 *  DONE/FAILED 是终点不算节点）。返回 id → 深度；不可达节点不入表。
 *  只服务自动布局与「可达性」判定——回边判定见 loopEdgeKeys（层深比在那里
 *  会误判菱形里的长分支）。 */
export function depthOf(def: WorkflowDefinition): Map<string, number> {
  const depth = new Map<string, number>()
  if (!def.nodes.some((n) => n.id === def.entry)) return depth
  depth.set(def.entry, 0)
  const queue = [def.entry]
  while (queue.length > 0) {
    const from = queue.shift()!
    const d = depth.get(from)!
    for (const e of def.edges) {
      if (e.from !== from) continue
      if (e.to === 'RETRY' || e.to === 'DONE' || e.to === 'FAILED') continue
      if (def.nodes.some((n) => n.id === e.to) && !depth.has(e.to)) {
        depth.set(e.to, d + 1)
        queue.push(e.to)
      }
    }
  }
  return depth
}

/** 回边集合（key = `${from}\0${to}`，画布与运行器共用一份——两处各写必然
 *  漂移）：一条边算回边，当且仅当它**闭合成环**（从 to 出发沿边表能走回
 *  from），自环恒是回边。不能用层深比较代替：菱形里较长分支的汇入边
 *  （A→B→B2、B2→D，D 的 BFS 层深被短分支 C→D 压成 2）会被误判成回边，
 *  运行器就会跳过 AND-join 的依赖门。终态（DONE/FAILED/RETRY）不是节点，
 *  不参与闭合判定。 */
export function loopEdgeKeys(def: WorkflowDefinition): Set<string> {
  const out = new Map<string, string[]>()
  for (const e of def.edges) {
    if (e.to === 'DONE' || e.to === 'FAILED' || e.to === 'RETRY') continue
    const list = out.get(e.from)
    if (list) list.push(e.to)
    else out.set(e.from, [e.to])
  }
  const reachCache = new Map<string, Set<string>>()
  const reachableFrom = (start: string): Set<string> => {
    const cached = reachCache.get(start)
    if (cached) return cached
    const seen = new Set<string>()
    const stack = [start]
    while (stack.length > 0) {
      const cur = stack.pop()!
      for (const next of out.get(cur) ?? []) {
        if (seen.has(next)) continue
        seen.add(next)
        stack.push(next)
      }
    }
    reachCache.set(start, seen)
    return seen
  }
  const keys = new Set<string>()
  for (const e of def.edges) {
    const closed = e.to === e.from || (e.to !== 'DONE' && e.to !== 'FAILED' && e.to !== 'RETRY' && reachableFrom(e.to).has(e.from))
    if (closed) keys.add(`${e.from}\u0000${e.to}`)
  }
  return keys
}

/** 单边问回边（keys 由 loopEdgeKeys 算一次；画布/运行器都别逐边重算）。 */
export function isLoopEdge(loopKeys: Set<string>, edge: { from: string; to: string }): boolean {
  return loopKeys.has(`${edge.from}\u0000${edge.to}`)
}

/** 同层带内的交叉边对数（`columnOf` = id → 层内序号，0 起）。
 *
 *  只数**两端都有序号且共处同一层带**（起点深度、终点深度都相同）的边对：
 *  跨层的长边没有层带可比，回边天然反向、终态不是节点。这就是层内排序的
 *  目标函数——纯函数，单测用它钉「重排后交叉不增」，画布不消费。 */
export function countCrossings(def: WorkflowDefinition, columnOf: Map<string, number>): number {
  return crossingsOf(def, depthOf(def), columnOf, loopEdgeKeys(def))
}

function crossingsOf(def: WorkflowDefinition, depth: Map<string, number>, columnOf: Map<string, number>, loops: Set<string>): number {
  const bands = new Map<string, Array<{ a: number; b: number; from: string; to: string }>>()
  for (const e of def.edges) {
    if (e.to === 'DONE' || e.to === 'FAILED' || e.to === 'RETRY') continue
    if (isLoopEdge(loops, e)) continue
    const dFrom = depth.get(e.from)
    const dTo = depth.get(e.to)
    const a = columnOf.get(e.from)
    const b = columnOf.get(e.to)
    if (dFrom === undefined || dTo === undefined || a === undefined || b === undefined) continue
    const key = `${dFrom}>${dTo}`
    const band = bands.get(key)
    if (band) band.push({ a, b, from: e.from, to: e.to })
    else bands.set(key, [{ a, b, from: e.from, to: e.to }])
  }
  let total = 0
  for (const band of bands.values()) {
    for (let i = 0; i < band.length; i += 1) {
      for (let j = i + 1; j < band.length; j += 1) {
        const e1 = band[i]
        const e2 = band[j]
        // 共享端点（同一出口分叉 / 同一入口汇合）不算交叉。
        if (e1.from === e2.from || e1.to === e2.to) continue
        if ((e1.a - e2.a) * (e1.b - e2.b) < 0) total += 1
      }
    }
  }
  return total
}

/** 层内排序（user 2026-11-09「连接线交叉太多」）：重心（barycenter）法。
 *
 *  同层节点原来按**声明序**横向排开，而声明序跟拓扑邻居无关——A 的两个
 *  下游若声明成「远的在左、近的在右」，两条线就在层带中间交叉。这里反复
 *  按上游（下扫）/下游（上扫）已定位置的平均序号重排本层，每轮只在交叉数
 *  不增加时采纳，再用相邻对换（transpose）收尾。启发式、纯函数：入参
 *  `columnOf` 被就地重写。 */
function orderLayer(def: WorkflowDefinition, depth: Map<string, number>, byLayer: Map<number, string[]>): void {
  const peaks = [...byLayer.keys()].sort((a, b) => a - b)
  const columnOf = new Map<string, number>()
  const sync = (): void => {
    columnOf.clear()
    for (const d of peaks) byLayer.get(d)!.forEach((id, i) => columnOf.set(id, i))
  }
  sync()

  const loops = loopEdgeKeys(def)
  const preds = new Map<string, string[]>()
  const succs = new Map<string, string[]>()
  for (const e of def.edges) {
    if (e.to === 'DONE' || e.to === 'FAILED' || e.to === 'RETRY') continue
    if (isLoopEdge(loops, e)) continue
    if (!depth.has(e.from) || !depth.has(e.to)) continue
    const p = preds.get(e.to)
    if (p) p.push(e.from)
    else preds.set(e.to, [e.from])
    const s = succs.get(e.from)
    if (s) s.push(e.to)
    else succs.set(e.from, [e.to])
  }

  /** 一条给定邻居的平均序号；邻居全都不在这批待排节点里 → null（保位）。 */
  const baryOf = (id: string, links: Map<string, string[]>): number | null => {
    const near = links.get(id)
    if (!near) return null
    let sum = 0
    let count = 0
    for (const x of near) {
      const c = columnOf.get(x)
      if (c !== undefined) {
        sum += c
        count += 1
      }
    }
    return count > 0 ? sum / count : null
  }

  const reorder = (ids: string[], links: Map<string, string[]>): string[] =>
    ids
      .map((id, i) => ({ id, i, key: baryOf(id, links) }))
      .sort((x, y) => {
        if (x.key === null && y.key === null) return x.i - y.i
        if (x.key === null) return x.i - y.i // 无邻居的节点保持原位参与比较
        if (y.key === null) return x.i - y.i
        return x.key - y.key || x.i - y.i
      })
      .map((x) => x.id)

  const crossings = (): number => crossingsOf(def, depth, columnOf, loops)

  let bestCross = crossings()
  let best = new Map<number, string[]>()
  const snapshot = (): void => {
    best = new Map(peaks.map((d) => [d, [...byLayer.get(d)!]]))
  }
  snapshot()

  // 2 轮下扫 + 上扫：重排本批节点，交叉数变差就整体回滚到上一份最好的。
  for (let sweep = 0; sweep < 2; sweep += 1) {
    for (const d of peaks) byLayer.set(d, reorder(byLayer.get(d)!, preds))
    sync()
    for (const d of [...peaks].reverse()) byLayer.set(d, reorder(byLayer.get(d)!, succs))
    sync()
    const now = crossings()
    if (now > bestCross) {
      for (const d of peaks) byLayer.set(d, [...best.get(d)!])
      sync()
    } else {
      bestCross = now
      snapshot()
    }
  }

  // transpose：相邻两项换位，只留让交叉数下降的那种（重心法在同等重心下
  // 会留平局，这一步把平局也吃掉）。
  for (let pass = 0; pass < 2; pass += 1) {
    let improved = false
    for (const d of peaks) {
      const ids = byLayer.get(d)!
      for (let i = 0; i + 1 < ids.length; i += 1) {
        const before = crossings()
        ;[ids[i], ids[i + 1]] = [ids[i + 1], ids[i]]
        sync()
        if (crossings() < before) improved = true
        else {
          ;[ids[i], ids[i + 1]] = [ids[i + 1], ids[i]]
          sync()
        }
      }
    }
    if (!improved) break
  }
}

/** 助手新增节点的落位（`applyWorkflowAssistantPatch` 专用，画布不消费）：
 *  只给**缺 layout** 的节点坐标——贴在第一个已定位上游的正下方一层，被占位
 *  就向右让开一列；没有已定位上游就落在既有布局包围盒的下一行。已有 layout
 *  的节点逐字不动（用户摆好的画布是用户内容，助手不得重排它）。
 *
 *  一个已定位节点都没有时原样返回：那是空图/全新生成，没有「既有构图」可
 *  依附，交给 autoWorkflowLayout 按 BFS 分层即可。 */
export function placeNewNodes(def: WorkflowDefinition): WorkflowDefinition {
  const positions = new Map<string, { x: number; y: number }>()
  for (const n of def.nodes) if (n.layout) positions.set(n.id, { ...n.layout })
  if (positions.size === 0) return def

  const taken = new Set([...positions.values()].map((p) => `${p.x},${p.y}`))
  const bottom = Math.max(...[...positions.values()].map((p) => p.y)) + LAYER_STEP_Y
  const upstreamOf = (id: string): { x: number; y: number } | undefined => {
    for (const e of def.edges) {
      if (e.to !== id) continue
      const p = positions.get(e.from)
      if (p) return p
    }
    return undefined
  }

  const placed = new Map<string, { x: number; y: number }>()
  for (const n of def.nodes) {
    if (n.layout) continue
    const up = upstreamOf(n.id)
    let x = up ? up.x : ORIGIN.x
    const y = up ? up.y + LAYER_STEP_Y : bottom
    while (taken.has(`${x},${y}`)) x += COLUMN_STEP_X
    const p = { x, y }
    taken.add(`${x},${y}`)
    positions.set(n.id, p)
    placed.set(n.id, p)
  }
  if (placed.size === 0) return def
  return { ...def, nodes: def.nodes.map((n) => (placed.has(n.id) ? { ...n, layout: placed.get(n.id)! } : n)) }
}

/** 给缺 layout 的节点按 BFS 层级落位；已有 layout 的节点原样保留。
 *  `force: true`（工具箱「自动整理」）：忽略已有坐标，全量按层重排。 */
export function autoWorkflowLayout(def: WorkflowDefinition, opts?: { force?: boolean }): WorkflowDefinition {
  const force = opts?.force === true
  const hasLayout = (n: WorkflowNode): boolean => !force && n.layout != null
  if (!force && def.nodes.every(hasLayout)) return def

  const depth = depthOf(def)
  // 每层的待落位队列（先按 nodes 声明序，随后由 orderLayer 按重心重排）；
  // 不可达节点排在最深层下方一行。
  const byLayer = new Map<number, WorkflowNode[]>()
  let maxDepth = -1
  for (const n of def.nodes) {
    if (hasLayout(n)) continue
    const d = depth.get(n.id)
    if (d === undefined) continue
    if (!byLayer.has(d)) byLayer.set(d, [])
    byLayer.get(d)!.push(n)
    if (d > maxDepth) maxDepth = d
  }
  const orphanY = ORIGIN.y + (maxDepth + 1) * LAYER_STEP_Y
  let orphanCol = 0

  // 分两跳落位：先只排 id（orderLayer 只认 id），再按排好的次序算坐标。
  const layerIds = new Map<number, string[]>()
  for (const [d, nodes] of byLayer)
    layerIds.set(
      d,
      nodes.map((n) => n.id),
    )
  orderLayer(def, depth, layerIds)

  const placed = new Map<string, { x: number; y: number }>()
  for (const [d, ids] of layerIds) {
    for (const [i, id] of ids.entries()) {
      placed.set(id, { x: ORIGIN.x + i * COLUMN_STEP_X, y: ORIGIN.y + d * LAYER_STEP_Y })
    }
  }
  const out = def.nodes.map((n): WorkflowNode => {
    if (hasLayout(n)) return n
    const p = placed.get(n.id)
    if (p) return { ...n, layout: p }
    // 不可达（或 entry 缺失）的孤儿：统一最深层的下一行，横向排队。
    return { ...n, layout: { x: ORIGIN.x + orphanCol++ * COLUMN_STEP_X, y: orphanY } }
  })
  return { ...def, nodes: out }
}
