import React, { useEffect, useRef, useState } from 'react'
import {
  CloseOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
  ReloadOutlined,
  RotateLeftOutlined,
  RotateRightOutlined,
  DownloadOutlined
} from '@ant-design/icons'

const btnStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.15)',
  border: 'none',
  color: '#fff',
  width: 40,
  height: 40,
  borderRadius: 8,
  cursor: 'pointer',
  fontSize: 18,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'background 0.15s'
}

export function ImageViewer({
  src,
  onClose
}: {
  src: string
  onClose: () => void
}): React.ReactElement {
  const [scale, setScale] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [offset, setOffset] = useState({ x: 0, y: 0 })

  // Use refs for drag state to avoid stale closures
  const draggingRef = useRef(false)
  const dragStartRef = useRef({ x: 0, y: 0 })
  const offsetRef = useRef({ x: 0, y: 0 })
  const containerRef = useRef<HTMLDivElement>(null)

  // Keep offsetRef in sync with offset state
  useEffect(() => { offsetRef.current = offset }, [offset])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape': onClose(); break
        case '+': case '=': setScale((s) => Math.min(s + 0.25, 5)); break
        case '-': setScale((s) => Math.max(s - 0.25, 0.25)); break
        case 'r': setRotation((r) => r + 90); break
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  // Use ref-attached listener with { passive: false } so preventDefault works
  // (Chrome makes wheel/touch listeners passive by default, blocking preventDefault)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const handler = (e: WheelEvent) => {
      e.preventDefault()
      const delta = e.deltaY > 0 ? -0.15 : 0.15
      setScale((s) => Math.max(0.25, Math.min(5, s + delta)))
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [])

  const handleMouseDown = (e: React.MouseEvent) => {
    if (scale > 1) {
      draggingRef.current = true
      dragStartRef.current = {
        x: e.clientX - offsetRef.current.x,
        y: e.clientY - offsetRef.current.y
      }
    }
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!draggingRef.current) return
    setOffset({
      x: e.clientX - dragStartRef.current.x,
      y: e.clientY - dragStartRef.current.y
    })
  }

  const handleMouseUp = () => { draggingRef.current = false }

  const handleDownload = async () => {
    try {
      const ext = (src.match(/\.(\w{3,4})(?:\?|$)/) || [])[1] || 'png'
      const { filePath, canceled } = await window.electronAPI.showSaveDialog({
        defaultName: `image.${ext}`,
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }]
      })
      if (canceled || !filePath) return
      await window.electronAPI.copyFile({ sourceUrl: src, destination: filePath })
    } catch (err) {
      console.warn('[ImageViewer] Download failed:', err)
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1050,
        background: 'rgba(0,0,0,0.85)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        userSelect: 'none'
      }}
      ref={containerRef}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      {/* Close button */}
      <button
        style={{
          position: 'fixed', top: 16, right: 16, zIndex: 1060,
          ...btnStyle
        }}
        onClick={onClose}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.3)' }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.15)' }}
      >
        <CloseOutlined />
      </button>

      {/* Toolbar */}
      <div
        style={{
          position: 'fixed',
          bottom: 32,
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          gap: 10,
          padding: '10px 18px',
          borderRadius: 14,
          background: 'rgba(0,0,0,0.6)',
          backdropFilter: 'blur(8px)',
          zIndex: 1060
        }}
      >
        {[
          { icon: <ZoomInOutlined />, title: '放大 (+)', onClick: () => setScale((s) => Math.min(s + 0.25, 5)) },
          { icon: <ZoomOutOutlined />, title: '缩小 (-)', onClick: () => setScale((s) => Math.max(s - 0.25, 0.25)) },
          { icon: <ReloadOutlined />, title: '重置', onClick: () => { setScale(1); setRotation(0); setOffset({ x: 0, y: 0 }) } },
          { icon: <RotateLeftOutlined />, title: '左旋 (r)', onClick: () => setRotation((r) => r - 90) },
          { icon: <RotateRightOutlined />, title: '右旋 (r)', onClick: () => setRotation((r) => r + 90) },
          { icon: <DownloadOutlined />, title: '下载', onClick: handleDownload },
        ].map(({ icon, title, onClick }, i) => (
          <button
            key={i}
            style={btnStyle}
            title={title}
            onClick={(e) => { e.stopPropagation(); onClick() }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.3)' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.15)' }}
          >
            {icon}
          </button>
        ))}
      </div>

      {/* Scale indicator */}
      <div
        style={{
          position: 'fixed', top: 16, left: 16, zIndex: 1060,
          color: 'rgba(255,255,255,0.5)', fontSize: 13,
          fontFamily: 'monospace'
        }}
      >
        {Math.round(scale * 100)}%
      </div>

      {/* Image */}
      <img
        src={src}
        alt="Preview"
        draggable={false}
        style={{
          maxWidth: '90vw',
          maxHeight: '90vh',
          objectFit: 'contain',
          transform: `scale(${scale}) rotate(${rotation}deg) translate(${offset.x}px, ${offset.y}px)`,
          transition: 'transform 0.1s',
          cursor: scale > 1 ? 'grab' : 'default',
          borderRadius: 4
        }}
        onDragStart={(e) => e.preventDefault()}
      />
    </div>
  )
}
