// ── Snapshot ref addressing (PLAN-browser-snapshot-ai) ──
// domSnapshot() now rides Playwright's own AI-mode snapshot engine
// (`ariaSnapshotJSON({ mode: 'ai' })`): every node in the returned tree carries
// a persistent ref, and the model addresses it with the bare selector engine
// form `aria-ref=<ref>`. No page-realm stamping happens any more — the page is
// never written (a forged `data-pm-ref`-style attribute cannot hijack
// addressing, because Playwright's ref engine does not read page-visible
// attributes).
//
// Selector form, measured against playwright-core 1.63: the bare custom-engine
// syntax `aria-ref=eN` resolves via page.locator; the CSS-attribute spelling
// `[aria-ref=eN]` does NOT (there is no DOM attribute). History compatibility:
// old sessions' snapshots numbered `[3]`, and a bare number still works — the
// facade sugar converts N through pmRefSelector here, so old numbers resolve
// to a nonexistent `eN` and the action fast-fails with the upgrade hint.
//
// **The ref carries a frame prefix, and it is not optional.** A fresh page
// prints `eN`; once a frame-bearing document has been snapshotted the counter
// is prefixed with a persistent frame id (`f7e74`), and that id grows across
// navigations — so even the MAIN document reads `f7e1` after a few of them
// (measured on a webmail login flow: `[ref=e1]` at login, `[ref=f7e1]` after).
// A ref is therefore a *token*, not a number: `e12` and `f7e12` are different
// addresses, and dropping the prefix points at the wrong frame.

/** A bare ref literal, exactly as the snapshot prints it: `eN`, or `f<frame>eN`. */
const REF_LITERAL = /^(?:f\d+)?e\d+$/
/** The selector engine form, with the ref captured: `aria-ref=eN` / `aria-ref=f7eN`. */
const REF_SELECTOR = /^aria-ref=((?:f\d+)?e\d+)$/

/** Whether a string IS a ref literal (`e12`, `f7e12`) — i.e. what the snapshot
 *  hands back and what a model echoes verbatim. Anything else (CSS, role
 *  chains, XPath) is not one. */
export function isRefLiteral(selector: string): boolean {
  return REF_LITERAL.test(selector)
}

/** The selector that resolves a ref against the host's locator engine. A
 *  ref-shaped string is taken VERBATIM (the frame prefix is part of the
 *  address); a number or digit string is the bare `eN` form. */
export function pmRefSelector(n: number | string): string {
  return REF_LITERAL.test(String(n)) ? `aria-ref=${n}` : `aria-ref=e${n}`
}

/** A raw string argument into a selector: ref literals become `aria-ref=…`,
 *  every other form passes through untouched (it is already a selector). */
export function resolveSelectorArg(selector: string): string {
  return REF_LITERAL.test(selector) ? `aria-ref=${selector}` : selector
}

/** Whether a selector is a snapshot ref (the host fast-fails these when the
 *  node is gone, instead of burning the full locator timeout). */
export function isPmRefSelector(selector: string): boolean {
  return REF_SELECTOR.test(selector)
}

/** The ref token a selector addresses: `e12` or `f7e12` — the whole token, frame
 *  prefix included, because that is what the tree and the error messages are
 *  keyed on. */
export function pmRefOf(selector: string): string | null {
  const m = REF_SELECTOR.exec(selector)
  return m ? m[1] : null
}

/** Recovery line appended to locator failures: the model decides its next move
 *  off the last bytes of a tool result, so the last bytes name the fix. */
export const PM_REF_RECOVERY_HINT =
  '（定位失败：重新调用 domSnapshot()，用返回的最新编号 [ref=eN] 直接寻址——编号带帧前缀时（[ref=f7e74]）把前缀一起原样传入：tab.playwright("f7e74", op)；纯数字编号用 tab.playwright(3, op)。或按新快照的 role/name 重建定位器。不要重试旧编号或旧定位器。）'
