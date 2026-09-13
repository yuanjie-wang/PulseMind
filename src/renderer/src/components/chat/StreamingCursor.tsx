/**
 * The transcript's "still working" cursor. Shared so the chat and the tool
 * studio show the same affordance while a loop is running.
 */
import React, { useId } from 'react'

export function StreamingCursor({ show }: { show: boolean }): React.ReactElement | null {
  const uid = useId()
  if (!show) return null
  const animName = `blink-${uid.replace(/[:.]/g, '')}`
  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: '0 24px' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 12, paddingLeft: 12 }}>
        <span
          style={{
            display: 'inline-block',
            width: 6,
            height: 14,
            background: '#000',
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
