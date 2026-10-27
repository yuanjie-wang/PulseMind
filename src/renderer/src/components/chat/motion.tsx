/**
 * Chat micro-motion — the one injection point for the keyframes, classes and
 * animation constants the transcript family shares (SegmentBlock's entrance,
 * ApprovalArea's attention, the expandable bodies, the status-icon pops).
 *
 * The <style> element is injected once per document (ExecutionSegment's
 * KEYFRAMES pattern): guarded on `typeof document`, so logic-level imports and
 * vitest's node env are no-ops. Every effect here degrades to its final value
 * when animations/transitions are off — which is both the
 * prefers-reduced-motion contract below and what lets the geometry/style probes
 * keep measuring the settled state after injecting their own kill sheet (the
 * probe-theme-dark precedent).
 */
import React from 'react'

/** A newly arrived transcript row (use-segment-entrance marks these; history
 *  hydration never animates). No fill mode: the animation ends on the element's
 *  natural style, so no lingering transform can become a containing block for
 *  fixed-position descendants. */
export const ENTER_ANIM = 'pm-enter-up 0.22s ease-out'
/** A glyph that just appeared as the result of a user action or a settlement. */
export const POP_ANIM = 'pm-pop-in 0.2s ease-out'
/** A glyph reporting failure — one short horizontal oscillation, not a loop. */
export const SHAKE_ANIM = 'pm-shake-x 0.3s ease-out'
/** The held-call decision strip: slide in, then a short edge pulse — twice,
 *  deliberately not looping (a looping glow reads as an error state). */
export const APPROVAL_IN_ANIM = 'pm-approval-in 0.22s ease-out, pm-approval-pulse 0.9s ease-out 0.15s 2'
/** The transcript caret (StreamingCaret): half a second on, half off, no fade. */
export const CARET_BLINK_ANIM = 'pm-caret-blink 1s step-end infinite'

const MOTION_CSS = `
@keyframes pm-enter-up { from { opacity: 0; transform: translateY(4px); } }
@keyframes pm-caret-blink { 0%, 50% { opacity: 1; } 51%, 100% { opacity: 0; } }
@keyframes pm-pop-in { from { opacity: 0; transform: scale(0.6); } }
@keyframes pm-shake-x {
  0%, 100% { transform: none; }
  20% { transform: translateX(-2px); }
  40% { transform: translateX(2px); }
  60% { transform: translateX(-1px); }
  80% { transform: translateX(1px); }
}
@keyframes pm-approval-in { from { opacity: 0; transform: translateY(-3px); } }
@keyframes pm-approval-pulse {
  0%, 100% { box-shadow: 0 0 0 0 transparent; }
  40% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--pm-warn) 20%, transparent); }
}
/* Expandable bodies (CollapseBody): the wrapper is always a 1fr grid row, so an
   open body tracks its content's height changes; @starting-style makes a freshly
   mounted body transition up from 0fr with zero JS and no double-rAF — and with
   transitions off (probes, reduced motion) it simply renders open. The close is
   a plain unmount: the body disappears in one frame, like every dismiss. */
.pm-collapse { display: grid; grid-template-rows: 1fr; transition: grid-template-rows 0.22s ease; }
.pm-collapse > div { overflow: hidden; min-height: 0; }
@starting-style { .pm-collapse { grid-template-rows: 0fr; } }
@media (prefers-reduced-motion: reduce) {
  .pm-collapse { transition: none !important; }
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
`

let motionInjected = false
if (typeof document !== 'undefined' && !motionInjected) {
  const el = document.createElement('style')
  el.textContent = MOTION_CSS
  document.head.appendChild(el)
  motionInjected = true
}

/**
 * The expandable body under CollapsibleToolBlock and ExecutionSegment. Renders
 * nothing while closed; on open it mounts through .pm-collapse, whose
 * @starting-style grows it from 0fr (see MOTION_CSS). `style` lands on the
 * inner content box (the bordered/padded card shell the callers had before).
 */
export function CollapseBody({
  open,
  style,
  children,
}: {
  open: boolean
  style?: React.CSSProperties
  children: React.ReactNode
}): React.ReactElement | null {
  if (!open) return null
  return (
    <div className="pm-collapse">
      <div>
        <div style={style}>{children}</div>
      </div>
    </div>
  )
}
