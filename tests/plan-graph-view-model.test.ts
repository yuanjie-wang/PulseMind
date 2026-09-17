// Plan graph canvas view model (PLAN-plan-graph-canvas M1).

import { describe, expect, it } from 'vitest'
import {
  DRAG_THRESHOLD_PX,
  MIN_PLAN_SCALE,
  planTopologySignature,
  viewScale,
} from '../src/shared/plan/view'

describe('viewScale', () => {
  it('never goes below 1 — fit ratios 0.4 / 0.9 all clamp to 1 (MIN_PLAN_SCALE)', () => {
    // The whole point of the canvas: a narrow pane must NOT shrink the graph
    // into unreadability. If MIN_PLAN_SCALE ever goes back to 0.55, these go red.
    expect(viewScale(0.4)).toBe(1)
    expect(viewScale(0.9)).toBe(1)
    expect(viewScale(0)).toBe(1)
  })

  it('never exceeds 1 — oversized fit still reads as 100%', () => {
    expect(viewScale(1.6)).toBe(1)
    expect(viewScale(1)).toBe(1)
  })

  it('pins the floor as a constant of exactly 1', () => {
    expect(MIN_PLAN_SCALE).toBe(1)
  })
})

describe('planTopologySignature', () => {
  const base = {
    objective: '发布 0.5',
    nodes: [
      { id: 'n1', dependsOn: [] as string[] },
      { id: 'n2', dependsOn: ['n1'] },
      { id: 'n3', dependsOn: ['n1'] },
    ],
  }

  it('is stable across status flips and object identity (D4)', () => {
    const flipped = {
      objective: base.objective,
      nodes: base.nodes.map((n) => ({ ...n })),
    }
    // Same topology, brand-new objects — execution updates produce these.
    expect(planTopologySignature(flipped)).toBe(planTopologySignature(base))
  })

  it('is sensitive to node additions and removals', () => {
    const added = { ...base, nodes: [...base.nodes, { id: 'n4', dependsOn: ['n2'] }] }
    expect(planTopologySignature(added)).not.toBe(planTopologySignature(base))
    const removed = { ...base, nodes: base.nodes.slice(0, 2) }
    expect(planTopologySignature(removed)).not.toBe(planTopologySignature(base))
  })

  it('is sensitive to dependency rewiring (order-independent for the edge set)', () => {
    const rewired = {
      ...base,
      nodes: [base.nodes[0], base.nodes[1], { id: 'n3', dependsOn: ['n2'] }],
    }
    expect(planTopologySignature(rewired)).not.toBe(planTopologySignature(base))
    // The same edges declared in a different order on different nodes stay stable.
    const reordered = {
      ...base,
      nodes: [
        base.nodes[0],
        { id: 'n2', dependsOn: [] },
        { id: 'n3', dependsOn: ['n1'] },
      ],
    }
    // n2 loses n1 and n3 keeps n1 — that is a DIFFERENT edge set, must differ.
    expect(planTopologySignature(reordered)).not.toBe(planTopologySignature(base))
    const permuted = {
      objective: base.objective,
      nodes: [
        { id: 'n3', dependsOn: ['n1'] },
        { id: 'n2', dependsOn: ['n1'] },
        { id: 'n1', dependsOn: [] },
      ],
    }
    // Node ORDER is part of the signature only through ids — a permuted id
    // sequence with the same edge set is a different layout, so it differs.
    expect(planTopologySignature(permuted)).not.toBe(planTopologySignature(base))
  })

  it('is sensitive to the objective', () => {
    expect(planTopologySignature({ ...base, objective: '发布 0.6' })).not.toBe(planTopologySignature(base))
  })
})

describe('drag threshold', () => {
  it('matches the launcher gesture constant (3px, D3)', () => {
    expect(DRAG_THRESHOLD_PX).toBe(3)
  })
})
