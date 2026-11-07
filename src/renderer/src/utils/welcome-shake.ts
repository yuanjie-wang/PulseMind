// ── The 新建任务 guidance shake ──
// Clicking 新建任务 lands on the welcome view, and the click also wiggles the
// surface the user is meant to act on next: the composer in chat mode, the
// whole project picker (heading + cards) in project mode (user 2026-09-23,
// 「左右摇晃」). The store carries the request (see newTaskStore); this module
// turns it into one horizontal oscillation via the Web Animations API —
// `el.animate()` retriggers by simply being called again, so repeated clicks
// re-shake without remounting the composer (its draft text must survive) and
// without any CSS-class remove/reflow/re-add dance.

import { useEffect } from 'react'
import type { RefObject } from 'react'
import { useNewTaskStore, type NewTaskShake, type NewTaskShakeTarget } from '../stores/newTaskStore'

/** How long a shake request stays honor-able. The bump and the welcome mount
 *  happen inside one click handler, so a fresh token must shake a surface that
 *  mounts AFTER it; the window is what keeps an OLD token from shaking an
 *  unrelated later entry into the welcome view (opening an empty conversation
 *  from history must not wiggle anything). 1s comfortably covers the
 *  bump→commit gap and is far below any human-meaningful interval. */
export const SHAKE_GRACE_MS = 1000

export const SHAKE_DURATION_MS = 500

export const SHAKE_KEYFRAMES: Keyframe[] = [
  { transform: 'translateX(0px)', offset: 0 },
  { transform: 'translateX(-10px)', offset: 0.12 },
  { transform: 'translateX(9px)', offset: 0.24 },
  { transform: 'translateX(-7px)', offset: 0.38 },
  { transform: 'translateX(5px)', offset: 0.52 },
  { transform: 'translateX(-3px)', offset: 0.68 },
  { transform: 'translateX(0px)', offset: 1 },
]

/** Pure decision half of the hook — vitest is node-env, so the observable
 *  behavior (does the element animate) lives in the probe, but target routing
 *  and the grace window are testable here. `shake.target === null` (a cancel)
 *  matches nothing. */
export function shouldPlayShake(shake: NewTaskShake, target: NewTaskShakeTarget, now: number): boolean {
  return shake.target === target && now - shake.at <= SHAKE_GRACE_MS
}

export function useWelcomeShake(target: NewTaskShakeTarget, ref: RefObject<HTMLElement | null>): void {
  const shake = useNewTaskStore((s) => s.shake)
  useEffect(() => {
    // The mount run is load-bearing, not an accident of useEffect semantics:
    // 新建任务 bumps the store and (re)mounts the welcome surface in the same
    // handler, so the just-bumped token must shake the freshly mounted element.
    // shouldPlayShake's grace window is what makes that same mount run safe
    // when the token is old.
    if (!shouldPlayShake(shake, target, Date.now())) return
    ref.current?.animate(SHAKE_KEYFRAMES, { duration: SHAKE_DURATION_MS, easing: 'ease-in-out' })
  }, [shake, target, ref])
}

// ── The form-swap enter transition ──
// The welcome page's project-mode forms swap by conditional render (the old
// tree unmounts instantly — there is no exit animation without briefly keeping
// both trees alive, machinery a polish pass doesn't justify), so the swap reads
// as a transition through the INCOMING surface: a one-shot fade + drift played
// on the picker root at the moment its form token changes. Direction follows
// the motion's anchor: a selection compresses DOWNWARD into the strip hugging
// the composer, so the strip rises in from below; 更换 expands back UP into the
// grid, so it settles in from above. Same WAAPI idiom as the shake above.

export const WELCOME_ENTER_MS = 220

export function playWelcomeEnter(el: HTMLElement | null, from: 'below' | 'above'): void {
  if (!el) return
  const y = from === 'below' ? 10 : -8
  el.animate(
    [
      { transform: `translateY(${y}px)`, opacity: '0' },
      { transform: 'translateY(0px)', opacity: '1' },
    ],
    { duration: WELCOME_ENTER_MS, easing: 'ease-out' },
  )
}
