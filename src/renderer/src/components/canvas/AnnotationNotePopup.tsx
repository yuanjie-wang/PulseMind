// ── Canvas note popup (deprecated 0.4.0 canvas) ── tiny auto-focus textarea for entering an annotation note at click position.
import { useState, useRef, useEffect } from 'react'

interface AnnotationNotePopupProps {
  x: number
  y: number
  onSubmit: (text: string) => void
  onCancel: () => void
}

export default function AnnotationNotePopup({ x, y, onSubmit, onCancel }: AnnotationNotePopupProps) {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const clampedX = Math.max(0, Math.min(x, window.innerWidth - 320))
  const clampedY = Math.max(0, y)

  return (
    <div
      data-rect-control="true"
      style={{
        position: 'absolute',
        left: clampedX,
        top: clampedY,
        zIndex: 10000,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        background: '#f0f0f0',
        border: '1px solid rgba(0,0,0,0.1)',
        borderRadius: 10,
        padding: '10px 12px',
        boxShadow: '0 4px 16px rgba(0,0,0,0.1)',
        minWidth: 280,
      }}
    >
      <div style={{
        fontSize: 11,
        fontWeight: 600,
        color: '#888',
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
      }}>
        改动意见
      </div>
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onSubmit(value)
          } else if (e.key === 'Escape') {
            onCancel()
          }
        }}
        onBlur={() => onSubmit(value)}
        placeholder="输入对此区域的改动意见..."
        style={{
          padding: '8px 10px',
          border: '1px solid rgba(0,0,0,0.15)',
          borderRadius: 6,
          background: '#fff',
          color: '#333',
          fontSize: 13,
          outline: 'none',
          width: '100%',
          fontFamily: 'inherit',
          boxSizing: 'border-box',
        }}
      />
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button
          onClick={onCancel}
          style={{
            padding: '4px 12px',
            border: 'none',
            borderRadius: 6,
            background: 'transparent',
            color: '#888',
            fontSize: 12,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          取消
        </button>
        <button
          onClick={() => onSubmit(value)}
          disabled={!value.trim()}
          style={{
            padding: '4px 12px',
            border: 'none',
            borderRadius: 6,
            background: value.trim() ? '#4f8cff' : '#ccc',
            color: '#fff',
            fontSize: 12,
            cursor: value.trim() ? 'pointer' : 'default',
            fontFamily: 'inherit',
          }}
        >
          确认
        </button>
      </div>
    </div>
  )
}
