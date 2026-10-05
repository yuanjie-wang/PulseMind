// The floating composer root must not cover the transcript's scrollbar (user
// report 2026-10-05: 「对话区的垂直滚动条，在与消息发送区同高的位置是无法拖动的」).
// The chat scroller is `height: 100%` and the composer floats
// `absolute; left:0; right:0` over its lower band, so the root's transparent
// padding box sat ON TOP of the track and every grab at the composer's height
// hit the composer (zIndex 10) instead of the track. The fix is a
// pointer-events pair on Composer: the floating root goes click-through and
// the inner column — the card plus the above-card slot — opts back in. The
// card is inset ≥24px from both pane edges by that very padding (wider than
// any scrollbar), so the card never needs to cover the track and nothing
// interactive lived in the band.
//
// vitest has no layout engine, so the pixel facts belong to
// scripts/probe-composer-scrollbar.mjs (a real scrollbar drag at the
// composer's height); this scan owns the wiring: a half-revert — dropping
// either half of the pair, or un-gating it from `floating` — fails here.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')
const composer = readFileSync(join(ROOT, 'src/renderer/src/components/chat/Composer.tsx'), 'utf-8')

describe('floating composer root clears the transcript scrollbar', () => {
  it('non-vacuity: the scans read the real floating root style', () => {
    expect(composer).toContain("position: 'absolute',")
    expect(composer).toContain("padding: '12px 24px 24px',")
  })

  it('the floating root is click-through — pointerEvents none, on the floating arm only', () => {
    // The arm match anchors on position:absolute and cannot cross the object's
    // closing brace, so "none" is proven to live INSIDE the root's own style.
    const arm = composer.match(/layout === 'floating'\s*\?\s*\{\s*position: 'absolute',[^}]*\}/s)
    expect(arm).toBeTruthy()
    expect(arm![0]).toContain("pointerEvents: 'none'")
    // 'auto' on the ROOT would re-cover the track — the exact bug, resurrected
    // the polite way. If a future change needs the band interactive, extend the
    // inner column instead (see the probe header for why).
    expect(arm![0]).not.toContain("pointerEvents: 'auto'")
  })

  it('the inner column opts back in — pointerEvents auto, gated on floating too', () => {
    expect(composer).toContain("...(layout === 'floating' ? { pointerEvents: 'auto' } : null)")
  })
})
