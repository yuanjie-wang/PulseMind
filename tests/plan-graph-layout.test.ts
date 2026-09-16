import { describe, expect, it } from 'vitest'
import {
  BUS_Y,
  CHANNEL,
  GAP_X,
  GAP_Y,
  GRAPH_PADDING,
  NODE_H,
  NODE_W,
  TERMINAL_W,
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

    expect(layout.width).toBe(
      GRAPH_PADDING + TERMINAL_W + GAP_X + 2 * (NODE_W + GAP_X) + NODE_W + GAP_X + TERMINAL_W + GRAPH_PADDING,
    )
    expect(layout.height).toBe(GRAPH_PADDING * 2 + 2 * NODE_H + GAP_Y)
    expect(layout.nodes.every(n => n.x >= 0 && n.y >= 0)).toBe(true)
  })

  it('draws one bezier per adjacent dependency: source right edge → dependent left edge', () => {
    const plan = createPlanDag('ship', [
      { description: 'a' },
      { description: 'b', dependsOn: [1] },
    ])
    const layout = layoutPlanGraph(plan)
    const taskEdges = layout.edges.filter(e => !e.from.startsWith('__') && !e.to.startsWith('__'))
    expect(taskEdges).toHaveLength(1)
    const [edge] = taskEdges
    const src = layout.nodes.find(n => n.id === 'n1')!
    const dst = layout.nodes.find(n => n.id === 'n2')!
    expect(edge.from).toBe('n1')
    expect(edge.to).toBe('n2')
    expect(edge.fromStatus).toBe('pending')
    expect(edge.kind).toBe('adjacent')
    // The path starts at the dependency's right-middle and ends at the
    // dependent's left-middle.
    expect(edge.path.startsWith(`M ${src.x + src.w} ${src.y + src.h / 2}`)).toBe(true)
    expect(edge.path.endsWith(`${dst.x} ${dst.y + dst.h / 2}`)).toBe(true)
  })

  it('routes skip-level dependencies over the top bus, never through nodes', () => {
    // n3 depends on n1 (two waves back) AND on n2 (one wave back): the
    // n1→n3 edge must leave the gap channel right of n1, ride the bus above
    // every node, and drop into the channel left of n3 — the direct line
    // would cut straight through n2's column.
    const plan = createPlanDag('ship', [
      { description: 'a' },
      { description: 'b', dependsOn: [1] },
      { description: 'c', dependsOn: [1, 2] },
    ])
    const layout = layoutPlanGraph(plan)
    const over = layout.edges.find(e => e.kind === 'over')!
    expect(over.from).toBe('n1')
    expect(over.to).toBe('n3')

    const n1 = layout.nodes.find(n => n.id === 'n1')!
    const n3 = layout.nodes.find(n => n.id === 'n3')!
    expect(over.path).toContain(` L ${n1.x + n1.w + CHANNEL} ${BUS_Y}`)
    expect(over.path).toContain(` L ${n3.x - CHANNEL} ${BUS_Y}`)
    expect(over.path.endsWith(`${n3.x} ${n3.y + n3.h / 2}`)).toBe(true)
    // Every bus Y is above every node, so the detour cannot cross one.
    expect(BUS_Y).toBeLessThan(layout.nodes.reduce((min, n) => Math.min(min, n.y), Infinity))
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

  it('brackets the graph with 开始/结束 anchors wired to entries and terminals', () => {
    // All-parallel plan (no depends_on at all): without anchors the cards
    // would float unconnected — 开始 fans out to all three, all drain into 结束.
    const plan = createPlanDag('parallel', [
      { description: 'a' },
      { description: 'b' },
      { description: 'c' },
    ])
    const layout = layoutPlanGraph(plan)

    const start = layout.nodes.find(n => n.terminal === 'start')!
    const end = layout.nodes.find(n => n.terminal === 'end')!
    expect(start.id).toBe('__start__')
    expect(end.id).toBe('__end__')
    // First and last columns belong to the anchors.
    expect(start.x).toBe(GRAPH_PADDING)
    expect(end.x + end.w + GRAPH_PADDING).toBe(layout.width)

    // Every task card is wired on both sides: from 开始 or a dependency, into
    // a dependent or 结束 — no floating modules.
    const linkedFrom = new Set(layout.edges.map(e => e.from))
    const linkedTo = new Set(layout.edges.map(e => e.to))
    for (const n of layout.nodes) {
      if (n.terminal === 'end') continue
      expect(linkedFrom.has(n.id), `${n.id} has no outgoing line`).toBe(true)
    }
    for (const n of layout.nodes) {
      if (n.terminal === 'start') continue
      expect(linkedTo.has(n.id), `${n.id} has no incoming line`).toBe(true)
    }
    // The anchors sit vertically centered on their fan-out/fan-in targets.
    const entries = layout.nodes.filter(n => !n.terminal)
    const avgCy = entries.reduce((s, n) => s + n.y + n.h / 2, 0) / entries.length
    expect(Math.abs(start.y + start.h / 2 - avgCy)).toBeLessThan(NODE_H)
  })

  it('brackets the graph with 开始/结束 anchors wired to entries and terminals (chain keeps its shape)', () => {
    const plan = createPlanDag('ship', [
      { description: 'a' },
      { description: 'b', dependsOn: [1] },
      { description: 'c', dependsOn: [2] },
    ])
    const layout = layoutPlanGraph(plan)
    // Chain: exactly one entry and one terminal — 开始→n1 … n3→结束.
    expect(layout.edges.filter(e => e.from === '__start__')).toHaveLength(1)
    expect(layout.edges.filter(e => e.to === '__end__')).toHaveLength(1)
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

  it('vertical flow turns waves into rows: deep chain grows tall, not wide', () => {
    const plan = createPlanDag('chain', [
      { description: 's1' },
      { description: 's2', dependsOn: [1] },
      { description: 's3', dependsOn: [2] },
      { description: 's4', dependsOn: [3] },
    ])
    const h = layoutPlanGraph(plan, 'horizontal')
    const v = layoutPlanGraph(plan, 'vertical')

    // Horizontal: 6 columns wide, one row tall. Vertical: tall and narrow —
    // the deep chain is exactly the case vertical flow wins.
    expect(h.width).toBeGreaterThan(h.height)
    expect(v.height).toBeGreaterThan(v.width)
    expect(v.width).toBeLessThan(h.width)
    expect(v.height).toBeGreaterThan(h.height)

    // Waves stack downward; the chain keeps its column (no breadth).
    const vById = new Map(v.nodes.map(n => [n.id, n]))
    expect(vById.get('n1')!.y).toBeLessThan(vById.get('n2')!.y)
    expect(vById.get('n4')!.y).toBeGreaterThan(vById.get('n3')!.y)
    expect(vById.get('n1')!.x).toBe(vById.get('n2')!.x)

    // 开始 sits on top, 结束 at the bottom.
    expect(v.nodes.find(n => n.terminal === 'start')!.y).toBeLessThan(vById.get('n1')!.y)
    expect(v.nodes.find(n => n.terminal === 'end')!.y).toBeGreaterThan(vById.get('n4')!.y)

    // Adjacent edges flow bottom → top: source bottom-center → target top-center.
    const edge = v.edges.find(e => e.from === 'n1' && e.to === 'n2')!
    const s1 = vById.get('n1')!
    const s2 = vById.get('n2')!
    expect(edge.path.startsWith(`M ${s1.x + s1.w / 2} ${s1.y + s1.h}`)).toBe(true)
    expect(edge.path.endsWith(`${s2.x + s2.w / 2} ${s2.y}`)).toBe(true)
  })

  it('an early terminal drains into 结束 through the left rail, not across cards', () => {
    // n3 ends one wave before n4: its line to 结束 must use the side rail.
    const plan = createPlanDag('ship', [
      { description: 'a' },
      { description: 'b', dependsOn: [1] },
      { description: 'c', dependsOn: [2] },
      { description: 'd', dependsOn: [1] },
    ])
    const v = layoutPlanGraph(plan, 'vertical')
    const over = v.edges.filter(e => e.kind === 'over')
    expect(over.some(e => e.to === '__end__')).toBe(true)
    // Every rail x is left of every card.
    const minCardX = Math.min(...v.nodes.filter(n => !n.terminal).map(n => n.x))
    for (const e of over) {
      const rail = e.path.match(/^M [\d.]+ [\d.]+ L [\d.]+ [\d.]+ L ([\d.]+) /)!
      expect(Number(rail[1])).toBeLessThan(minCardX)
    }
  })

  it('a wide fan-in staggers its drop rails inside the gap, never through the previous row', () => {
    // n6 depends on four wave-0 nodes across two waves: four over edges drop
    // into n6's channel. Vertical flow is the tight case (GAP_Y 24) — the old
    // fixed 6px step put its third rail 6px INTO the row above's card, and the
    // seventh into the previous column in horizontal flow.
    const plan = createPlanDag('fan-in', [
      { description: 'a' },
      { description: 'b' },
      { description: 'c' },
      { description: 'd' },
      { description: 'e', dependsOn: [1] },
      { description: 'z', dependsOn: [1, 2, 3, 4, 5] },
    ])

    // Vertical: path is `M x2 y2 L x2 outY L busX outY L busX inY …` — token 11 is the rail Y.
    const v = layoutPlanGraph(plan, 'vertical')
    const dst = v.nodes.find(n => n.id === 'n6')!
    const into = v.edges.filter(e => e.kind === 'over' && e.to === 'n6')
    expect(into).toHaveLength(4)
    const rails = into.map(e => Number(e.path.split(' ')[11]))
    for (const rail of rails) {
      expect(rail).toBeGreaterThanOrEqual(dst.y - GAP_Y + 4)
      expect(rail).toBeLessThanOrEqual(dst.y - CHANNEL)
    }
    expect(new Set(rails).size).toBe(4)

    // Horizontal: `M x2 y2 L outX y2 L outX busY L inX busY …` — token 10 is the rail X.
    const h = layoutPlanGraph(plan, 'horizontal')
    const hDst = h.nodes.find(n => n.id === 'n6')!
    const hInto = h.edges.filter(e => e.kind === 'over' && e.to === 'n6')
    expect(hInto).toHaveLength(4)
    const hRails = hInto.map(e => Number(e.path.split(' ')[10]))
    for (const rail of hRails) {
      expect(rail).toBeGreaterThanOrEqual(hDst.x - GAP_X + 4)
      expect(rail).toBeLessThanOrEqual(hDst.x - CHANNEL)
    }
    expect(new Set(hRails).size).toBe(4)
  })
})
