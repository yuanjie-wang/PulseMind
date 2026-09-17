// ── Plan graph view model (PLAN-plan-graph-canvas §设计1) ──
// The canvas decisions as pure values: the scale floor is 1.0 (D1 — the graph
// never shrinks; a too-narrow pane pans instead, because 0.55× made 11.5px
// text into ~6.3px mush as the DEFAULT state, not an edge case), and the
// drag-vs-click threshold (D3) matches the launcher's consumeDragClick — the
// same human-factors number (3px) for the same gesture.

/** The graph's minimum scale: 100%. Never below — pan instead (D1). When free
 *  zoom lands (二期), this is the one constant to replace. */
export const MIN_PLAN_SCALE = 1

/** Pointer travel below which a press is still a click (D3). */
export const DRAG_THRESHOLD_PX = 3

/** `max(MIN_PLAN_SCALE, min(fit, 1))` — the old floor was 0.55. With MIN=1
 *  the min() half is dead arithmetic; kept so the shape survives the future
 *  zoom work unchanged. */
export function viewScale(fitRatio: number): number {
  return Math.max(MIN_PLAN_SCALE, Math.min(fitRatio, 1))
}

/** Stable topology signature of a plan (D4): objective + node id sequence +
 *  the dependsOn edge set. Status flips produce NEW plan objects every turn —
 *  resetting the canvas view on object identity would yank it mid-run. Only a
 *  real topology change (new plan, create_plan reorder, rewired deps, new
 *  objective) returns a different string. */
export function planTopologySignature(plan: {
  objective: string
  nodes: { id: string; dependsOn: string[] }[]
}): string {
  const edges = plan.nodes
    .flatMap((n) => n.dependsOn.map((dep) => `${dep}->${n.id}`))
    .sort()
  return JSON.stringify([plan.objective, plan.nodes.map((n) => n.id), edges])
}
