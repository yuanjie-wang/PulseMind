/**
 * The transcript's "still working" cursor at the foot of the column. Shared so
 * the hosts that still draw it (TranscriptView — tool studio, form assist,
 * sub-agent drill-in) show the same affordance while a loop is running. It
 * yields whenever a live text tail is on screen — hosts pass
 * `show={isRequesting && !hasLiveTextTail(segments)}` — because the growing
 * fading text is then its own indicator and no cursor shows at all (the
 * in-text tail caret this used to yield to is retired, user ruling
 * 2026-11-21: 渐变流式期间不要光标). The horizontal geometry mirrors
 * SegmentView's message column (maxWidth 1000 centred, the host's
 * contentInset), so hosts with contentInset 0 — the editor assistants — get
 * the blink flush left with the conversation instead of at the chat's 24px
 * column inset.
 */
import React from 'react'
import { MESSAGE_COLUMN_INSET } from './SegmentView'
import { StreamingCaret } from './StreamingCaret'

export function StreamingCursor({ show, contentInset = MESSAGE_COLUMN_INSET }: { show: boolean; contentInset?: number }): React.ReactElement | null {
  if (!show) return null
  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: `0 ${contentInset}px` }}>
      <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 12, paddingLeft: 12 }}>
        <StreamingCaret />
      </div>
    </div>
  )
}
