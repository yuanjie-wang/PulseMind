// ── Mask watcher: keep the native caption buttons in step with the dim layer ──
//
// A global modal paints a black mask over the whole window — but the Windows/
// Linux caption buttons (minimise/maximise/close) are drawn by the OS ON TOP of
// the web content, so the mask can never reach them: they stay at full
// brightness over a dimmed header (the 穿帮 report). The renderer is the only
// side that knows a mask is open, so it reports the combined mask alpha and the
// main process repaints the overlay pre-dimmed (dimTitleBarOverlayColors).
//
// What counts as a mask: every antd family that portals a viewport-covering dim
// layer (Modal → .ant-modal-mask, Drawer → .ant-drawer-mask, image preview →
// .ant-image-preview-mask — verified against @rc-component/dialog's `${prefixCls}-mask`),
// plus a `[data-pm-mask]` hook for hand-rolled overlays (the chat's ImageViewer
// carries it; its rgba(0,0,0,0.85) is read straight from computed style, so no
// alpha is hard-coded anywhere here). Stacked masks composite multiplicatively —
// 1 - Π(1 - a) — which is exactly what a black mask does to the header beneath.

/** Elements that dim the window. One selector, exported so tests can pin it. */
export const MASK_SELECTOR = '.ant-modal-mask, .ant-image-preview-mask, .ant-drawer-mask, [data-pm-mask]'

/** Two structural changes closer than this are the same alpha (float noise). */
const ALPHA_EPSILON = 0.005

/**
 * Alpha of a computed `background-color` (`rgba(0, 0, 0, 0.45)`, `rgb(0, 0, 0)`,
 * a percentage alpha, `transparent`, or anything unparseable → 0). Reads the
 * computed value rather than mapping class names to defaults, so a theme that
 * overrides colorBgMask or a new hand-rolled overlay needs no edit here.
 */
export function maskAlphaOf(backgroundColor: string): number {
  const value = (backgroundColor ?? '').trim()
  if (value === '' || value === 'transparent' || value === 'none') return 0
  const m = value.match(
    /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.%]+))?\s*\)$/i,
  )
  if (!m) return 0
  if (m[4] === undefined) return 1
  const alpha = m[4].endsWith('%') ? Number.parseFloat(m[4]) / 100 : Number.parseFloat(m[4])
  return Math.min(1, Math.max(0, alpha))
}

/** How much black masks of `alphas` stacked over one header dim it: 1 - Π(1 - a). */
export function combineMaskAlphas(alphas: number[]): number {
  let keep = 1
  for (const a of alphas) {
    const clamped = Math.min(1, Math.max(0, a))
    if (clamped <= 0) continue
    keep *= 1 - clamped
  }
  return 1 - keep
}

/** Skip masks that are in the DOM but not on screen (a closed dialog's wrap
 *  hidden behind display:none). checkVisibility() is Chromium's; jsdom has no
 *  layout, so fall back to the element's own display. */
function onScreen(el: Element): boolean {
  const anyEl = el as HTMLElement
  if (typeof anyEl.checkVisibility === 'function') return anyEl.checkVisibility()
  return getComputedStyle(el).display !== 'none'
}

/** Combined alpha of every mask currently covering the window (0 = none). */
export function currentMaskAlpha(doc: Document = document): number {
  const alphas: number[] = []
  for (const el of doc.querySelectorAll(MASK_SELECTOR)) {
    if (!onScreen(el)) continue
    const a = maskAlphaOf(getComputedStyle(el).backgroundColor)
    if (a > 0) alphas.push(a)
  }
  return combineMaskAlphas(alphas)
}

/** A node is worth recomputing for when it IS a mask or CONTAINS one (portal
 *  containers are appended first and filled a commit later, so descendants
 *  count too — for removals the detached subtree still answers both calls). */
function announcesMask(node: Node): boolean {
  if (node.nodeType !== 1) return false
  const el = node as Element
  return Boolean(el.matches?.(MASK_SELECTOR) || el.querySelector?.(MASK_SELECTOR))
}

/**
 * Watch document.body for masks and push the combined alpha over the bridge.
 * Runs one report at start (whatever is open by then counts too) and returns
 * its disposer — App mounts it once per mount, so a probe's unmount cleans up.
 *
 * The observer is childList+subtree because masks arrive however React
 * portals them; each mutation is cheap-filtered (matches on the touched
 * elements only) before the one querySelectorAll a real change costs — chat
 * streaming mutates constantly and must not pay a document-wide scan.
 */
export function startTitleBarMaskWatcher(win: Window = window): () => void {
  let lastSent = -1
  const report = (): void => {
    const alpha = currentMaskAlpha(win.document)
    if (Math.abs(alpha - lastSent) < ALPHA_EPSILON) return
    lastSent = alpha
    win.electronAPI?.setTitleBarMaskAlpha?.(alpha)
  }

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const nodes of [m.addedNodes, m.removedNodes]) {
        for (const node of nodes) {
          if (announcesMask(node)) {
            report()
            return
          }
        }
      }
    }
  })
  observer.observe(win.document.body, { childList: true, subtree: true })
  report()
  return () => observer.disconnect()
}
