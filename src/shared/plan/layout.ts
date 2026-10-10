/**
 * Pure geometry for the plan DAG view (PLAN-workbench W6 + W9 + W11).
 *
 * The graph is a wave DAG: wave index = position along the FLOW axis,
 * barycenter-ordered row index = position across it. The flow axis is
 * HORIZONTAL (waves → right) or VERTICAL (waves → down), chosen by the
 * caller from whichever orientation fits its viewport better — a deep chain
 * reads top-to-bottom in a narrow pane, a wide parallel plan reads
 * left-to-right. All routing invariants hold in both orientations because
 * they are defined on the (flow, cross) axes and only projected.
 *
 * Edge routing: an edge between ADJACENT waves is a bezier across the gap
 * between them (source's flow+ edge → target's flow− edge). Any edge that
 * spans further (a skip-level dependency, or a terminal draining into 结束
 * from an earlier wave) would cut through intermediate cards, so it detours
 * along the cross− side (above the grid / left of the grid): a bus lane
 * above every card, dropping into the target's flow− edge through the
 * node-free gap channel. Lanes get GLOBAL running indices — every over edge
 * rides at its own offset — and the lane count is known BEFORE cards are
 * placed, so the grid shifts to make room: a line can never overlap a card.
 *
 * The 开始/结束 anchor pills bracket the flow: 开始 fans out to every entry
 * (no dependsOn), every terminal (no dependents) drains into 结束.
 */
import type { Plan, PlanNode, PlanNodeStatus } from '../types/plan'
import { planLayers } from './graph'

/** Card width. The description wrap in PlanGraphView is derived from it
 *  (inner width = NODE_W − 20), so widen both together or text overflows. */
export const NODE_W = 180
/** Tall enough for the card's four text rows (编号 / 执行者 / 内容 ×2) — see
 *  ROW_NUM..DESC_STEP in PlanGraphView, which place the baselines. */
export const NODE_H = 72
/** Room for a dependency bezier between adjacent waves. */
export const GAP_X = 44
export const GAP_Y = 24
export const GRAPH_PADDING = 14
/** Base coordinate of the first bus lane (lane i sits at BUS_Y + i*BUS_LANE_STEP). */
export const BUS_Y = 6
export const BUS_LANE_STEP = 9
/** How far a routed edge offsets from a card edge into the gap channel. */
export const CHANNEL = 12
/** The 开始/结束 anchor pills bracketing the flow. */
export const TERMINAL_W = 40
export const TERMINAL_H = 26

export type GraphDirection = 'horizontal' | 'vertical'

export interface LayoutNode {
  id: string
  num: number
  description: string
  status: PlanNodeStatus
  assignee?: string
  summary?: string
  msgId?: string
  /** Sub-conversation the node's spawn runs in — the click target for the
   *  drill-down (PLAN-workbench W12), carried through from the plan node. */
  subConvId?: string
  wave: number
  x: number
  y: number
  w: number
  h: number
  terminal?: 'start' | 'end'
}

export interface LayoutEdge {
  from: string
  to: string
  path: string
  fromStatus: PlanNodeStatus
  kind: 'adjacent' | 'over'
}

export interface PlanGraphLayout {
  direction: GraphDirection
  nodes: LayoutNode[]
  edges: LayoutEdge[]
  width: number
  height: number
}

interface Spec {
  src: LayoutNode
  dst: LayoutNode
  fromStatus: PlanNodeStatus
}

export function layoutPlanGraph(plan: Plan, direction: GraphDirection = 'horizontal'): PlanGraphLayout {
  // ── Topology (orientation-independent) ──
  const waves = planLayers(plan)
  const waveOf = new Map<string, number>()
  waves.forEach((wave, wi) => { for (const n of wave) waveOf.set(n.id, wi) })

  // Bus-lane reservation must count the SAME edge set that will allocate
  // lanes below (full_20261011 M12-P1-2): the terminal→结 end anchor drains
  // from ANY wave, so a plan whose branch ends early rides its own lane — an
  // edge a dependency-only count never saw, and the bus then crossed the
  // first card row. Both counts are wave facts, so they are computable from
  // waveOf alone before placement (the anchor edges' adjacency is decided by
  // src.wave vs dst.wave−1, exactly as the spec loop below judges it).
  const dependedOn = new Set(plan.nodes.flatMap(n => n.dependsOn))
  let totalLanes = 0
  for (const node of plan.nodes) {
    const nodeWave = waveOf.get(node.id)
    for (const depId of node.dependsOn) {
      const depWave = waveOf.get(depId)
      if (depWave !== undefined && nodeWave !== undefined && depWave !== nodeWave - 1) {
        totalLanes += 1
      }
    }
    if (!dependedOn.has(node.id) && nodeWave !== undefined && nodeWave !== waves.length - 1) {
      totalLanes += 1
    }
  }
  // Bus lanes sit on the cross− side of the grid; the grid shifts to clear them.
  const lanePad = totalLanes > 0 ? BUS_Y + totalLanes * BUS_LANE_STEP + 12 : GRAPH_PADDING

  // Barycenter cross-order within each wave.
  const crossOf = new Map<string, number>()
  waves.forEach((wave) => {
    const barycenter = (n: PlanNode): number => {
      const depCross = n.dependsOn
        .map(d => crossOf.get(d))
        .filter((r): r is number => r !== undefined)
      if (depCross.length === 0) return Number.MAX_SAFE_INTEGER
      return depCross.reduce((s, r) => s + r, 0) / depCross.length
    }
    ;[...wave].sort((a, b) => barycenter(a) - barycenter(b)).forEach((n, ci) => crossOf.set(n.id, ci))
  })

  // ── Placement ──
  const nodes: LayoutNode[] = []
  const place = (n: PlanNode, wi: number, ci: number): void => {
    nodes.push({
      id: n.id,
      num: Number(n.id.slice(1)),
      description: n.description,
      status: n.status,
      ...(n.assignee ? { assignee: n.assignee } : {}),
      ...(n.summary ? { summary: n.summary } : {}),
      ...(n.msgId ? { msgId: n.msgId } : {}),
      ...(n.subConvId ? { subConvId: n.subConvId } : {}),
      wave: wi,
      ...(direction === 'horizontal'
        ? {
            x: GRAPH_PADDING + TERMINAL_W + GAP_X + wi * (NODE_W + GAP_X),
            y: lanePad + ci * (NODE_H + GAP_Y),
            w: NODE_W, h: NODE_H,
          }
        : {
            x: lanePad + ci * (NODE_W + GAP_X),
            y: GRAPH_PADDING + TERMINAL_H + GAP_Y + wi * (NODE_H + GAP_Y),
            w: NODE_W, h: NODE_H,
          }),
    })
  }
  waves.forEach((wave, wi) => {
    for (const n of wave) place(n, wi, crossOf.get(n.id) ?? 0)
  })
  const pos = new Map(nodes.map(n => [n.id, n]))

  const entryIds = new Set(plan.nodes.filter(n => n.dependsOn.length === 0).map(n => n.id))
  const entries = nodes.filter(n => entryIds.has(n.id))
  const terminals = nodes.filter(n => !dependedOn.has(n.id))

  // Flow extent (after the last wave) and cross extent (widest wave).
  const flowEnd = direction === 'horizontal'
    ? GRAPH_PADDING + TERMINAL_W + GAP_X + (waves.length - 1) * (NODE_W + GAP_X) + NODE_W + GAP_X
    : GRAPH_PADDING + TERMINAL_H + GAP_Y + (waves.length - 1) * (NODE_H + GAP_Y) + NODE_H + GAP_Y
  const crossExtent = direction === 'horizontal'
    ? lanePad + Math.max(...waves.map(w => w.length), 1) * NODE_H + (Math.max(...waves.map(w => w.length), 1) - 1) * GAP_Y + GRAPH_PADDING
    : lanePad + Math.max(...waves.map(w => w.length), 1) * NODE_W + (Math.max(...waves.map(w => w.length), 1) - 1) * GAP_X + GRAPH_PADDING

  const start = direction === 'horizontal'
    ? {
        id: '__start__', num: 0, description: '开始', status: 'pending' as const, wave: -1,
        x: GRAPH_PADDING, y: clamp(centerOf(entries, 'y', lanePad) - TERMINAL_H / 2, lanePad, crossExtent - GRAPH_PADDING - TERMINAL_H),
        w: TERMINAL_W, h: TERMINAL_H, terminal: 'start' as const,
      }
    : {
        id: '__start__', num: 0, description: '开始', status: 'pending' as const, wave: -1,
        x: clamp(centerOf(entries, 'x', lanePad) - TERMINAL_W / 2, lanePad, crossExtent - GRAPH_PADDING - TERMINAL_W),
        y: GRAPH_PADDING, w: TERMINAL_W, h: TERMINAL_H, terminal: 'start' as const,
      }
  const end = direction === 'horizontal'
    ? {
        id: '__end__', num: 0, description: '结束', status: 'pending' as const, wave: waves.length,
        x: flowEnd, y: clamp(centerOf(terminals, 'y', lanePad) - TERMINAL_H / 2, lanePad, crossExtent - GRAPH_PADDING - TERMINAL_H),
        w: TERMINAL_W, h: TERMINAL_H, terminal: 'end' as const,
      }
    : {
        id: '__end__', num: 0, description: '结束', status: 'pending' as const, wave: waves.length,
        x: clamp(centerOf(terminals, 'x', lanePad) - TERMINAL_W / 2, lanePad, crossExtent - GRAPH_PADDING - TERMINAL_W),
        y: flowEnd, w: TERMINAL_W, h: TERMINAL_H, terminal: 'end' as const,
      }

  // ── Edge specs: real dependencies + the anchor fan-in/out ──
  const specs: Spec[] = []
  for (const node of plan.nodes) {
    const dst = pos.get(node.id)
    if (!dst) continue
    for (const depId of node.dependsOn) {
      const src = pos.get(depId)
      if (!src) continue
      specs.push({ src, dst, fromStatus: src.status })
    }
  }
  for (const entry of entries) specs.push({ src: start, dst: entry, fromStatus: 'pending' })
  for (const terminal of terminals) specs.push({ src: terminal, dst: end, fromStatus: terminal.status })

  // Stagger bookkeeping: bus lanes are GLOBAL (unique height per over edge);
  // drop channels and entry offsets stagger within each target group.
  const overIndex = new Map<string, number>()
  const overCount = new Map<string, number>()
  let globalLane = 0
  for (const s of specs) {
    if (s.src.wave !== s.dst.wave - 1) {
      overIndex.set(s.dst.id, overIndex.get(s.dst.id) ?? 0)
      overCount.set(s.dst.id, (overCount.get(s.dst.id) ?? 0) + 1)
    }
  }
  const nextOverIndex = (k: string): number => {
    const i = overIndex.get(k)!
    overIndex.set(k, i + 1)
    return i
  }

  const edges: LayoutEdge[] = specs.map(({ src, dst, fromStatus }) => {
    if (src.wave === dst.wave - 1) {
      return { from: src.id, to: dst.id, path: bezierEdge(src, dst, direction), fromStatus, kind: 'adjacent' as const }
    }
    const i = nextOverIndex(dst.id)
    const count = overCount.get(dst.id) ?? 1
    const lane = BUS_Y + globalLane++ * BUS_LANE_STEP
    // Drop-channel stagger: spread a target's fan-in across the gap that is
    // actually available, and never past it. The old fixed 6px step ran out of
    // channel at i ≥ 6 in horizontal flow (GAP_X 44) and i ≥ 2 in vertical
    // (GAP_Y 24), drawing the entry rail through the previous row/column's
    // card — the deepest offset lands CHANNEL + (count−1)·step = gap − 4, i.e.
    // 4px clear of the neighbouring card. A single over edge (count 1) keeps
    // the exact pre-fix geometry (offset 0 regardless of step).
    const gap = direction === 'horizontal' ? GAP_X : GAP_Y
    const step = (gap - CHANNEL - 4) / Math.max(count - 1, 1)
    return {
      from: src.id,
      to: dst.id,
      path: direction === 'horizontal'
        ? busEdgeH(src, dst, {
            busY: lane,
            inX: dst.x - CHANNEL - i * step,
            entryY: clamp(dst.y + dst.h / 2 + (i - (count - 1) / 2) * 12, dst.y + 8, dst.y + dst.h - 8),
          })
        : busEdgeV(src, dst, {
            busX: lane,
            inY: dst.y - CHANNEL - i * step,
            entryX: clamp(dst.x + dst.w / 2 + (i - (count - 1) / 2) * 14, dst.x + 8, dst.x + dst.w - 8),
          }),
      fromStatus,
      kind: 'over' as const,
    }
  })

  return {
    direction,
    nodes: [start, ...nodes, end],
    edges,
    width: direction === 'horizontal' ? flowEnd + TERMINAL_W + GRAPH_PADDING : crossExtent,
    height: direction === 'horizontal' ? crossExtent : flowEnd + TERMINAL_H + GRAPH_PADDING,
  }
}

/** Vertical center (axis='y') / horizontal center (axis='x') of a group. */
function centerOf(group: LayoutNode[], axis: 'x' | 'y', fallback: number): number {
  if (group.length === 0) return fallback + (axis === 'x' ? NODE_W : NODE_H) / 2
  return group.reduce((s, n) => s + n[axis] + (axis === 'x' ? n.w : n.h) / 2, 0) / group.length
}

/** Adjacent waves: source's flow+ edge → target's flow− edge, bezier bulging
 *  through the flow midpoint. */
function bezierEdge(src: LayoutNode, dst: LayoutNode, direction: GraphDirection): string {
  if (direction === 'horizontal') {
    const x1 = dst.x
    const y1 = dst.y + dst.h / 2
    const x2 = src.x + src.w
    const y2 = src.y + src.h / 2
    const mx = (x1 + x2) / 2
    return `M ${x2} ${y2} C ${mx} ${y2}, ${mx} ${y1}, ${x1} ${y1}`
  }
  const x1 = dst.x + dst.w / 2
  const y1 = dst.y
  const x2 = src.x + src.w / 2
  const y2 = src.y + src.h
  const my = (y1 + y2) / 2
  return `M ${x2} ${y2} C ${x2} ${my}, ${x1} ${my}, ${x1} ${y1}`
}

/** A dependency spanning more than one wave must not cut through the
 *  intermediate cards: detour along the cross− side (top lane in horizontal
 *  flow, left rail in vertical flow) and enter the target's flow− edge.
 *  Lanes/entry offsets come from the stagger bookkeeping. */
function busEdgeH(
  src: LayoutNode,
  dst: LayoutNode,
  lane: { busY: number; inX: number; entryY: number },
): string {
  const x2 = src.x + src.w
  const y2 = src.y + src.h / 2
  const outX = x2 + CHANNEL
  return `M ${x2} ${y2} L ${outX} ${y2} L ${outX} ${lane.busY} L ${lane.inX} ${lane.busY} L ${lane.inX} ${lane.entryY} L ${dst.x} ${lane.entryY}`
}

function busEdgeV(
  src: LayoutNode,
  dst: LayoutNode,
  lane: { busX: number; inY: number; entryX: number },
): string {
  const x2 = src.x + src.w / 2
  const y2 = src.y + src.h
  const outY = y2 + CHANNEL
  return `M ${x2} ${y2} L ${x2} ${outY} L ${lane.busX} ${outY} L ${lane.busX} ${lane.inY} L ${lane.entryX} ${lane.inY} L ${lane.entryX} ${dst.y}`
}

const clamp = (v: number, min: number, max: number): number => Math.min(Math.max(v, min), max)
