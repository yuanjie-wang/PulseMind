import { useState, useRef, useEffect } from 'react'
import { Tooltip } from 'antd'

interface ZoomControlsProps {
  zoom: number
  onZoomIn: () => void
  onZoomOut: () => void
  onResetZoom: () => void
  onCenterView: () => void
  onZoomSet: (zoom: number) => void
}

const MIN_ZOOM = 0.1
const MAX_ZOOM = 5

export default function ZoomControls({ zoom, onZoomIn, onZoomOut, onResetZoom, onCenterView, onZoomSet }: ZoomControlsProps) {
  const [editing, setEditing] = useState(false)
  const [inputValue, setInputValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  const handleSubmit = () => {
    const pct = parseInt(inputValue, 10)
    if (!isNaN(pct) && pct > 0) {
      onZoomSet(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pct / 100)))
    }
    setEditing(false)
  }

  const btnStyle: React.CSSProperties = {
    width: 28,
    height: 28,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    borderRadius: 4,
    background: 'transparent',
    cursor: 'pointer',
    color: '#6e6e73',
    fontSize: 16,
    fontWeight: 600,
  }

  return (
    <div style={{
      position: 'fixed',
      bottom: 16,
      right: 16,
      zIndex: 100,
      display: 'flex',
      alignItems: 'center',
      gap: 2,
      padding: 4,
      background: '#f8f8f8',
      border: '1px solid rgba(210,210,215,0.5)',
      borderRadius: 12,
      boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
    }}>
      <Tooltip title="缩小">
        <button style={btnStyle} onClick={onZoomOut}>
          <span>−</span>
        </button>
      </Tooltip>
      {editing ? (
        <input
          ref={inputRef}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value.replace(/[^0-9]/g, ''))}
          onBlur={handleSubmit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSubmit()
            if (e.key === 'Escape') setEditing(false)
          }}
          style={{
            width: 44,
            textAlign: 'center',
            fontSize: 12,
            color: '#6e6e73',
            fontVariantNumeric: 'tabular-nums',
            border: '1px solid #4f8cff',
            borderRadius: 4,
            outline: 'none',
            padding: '1px 2px',
            fontFamily: 'inherit',
          }}
        />
      ) : (
        <span
          onClick={() => { setInputValue(String(Math.round(zoom * 100))); setEditing(true) }}
          style={{
            minWidth: 44,
            textAlign: 'center',
            fontSize: 12,
            color: '#6e6e73',
            fontVariantNumeric: 'tabular-nums',
            userSelect: 'none',
            cursor: 'text',
            padding: '1px 2px',
            borderRadius: 4,
          }}
        >
          {Math.round(zoom * 100)}%
        </span>
      )}
      <Tooltip title="放大">
        <button style={btnStyle} onClick={onZoomIn}>
          <span>+</span>
        </button>
      </Tooltip>
      <div style={{ width: 1, height: 16, background: '#d2d2d7', margin: '0 4px' }} />
      <Tooltip title="重置缩放">
        <button
          style={{
            height: 28, padding: '0 8px',
            border: 'none', borderRadius: 4,
            background: 'transparent',
            color: '#6e6e73', fontSize: 11, cursor: 'pointer',
          }}
          onClick={onResetZoom}
        >
          1:1
        </button>
      </Tooltip>
      <div style={{ width: 1, height: 16, background: '#d2d2d7', margin: '0 4px' }} />
      <Tooltip title="回到工作区中心">
        <button
          style={{
            height: 28, padding: '0 6px',
            border: 'none', borderRadius: 4,
            background: 'transparent',
            color: '#6e6e73', fontSize: 13, cursor: 'pointer',
            display: 'flex', alignItems: 'center',
          }}
          onClick={onCenterView}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="3" />
            <circle cx="12" cy="12" r="9" />
            <line x1="12" y1="1" x2="12" y2="5" />
            <line x1="12" y1="19" x2="12" y2="23" />
            <line x1="1" y1="12" x2="5" y2="12" />
            <line x1="19" y1="12" x2="23" y2="12" />
          </svg>
        </button>
      </Tooltip>
    </div>
  )
}
