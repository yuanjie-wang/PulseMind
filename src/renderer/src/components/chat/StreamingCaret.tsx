/**
 * The transcript's caret — a 6×14 bar of --pm-ink blinking at 1s step-end.
 *
 * Two hosts draw it, never both at once: `StreamingCursor` at the foot of the
 * column while the loop works without live text (thinking, tool rounds, the
 * wait for the first token), and SegmentView's streaming tail at the end of
 * the live text itself (x-markdown's `streaming.tail` component). The cursor
 * the user watches is therefore ONE glyph moving from the column's foot into
 * the sentence, not a second symbol appearing next to it (user ruling
 * 2026-10-26: 不要出现两个光标). `data-streaming-cursor` rides both hosts, so
 * counting it answers 「how many cursors are on screen」 — exactly one during a
 * run, none once settled — which is what vitest and the probes assert.
 */
import React from 'react'
import { CARET_BLINK_ANIM } from './motion'

export function StreamingCaret({ style }: { style?: React.CSSProperties }): React.ReactElement {
  return (
    <span
      data-streaming-cursor=""
      style={{
        display: 'inline-block',
        width: 6,
        height: 14,
        background: 'var(--pm-ink)',
        animation: CARET_BLINK_ANIM,
        verticalAlign: 'text-bottom',
        willChange: 'opacity',
        ...style,
      }}
    />
  )
}
