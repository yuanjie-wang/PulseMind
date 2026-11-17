// shared/workflow/route.ts —— 连线路径算法的单测（纯几何，不碰 DOM）。
// 四条要求各有一组钉子：最短（对齐直连 0 拐点、不为拐弯绕远）、不遮挡（折线
// 不与任何卡片矩形相交，含自环）、美观（拐角圆角/标签贴出口端口/同源分叉
// 不叠线）、横平竖直（所有 L 段轴对齐）。
// 另有「箭头不被端口圆点吃掉」的钉子：d 的末段比 points 短 ARROW_GAP，
// points/length（路由与罚分的真相）不受影响。

import { describe, expect, it } from 'vitest'
import { routeEdges, type RouteEdgeSpec, type RouteRect } from '../src/shared/workflow/route'

const rect = (id: string, x: number, y: number, width = 240, height = 80): RouteRect => ({ id, x, y, width, height })

/** 折线上是否有一段落进矩形**内部**（贴边走不算：净距本来就是给贴边的）。 */
function crossesInterior(points: Array<{ x: number; y: number }>, r: RouteRect, eps = 1): boolean {
  const x0 = r.x + eps
  const x1 = r.x + r.width - eps
  const y0 = r.y + eps
  const y1 = r.y + r.height - eps
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]
    const b = points[i]
    if (Math.abs(a.y - b.y) < 0.01) {
      // 水平段
      if (a.y <= y0 || a.y >= y1) continue
      const lo = Math.min(a.x, b.x)
      const hi = Math.max(a.x, b.x)
      if (hi > x0 && lo < x1) return true
    } else if (Math.abs(a.x - b.x) < 0.01) {
      if (a.x <= x0 || a.x >= x1) continue
      const lo = Math.min(a.y, b.y)
      const hi = Math.max(a.y, b.y)
      if (hi > y0 && lo < y1) return true
    } else {
      throw new Error(`非轴对齐段 (${a.x},${a.y}) → (${b.x},${b.y})`)
    }
  }
  return false
}

/** SVG d 的段都必须是「L 到轴对齐点」或「Q 拐角」，且 Q 的两端与相邻段同向。 */
function assertOrthogonalPath(path: string): void {
  expect(path.startsWith('M ')).toBe(true)
  const tokens = path.trim().split(/\s+/)
  let cursor: { x: number; y: number } | null = null
  for (let i = 0; i < tokens.length;) {
    const cmd = tokens[i]
    if (cmd === 'M' || cmd === 'L') {
      const x = Number(tokens[i + 1])
      const y = Number(tokens[i + 2])
      expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true)
      if (cursor) expect(Math.abs(x - cursor.x) < 0.05 || Math.abs(y - cursor.y) < 0.05).toBe(true)
      cursor = { x, y }
      i += 3
    } else if (cmd === 'Q') {
      const cx = Number(tokens[i + 1])
      const cy = Number(tokens[i + 2])
      const x = Number(tokens[i + 3])
      const y = Number(tokens[i + 4])
      expect(Number.isFinite(cx) && Number.isFinite(cy) && Number.isFinite(x) && Number.isFinite(y)).toBe(true)
      // 圆角两端都还落在原来那条轴上：进角点与出角点各与之一致。
      if (cursor) expect(Math.abs(cx - cursor.x) < 0.05 || Math.abs(cy - cursor.y) < 0.05).toBe(true)
      expect(Math.abs(x - cx) < 0.05 || Math.abs(y - cy) < 0.05).toBe(true)
      cursor = { x, y }
      i += 5
    } else {
      throw new Error(`未知指令 ${cmd}：${path}`)
    }
  }
}

const edge = (id: string, from: RouteEdgeSpec['from'], to: RouteEdgeSpec['to']): RouteEdgeSpec => ({ id, from, to })

/** SVG d 的最后一段终点（M/L 三个 token、Q 五个 token）。 */
function pathEnd(path: string): Pt {
  const tokens = path.trim().split(/\s+/)
  let cursor: Pt = { x: 0, y: 0 }
  for (let i = 0; i < tokens.length;) {
    if (tokens[i] === 'M' || tokens[i] === 'L') {
      cursor = { x: Number(tokens[i + 1]), y: Number(tokens[i + 2]) }
      i += 3
    } else {
      cursor = { x: Number(tokens[i + 3]), y: Number(tokens[i + 4]) }
      i += 5
    }
  }
  return cursor
}

type Pt = { x: number; y: number }

/** 两条折线之间最长的一段「共线重合」（同一条 y 上的水平重叠 / 同一条 x 上的
 *  竖直重叠）。画面上重合超过几十像素，两条线看起来就是一条。 */
function maxSharedRun(a: Pt[], b: Pt[]): number {
  let worst = 0
  for (let i = 1; i < a.length; i += 1) {
    const p = a[i - 1]
    const q = a[i]
    const horizontal = Math.abs(p.y - q.y) < 0.01
    for (let j = 1; j < b.length; j += 1) {
      const r = b[j - 1]
      const s = b[j]
      if (horizontal !== Math.abs(r.y - s.y) < 0.01) continue
      if (horizontal) {
        if (Math.abs(p.y - r.y) >= 1) continue
        const overlap = Math.min(Math.max(p.x, q.x), Math.max(r.x, s.x)) - Math.max(Math.min(p.x, q.x), Math.min(r.x, s.x))
        if (overlap > worst) worst = overlap
      } else {
        if (Math.abs(p.x - r.x) >= 1) continue
        const overlap = Math.min(Math.max(p.y, q.y), Math.max(r.y, s.y)) - Math.max(Math.min(p.y, q.y), Math.min(r.y, s.y))
        if (overlap > worst) worst = overlap
      }
    }
  }
  return worst
}

describe('routeEdges —— 最短', () => {
  it('同列上下对齐：一条直线，零拐点，长度 = 两端口间距', () => {
    const rects = [rect('a', 0, 0), rect('b', 0, 160)]
    const routes = routeEdges(rects, [edge('e', { nodeId: 'a', side: 'bottom' }, { nodeId: 'b', side: 'top' })])
    const r = routes.get('e')!
    expect(r.points).toHaveLength(2)
    expect(r.points[0]).toEqual({ x: 120, y: 80 })
    expect(r.points[1]).toEqual({ x: 120, y: 160 })
    expect(r.bends).toBe(0)
    expect(Math.round(r.length)).toBe(80)
    // d 只在末尾回缩 ARROW_GAP（箭头尖要贴住端口圆点边缘，不埋也不留缝），
    // points/length 不变。
    expect(r.path).toBe('M 120 80 L 120 154')
  })

  it('侧向入口（左）：最后一段从卡片外侧横着进来，末端就是端口', () => {
    const rects = [rect('a', 0, 0), rect('b', 400, 0)]
    const routes = routeEdges(rects, [edge('e', { nodeId: 'a', side: 'right' }, { nodeId: 'b', side: 'left' })])
    const r = routes.get('e')!
    expect(r.points[0]).toEqual({ x: 240, y: 40 })
    expect(r.points[r.points.length - 1]).toEqual({ x: 400, y: 40 })
    expect(r.points).toHaveLength(2)
    expect(r.bends).toBe(0)
  })

  it('没有障碍时不为「好看」故意加拐点：错开的两列也只走 Z 形（两个直角）', () => {
    const rects = [rect('a', 0, 0), rect('b', 400, 400)]
    const routes = routeEdges(rects, [edge('e', { nodeId: 'a', side: 'bottom' }, { nodeId: 'b', side: 'top' })])
    const r = routes.get('e')!
    // 竖直段 + 水平段 + 竖直段：最少 2 个直角，绝不会更多。
    expect(r.points).toHaveLength(4)
    expect(r.bends).toBe(2)
    // 长度 = 曼哈顿距离（没有绕远）。
    const manhattan = Math.abs(120 - 520) + Math.abs(80 - 400)
    expect(r.length).toBeCloseTo(manhattan, 3)
  })

  it('拐弯要付代价：没有障碍时不为省长度制造多余直角', () => {
    // a 的底出下缘，b 比 a 窄且中线偏 20px —— 最少只要两个直角（Z 形），
    // 三个直角的走法更短也不该出现（每个直角 24px）。
    const rects = [rect('a', 0, 0), rect('b', 60, 300, 160)]
    const routes = routeEdges(rects, [edge('e', { nodeId: 'a', side: 'bottom' }, { nodeId: 'b', side: 'top' })])
    expect(routes.get('e')!.bends).toBe(2)
  })
})

describe('routeEdges —— 不被节点遮挡', () => {
  it('正下方挡着一张卡：从卡片旁边绕过去，不穿卡面', () => {
    const blocker = rect('mid', 0, 160)
    const rects = [rect('a', 0, 0), blocker, rect('b', 0, 320)]
    const routes = routeEdges(rects, [edge('e', { nodeId: 'a', side: 'bottom' }, { nodeId: 'b', side: 'top' })])
    const r = routes.get('e')!
    expect(r.bends).toBeGreaterThanOrEqual(4)
    for (const x of rects) expect(crossesInterior(r.points, x)).toBe(false)
    // 绕行必须真的绕出去：至少有一段落在卡片左/右边界之外。
    const outside = r.points.some((p) => p.x < blocker.x - 1 || p.x > blocker.x + blocker.width + 1)
    expect(outside).toBe(true)
  })

  it('多张卡 + 多条线：任何一条折线都不进任何一张卡的内部', () => {
    const rects = [rect('a', 80, 80), rect('b', 80, 320), rect('c', 460, 320), rect('d', 80, 560), rect('blocker', 80, 200, 240, 80)]
    const routes = routeEdges(rects, [
      edge('ab', { nodeId: 'a', side: 'bottom' }, { nodeId: 'b', side: 'top' }),
      edge('ac', { nodeId: 'a', side: 'bottom' }, { nodeId: 'c', side: 'top' }),
      edge('bd', { nodeId: 'b', side: 'bottom' }, { nodeId: 'd', side: 'top' }),
      edge('cd', { nodeId: 'c', side: 'bottom' }, { nodeId: 'd', side: 'top' }),
    ])
    expect(routes.size).toBe(4)
    for (const r of routes.values()) {
      for (const box of rects) expect(crossesInterior(r.points, box)).toBe(false)
    }
  })

  it('自环（从卡片出去再回来）也必须绕开自己，不许穿卡', () => {
    const a = rect('a', 0, 0)
    const routes = routeEdges([a], [edge('self', { nodeId: 'a', side: 'bottom' }, { nodeId: 'a', side: 'top' })])
    const r = routes.get('self')!
    expect(r.points.length).toBeGreaterThanOrEqual(4)
    expect(crossesInterior(r.points, a)).toBe(false)
  })

  it('净距生效：折线与卡片边缘之间至少留 clearance（除端口本身那一段）', () => {
    const blocker = rect('mid', 0, 160)
    const rects = [rect('a', 0, 0), blocker, rect('b', 0, 320)]
    const routes = routeEdges(rects, [edge('e', { nodeId: 'a', side: 'bottom' }, { nodeId: 'b', side: 'top' })], {
      clearance: 12,
    })
    const r = routes.get('e')!
    // 绕行的那条竖线必须落在 blocker 外扩 12px 的边界上或更远。
    const vertical = r.points.filter((p) => p.x !== 120).map((p) => p.x)
    expect(vertical.length).toBeGreaterThan(0)
    for (const x of vertical) expect(x <= blocker.x - 12 + 0.01 || x >= blocker.x + blocker.width + 12 - 0.01).toBe(true)
  })

  it('入口 stub 落进邻居卡的净距环：净距 0 重试仍给出正交折线，不退化成穿卡兜底', () => {
    // b 的左侧端口 (400,40) 外推 16px = (384,40)。w 占 300..380，它的净距环一直
    // 铺到 392——正常档里这个落点四周全被净距环封死（无解）。收缩到净距 0 时
    // w 只剩 300..380，落点与它旁边那条竖线都有路可走：线贴着边走，仍不进卡。
    const rects = [rect('a', 0, 0), rect('w', 300, 0, 80), rect('b', 400, 0)]
    const routes = routeEdges(rects, [edge('e', { nodeId: 'a', side: 'bottom' }, { nodeId: 'b', side: 'left' })])
    const r = routes.get('e')!
    assertOrthogonalPath(r.path)
    for (const box of rects) expect(crossesInterior(r.points, box)).toBe(false)
    // 真的接到端口上（而不是兜底折线在别处收尾）。
    expect(r.points[r.points.length - 1]).toEqual({ x: 400, y: 40 })
    // 兜底折线是 3 个拐点的固定 Z 形；这一档要比它更认路（至少一次绕行折返）。
    expect(r.points.length).toBeGreaterThanOrEqual(4)
  })
})

describe('routeEdges —— 美观', () => {
  it('拐角是圆角 Q，且端头两笔仍是轴对齐 L', () => {
    const rects = [rect('a', 0, 0), rect('b', 400, 400)]
    const routes = routeEdges(rects, [edge('e', { nodeId: 'a', side: 'bottom' }, { nodeId: 'b', side: 'top' })])
    const r = routes.get('e')!
    expect(r.path).toContain(' Q ')
    assertOrthogonalPath(r.path)
  })

  it('半径受相邻段长限制：短段退化成尖角而不是吃掉整段', () => {
    const rects = [rect('a', 0, 0), rect('b', 30, 160)]
    const routes = routeEdges(rects, [edge('e', { nodeId: 'a', side: 'bottom' }, { nodeId: 'b', side: 'top' })])
    const r = routes.get('e')!
    assertOrthogonalPath(r.path)
    // 所有坐标都必须有限、不出现 NaN（半径被除零污染时这里会炸）。
    expect(r.path).not.toContain('NaN')
  })

  it('标签贴出口端口：沿首段走 LABEL_GAP，不挂到画布中间', () => {
    const rects = [rect('a', 0, 0), rect('b', 400, 400)]
    const routes = routeEdges(rects, [edge('e', { nodeId: 'a', side: 'bottom' }, { nodeId: 'b', side: 'top' })])
    const r = routes.get('e')!
    // 出口端口 = a 的下缘中点；标签是「这条线从哪个状态出来」，必须贴着它。
    expect(r.points[0]).toEqual({ x: 120, y: 80 })
    const [p0, p1] = r.points
    const segLen = Math.abs(p1.x - p0.x) + Math.abs(p1.y - p0.y)
    const d = Math.min(16, segLen)
    expect(r.label.x).toBeCloseTo(p0.x + ((p1.x - p0.x) / segLen) * d)
    expect(r.label.y).toBeCloseTo(p0.y + ((p1.y - p0.y) / segLen) * d)
    // 距离端口一小段（旧实现取最长段中点，这里会差出上百像素）。
    expect(Math.abs(r.label.y - p0.y)).toBeLessThanOrEqual(16)
  })

  it('箭头尖恰好落在端口圆点边缘：d 的末段比 points 短 ARROW_GAP（= 圆点外半径），length 仍是全长', () => {
    const rects = [rect('a', 0, 0), rect('b', 400, 400)]
    const routes = routeEdges(rects, [edge('e', { nodeId: 'a', side: 'bottom' }, { nodeId: 'b', side: 'top' })])
    const r = routes.get('e')!
    assertOrthogonalPath(r.path)
    const target = r.points[r.points.length - 1]
    // points 仍精确收在端口中心（路由、罚分、拐点数都读它）。
    expect(target).toEqual({ x: 520, y: 400 })
    const end = pathEnd(r.path)
    // 回缩量 = 圆点外半径 6（WorkflowCanvas 的 .wf-handle-* 外径 12，border-box
    // 契约）——箭头尖因此精确落在圆点边缘，既不埋进圆点也不悬空留缝
    // （user 2026-11-09 先「箭头被遮住」后「有间隙，期望恰好接住」两轮反馈）。
    expect(Math.abs(target.x - end.x) + Math.abs(target.y - end.y)).toBeCloseTo(6)
    // 提前收手只能发生在**最后一段的方向**上（顶入端口 → 从正上方进来）。
    expect(end.x).toBeCloseTo(target.x)
    expect(end.y).toBeCloseTo(target.y - 6)
    // length 是路由语义的量，不跟着 d 缩短。
    let full = 0
    for (let i = 1; i < r.points.length; i += 1) {
      full += Math.abs(r.points[i].x - r.points[i - 1].x) + Math.abs(r.points[i].y - r.points[i - 1].y)
    }
    expect(r.length).toBeCloseTo(full)
  })

  it('同一个出口分叉的三条线：过 stub 之后立刻分开，不叠成一根', () => {
    const rects = [rect('a', 0, 0), rect('l', -200, 320, 160), rect('m', 80, 320, 160), rect('r', 360, 320, 160)]
    const routes = routeEdges(rects, [
      edge('al', { nodeId: 'a', side: 'bottom', at: 0.5 }, { nodeId: 'l', side: 'top' }),
      edge('am', { nodeId: 'a', side: 'bottom', at: 0.5 }, { nodeId: 'm', side: 'top' }),
      edge('ar', { nodeId: 'a', side: 'bottom', at: 0.5 }, { nodeId: 'r', side: 'top' }),
    ])
    const ls = routes.get('al')!.points
    const ms = routes.get('am')!.points
    const rs = routes.get('ar')!.points
    // 三条线共用同一个端口（第一个点必然相同），之后各自散开。
    expect(ls[0]).toEqual(ms[0])
    expect(ms[0]).toEqual(rs[0])
    // 关键在「共线重叠的长度」：叠 200px 在画面上就只剩一条线了。定额罚分
    // 让「叠 208px」与「叠 40px」同价时，A* 会选前者（实测过）。
    for (const [a, b] of [
      [ls, ms],
      [ls, rs],
      [ms, rs],
    ]) {
      expect(maxSharedRun(a, b)).toBeLessThanOrEqual(60)
    }
  })

  it('多结果状态的出口按 at 分开（0.25 / 0.75）', () => {
    const rects = [rect('a', 0, 0), rect('b', 0, 320)]
    const routes = routeEdges(rects, [
      edge('p', { nodeId: 'a', side: 'bottom', at: 0.25 }, { nodeId: 'b', side: 'top' }),
      edge('f', { nodeId: 'a', side: 'bottom', at: 0.75 }, { nodeId: 'b', side: 'top' }),
    ])
    expect(routes.get('p')!.points[0]).toEqual({ x: 60, y: 80 })
    expect(routes.get('f')!.points[0]).toEqual({ x: 180, y: 80 })
  })
})

describe('routeEdges —— 换侧绕行（主侧交叉、对侧干净）', () => {
  // 夹具是搜出来的（不是手搓的）：U→V 先路由，它的横段压在 S→T 主侧入口的
  // 竖直上升段上；S→T 的几何主侧是左侧（T 在 S 右上方，|dx| > 1.2|dy|），
  // 从右侧绕行（贴着 T 的右缘上去）则一根线都不碰。长度 +272，在预算内。
  const rects = [rect('u', 80, 80), rect('v', 380, 240), rect('s', 80, 240), rect('t', 380, 80)]
  const blocker = edge('b', { nodeId: 'u', side: 'bottom' }, { nodeId: 'v', side: 'top' })
  const plain = edge('x', { nodeId: 's', side: 'bottom' }, { nodeId: 't', side: 'left' })
  const withAlt: RouteEdgeSpec = { ...plain, altSides: ['right', 'top'] }

  /** 两条折线之间的严格内部交叉数（与 router 自己的 conflictCost 同一判据）。 */
  const crossCount = (a: Pt[], b: Pt[]): number => {
    let n = 0
    for (let i = 1; i < a.length; i += 1) {
      for (let j = 1; j < b.length; j += 1) {
        const p = a[i - 1]
        const q = a[i]
        const r = b[j - 1]
        const s = b[j]
        const aVert = Math.abs(p.x - q.x) < 0.01
        const bVert = Math.abs(r.x - s.x) < 0.01
        if (aVert === bVert) continue
        const v = aVert ? [p, q] : [r, s]
        const h = aVert ? [r, s] : [p, q]
        const vx = v[0].x
        const hy = h[0].y
        const vlo = Math.min(v[0].y, v[1].y)
        const vhi = Math.max(v[0].y, v[1].y)
        const hlo = Math.min(h[0].x, h[1].x)
        const hhi = Math.max(h[0].x, h[1].x)
        if (vx > hlo + 0.5 && vx < hhi - 0.5 && hy > vlo + 0.5 && hy < vhi - 0.5) n += 1
      }
    }
    return n
  }

  it('主侧交叉 → 换到对侧，交叉数归零、toSide 跟着换', () => {
    const before = routeEdges(rects, [blocker, plain])
    const after = routeEdges(rects, [blocker, withAlt])
    const b = before.get('b')!.points
    const p = before.get('x')!
    const q = after.get('x')!
    expect(crossCount(p.points, b)).toBe(1)
    expect(crossCount(q.points, b)).toBe(0)
    expect(p.toSide).toBe('left')
    expect(q.toSide).toBe('right')
    // 端点要真的落在右侧线头的端口上（(x+width, y+height/2)）——画布据此写
    // targetHandle，两边不一致就是「线从一个空处钻进卡片」。
    expect(q.points[q.points.length - 1]).toEqual({ x: 620, y: 120 })
    expect(p.points[p.points.length - 1]).toEqual({ x: 380, y: 120 })
    expect(q.bends).toBe(q.points.length - 2)
    expect(q.length - p.length).toBe(272)
    assertOrthogonalPath(q.path)
  })

  it('不给 altSides：逐字节等于主线（换侧是 opt-in，默认行为不动）', () => {
    const routes = routeEdges(rects, [blocker, plain])
    const r = routes.get('x')!
    expect(r.toSide).toBe('left')
    expect(r.path).toBe(routeEdges(rects, [blocker, plain]).get('x')!.path)
  })

  it('主侧本来就干净：不去试备选（不付额外搜索，端口不抖）', () => {
    const routes = routeEdges(rects, [withAlt])
    expect(routes.get('x')!.toSide).toBe('left')
  })

  it('换侧预算为 0 时认下交叉：不为了躲一根线画巨圈', () => {
    const routes = routeEdges(rects, [blocker, withAlt], { detourBudget: 0 })
    expect(routes.get('x')!.toSide).toBe('left')
    expect(routes.get('x')!.path).toBe(routeEdges(rects, [blocker, plain]).get('x')!.path)
  })

  it('拖动档（fast）冻结端口：拖动中端口来回跳比交叉更刺眼', () => {
    const routes = routeEdges(rects, [blocker, withAlt], { fast: true })
    expect(routes.get('x')!.toSide).toBe('left')
  })

  it('换侧结果确定（同一张图两遍逐字节一致）', () => {
    const one = routeEdges(rects, [blocker, withAlt]).get('x')!
    const two = routeEdges(rects, [blocker, withAlt]).get('x')!
    expect(two.path).toBe(one.path)
    expect(two.toSide).toBe(one.toSide)
  })
})

describe('routeEdges —— 确定性与退化输入', () => {
  it('同一张图算两遍逐字节一致（边序路由不能有随机性）', () => {
    const rects = [rect('a', 0, 0), rect('blocker', 0, 160), rect('b', 0, 320), rect('c', 300, 160)]
    const edges = [
      edge('ab', { nodeId: 'a', side: 'bottom' }, { nodeId: 'b', side: 'top' }),
      edge('ac', { nodeId: 'a', side: 'right' }, { nodeId: 'c', side: 'left' }),
    ]
    const one = routeEdges(rects, edges)
    const two = routeEdges(rects, edges)
    expect([...one.keys()].sort()).toEqual([...two.keys()].sort())
    for (const [id, r] of one) expect(two.get(id)!.path).toBe(r.path)
  })

  it('端点矩形缺席的边不进结果（画布据此等测量到位，而不是画一条穿卡直线）', () => {
    const routes = routeEdges([rect('a', 0, 0)], [edge('x', { nodeId: 'a', side: 'bottom' }, { nodeId: 'ghost', side: 'top' })])
    expect(routes.size).toBe(0)
  })

  it('空输入不炸', () => {
    expect(routeEdges([], []).size).toBe(0)
    expect(routeEdges([rect('a', 0, 0)], []).size).toBe(0)
  })

  it('两卡完全重叠这种退化图也有路（兜底折线），不返回 NaN', () => {
    const rects = [rect('a', 0, 0), rect('b', 0, 0)]
    const routes = routeEdges(rects, [edge('e', { nodeId: 'a', side: 'bottom' }, { nodeId: 'b', side: 'top' })])
    const r = routes.get('e')!
    expect(r.path).not.toContain('NaN')
    expect(r.points.length).toBeGreaterThan(1)
  })

  it('大图（20 卡 / 约 26 条线）在可接受时间内算完', () => {
    const rects: RouteRect[] = []
    const edges: RouteEdgeSpec[] = []
    for (let row = 0; row < 5; row += 1) {
      for (let col = 0; col < 4; col += 1) rects.push(rect(`n${row}_${col}`, col * 300, row * 160))
    }
    for (let row = 0; row < 4; row += 1) {
      for (let col = 0; col < 4; col += 1) {
        edges.push(edge(`d${row}_${col}`, { nodeId: `n${row}_${col}`, side: 'bottom' }, { nodeId: `n${row + 1}_${col}`, side: 'top' }))
        if (col < 3) {
          edges.push(edge(`s${row}_${col}`, { nodeId: `n${row}_${col}`, side: 'right' }, { nodeId: `n${row}_${col + 1}`, side: 'left' }))
        }
      }
    }
    const started = Date.now()
    const routes = routeEdges(rects, edges)
    const elapsed = Date.now() - started
    expect(routes.size).toBe(edges.length)
    expect(elapsed).toBeLessThan(3000)
    for (const r of routes.values()) assertOrthogonalPath(r.path)
  })
})

describe('routeEdges —— 平行间距 ≥10px（user 2026-11-15「预留至少10px的间距」）', () => {
  /** 两条折线之间，所有「投影重叠 > 30px 的平行段对」的最小错开距离。
   *  垂直相交（ crossings ）不算——那是交叉，不是贴线。 */
  function minParallelDistance(a: Array<{ x: number; y: number }>, b: Array<{ x: number; y: number }>): number {
    let min = Number.POSITIVE_INFINITY
    for (let i = 1; i < a.length; i += 1) {
      for (let j = 1; j < b.length; j += 1) {
        const h1 = Math.abs(a[i - 1].y - a[i].y) < 0.01
        const h2 = Math.abs(b[j - 1].y - b[j].y) < 0.01
        if (h1 !== h2) continue
        const l1 = h1 ? a[i - 1].y : a[i - 1].x
        const l2 = h2 ? b[j - 1].y : b[j - 1].x
        const lo1 = h1 ? Math.min(a[i - 1].x, a[i].x) : Math.min(a[i - 1].y, a[i].y)
        const hi1 = h1 ? Math.max(a[i - 1].x, a[i].x) : Math.max(a[i - 1].y, a[i].y)
        const lo2 = h2 ? Math.min(b[j - 1].x, b[j].x) : Math.min(b[j - 1].y, b[j].y)
        const hi2 = h2 ? Math.max(b[j - 1].x, b[j].x) : Math.max(b[j - 1].y, b[j].y)
        const overlap = Math.min(hi1, hi2) - Math.max(lo1, lo2)
        if (overlap > 30) min = Math.min(min, Math.abs(l1 - l2))
      }
    }
    return min
  }

  // E1 从 a 直落 b，竖线在 x=120（a/b 的中线）。c 紧贴 a 右侧 4px，E2 从 c 直落
  // 同一个 b——它的自然车道 x=124 与 E1 只差 4px，贴线就是它的**最短路**。网格的
  // 自然候选里没有任何 ≥10px 的替身（120/124 都来自卡片），让路车道 110/130 只能
  // 来自 laneOffsets（既有线坐标 ±10）——这条夹具同时钉住「贴线罚分」与「让路
  // 车道」两件事。
  const rects: RouteRect[] = [rect('a', 0, 0, 240, 80), rect('b', 0, 320, 240, 80), rect('c', 4, 0, 240, 80)]
  const edges: RouteEdgeSpec[] = [
    { id: 'e1', from: { nodeId: 'a', side: 'bottom' }, to: { nodeId: 'b', side: 'top' } },
    { id: 'e2', from: { nodeId: 'c', side: 'bottom' }, to: { nodeId: 'b', side: 'top' } },
  ]

  it('默认参数：E2 避到既有线 ±10px 的让路车道（贴线罚分 + 让路车道缺一不可）', () => {
    const routes = routeEdges(rects, edges)
    const e1 = routes.get('e1')!.points
    const e2 = routes.get('e2')!.points
    for (const [id, pts] of [
      ['e1', e1],
      ['e2', e2],
    ] as const) {
      expect(crossesInterior(pts, rects[0]), `${id} vs a`).toBe(false)
      expect(crossesInterior(pts, rects[1]), `${id} vs b`).toBe(false)
      assertOrthogonalPath(routes.get(id)!.path)
    }
    expect(minParallelDistance(e1, e2)).toBeGreaterThanOrEqual(10)
    // 让路车道恰好落在既有线 ±10（E1 竖线 x=120）：E2 的长竖线应在 110 或 130
    const e2VertXs = [...new Set(e2.slice(0, -1).map((p) => p.x))]
    expect(e2VertXs.some((x) => x === 110 || x === 130)).toBe(true)
  })

  it('对照：parallelGap 关掉（0）后同一夹具贴到 <10px——钉住测试测的确实是这段代码', () => {
    const routes = routeEdges(rects, edges, { parallelGap: 0 })
    const min = minParallelDistance(routes.get('e1')!.points, routes.get('e2')!.points)
    expect(min).toBeLessThan(10)
  })

  it('走廊塞不下 10px 时允许贴近（软罚分不破坏可行性），且结果确定', () => {
    // 两张卡相距 28px：净距走廊只有 4px（92 与 96 两行），任何横穿线都躲不开 10px
    const tightRects: RouteRect[] = [rect('a', 0, 0, 240, 80), rect('b', 300, 0, 240, 80), rect('c', 0, 108, 240, 80), rect('d', 300, 108, 240, 80)]
    const tightEdges: RouteEdgeSpec[] = [
      { id: 'e1', from: { nodeId: 'a', side: 'right' }, to: { nodeId: 'c', side: 'left' } },
      { id: 'e2', from: { nodeId: 'b', side: 'left' }, to: { nodeId: 'd', side: 'right' } },
    ]
    const routes = routeEdges(tightRects, tightEdges)
    expect(routes.size).toBe(2)
    for (const r of routes.values()) assertOrthogonalPath(r.path)
    // 确定性：两遍逐字节一致
    const again = routeEdges(tightRects, tightEdges)
    expect(JSON.stringify([...routes.values()].map((r) => r.points))).toBe(JSON.stringify([...again.values()].map((r) => r.points)))
  })
})

describe('routeEdges —— 真实图回归：coding-pipeline 几何（RF transform 实测）', () => {
  // 2026-11-15「水平线还是有重合」的原始现场：卡 266×101、层距 160、回边
  // fix→test 贴着 DONE 入场排 4px 走全程。夹具直接用真实坐标，钉三处修复
  // 不回退：近排罚分（d<10）必须把回边横线挤出走廊、513 同排交叠拆开、
  // 384/388 近排错开。
  const rects: RouteRect[] = [
    { id: 'START', x: 148, y: -10, width: 142, height: 39 },
    rect('code', 80, 80, 266, 101),
    rect('test', 80, 240, 266, 101),
    rect('review', 80, 400, 266, 101),
    rect('fix', 433, 400, 266, 101),
    { id: 'DONE', x: 148, y: 540, width: 142, height: 39 },
  ]
  const edges: RouteEdgeSpec[] = [
    { id: 'start-entry', from: { nodeId: 'START', side: 'bottom' }, to: { nodeId: 'code', side: 'top' } },
    { id: 'code|pass|test', from: { nodeId: 'code', side: 'bottom', at: 1 / 6 }, to: { nodeId: 'test', side: 'top' } },
    { id: 'code|fail|fix', from: { nodeId: 'code', side: 'bottom', at: 0.5 }, to: { nodeId: 'fix', side: 'left' } },
    { id: 'code|blocked|DONE', from: { nodeId: 'code', side: 'bottom', at: 5 / 6 }, to: { nodeId: 'DONE', side: 'top' } },
    { id: 'test|pass|review', from: { nodeId: 'test', side: 'bottom', at: 0.25 }, to: { nodeId: 'review', side: 'top' } },
    { id: 'test|fail|fix', from: { nodeId: 'test', side: 'bottom', at: 0.75 }, to: { nodeId: 'fix', side: 'left' } },
    { id: 'review|pass|DONE', from: { nodeId: 'review', side: 'bottom', at: 0.25 }, to: { nodeId: 'DONE', side: 'top' } },
    { id: 'review|fail|fix', from: { nodeId: 'review', side: 'bottom', at: 0.75 }, to: { nodeId: 'fix', side: 'left' } },
    { id: 'fix|pass|test', from: { nodeId: 'fix', side: 'bottom', at: 0.25 }, to: { nodeId: 'test', side: 'right' } },
    { id: 'fix|fail|test', from: { nodeId: 'fix', side: 'bottom', at: 0.75 }, to: { nodeId: 'test', side: 'left' } },
  ]

  /** 跨边水平段对里「投影重叠 > 30px」的最小错开距离：共享端口 stub 的合法
   *  收敛（十几 px 重叠）放过，走廊级别的长距离贴线（百余 px）拦下。 */
  function minHorizontalOverlapDistance(routes: Map<string, { points: Array<{ x: number; y: number }> }>): number {
    let min = Number.POSITIVE_INFINITY
    const ids = [...routes.keys()]
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const A = routes.get(ids[i])!.points
        const B = routes.get(ids[j])!.points
        for (let p = 1; p < A.length; p += 1) {
          for (let q = 1; q < B.length; q += 1) {
            const hA = Math.abs(A[p - 1].y - A[p].y) < 0.01
            const hB = Math.abs(B[q - 1].y - B[q].y) < 0.01
            if (!hA || !hB) continue
            const overlap = Math.min(A[p].x, B[q].x) - Math.max(A[p - 1].x, B[q - 1].x)
            if (overlap <= 30) continue
            min = Math.min(min, Math.abs(A[p - 1].y - B[q - 1].y))
          }
        }
      }
    }
    return min
  }

  it('所有跨边水平长重叠（>30px）的行距 ≥ 10px', () => {
    const routes = routeEdges(rects, edges)
    expect(routes.size).toBe(edges.length)
    const min = minHorizontalOverlapDistance(routes)
    expect(min).toBeGreaterThanOrEqual(10)
  })

  it('三处原始病灶各自钉住', () => {
    const routes = routeEdges(rects, edges)
    const horizontalRows = (id: string): number[] => {
      const pts = routes.get(id)!.points
      const rows: number[] = []
      for (let i = 1; i < pts.length; i += 1) {
        if (Math.abs(pts[i - 1].y - pts[i].y) < 0.01 && Math.abs(pts[i].x - pts[i - 1].x) > 30) rows.push(pts[i].y)
      }
      return rows
    }
    // 回边 fix→test 不再贴着 DONE 入场排（524）走全程——要么绕到走廊外（591）
    for (const row of horizontalRows('fix|fail|test')) expect(Math.abs(row - 524)).toBeGreaterThanOrEqual(10)
    // 513 同排交叠拆开：fix→test 的长横线与 review→fix 的 513 排错开
    for (const row of horizontalRows('fix|pass|test')) expect(row === 513 && horizontalRows('review|fail|fix').includes(513)).toBe(false)
    // 384/388 近排：test→fix 的转排行与 review 入场排（384）错开 ≥10
    for (const row of horizontalRows('test|fail|fix')) expect(Math.abs(row - 384)).toBeGreaterThanOrEqual(10)
  })
})
