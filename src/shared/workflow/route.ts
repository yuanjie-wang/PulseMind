// 工作流画布的连线路径算法（纯函数，画布与单测共用一份）。
//
// user 2026-11-09：「要设计套连线路径的算法，1.路径最短；2.不被节点遮挡；
// 3.美观；4.走横平竖直的连线」——四条要求对应四层：
//
// 1. **最短**：A* 的主代价就是段长，**只**为绕开障碍和拐弯付钱。没有任何
//    「先横后竖」的固定模板（React Flow 的 smoothstep 就是模板：它从出口直下
//    一段、中间横过去、再直上/直下进目标，中间那根横线必然穿过挡在中间的卡片）。
// 2. **不被遮挡**：障碍 = 所有节点矩形**外扩 `clearance`**（默认 12px，视觉上
//    线与卡片之间永远留一条缝）。候选坐标取每张卡的左/右/中/上下边界 ± 净距
//    与两端口坐标（Hanan 网格），相邻候选坐标之间先做可见性判定——穿卡片的
//    那段直接不进图。所以「绕行」是图论意义上的不存在那条边，不是事后裁剪。
// 3. **美观**：① 拐弯有固定罚分（默认 24px 等效长度），省 20px 换两个直角不干；
//    ② 与**已路由**的线交叉/重叠再加罚（交叉 40 定额、重叠 20 / 每 50px 长度）——
//    边按输入序路由，后路由的线主动避让先路由的线，分叉出去的三条线因此不会叠成
//    一根（按长度计费是承重的：定额罚分下「叠 200px」与「叠 40px」同价，A* 会选
//    前者，画面上两条线重合、看起来只剩一条）；
//    ③ 出口/入口的外法线方向是一等约束（先沿法线走 stub，再从 stub 端点开始
//    找路），不会出现「从卡片下缘出来立刻贴着卡片横走」的怪相；
//    ④ 拐角一律圆角（默认 r=6，且不超过相邻段长的一半）。
// 4. **横平竖直**：所有中间段都落在候选坐标上，只在两个候选坐标之间移动，
//    输出路径由 `L`（轴对齐）与 `Q`（圆角）两种指令组成，没有斜线。
//
// 刻意不做的两件事：
// - **端口身份不进算法**：调用方只给 {nodeId, side, at}，线头 id（out:<状态>）
//   到 `at` 的换算住在画布（`inputSideOf` / 结果状态下标），算法不该知道调度键。
// - **不追求全局最优**：边序路由 + 罚分是工程解；求全局最小总长/最小交叉是
//   另一类问题（steiner / ILP），画布上 20 个节点的图不值那个复杂度，而边序
//   路由的结果是确定的——同一张图每次打开都是同一组路径（可回归、可探针）。

export interface RouteRect {
  /** 节点 id（画布传 RF 的 node id）。 */
  id: string
  x: number
  y: number
  width: number
  height: number
}

export type RouteSide = 'top' | 'bottom' | 'left' | 'right'

export interface RoutePort {
  nodeId: string
  side: RouteSide
  /** 沿该边的位置（0..1，默认 0.5 居中）——多结果状态的下缘线头逐列排开时用。 */
  at?: number
}

export interface RouteEdgeSpec {
  id: string
  from: RoutePort
  to: RoutePort
  /** 备选入口边（user 2026-11-09：「从左侧走路径短，但是会形成交叉，此时可以
   *  从右侧绕行」）。**主入口与已路由线真的冲突时**才逐个试，选「交叉最少、
   *  其次代价最低」的那一侧；主侧干净、`fast` 档、或换侧的代价超预算时一律
   *  走 `to.side`（结果与不传此字段逐字节一致）。 */
  altSides?: RouteSide[]
}

export interface RoutePoint {
  x: number
  y: number
}

export interface RouteResult {
  /** 折线拐点（未圆角）：p1 → 拐点… → p2，相邻两点必有一条轴对齐。 */
  points: RoutePoint[]
  /** SVG `d`：轴对齐的 L 段 + 拐角处的 Q。**末段比 `points` 短 `ARROW_GAP`**
   *  ——回流箭头的尖恰好落在入口线头圆点的边缘（见 ARROW_GAP 的注释）。 */
  path: string
  /** 标签落点 = **出口端口外一小段**（`LABEL_GAP`）：多状态/循环标签是「这条
   *  线是从哪个状态出来的」，挂到画布中间就失去参照（见 labelAnchor）。 */
  label: RoutePoint
  length: number
  /** 直角拐点数（＝ points.length - 2）。 */
  bends: number
  /** 实际采用的入口边——可能来自 `altSides`（绕行换侧），画布据此写
   *  `targetHandle`，否则线的端点与它挂的线头不是同一个，拖拽命中面会错位。 */
  toSide: RouteSide
}

export interface RouteOptions {
  /** 与节点矩形保持的净距（px）。 */
  clearance?: number
  /** 出/入端口后先沿法线直行的长度（px）：要大于 clearance，否则起点落在净距环里。 */
  stub?: number
  /** 每个直角拐点的等效长度罚分（px）。 */
  bendCost?: number
  /** 与已路由线交叉的罚分（px）。 */
  crossCost?: number
  /** 与已路由线共线重叠的罚分（px）。 */
  overlapCost?: number
  /** 拐角圆角半径（px，0 = 尖角）。 */
  radius?: number
  /** 换侧预算（px）：交叉更少的备选侧最多允许多走这么长的等效距离，超了仍
   *  走主侧——「宁绕不交」也要有上限，否则密集图会为躲一根线画出巨圈。 */
  detourBudget?: number
  /** 备选侧相对主侧的固有偏置（px）：交叉数与代价都持平时主侧赢，端口不抖。 */
  sideBias?: number
  /** 快速档：只算长度+拐弯（拖动重排时每帧重算，交叠罚分留给松手后的稳定态）。 */
  fast?: boolean
}

const DEFAULTS = {
  clearance: 12,
  stub: 16,
  bendCost: 24,
  crossCost: 40,
  overlapCost: 20,
  radius: 6,
  detourBudget: 600,
  sideBias: 24,
} as const

/** 候选坐标去重的容差（px）：小于半像素的两条候选线在视觉上是同一条。 */
const SAME = 0.5

/** 画出来的路径尾巴回缩量（px）= **入口线头圆点的外半径**：React Flow 的
 *  ArrowClosed 标记画在路径**终点**上（`refX="0"` 让符号顶点正好落在终点，
 *  `markerUnits="strokeWidth"` 缩放），而终点本身是圆点圆心——不回缩就被
 *  圆点整枚吞掉（user 2026-11-09「现在连接端点会把连接线的箭头端点遮住」）。
 *  回缩到**恰好等于半径**时箭头尖精确落在圆点边缘（user 同日复审「端点和箭头
 *  之间有间隙，期望恰好接住」）：标记的笔画半宽（0.5 单位 × 边宽 1.5 ×
 *  12.5/20 ≈ 0.47px）朝前溢出到圆点边缘之下，视觉上是贴着而不是悬着。
 *  12 是 `WorkflowCanvas.tsx` 里 `.wf-handle-*` 的**契约外径**（border-box，不受
 *  DPR 取整影响）——改圆点尺寸必须同步改这里。**只改画出来的 `d`**：`points`、
 *  `length`、标签仍按真实端点算，路由的交叉/重叠判定与代价比较不受影响。 */
const ARROW_GAP = 6

/** 标签中心离**出口**端口的距离（px）：0.5 的端口净空 + 文字半高 + 一点缝，
 *  既不压住线头圆点，也不越过出口 stub 的拐点。 */
const LABEL_GAP = 16

interface Inflated {
  x: number
  y: number
  w: number
  h: number
}

interface PortGeometry {
  point: RoutePoint
  /** 外法线（指向卡片外侧）——出口沿它出去，入口逆着它进来。 */
  normal: RoutePoint
}

interface Segment {
  a: RoutePoint
  b: RoutePoint
}

const DIR_H = 0
const DIR_V = 1

const round1 = (n: number): number => Math.round(n * 10) / 10

function portGeometry(rect: RouteRect, side: RouteSide, at: number | undefined): PortGeometry {
  const t = Math.min(1, Math.max(0, at ?? 0.5))
  switch (side) {
    case 'top':
      return { point: { x: rect.x + rect.width * t, y: rect.y }, normal: { x: 0, y: -1 } }
    case 'bottom':
      return { point: { x: rect.x + rect.width * t, y: rect.y + rect.height }, normal: { x: 0, y: 1 } }
    case 'left':
      return { point: { x: rect.x, y: rect.y + rect.height * t }, normal: { x: -1, y: 0 } }
    case 'right':
      return { point: { x: rect.x + rect.width, y: rect.y + rect.height * t }, normal: { x: 1, y: 0 } }
  }
}

function dirOf(normal: RoutePoint): number {
  return normal.x === 0 ? DIR_V : DIR_H
}

/** 候选坐标排序去重（数值序，容差 SAME）——顺序决定 A* 的平手解，必须稳定。 */
function normalizeCandidates(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b)
  const out: number[] = []
  for (const v of sorted) {
    if (out.length === 0 || v - out[out.length - 1] > SAME) out.push(v)
  }
  return out
}

/** 水平段是否穿过任一障碍的**内部**（沿外扩后的边界走是允许的：那条缝就是
 *  净距本身）。严格不等号是承重的——否则贴着卡片走的路径永远「被挡」。 */
function hBlocked(y: number, xa: number, xb: number, obstacles: Inflated[]): boolean {
  const lo = Math.min(xa, xb)
  const hi = Math.max(xa, xb)
  if (hi - lo < 1) return false
  for (const r of obstacles) {
    if (y <= r.y + 0.01 || y >= r.y + r.h - 0.01) continue
    if (hi <= r.x + 0.01 || lo >= r.x + r.w - 0.01) continue
    return true
  }
  return false
}

function vBlocked(x: number, ya: number, yb: number, obstacles: Inflated[]): boolean {
  const lo = Math.min(ya, yb)
  const hi = Math.max(ya, yb)
  if (hi - lo < 1) return false
  for (const r of obstacles) {
    if (x <= r.x + 0.01 || x >= r.x + r.w - 0.01) continue
    if (hi <= r.y + 0.01 || lo >= r.y + r.h - 0.01) continue
    return true
  }
  return false
}

/** 与已路由线段的交叉/重叠罚分（美观层：后路由的线让路）。 */
function conflictCost(a: RoutePoint, b: RoutePoint, routed: Segment[], crossCost: number, overlapCost: number): number {
  if (routed.length === 0) return 0
  const horizontal = Math.abs(a.y - b.y) < SAME
  const alo = horizontal ? Math.min(a.x, b.x) : Math.min(a.y, b.y)
  const ahi = horizontal ? Math.max(a.x, b.x) : Math.max(a.y, b.y)
  const aline = horizontal ? a.y : a.x
  let cost = 0
  for (const s of routed) {
    const sHorizontal = Math.abs(s.a.y - s.b.y) < SAME
    const slo = sHorizontal ? Math.min(s.a.x, s.b.x) : Math.min(s.a.y, s.b.y)
    const shi = sHorizontal ? Math.max(s.a.x, s.b.x) : Math.max(s.a.y, s.b.y)
    const sline = sHorizontal ? s.a.y : s.a.x
    if (sHorizontal === horizontal) {
      // 同向：共线且区间有重叠 → 叠成一条；错开 1px 以内也算（视觉上分不开）。
      // **按重叠长度计费**：两条线叠 200px 是「看起来只剩一条线」的读图事故，
      // 叠 40px（同一出口刚分叉那几像素）无关痛痒——定额罚分会让两种情形同价，
      // A* 于是安心把两条线叠在一起（实测踩过：同源三分叉里有两条在卡片正下方
      // 的同一根竖线上重合了 208px）。
      if (Math.abs(sline - aline) >= 1) continue
      const overlap = Math.min(ahi, shi) - Math.max(alo, slo)
      if (overlap > 2) cost += overlapCost * (overlap / 50)
      continue
    }
    // 交叉：水平段与竖直段在两者内部相交。
    const hy = horizontal ? aline : sline
    const hlo = horizontal ? alo : slo
    const hhi = horizontal ? ahi : shi
    const vx = horizontal ? sline : aline
    const vlo = horizontal ? slo : alo
    const vhi = horizontal ? shi : ahi
    if (vx > hlo + 0.5 && vx < hhi - 0.5 && hy > vlo + 0.5 && hy < vhi - 0.5) cost += crossCost
  }
  return cost
}

function segmentsOf(points: RoutePoint[]): Segment[] {
  const out: Segment[] = []
  for (let i = 1; i < points.length; i += 1) out.push({ a: points[i - 1], b: points[i] })
  return out
}

/** 去重复点 + 去共线中间点：A* 的网格步长是候选坐标之间的整段，一次移动
 *  可能被拆成若干共线小段，全并成一条。 */
function simplify(points: RoutePoint[]): RoutePoint[] {
  const deduped: RoutePoint[] = []
  for (const p of points) {
    const last = deduped[deduped.length - 1]
    if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue
    deduped.push({ x: p.x, y: p.y })
  }
  const out: RoutePoint[] = []
  for (const p of deduped) {
    while (out.length >= 2) {
      const a = out[out.length - 2]
      const b = out[out.length - 1]
      const collinearH = Math.abs(a.y - b.y) < 0.01 && Math.abs(b.y - p.y) < 0.01
      const collinearV = Math.abs(a.x - b.x) < 0.01 && Math.abs(b.x - p.x) < 0.01
      if (collinearH || collinearV) out.pop()
      else break
    }
    out.push(p)
  }
  return out
}

/** 标签锚点：从**第一个点（出口端口）**沿第一段走 `LABEL_GAP`，但不越过第一个
 *  拐点。第一段永远是出口 stub（沿外法线），所以标签就贴在它的出口下方/侧旁。 */
function labelAnchor(points: RoutePoint[]): RoutePoint {
  const a = points[0]
  const b = points[1]
  if (!b) return a
  const segLen = Math.abs(b.x - a.x) + Math.abs(b.y - a.y)
  if (segLen < 0.5) return a
  const d = Math.min(LABEL_GAP, segLen)
  return { x: a.x + ((b.x - a.x) / segLen) * d, y: a.y + ((b.y - a.y) / segLen) * d }
}

/** 把折线的**末端**沿最后一段回缩 `gap`（最多回缩一半，末段过短时不动）——
 *  给箭头腾出落点，见 `ARROW_GAP`。只影响画出来的那半条腿。 */
function trimTail(points: RoutePoint[], gap: number): RoutePoint[] {
  if (points.length < 2) return points
  const last = points[points.length - 1]
  const prev = points[points.length - 2]
  const segLen = Math.abs(last.x - prev.x) + Math.abs(last.y - prev.y)
  const cut = Math.min(gap, segLen / 2)
  if (cut < 0.5) return points
  return [...points.slice(0, -1), { x: last.x + ((prev.x - last.x) / segLen) * cut, y: last.y + ((prev.y - last.y) / segLen) * cut }]
}

/** 折线 → SVG d（拐角圆角） + 标签落点。圆角半径受相邻段长一半限制，短段
 *  直接尖角——否则 6px 的圆角会把两段吃成一个。 */
function buildPath(points: RoutePoint[], radius: number): { path: string; label: RoutePoint; length: number } {
  const drawn = trimTail(points, ARROW_GAP)
  let path = `M ${round1(drawn[0].x)} ${round1(drawn[0].y)}`
  let length = 0
  for (let i = 1; i < points.length; i += 1) {
    length += Math.abs(points[i].x - points[i - 1].x) + Math.abs(points[i].y - points[i - 1].y)
  }
  for (let i = 1; i < drawn.length; i += 1) {
    const a = drawn[i - 1]
    const b = drawn[i]
    const segLen = Math.abs(b.x - a.x) + Math.abs(b.y - a.y)
    if (i === drawn.length - 1) {
      path += ` L ${round1(b.x)} ${round1(b.y)}`
      continue
    }
    const c = drawn[i + 1]
    const nextLen = Math.abs(c.x - b.x) + Math.abs(c.y - b.y)
    const r = Math.min(radius, segLen / 2, nextLen / 2)
    if (r < 1) {
      path += ` L ${round1(b.x)} ${round1(b.y)}`
      continue
    }
    const inX = b.x + ((a.x - b.x) / (segLen || 1)) * r
    const inY = b.y + ((a.y - b.y) / (segLen || 1)) * r
    const outX = b.x + ((c.x - b.x) / (nextLen || 1)) * r
    const outY = b.y + ((c.y - b.y) / (nextLen || 1)) * r
    path += ` L ${round1(inX)} ${round1(inY)} Q ${round1(b.x)} ${round1(b.y)} ${round1(outX)} ${round1(outY)}`
  }
  return { path, label: labelAnchor(points), length }
}

/** 最小堆（A* 开放集）：f 相同时按状态键升序出队——平手解也必须确定。 */
class MinHeap {
  private readonly f: number[] = []
  private readonly k: number[] = []

  get size(): number {
    return this.f.length
  }

  push(f: number, k: number): void {
    this.f.push(f)
    this.k.push(k)
    let i = this.f.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.f[parent] < this.f[i] || (this.f[parent] === this.f[i] && this.k[parent] <= this.k[i])) break
      this.swap(i, parent)
      i = parent
    }
  }

  pop(): { f: number; k: number } {
    const top = { f: this.f[0], k: this.k[0] }
    const lastF = this.f.pop()!
    const lastK = this.k.pop()!
    if (this.f.length > 0) {
      this.f[0] = lastF
      this.k[0] = lastK
      let i = 0
      for (;;) {
        const l = i * 2 + 1
        const r = l + 1
        let best = i
        if (l < this.f.length && (this.f[l] < this.f[best] || (this.f[l] === this.f[best] && this.k[l] < this.k[best]))) best = l
        if (r < this.f.length && (this.f[r] < this.f[best] || (this.f[r] === this.f[best] && this.k[r] < this.k[best]))) best = r
        if (best === i) break
        this.swap(i, best)
        i = best
      }
    }
    return top
  }

  private swap(i: number, j: number): void {
    const tf = this.f[i]
    this.f[i] = this.f[j]
    this.f[j] = tf
    const tk = this.k[i]
    this.k[i] = this.k[j]
    this.k[j] = tk
  }
}

interface AStarInput {
  xs: number[]
  ys: number[]
  start: RoutePoint
  end: RoutePoint
  startDir: number
  endDir: number
  obstacles: Inflated[]
  routed: Segment[]
  bendCost: number
  crossCost: number
  overlapCost: number
  fast: boolean
}

/** 在候选网格上跑 A*（状态 = 网格点 × 进入方向）。返回网格点序列（含首尾），
 *  无解返回 null（正常情况下外圈车道保证连通）。 */
function solveGrid(input: AStarInput): RoutePoint[] | null {
  const { xs, ys, start, end, startDir, endDir, obstacles, routed, bendCost, crossCost, overlapCost, fast } = input
  const nx = xs.length
  const ny = ys.length
  if (nx < 2 || ny < 2) return null
  const indexOf = (value: number, list: number[]): number => {
    let best = 0
    for (let i = 1; i < list.length; i += 1) if (Math.abs(list[i] - value) < Math.abs(list[best] - value)) best = i
    return best
  }
  const si = indexOf(start.x, xs)
  const sj = indexOf(start.y, ys)
  const ti = indexOf(end.x, xs)
  const tj = indexOf(end.y, ys)
  const cells = nx * ny
  const stateOf = (i: number, j: number, dir: number): number => (j * nx + i) * 2 + dir
  const g: number[] = new Array(cells * 2).fill(Number.POSITIVE_INFINITY)
  const parent: number[] = new Array(cells * 2).fill(-1)
  const closed: boolean[] = new Array(cells * 2).fill(false)
  // 可通行性**按段缓存**，键 = 该段的起点格（向右 = (i,j)→(i+1,j)，向下 =
  // (i,j)→(i,j+1)）。方向必须显式区分：早先只有一份「当前格能不能上下」，
  // 它描述的是**下方**那段，却被上行移动也拿去用——末行起步时向上一律判死，
  // 明明有路的图也走不出去，整条边退回兜底折线（2026-11-09 实测：起终点在
  // 同一障碍带里、只在最后一行对齐时命中）。
  const hOpen: boolean[] = new Array(cells).fill(false)
  const vOpen: boolean[] = new Array(cells).fill(false)
  const hKnown: boolean[] = new Array(cells).fill(false)
  const vKnown: boolean[] = new Array(cells).fill(false)
  /** 段 (i,j)→(i+1,j) 是否可走。 */
  const hFree = (i: number, j: number): boolean => {
    if (i + 1 >= nx) return false
    const cell = j * nx + i
    if (!hKnown[cell]) {
      hKnown[cell] = true
      hOpen[cell] = !hBlocked(ys[j], xs[i], xs[i + 1], obstacles)
    }
    return hOpen[cell]
  }
  /** 段 (i,j)→(i,j+1) 是否可走。 */
  const vFree = (i: number, j: number): boolean => {
    if (j + 1 >= ny) return false
    const cell = j * nx + i
    if (!vKnown[cell]) {
      vKnown[cell] = true
      vOpen[cell] = !vBlocked(xs[i], ys[j], ys[j + 1], obstacles)
    }
    return vOpen[cell]
  }

  const heuristic = (x: number, y: number): number => Math.abs(x - end.x) + Math.abs(y - end.y)
  const open = new MinHeap()
  const startState = stateOf(si, sj, startDir)
  g[startState] = 0
  open.push(heuristic(start.x, start.y), startState)

  let bestGoal = Number.POSITIVE_INFINITY
  let bestGoalState = -1
  while (open.size > 0) {
    const { f, k } = open.pop()
    if (f >= bestGoal) break
    if (closed[k]) continue
    closed[k] = true
    const dir = k % 2
    const cell = (k - dir) / 2
    const i = cell % nx
    const j = (cell - i) / nx
    const x = xs[i]
    const y = ys[j]

    if (i === ti && j === tj) {
      const total = g[k] + (dir === endDir ? 0 : bendCost)
      if (total < bestGoal) {
        bestGoal = total
        bestGoalState = k
      }
      continue
    }

    const moves: Array<{ ni: number; nj: number; dir: number; nx: number; ny: number }> = []
    if (hFree(i, j)) moves.push({ ni: i + 1, nj: j, dir: DIR_H, nx: xs[i + 1], ny: y })
    if (i > 0 && hFree(i - 1, j)) moves.push({ ni: i - 1, nj: j, dir: DIR_H, nx: xs[i - 1], ny: y })
    if (vFree(i, j)) moves.push({ ni: i, nj: j + 1, dir: DIR_V, nx: x, ny: ys[j + 1] })
    if (j > 0 && vFree(i, j - 1)) moves.push({ ni: i, nj: j - 1, dir: DIR_V, nx: x, ny: ys[j - 1] })
    for (const m of moves) {
      const ns = stateOf(m.ni, m.nj, m.dir)
      if (closed[ns]) continue
      const segLen = Math.abs(m.nx - x) + Math.abs(m.ny - y)
      let cost = segLen + (dir === m.dir ? 0 : bendCost)
      if (!fast) cost += conflictCost({ x, y }, { x: m.nx, y: m.ny }, routed, crossCost, overlapCost)
      const next = g[k] + cost
      if (next < g[ns] - 1e-6) {
        g[ns] = next
        parent[ns] = k
        open.push(next + heuristic(m.nx, m.ny), ns)
      }
    }
  }

  if (bestGoalState < 0) return null
  const points: RoutePoint[] = []
  let cur = bestGoalState
  while (cur >= 0) {
    const dir = cur % 2
    const cell = (cur - dir) / 2
    const i = cell % nx
    const j = (cell - i) / nx
    points.push({ x: xs[i], y: ys[j] })
    cur = parent[cur]
  }
  points.reverse()
  return points
}

/** 无解兜底：中点折返的 Z 形。网格正常情况下总能连通（外圈留了车道），
 *  这条只在调用方给的矩形退化（宽高 0/重叠）时出现——有路总比不画强。 */
function fallbackPoints(start: RoutePoint, end: RoutePoint, startDir: number): RoutePoint[] {
  if (startDir === DIR_V) {
    const midY = (start.y + end.y) / 2
    return [start, { x: start.x, y: midY }, { x: end.x, y: midY }, end]
  }
  const midX = (start.x + end.x) / 2
  return [start, { x: midX, y: start.y }, { x: midX, y: end.y }, end]
}

/**
 * 给一组边算正交路径。返回 id → 结果；**端点矩形缺席的边不在结果里**（调用
 * 方据此跳过这一帧的更新，等节点测量/同步到位再画），不会被静默画成一条穿卡
 * 的直线。
 *
 * 边按输入序路由：先路由的线占据空间，后路由的线带着交叉/重叠罚分绕开它。
 * 顺序由调用方（画布按 def.edges 的声明序）决定，同一张图结果确定。
 */
export function routeEdges(rects: RouteRect[], edges: RouteEdgeSpec[], options?: RouteOptions): Map<string, RouteResult> {
  const clearance = options?.clearance ?? DEFAULTS.clearance
  const stub = options?.stub ?? DEFAULTS.stub
  const bendCost = options?.bendCost ?? DEFAULTS.bendCost
  const crossCost = options?.crossCost ?? DEFAULTS.crossCost
  const overlapCost = options?.overlapCost ?? DEFAULTS.overlapCost
  const radius = options?.radius ?? DEFAULTS.radius
  const detourBudget = options?.detourBudget ?? DEFAULTS.detourBudget
  const sideBias = options?.sideBias ?? DEFAULTS.sideBias
  const fast = options?.fast === true

  const out = new Map<string, RouteResult>()
  const byId = new Map(rects.map((r) => [r.id, r]))

  // 障碍与候选坐标都随净距变，所以按净距造一份「网格帧」：全局候选 = 每张卡的
  // 左右边/中线、上下边/中线；外加一圈更远的外圈车道（绕开所有卡片的路永远
  // 存在，A* 不会因为「无解」退化成兜底折线）。
  interface GridFrame {
    obstacles: Inflated[]
    xs: number[]
    ys: number[]
  }
  const frameOf = (gap: number): GridFrame => {
    const obstacles: Inflated[] = rects.map((r) => ({
      x: r.x - gap,
      y: r.y - gap,
      w: r.width + gap * 2,
      h: r.height + gap * 2,
    }))
    const xs: number[] = []
    const ys: number[] = []
    for (const r of rects) {
      xs.push(r.x - gap, r.x + r.width + gap, r.x + r.width / 2)
      ys.push(r.y - gap, r.y + r.height + gap, r.y + r.height / 2)
    }
    if (rects.length > 0) {
      const lane = gap * 2 + stub
      const minX = Math.min(...rects.map((r) => r.x))
      const maxX = Math.max(...rects.map((r) => r.x + r.width))
      const minY = Math.min(...rects.map((r) => r.y))
      const maxY = Math.max(...rects.map((r) => r.y + r.height))
      xs.push(minX - lane, maxX + lane)
      ys.push(minY - lane, maxY + lane)
    }
    return { obstacles, xs, ys }
  }
  const strict = frameOf(clearance)
  // 收缩档：净距 0 = 允许线贴着卡片边缘走。两张卡之间塞不下 2×clearance 的
  // 走廊时（自动布局 34px 间距 < 24+2×stub 的净距环），正常档会把整条走廊判
  // 死、绕大圈甚至无解；这一档还能给出「贴着边走」的正交折线，四条要求里
  // 只让「留缝」这条退让，绝不退让「不穿卡」。
  const tight = clearance > 0 ? frameOf(0) : strict

  const routed: Segment[] = []

  /** 一条边的某一种入口走法（主侧与每个备选侧各算一次）。 */
  interface Attempt {
    side: RouteSide
    points: RoutePoint[]
    path: string
    label: RoutePoint
    length: number
    bends: number
    /** A* 两档都没解、退到兜底折线（端口被邻居卡埋住）——这种不值当候选。 */
    fallback: boolean
  }

  /** 折线落在已路由线上的代价（与 A* 内同一公式、同一把尺子，才可比）。
   *  `cross=1, overlap=0` 时它的值就是**交叉数**（整数，逐对相加不会漂）。 */
  const conflictOf = (points: RoutePoint[], cross: number, overlap: number): number => {
    let sum = 0
    for (const seg of segmentsOf(points)) sum += conflictCost(seg.a, seg.b, routed, cross, overlap)
    return sum
  }

  for (const spec of edges) {
    const fromRect = byId.get(spec.from.nodeId)
    const toRect = byId.get(spec.to.nodeId)
    if (!fromRect || !toRect) continue
    const fromPort = portGeometry(fromRect, spec.from.side, spec.from.at)
    const start = { x: fromPort.point.x + fromPort.normal.x * stub, y: fromPort.point.y + fromPort.normal.y * stub }
    const startDir = dirOf(fromPort.normal)

    const attempt = (side: RouteSide): Attempt => {
      const toPort = portGeometry(toRect, side, spec.to.at)
      const end = { x: toPort.point.x + toPort.normal.x * stub, y: toPort.point.y + toPort.normal.y * stub }
      const endDir = dirOf(toPort.normal)
      const solveIn = (frame: GridFrame): RoutePoint[] | null =>
        solveGrid({
          xs: normalizeCandidates([...frame.xs, fromPort.point.x, toPort.point.x, start.x, end.x]),
          ys: normalizeCandidates([...frame.ys, fromPort.point.y, toPort.point.y, start.y, end.y]),
          start,
          end,
          startDir,
          endDir,
          obstacles: frame.obstacles,
          routed,
          bendCost,
          crossCost,
          overlapCost,
          fast,
        })
      // 重试梯：正常净距 → 净距 0（端点卡片真有重叠、端口被邻居卡埋住时才会
      // 无解）。无解即 `mid === null`，兜底折线由这里给、由调用方决定要不要用。
      const mid = solveIn(strict) ?? (tight === strict ? null : solveIn(tight))
      const points = simplify([fromPort.point, ...(mid ?? fallbackPoints(start, end, startDir)), toPort.point])
      const { path, label, length } = buildPath(points, radius)
      return { side, points, path, label, length, bends: Math.max(0, points.length - 2), fallback: mid === null }
    }

    const primary = attempt(spec.to.side)
    let chosen = primary
    // 换侧只在**主侧真的撞上已路由线**时才做（user 2026-11-09「从左侧走路径短，
    // 但是会形成交叉，此时可以从右侧绕行」）：干净的主侧不付任何额外搜索、结果
    // 与不传 altSides 逐字节一致；拖动档（fast）一律不动端口，否则端口会在拖动
    // 过程中来回跳。
    const alts = fast ? [] : (spec.altSides ?? []).filter((side) => side !== spec.to.side)
    if (alts.length > 0 && conflictOf(primary.points, 1, 1) > 0) {
      const costOf = (a: Attempt, bias: number): number => a.length + a.bends * bendCost + conflictOf(a.points, crossCost, overlapCost) + bias
      const primaryCost = costOf(primary, 0)
      // 排序键是**交叉数优先**（不是把交叉折成很贵的长途罚分）：用户要的就是
      // 「宁可多走几步也别交叉」，所以先比交叉、同交叉数才比代价。
      let bestCross = conflictOf(primary.points, 1, 0)
      let bestCost = primaryCost
      for (const side of alts) {
        const cand = attempt(side)
        if (cand.fallback) continue
        const cross = conflictOf(cand.points, 1, 0)
        const cost = costOf(cand, sideBias)
        const better = cross < bestCross || (cross === bestCross && cost < bestCost - 1e-6)
        if (!better) continue
        // 预算：换侧带来的额外等效长度超上限就认了这次交叉——密集图里为躲
        // 一根线画出巨圈比交叉更难看。
        if (cost - primaryCost > detourBudget) continue
        bestCross = cross
        bestCost = cost
        chosen = cand
      }
    }

    out.set(spec.id, {
      points: chosen.points,
      path: chosen.path,
      label: chosen.label,
      length: chosen.length,
      bends: chosen.bends,
      toSide: chosen.side,
    })
    routed.push(...segmentsOf(chosen.points))
  }
  return out
}
