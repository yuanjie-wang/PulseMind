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
