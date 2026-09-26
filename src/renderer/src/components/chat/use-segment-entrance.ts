/**
 * Which transcript segments are NEWLY arrived and should play the entrance
 * animation (SegmentBlock's `enter`), as a set of segment keys.
 *
 * The rule the whole design protects: **history never animates**. On the first
 * render every key present is marked seen silently — so opening a conversation,
 * a run record or a sub-agent session renders settled — and only keys that
 * appear on a LATER pass come back as fresh. The ref is deliberately not state:
 * it is a render-time memoization input like ChatView's segment caches.
 *
 * Two remount shapes would otherwise replay the animation and are handled:
 * - ChatView's window slides (`slice(windowTop)`) remount far rows while
 *   scrolling — but only ever OLD rows (the tail PAGE_SIZE is always rendered),
 *   and old rows are never fresh; fresh rows clear nobody.
 * - A host that swaps conversations under a still-mounted view (the sub-agent
 *   session view flipping nodes) passes `resetKey` (its conversation id): on
 *   change the seen set is discarded and the incoming list is treated as
 *   history, so a switch reads as an open, not an entrance wave.
 *
 * The `streaming` segment is skipped on purpose: its key is the same string
 * every turn, so it could animate at most once per mount — while the turn's
 * real arrivals (the user message, then the settled single/execution segments
 * that replace it) carry unique keys and animate on their own.
 */
import { useLayoutEffect, useRef, useState } from 'react'
import { getSegmentKey, type Segment } from './message-segments'

const EMPTY_SET: ReadonlySet<string> = new Set()

export function useSegmentEntrance(segments: readonly Segment[], resetKey?: string): ReadonlySet<string> {
  const seenRef = useRef<Set<string> | null>(null)
  const resetRef = useRef(resetKey)
  const [fresh, setFresh] = useState<ReadonlySet<string>>(EMPTY_SET)

  useLayoutEffect(() => {
    if (resetRef.current !== resetKey) {
      resetRef.current = resetKey
      seenRef.current = null
      setFresh(EMPTY_SET)
    }
    const first = seenRef.current === null
    const seen = seenRef.current ?? new Set<string>()
    const newly: string[] = []
    for (const seg of segments) {
      if (seg.type === 'streaming') continue
      const key = getSegmentKey(seg)
      if (!seen.has(key)) {
        seen.add(key)
        if (!first) newly.push(key)
      }
    }
    seenRef.current = seen
    if (newly.length === 0) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the fresh set is derived from the committed segment list, not from an external system; the guard (newly empty → return) means it fires once per genuinely new segment, never per streamed chunk, so there is no cascading render
    setFresh((prev) => {
      const next = new Set(prev)
      for (const key of newly) next.add(key)
      return next
    })
  }, [segments, resetKey])

  return fresh
}
