/** Launcher drag — 悬浮球可上下拖动 (user request 2026-09-16, PLAN M2.9).
 *
 * Vertical only: the ball stays in the right gutter, which keeps the position a
 * single number (and keeps it clear of the page's own corner controls). The
 * preference belongs to the *user*, not to the tab, so it is stored globally in
 * `chrome.storage.local` — `chrome.storage.session` is granted to trusted
 * contexts only and a content script cannot read it (see background/state.ts),
 * which is why the panel asks the worker for its per-tab state but this does
 * not.
 *
 * Two rules are load-bearing:
 *
 * 1. **A drag must not also be a click.** The browser dispatches `click` on the
 *    capturing element after any mousedown/mouseup pair, however far the
 *    pointer travelled, so a gesture that crossed DRAG_THRESHOLD swallows
 *    exactly the one click it is about to produce. The flag is cleared on the
 *    *next* pointerdown rather than only in the click handler: if that click
 *    never arrives (the element unmounted mid-gesture), the button must not be
 *    left permanently dead.
 * 2. **A viewport-driven re-clamp is not persisted.** Shrinking the window can
 *    push the ball inside the safe range, but writing that back would turn a
 *    temporary window size into the user's saved choice, so enlarging the
 *    window again would not restore the position they picked.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'

/** `.pm-fab`'s box, mirrored from `--pm-fab-size` / `--pm-fab-margin` in the
 *  stylesheet. The clamp is expressed in these terms, so if the ball is resized
 *  the two must move together — tests/fab-drag.test.ts reads the stylesheet and
 *  fails if they drift, and scripts/probe-panel-render.mjs asserts the
 *  observable consequence (a 20px gap at both ends of the range). */
export const FAB_SIZE = 44
export const FAB_MARGIN = 20

/** Pointer travel (px) that turns a click into a drag — below it the gesture is
 *  treated as stationary, so a slightly shaky click still opens the panel. */
const DRAG_THRESHOLD = 3

const STORAGE_KEY = 'fabTop'

/** Clamp a ball-top position into the viewport, keeping FAB_MARGIN clear at
 *  both ends. Pure, and exported for the unit test. The `Math.max` on the upper
 *  bound keeps the range non-empty in a viewport too short to hold the ball. */
export function clampFabTop(top: number, viewportHeight: number, size: number = FAB_SIZE): number {
  const upper = Math.max(FAB_MARGIN, viewportHeight - size - FAB_MARGIN)
  return Math.round(Math.min(Math.max(top, FAB_MARGIN), upper))
}

async function readStoredTop(): Promise<number | null> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY)
    const value = stored?.[STORAGE_KEY]
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

async function persistTop(top: number): Promise<void> {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: top })
  } catch {
    /* storage unavailable — the ball keeps its position for this page load */
  }
}

interface DragState {
  pointerId: number
  /** Pointer and ball's own top edge at pointerdown, so the drag moves the ball
   *  by the pointer's travel and the grip point inside it never jumps. */
  startY: number
  startTop: number
  moved: boolean
}

/** The ball's layout top — its `top` used value, which is `bottom`-resolved
 *  while no position has been stored. Deliberately not the rect: a hover scales
 *  the ball 1.06 and the rect would hand back a box 1.3px above the layout one,
 *  putting that error into every drag. */
function layoutTop(el: HTMLElement): number {
  const top = Number.parseFloat(getComputedStyle(el).top)
  return Number.isFinite(top) ? top : el.getBoundingClientRect().top
}

export interface FabDrag {
  /** Inline custom properties for `.pm-fab`. Empty until a position exists, so
   *  a first run renders exactly as the CSS default (`bottom: 20px`). */
  style: CSSProperties
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void
  /** True exactly once, for the click a drag is about to deliver. */
  consumeDragClick: () => boolean
}

export function useFabDrag(): FabDrag {
  /** The rendered top — `topRef` clamped to the viewport in force right now. */
  const [top, setTop] = useState<number | null>(null)
  /** The user's *chosen* top, which is what gets persisted. Kept apart from the
   *  rendered value so a temporary viewport can re-clamp the display without
   *  overwriting the choice (see the resize effect below). Null = never chosen,
   *  i.e. the stylesheet's `bottom: 20px` is holding the ball. */
  const topRef = useRef<number | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const swallowClickRef = useRef(false)

  const applyChosen = useCallback((chosen: number | null): void => {
    topRef.current = chosen
    setTop(chosen === null ? null : clampFabTop(chosen, window.innerHeight))
  }, [])

  useEffect(() => {
    let cancelled = false
    void readStoredTop().then((stored) => {
      if (cancelled || stored === null) return
      applyChosen(stored)
    })
    return () => {
      cancelled = true
    }
  }, [applyChosen])

  useEffect(() => {
    const onResize = (): void => {
      if (topRef.current === null) return
      // Re-clamp the display only — never the choice. Writing the clamped value
      // back would turn a temporarily small window into the user's saved
      // position, so enlarging the window again would not restore it.
      setTop(clampFabTop(topRef.current, window.innerHeight))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLElement>): void => {
    if (e.button !== 0) return
    // A fresh gesture owns the flag: an unclaimed swallow from an interrupted
    // drag must not eat this click.
    swallowClickRef.current = false
    dragRef.current = {
      pointerId: e.pointerId,
      startY: e.clientY,
      // No stored position yet means the CSS default is holding the ball down
      // in the corner — start from where the user actually sees it.
      startTop: topRef.current ?? layoutTop(e.currentTarget),
      moved: false,
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }, [])

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>): void => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== e.pointerId) return
      const dy = e.clientY - drag.startY
      if (!drag.moved && Math.abs(dy) < DRAG_THRESHOLD) return
      drag.moved = true
      const raw = drag.startTop + dy
      const clamped = clampFabTop(raw, window.innerHeight)
      applyChosen(clamped)
      // Sticky at the ends: when the clamp bites, rebase the drag's origin on
      // the pinned position — the comment (and the ruling) promises the ball
      // comes back the moment the pointer reverses, which only follows if the
      // overshoot is not banked into `startTop + dy`. Without the rebase the
      // ball stayed pinned while the pointer retraced the whole overshoot.
      if (clamped !== raw) {
        drag.startTop = clamped
        drag.startY = e.clientY
      }
    },
    [applyChosen],
  )

  const onPointerUp = useCallback((e: ReactPointerEvent<HTMLElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    dragRef.current = null
    if (!drag.moved) return
    swallowClickRef.current = true
    if (topRef.current !== null) void persistTop(topRef.current)
  }, [])

  const onPointerCancel = useCallback((): void => {
    // Keep the position reached so far, but restore the click: a cancelled
    // gesture should not leave a swallow behind (onPointerDown also clears it).
    if (dragRef.current) dragRef.current = null
  }, [])

  const consumeDragClick = useCallback((): boolean => {
    if (!swallowClickRef.current) return false
    swallowClickRef.current = false
    return true
  }, [])

  const style = useMemo<CSSProperties>(() => {
    if (top === null) return {}
    // Both ends are written: leaving `bottom` at its default would over-constrain
    // the box (top + bottom + height) and the height would lose.
    return { '--pm-fab-top': `${top}px`, '--pm-fab-bottom': 'auto' } as CSSProperties
  }, [top])

  return { style, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, consumeDragClick }
}
