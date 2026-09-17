// ── Snapshot ref addressing (page_* 哲学, host-side) ──
// domSnapshot() numbers the page's interactive elements and tags each one with
// `data-pm-ref`, so the model can address what it just saw by that number —
// the same observe→address determinism the extension's page_* family gets from
// its indexed DOM walk, but resolved through the host's single selector engine.
// Three places must agree on the attribute and its selector form: the in-page
// walk (main/browser/snapshot-refs.ts), the client sugar (`ref()` here), and
// the host's stale-ref fast path (main/browser/PlaywrightCommands.ts).

/** The tag the snapshot walk leaves on interactive elements. Namespaced so a
 *  page's own attributes can't collide. */
export const PM_REF_ATTR = 'data-pm-ref'

/** The selector that resolves ref N against the host's locator engine. */
export function pmRefSelector(n: number | string): string {
  return `[${PM_REF_ATTR}="${n}"]`
}

/** Whether a selector is a snapshot ref (the host fast-fails these when the
 *  tag is gone, instead of burning the full locator timeout). */
export function isPmRefSelector(selector: string): boolean {
  return selector.startsWith(`[${PM_REF_ATTR}="`) && selector.endsWith('"]')
}

/** Recovery line appended to locator failures: the model decides its next move
 *  off the last bytes of a tool result, so the last bytes name the fix. */
export const PM_REF_RECOVERY_HINT =
  '（定位失败：重新调用 domSnapshot()，用返回的最新编号 [N] 直接寻址——tab.playwright(N, op)，或按新快照的 role/name 重建定位器。不要重试旧编号或旧定位器。）'
