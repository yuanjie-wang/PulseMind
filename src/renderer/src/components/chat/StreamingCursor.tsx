/**
 * The transcript's "still working" cursor. Shared so the chat and the tool
 * studio show the same affordance while a loop is running. The horizontal
 * geometry mirrors SegmentView's message column (maxWidth 1000 centred, the
 * host's contentInset), so hosts with contentInset 0 — the editor assistants —
 * get the blink flush left with the conversation instead of at the chat's
 * 24px column inset.
 */
import React, { useId } from 'react'
import { MESSAGE_COLUMN_INSET } from './SegmentView'

export function StreamingCursor({ show, contentInset = MESSAGE_COLUMN_INSET }: { show: boolean; contentInset?: number }): React.ReactElement | null {
  const uid = useId()
  if (!show) return null
  const animName = `blink-${uid.replace(/[:.]/g, '')}`
  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: `0 ${contentInset}px` }}>
      <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 12, paddingLeft: 12 }}>
        <span
          style={{
            display: 'inline-block',
            width: 6,
            height: 14,
            background: 'var(--pm-ink)',
            animation: `${animName} 1s step-end infinite`,
            verticalAlign: 'text-bottom',
            willChange: 'opacity',
          }}
        />
      </div>
      <style>{`@keyframes ${animName} { 0%, 50% { opacity: 1; } 51%, 100% { opacity: 0; } }`}</style>
    </div>
  )
}
