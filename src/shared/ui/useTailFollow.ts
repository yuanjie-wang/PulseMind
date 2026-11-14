// ── React binding for the tail-follow engine ──
// The engine (shared/tail-follow.ts) owns the policy; this hook owns the React
// lifecycle, and every scrolling transcript host now goes through it instead of
// re-deriving "am I at the bottom?" from geometry.
//
// The per-commit settle is what makes following 100%: hosts used to snap once
// (or twice, via rAF) per commit and then stop — content that grows after the
// commit (x-markdown's delayed body, code blocks, images) was simply left
// behind. The engine keeps snapping on every frame the height changes.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createTailFollow, type TailFollow, type TailFollowOptions, type TailFollowTarget } from '../tail-follow'

/**
 * Creates a tail follower bound to `getEl` for this component's lifetime:
 * attaches input/scroll listeners on mount (idempotent, so a remount may call
 * `attach` again with the new element), re-arms the settle loop on every commit,
 * and disposes on unmount.
 *
 * Option values are read once (they are tunables, not state); `onFollowingChange`
 * is the exception — it always runs through the latest closure, so a host may
 * pass a fresh arrow every render without re-creating the engine (which would
 * drop `following` and the write proofs).
 */
export function useTailFollow(getEl: () => TailFollowTarget | null, opts: TailFollowOptions = {}): TailFollow {
  const getRef = useRef(getEl)
  const optsRef = useRef(opts)
  // Written before the settle effect below so a commit never settles against a
  // stale getter (the ref the getter closes over is assigned during the commit).
  useLayoutEffect(() => {
    getRef.current = getEl
    optsRef.current = opts
  })

  const [follow] = useState(() =>
    createTailFollow(() => getRef.current(), {
      ...opts,
      onFollowingChange: (following) => optsRef.current.onFollowingChange?.(following),
    }),
  )

  // Re-attach on every commit — `attach` is idempotent (it returns early while
  // the element is unchanged), and the scroller can legitimately be a DIFFERENT
  // element later: ChatBody swaps from its welcome form to the transcript
  // scroller, and a host remount replaces the node outright. Then report the
  // commit as growth: while following, keep the tail glued until the height
  // stops moving. No-op when released or held.
  useLayoutEffect(() => {
    follow.attach(getRef.current())
    follow.settle()
  })

  useEffect(() => () => follow.dispose(), [follow])

  return follow
}

export type { TailFollow, TailFollowOptions, TailFollowTarget }
