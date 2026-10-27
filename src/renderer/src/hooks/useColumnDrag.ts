// ── Column-divider drag (2026-10-26) ──
// The pointer gesture shared by the sidebar's and the 工作区 tree's drag
// handles: capture the pointer, track one axis, publish the clamped width.
// The two guards the workbench pane's handle paid for first are carried
// over: a canceled drag fires no pointerup, so a `buttons === 0` move ends
// it (a plain HOVER over the handle would otherwise keep resizing), and
// only the pointer that STARTED the drag may end it (a second pointer's
// pointerup must not).
//
// Deliberately not folded back into WorkbenchPane: its drag also throttles
// and pushes the width to the main-process dock while the browser tab is
// frontmost — that IPC contract stays where it is.

import { useRef, useState } from 'react'

interface Options {
  /** Width at pointerdown, read live (getState) so a stale closure never seeds the drag. */
  getStartWidth: () => number
  /** +1: handle on the left edge, rightward travel grows (sidebar). -1: handle on the right edge, leftward travel grows (tree divider). */
  direction: 1 | -1
  /** Clamp against the live container (measured inside the closure). */
  clamp: (desired: number) => number
  /** Publish the clamped width (a store write per move). */
  apply: (next: number) => void
}

export function useColumnDrag({ getStartWidth, direction, clamp, apply }: Options): {
  dragging: boolean
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void
  onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void
} {
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    drag.current = { pointerId: e.pointerId, startX: e.clientX, startWidth: getStartWidth() }
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d || e.pointerId !== d.pointerId) return
    if (e.buttons === 0) {
      drag.current = null
      setDragging(false)
      return
    }
    apply(clamp(d.startWidth + direction * (e.clientX - d.startX)))
  }
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (drag.current && e.pointerId !== drag.current.pointerId) return
    drag.current = null
    setDragging(false)
  }

  return { dragging, onPointerDown, onPointerMove, onPointerUp }
}
