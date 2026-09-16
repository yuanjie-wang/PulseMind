import { describe, expect, it } from 'vitest'
import {
  GAP_X,
  GAP_Y,
  GRAPH_PADDING,
  NODE_H,
  NODE_W,
  layoutPlanGraph,
} from '../src/shared/plan/layout'
import { createPlanDag } from '../src/shared/plan/graph'

describe('layoutPlanGraph', () => {
  it('places waves in columns and rows without overlap', () => {
    const plan = createPlanDag('ship', [
      { description: 'a' },
      { description: 'b', dependsOn: [1] },
      { description: 'c', dependsOn: [1] },
      { description: 'd', dependsOn: [2, 3] },
    ])
    const layout = layoutPlanGraph(plan)

    const byId = new Map(layout.nodes.map(n => [n.id, n]))
    expect(byId.get('n1')!.wave).toBe(0)
    expect(byId.get('n2')!.wave).toBe(1)
    expect(byId.get('n3')!.wave).toBe(1)
    expect(byId.get('n4')!.wave).toBe(2)

    // Columns advance by NODE_W + GAP_X; rows within a wave by NODE_H + GAP_Y.
    expect(byId.get('n2')!.x - byId.get('n1')!.x).toBe(NODE_W + GAP_X)
    expect(byId.get('n3')!.x).toBe(byId.get('n2')!.x)
    expect(byId.get('n3')!.y - byId.get('n2')!.y).toBe(NODE_H + GAP_Y)

    expect(layout.width).toBe(GRAPH_PADDING * 2 + 3 * NODE_W + 2 * GAP_X)
    expect(layout.height).toBe(GRAPH_PADDING * 2 + 2 * NODE_H + GAP_Y)
    expect(layout.nodes.every(n => n.x >= 0 && n.y >= 0)).toBe(true)
  })

  it('draws one bezier per dependency: source right edge → dependent left edge', () => {
    const plan = createPlanDag('ship', [
      { description: 'a' },
      { description: 'b', dependsOn: [1] },
    ])
    const layout = layoutPlanGraph(plan)
    expect(layout.edges).toHaveLength(1)
    const [edge] = layout.edges
    const src = layout.nodes.find(n => n.id === 'n1')!
    const dst = layout.nodes.find(n => n.id === 'n2')!
    expect(edge.from).toBe('n1')
    expect(edge.to).toBe('n2')
    expect(edge.fromStatus).toBe('pending')
    // The path starts at the dependency's right-middle and ends at the
    // dependent's left-middle.
    expect(edge.path.startsWith(`M ${src.x + src.w} ${src.y + src.h / 2}`)).toBe(true)
    expect(edge.path.endsWith(`${dst.x} ${dst.y + dst.h / 2}`)).toBe(true)
  })

  it('barycenter ordering straightens crossing dependency lines', () => {
    // n1→n3, n2→n4 (criss-cross in input order); barycenter sorts wave 2 so
    // n3 (dep row 0) sits above n4 (dep row 1) — no crossing.
    const plan = createPlanDag('ship', [
      { description: 'n1' },
      { description: 'n2' },
      { description: 'n3', dependsOn: [1] },
      { description: 'n4', dependsOn: [2] },
    ])
    const layout = layoutPlanGraph(plan)
    const byId = new Map(layout.nodes.map(n => [n.id, n]))
    expect(byId.get('n3')!.y).toBeLessThan(byId.get('n4')!.y)

    // A swapped dependency (n3←n2, n4←n1) must flip wave-2 order accordingly.
    const crossed = createPlanDag('ship', [
      { description: 'n1' },
      { description: 'n2' },
      { description: 'n3', dependsOn: [2] },
      { description: 'n4', dependsOn: [1] },
    ])
    const crossedLayout = layoutPlanGraph(crossed)
    const cById = new Map(crossedLayout.nodes.map(n => [n.id, n]))
    expect(cById.get('n4')!.y).toBeLessThan(cById.get('n3')!.y)
  })

  it('exposes node metadata for rendering (status, assignee, jump anchor)', () => {
    const plan = createPlanDag('ship', [
      { description: 'a' },
      { description: 'b', dependsOn: [1], assignee: 'fe' },
    ])
    plan.nodes[0].status = 'completed'
    plan.nodes[0].msgId = 'msg-1'
    const layout = layoutPlanGraph(plan)
    const first = layout.nodes.find(n => n.id === 'n1')!
    expect(first.status).toBe('completed')
    expect(first.msgId).toBe('msg-1')
    const second = layout.nodes.find(n => n.id === 'n2')!
    expect(second.assignee).toBe('fe')
    const edge = layout.edges[0]
    expect(edge.fromStatus).toBe('completed')
  })
})
