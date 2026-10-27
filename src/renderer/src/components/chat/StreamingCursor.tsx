/**
 * The transcript's "still working" cursor at the foot of the column. Shared so
 * the chat and the tool studio show the same affordance while a loop is
 * running. It yields whenever a live text tail is on screen — hosts pass
 * `show={isRequesting && !hasLiveTextTail(segments)}` — because the same caret
 * then sits at the end of the streaming text instead (SegmentView's streaming
 * tail), and a run must show exactly one cursor. The horizontal geometry
 * mirrors SegmentView's message column (maxWidth 1000 centred, the host's
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
