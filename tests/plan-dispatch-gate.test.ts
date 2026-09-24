import { describe, expect, it } from 'vitest'
import { createPlanDag, markNode, resolveReadyNode } from '../src/shared/plan/graph'
import type { Plan } from '../src/shared/types/plan'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * 第一档顺序硬门 (order gate): spawn_agent's planNode must resolve through
 * resolveReadyNode — pending AND every dependency completed. The old check
 * (`status !== 'pending'`) could not reject a node whose upstream was still
 * running, because such a node is also pending: depends_on was prompt-level
 * advice, not an execution-level gate.
 *
 * Three layers:
 *  1. the pure gate (accept / reject / the model-facing message), driven for real;
 *  2. non-vacuity — the gate rejects exactly the抢跑 case the pending check missed;
 *  3. wiring scans — spawn-tool routes through resolveReadyNode, and the tool
 *     copy carries the order contract (the model must WRITE depends_on for the
 *     gate to have anything to enforce).
 */

/** diamond: n1 → (n2, n3) → n4. */
function diamond(): Plan {
  return createPlanDag('ship it', [
    { description: '调研' },
    { description: '前端', dependsOn: [1] },
    { description: '后端', dependsOn: [1] },
    { description: '发布', dependsOn: [2, 3] },
  ])
}

function src(rel: string): string {
  return readFileSync(resolve(__dirname, '..', rel), 'utf8')
}

describe('resolveReadyNode — the dispatch gate', () => {
  it('accepts the root and dependency-complete nodes, in every ref form', () => {
    const plan = diamond()
    expect(resolveReadyNode(plan, 1).id).toBe('n1')
    expect(resolveReadyNode(plan, 'n1').id).toBe('n1')
    markNode(plan, 1, 'completed')
    expect(resolveReadyNode(plan, 2).id).toBe('n2')
    expect(resolveReadyNode(plan, '3').id).toBe('n3')
    markNode(plan, 2, 'completed')
    markNode(plan, 3, 'completed')
    expect(resolveReadyNode(plan, 'n4').id).toBe('n4')
  })

  it('rejects a pending node whose dependency is still running — the case a pending-only check cannot see', () => {
    const plan = diamond()
    // n2 IS pending (the old check passed it) but n1 has not settled.
    expect(plan.nodes[1].status).toBe('pending')
    expect(() => resolveReadyNode(plan, 2)).toThrow('Plan node n2 is not ready — waiting on n1 (pending)')
    expect(() => resolveReadyNode(plan, 2)).toThrow('spawn_agent only accepts a node from the READY set')
    // n4 names both open deps, not just the first.
    expect(() => resolveReadyNode(plan, 'n4')).toThrow('n2 (pending), n3 (pending)')
  })

  it('rejects when a dependency failed or was skipped, naming its status', () => {
    const plan = diamond()
    markNode(plan, 1, 'completed')
    markNode(plan, 2, 'failed')
    expect(() => resolveReadyNode(plan, 4)).toThrow('waiting on n2 (failed), n3 (pending)')
    markNode(plan, 2, 'skipped')
    expect(() => resolveReadyNode(plan, 4)).toThrow('n2 (skipped)')
    // retry settles upstream → n4 becomes dispatchable again (both deps now).
    markNode(plan, 2, 'completed')
    markNode(plan, 3, 'completed')
    expect(resolveReadyNode(plan, 4).id).toBe('n4')
  })

  it('keeps the settled-node and unknown-ref errors (the shapes tests already pin)', () => {
    const plan = diamond()
    markNode(plan, 1, 'completed')
    expect(() => resolveReadyNode(plan, 1)).toThrow('Plan node n1 is already completed — pick a node from the READY set.')
    expect(() => resolveReadyNode(plan, 9)).toThrow('Unknown planNode "9" — valid: n1..n4.')
  })

  it('a fully-parallel plan never trips the gate (the common path stays free)', () => {
    const plan = createPlanDag('all parallel', [
      { description: 'a' },
      { description: 'b' },
      { description: 'c' },
    ])
    for (const n of plan.nodes) expect(resolveReadyNode(plan, n.id).id).toBe(n.id)
  })
})

describe('wiring: spawn routes through the gate, and the copy carries the contract', () => {
  const spawnSrc = src('src/renderer/src/agent/executors/spawn-tool.ts')

  it('spawn-tool resolves planNode via resolveReadyNode and holds no inline planNode status check', () => {
    expect(spawnSrc).toContain('resolveReadyNode(plan, planNodeRaw')
    // The pre-gate shape must not come back: a direct resolveNodeRef + pending
    // comparison here would silently bypass the dependency check.
    expect(spawnSrc).not.toContain('resolveNodeRef(')
    expect(spawnSrc).not.toContain("status !== 'pending'")
  })

  it('create_plan instructions carry the serial example and the depends_on red line', () => {
    const instructions = src('src/renderer/src/tools/tool-instructions.ts')
    // The worked example (a step naming depends_on) — no example was the whole
    // 「模型从不画串行图」 report's first layer.
    expect(instructions).toContain('### Example — sequential stages, parallel leaves')
    expect(instructions).toContain('"depends_on": [1]')
    // Array order never sequences + the MUST for consuming nodes.
    expect(instructions).toContain('Array order never creates order')
    expect(instructions).toContain("If a node consumes another node's output, you MUST list that node in its depends_on")
    // The gate itself is announced to the model — a rejected dispatch must not
    // be the first time it hears about the READY rule.
    expect(instructions).toContain('spawn_agent rejects a node whose dependencies are not all completed')
    expect(instructions).toContain('Only nodes in the READY set are accepted')
  })

  it('schema descriptions warn that array order never sequences and name the enforcement', () => {
    const tools = src('src/renderer/src/tools/built-in-tools.ts')
    expect(tools).toContain('array order never sequences them')
    expect(tools).toContain('it does NOT imply execution order')
    expect(tools).toContain('only a READY node (pending, all dependencies completed) is accepted')
    expect(tools).toContain('spawn_agent rejects nodes outside the READY set')
  })
})
