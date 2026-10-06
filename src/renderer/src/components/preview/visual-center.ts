// ── Visual centering under a classic scrollbar ── The grey the eye reads runs
// from the pane's EDGE, and a classic scrollbar strip (macOS 「始终显示滚动条」,
// Windows) is visually continuous with the backdrop: centering inside the
// content box leaves the right side `gutter + scrollbar` wide while the left
// stays `gutter`. These helpers compute the padding that splits the strip
// evenly so both sides measure the same from where the user actually looks.
// Under overlay scrollbars (offset == client) the scrollbar term is 0 and
// they reduce to plain centering. Verified in a real headed browser against
// an injected classic scrollbar: scripts/probe-visual-center.mjs.

/** Horizontal padding that visually centers `paintedWidth` (CSS px as
 *  painted — getBoundingClientRect semantics, zoom included) inside
 *  `container`, splitting the vertical scrollbar's strip. 0 once the content
 *  overflows: an overflowing pane is a panning surface, not a framed one. */
export function visualCenterPaddingX(container: HTMLElement, paintedWidth: number): number {
  return centerOffset(container.clientWidth, Math.max(0, container.offsetWidth - container.clientWidth), paintedWidth)
}

/** Vertical counterpart — splits a classic HORIZONTAL scrollbar's strip. */
export function visualCenterPaddingY(container: HTMLElement, paintedHeight: number): number {
  return centerOffset(container.clientHeight, Math.max(0, container.offsetHeight - container.clientHeight), paintedHeight)
}

/** spare/2 centers inside the content box; +scrollbar/2 shifts the content
 *  right so the strip past the right gutter is matched on the left. Clamped
 *  to `spare` so the content never pokes past the content box — that would
 *  summon a horizontal scrollbar of its own. */
function centerOffset(clientSize: number, scrollbar: number, painted: number): number {
  const spare = clientSize - painted
  if (spare <= 0) return 0
  return Math.min(spare, spare / 2 + scrollbar / 2)
}
