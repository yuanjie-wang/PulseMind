// ── Snapshot ref addressing (PLAN-browser-snapshot-ai) ──
// domSnapshot() now rides Playwright's own AI-mode snapshot engine
// (`ariaSnapshotJSON({ mode: 'ai' })`): every node in the returned tree carries
// a persistent `ref: eN`, and the model addresses it with the bare selector
// engine form `aria-ref=eN`. No page-realm stamping happens any more — the
// page is never written (a forged `data-pm-ref`-style attribute cannot hijack
// addressing, because Playwright's ref engine does not read page-visible
// attributes).
//
// Selector form, measured against playwright-core 1.63: `aria-ref=eN` (bare
// custom-engine syntax) resolves via page.locator; the CSS-attribute spelling
// `[aria-ref=eN]` does NOT (there is no DOM attribute). History compatibility:
// old sessions' snapshots numbered `[3]`, and a bare number still works — the
// facade sugar converts N through pmRefSelector here, so old numbers resolve
// to a nonexistent `eN` and the action fast-fails with the upgrade hint.

/** The selector that resolves ref N against the host's locator engine. */
export function pmRefSelector(n: number | string): string {
  return `aria-ref=e${n}`
}

/** Whether a selector is a snapshot ref (the host fast-fails these when the
 *  node is gone, instead of burning the full locator timeout). */
export function isPmRefSelector(selector: string): boolean {
  return /^aria-ref=e\d+$/.test(selector)
}

/** The number N a ref selector addresses (the digits after `e`). */
export function pmRefNumberOf(selector: string): string | null {
  const m = /^aria-ref=e(\d+)$/.exec(selector)
  return m ? m[1] : null
}

/** Recovery line appended to locator failures: the model decides its next move
 *  off the last bytes of a tool result, so the last bytes name the fix. */
export const PM_REF_RECOVERY_HINT =
  '（定位失败：重新调用 domSnapshot()，用返回的最新编号 [ref=eN] 直接寻址——tab.playwright(N, op)，或按新快照的 role/name 重建定位器。不要重试旧编号或旧定位器。）'
