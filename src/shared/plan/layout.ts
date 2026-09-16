/**
 * Pure geometry for the plan DAG view (PLAN-workbench W6). Waves become
 * columns (time flows left → right), nodes inside a wave are ordered by the
 * average row of their dependencies (barycenter — keeps dependency lines from
 * fanning across each other), and every dependency becomes one cubic bezier.
 * The renderer (PlanGraphView) draws exactly what this returns; tests pin the
 * math without a DOM.
 */
import type { Plan, PlanNode, PlanNodeStatus } from '../types/plan'
import { planLayers } from './graph'

export const NODE_W = 128
export const NODE_H = 44
/** Horizontal room for the dependency bezier between waves. */
export const GAP_X = 56
export const GAP_Y = 18
export const GRAPH_PADDING = 12

export interface LayoutNode {
  id: string
  /** 1-based number, for the label. */
  num: number
  description: string
  status: PlanNodeStatus
  assignee?: string
  summary?: string
  msgId?: string
  wave: number
  x: number
  y: number
  w: number
  h: number
}

export interface LayoutEdge {
  from: string
  to: string
  /** SVG `d` for a cubic bezier: source right edge → target left edge. */
  path: string
  /** Source status — the line's color/state follows the upstream node. */
  fromStatus: PlanNodeStatus
}

export interface PlanGraphLayout {
  nodes: LayoutNode[]
  edges: LayoutEdge[]
  /** Total drawn size (padding included) — the SVG viewBox. */
  width: number
  height: number
}

export function layoutPlanGraph(plan: Plan): PlanGraphLayout {
  const waves = planLayers(plan)

  // Row position of every placed node, wave by wave, so barycenter ordering
  // can look back at the previous column.
  const rowOf = new Map<string, number>()
  const nodes: LayoutNode[] = []

  waves.forEach((wave, wi) => {
    const barycenter = (n: PlanNode): number => {
      const depRows = n.dependsOn
        .map(d => rowOf.get(d))
        .filter((r): r is number => r !== undefined)
      if (depRows.length === 0) return Number.MAX_SAFE_INTEGER // deps unseen → keep input order at the tail
      return depRows.reduce((s, r) => s + r, 0) / depRows.length
    }
    const ordered = [...wave].sort((a, b) => barycenter(a) - barycenter(b))
    ordered.forEach((n, ri) => {
      rowOf.set(n.id, ri)
      nodes.push({
        id: n.id,
        num: Number(n.id.slice(1)),
        description: n.description,
        status: n.status,
        ...(n.assignee ? { assignee: n.assignee } : {}),
        ...(n.summary ? { summary: n.summary } : {}),
        ...(n.msgId ? { msgId: n.msgId } : {}),
        wave: wi,
        x: GRAPH_PADDING + wi * (NODE_W + GAP_X),
        y: GRAPH_PADDING + ri * (NODE_H + GAP_Y),
        w: NODE_W,
        h: NODE_H,
      })
    })
  })

  const pos = new Map(nodes.map(n => [n.id, n]))
  const edges: LayoutEdge[] = []
  for (const node of plan.nodes) {
    const dst = pos.get(node.id)
    if (!dst) continue
    for (const depId of node.dependsOn) {
      const src = pos.get(depId)
      if (!src) continue
      // Dependency → dependent: source's right edge to target's left edge.
      const x1 = dst.x
      const y1 = dst.y + dst.h / 2
      const x2 = src.x + src.w
      const y2 = src.y + src.h / 2
      const mx = (x1 + x2) / 2
      edges.push({
        from: depId,
        to: node.id,
        path: `M ${x2} ${y2} C ${mx} ${y2}, ${mx} ${y1}, ${x1} ${y1}`,
        fromStatus: src.status,
      })
    }
  }

  const columns = waves.length
  const rows = Math.max(...waves.map(w => w.length), 1)
  return {
    nodes,
    edges,
    width: GRAPH_PADDING * 2 + columns * NODE_W + (columns - 1) * GAP_X,
    height: GRAPH_PADDING * 2 + rows * NODE_H + (rows - 1) * GAP_Y,
  }
}
