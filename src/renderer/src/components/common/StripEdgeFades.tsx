// ── 页签条的边缘渐隐 (2026-10-30, 用户裁定「两端渐隐提示」) ──
// Both tab strips in the app hide their scrollbar (`scrollbar-width: none`, the
// BrowserPaneChrome precedent — VS Code does the same), which is right for looks
// and wrong for the mouse: a trackpad user has a native two-finger `deltaX`
// gesture, a mouse user has only a vertical wheel, and NOTHING on screen says
// the strip can move. (The wheel does work over both strips — the components
// convert the vertical delta, and Shift+wheel is the browser's own horizontal
// mapping; measured, 2026-10-30.)
//
// So: a gradient mask on each edge, drawn only while there is something to
// reveal in that direction — nothing when the chips fit, one edge mid-scroll,
// both while the strip is somewhere in the middle. Cheap, no new click target,
// and identical in both strips because it is this one component.
//
// `pointerEvents: 'none'` is load-bearing: the mask sits OVER the chips, so a
// fade that took clicks would silently break the tab under it. Pinned by
// probe-workspace-tree (§19j: the chip under a fade still activates).

import React, { useEffect, useState } from 'react'

/** Mask width in px — wide enough to read as "more over there", narrow enough
 *  not to cover a whole 64px chip. */
export const FADE_WIDTH = 16

export interface StripFades {
  left: boolean
  right: boolean
}

/** The scroll metrics of the strip element, as much as the decision needs. */
export interface StripMetrics {
  scrollLeft: number
  clientWidth: number
  scrollWidth: number
}

/** Shared no-fade value: referentially stable, so the hook's identity check
 *  below never re-renders a strip that is not fading anything. */
export const NO_FADES: StripFades = { left: false, right: false }

/** Which edges hide content — pure, so the thresholds are unit-tested rather
 *  than eyeballed. The 1px slack absorbs fractional scroll offsets (HiDPI
 *  zoom, 0.5px chip widths), which would otherwise flicker an edge at the ends. */
export function stripFadesOf({ scrollLeft, clientWidth, scrollWidth }: StripMetrics): StripFades {
  const left = scrollLeft > 1
  const right = scrollLeft + clientWidth < scrollWidth - 1
  if (!left && !right) return NO_FADES
  return { left, right }
}

/**
 * Live edge state for a strip: re-read on scroll, on the pane being resized
 * (ResizeObserver), and whenever the chips themselves change — the last one
 * cannot be observed, because adding a chip changes `scrollWidth` without
 * resizing the element or scrolling it, so callers pass a `signature` of the
 * content (paths/ids joined) and the hook re-syncs when it moves.
 */
export function useStripFades(ref: React.RefObject<HTMLElement | null>, signature?: string): StripFades {
  const [fades, setFades] = useState<StripFades>(NO_FADES)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const sync = (): void =>
      setFades((prev) => {
        const next = stripFadesOf(el)
        return prev.left === next.left && prev.right === next.right ? prev : next
      })
    sync()
    el.addEventListener('scroll', sync, { passive: true })
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', sync)
      ro.disconnect()
    }
  }, [ref, signature])
  return fades
}

/** The two masks. Rendered as SIBLINGS of the scroller inside a `position:
 *  relative` wrapper that matches the scroller's box (the strip row's own
 *  padding must not enter the geometry). */
export function StripEdgeFades({ fades }: { fades: StripFades }): React.ReactElement {
  const mask: React.CSSProperties = {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: FADE_WIDTH,
    pointerEvents: 'none',
  }
  return (
    <>
      {fades.left && <div data-strip-fade="left" style={{ ...mask, left: 0, background: 'linear-gradient(to right, var(--pm-bg), transparent)' }} />}
      {fades.right && <div data-strip-fade="right" style={{ ...mask, right: 0, background: 'linear-gradient(to left, var(--pm-bg), transparent)' }} />}
    </>
  )
}
