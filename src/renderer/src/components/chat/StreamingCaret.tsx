/**
 * The transcript's caret — a 6×14 bar of --pm-ink blinking at 1s step-end.
 *
 * One host draws it today: `StreamingCursor` at the foot of TranscriptView
 * hosts (tool studio / form assist / sub-agent drill-in) while the loop works
 * without live text. The other host is retired — x-markdown's in-text
 * `streaming.tail` caret rode the live text until user ruling 2026-11-21
 * (渐变流式期间不要光标): the fading text itself is the streaming indicator,
 * and the chat's foot cursor had already been retired the same day in favour
 * of the live-badge. `data-streaming-cursor` stays so counting it still
 * answers 「how many cursors are on screen」 — one during a TranscriptView
 * run's textless phases, none once settled — which is what vitest and the
 * probes assert.
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
