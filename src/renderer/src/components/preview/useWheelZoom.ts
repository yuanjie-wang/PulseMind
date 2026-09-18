// ── Wheel / pinch zoom ── The gesture half of the shared zoom control: the
//  footer's buttons move the scale, this hook lets the pointer move it too.
//  Split by 'is there anything to scroll?':
//
//   · A trackpad pinch is delivered as a wheel event carrying ctrlKey (⌘ on the
//     systems that swap the modifier), so that route is always a zoom command —
//     the same as a browser window.
//   · A plain wheel is only a zoom command where the surface has nothing to
//     scroll: the image preview stays fitted to its pane, while a Word document
//     is read by scrolling. Hence `plainWheel`, on for images, off for pages.
//
//  The zoom is stepless: every event contributes its own factor, exponential
//  in the delta, so a trackpad's stream of small deltas compounds smoothly and
//  one 100px mouse notch lands on ≈1.8× — the same ratio a − / + click uses.
//  Nothing is accumulated: quantising the gesture back into steps is exactly
//  what "stepless" rules out.
//
//  The handler also hands over WHERE the gesture happened. A pinch has a
//  position and the zoom is expected to grow out of it; without that the pane
//  would scale about its own top-left corner and the thing under the fingers
//  would slide away. See anchoredScroll for the arithmetic.

import { useEffect, type RefObject } from 'react'

/** Zoom factor per pixel of wheel delta — `ln(1.8)/100`, so a 100px notch
 *  matches ZOOM_STEP_FACTOR and the two inputs speak the same ratio. */
const WHEEL_ZOOM_SENSITIVITY = Math.log(1.8) / 100

/** A pointer position in viewport coordinates, i.e. where the gesture landed. */
export interface ZoomAnchor {
  clientX: number
  clientY: number
}

/** The scroll offsets that leave the point under the cursor where it is while a
 *  zoom changes the content's size by `ratio` (new scale / old scale): the
 *  content point under the cursor is `scroll + cursor offset`, and it must land
 *  on the same screen pixel at the new scale. Both viewers' content grows in
 *  proportion to the scale — a page by `zoom`, an image by its width — so one
 *  ratio serves both. */
export function anchoredScroll(el: HTMLElement, anchor: ZoomAnchor, ratio: number): { left: number; top: number } {
  const rect = el.getBoundingClientRect()
  const offsetX = anchor.clientX - rect.left
  const offsetY = anchor.clientY - rect.top
  return {
    left: (el.scrollLeft + offsetX) * ratio - offsetX,
    top: (el.scrollTop + offsetY) * ratio - offsetY,
  }
}

export function useWheelZoom(
  ref: RefObject<HTMLElement | null>,
  onZoom: (factor: number, anchor: ZoomAnchor) => void,
  options?: { plainWheel?: boolean }
): void {
  const plainWheel = options?.plainWheel ?? false
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const handleWheel = (event: WheelEvent): void => {
      const gesture = event.ctrlKey || event.metaKey
      if ((!gesture && !plainWheel) || event.deltaY === 0) return
      // The gesture belongs to the zoom even once the scale is clamped, so the
      // page's own scroll is swallowed either way.
      event.preventDefault()
      // deltaY < 0 (wheel up / pinch out) zooms in.
      onZoom(Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY), { clientX: event.clientX, clientY: event.clientY })
    }
    element.addEventListener('wheel', handleWheel, { passive: false })
    return () => element.removeEventListener('wheel', handleWheel)
  }, [ref, onZoom, plainWheel])
}
