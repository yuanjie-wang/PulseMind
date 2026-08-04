import React, { useState, useRef, useEffect } from 'react'
import { ArrowRightOutlined, ReloadOutlined, ExportOutlined, DeleteOutlined, FileTextOutlined, ChromeOutlined, PictureOutlined } from '@ant-design/icons'
import type { Annotation, ToolType } from '../../types/canvas'

interface LeftAnnotationToolbarProps {
  selectedRectId: string | null
  allAnnotations: Annotation[]
  zoom: number
  panX: number
  panY: number
  currentTool: ToolType
  onToolChange: (tool: ToolType) => void
  currentColor: string
  onColorChange: (color: string) => void
  onResetRect?: (id: string) => void
  onDeleteRect: (id: string) => void
  onExportHtml?: (id: string) => void
  onOpenInBrowser?: (id: string) => void
  onExportImage?: (id: string) => void
}

const COLORS = ['#ff0000', '#ff8800', '#ffdd00', '#00cc44', '#0088ff', '#8800ff', '#000000']

function ToolButton({ active, onClick, title, children, color }: {
  active?: boolean; onClick: () => void; title: string; children: React.ReactNode; color?: string
}) {
  return (
    <button
      data-rect-control="true"
      onClick={onClick}
      title={title}
      style={{
        width: 30, height: 30,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        border: 'none', borderRadius: 6,
        background: active ? 'rgba(79,140,255,0.2)' : 'transparent',
        color: color ?? (active ? '#4f8cff' : '#6e6e73'),
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  )
}

function ExportButton({ onClick, children, borderTop }: {
  onClick: () => void; children: React.ReactNode; borderTop?: boolean
}) {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '6px 12px',
        border: 'none',
        borderTop: borderTop ? '1px solid #d2d2d7' : 'none',
        background: hover ? 'rgba(248,248,248,0.5)' : 'transparent',
        color: '#1d1d1f',
        fontSize: 12,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        fontFamily: 'inherit',
      }}
    >
      {children}
    </button>
  )
}

export default function LeftAnnotationToolbar({
  selectedRectId, allAnnotations, zoom, panX, panY,
  currentTool, onToolChange, currentColor, onColorChange,
  onResetRect, onDeleteRect, onExportHtml, onOpenInBrowser, onExportImage,
}: LeftAnnotationToolbarProps) {
  const [exportOpen, setExportOpen] = useState(false)
  const [leftColorOpen, setLeftColorOpen] = useState(false)
  const leftColorRef = useRef<HTMLDivElement>(null)

  // Click-outside handler for color picker
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (leftColorRef.current && !leftColorRef.current.contains(e.target as Node)) {
        setLeftColorOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Close popups on selection change
  useEffect(() => {
    setExportOpen(false)
    setLeftColorOpen(false)
  }, [selectedRectId])

  if (!selectedRectId) return null
  const selAnn = allAnnotations.find((a) => a.id === selectedRectId)
  if (!selAnn?.boundingBox) return null

  const b = selAnn.boundingBox
  const vpX = b.x * zoom + panX
  const vpY = b.y * zoom + panY
  const vpCenterY = vpY + b.height * zoom / 2

  return (
    <div
      data-rect-control="true"
      style={{
        position: 'absolute',
        left: vpX - 50,
        top: vpCenterY,
        transform: 'translateY(-50%)',
        zIndex: 500,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 3,
        padding: 6,
        background: '#f8f8f8',
        border: '1px solid #d2d2d7',
        borderRadius: 12,
        boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
      }}
    >
      {/* Rectangle */}
      <ToolButton active={currentTool === 'rectangle'} onClick={() => onToolChange('rectangle')} title="矩形框">
        <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" />
        </svg>
      </ToolButton>

      {/* Ellipse */}
      <ToolButton active={currentTool === 'ellipse'} onClick={() => onToolChange('ellipse')} title="椭圆">
        <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
        </svg>
      </ToolButton>

      {/* Arrow */}
      <ToolButton active={currentTool === 'arrow'} onClick={() => onToolChange('arrow')} title="箭头">
        <ArrowRightOutlined style={{ fontSize: 15 }} />
      </ToolButton>

      <div style={{ width: '80%', height: 1, background: '#d2d2d7', margin: '3px 0' }} />

      {/* Color picker */}
      <div ref={leftColorRef} style={{ position: 'relative' }}>
        <button
          data-rect-control="true"
          onClick={() => setLeftColorOpen((v) => !v)}
          title="颜色"
          style={{
            width: 16, height: 16, minWidth: 0, padding: 0,
            marginTop: 2, marginBottom: 2,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: '1.5px solid rgba(0,0,0,0.15)',
            borderRadius: '50%',
            background: currentColor,
            cursor: 'pointer',
            transition: 'all 0.15s',
          }}
        />
        {leftColorOpen && (
          <div
            style={{
              position: 'absolute',
              left: '100%', top: '50%',
              transform: 'translateY(-50%)',
              marginLeft: 8,
              display: 'flex', gap: 3, padding: 6,
              background: '#fff',
              border: '1px solid #d2d2d7',
              borderRadius: 10,
              boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
              zIndex: 20,
            }}
          >
            {COLORS.map((color) => (
              <button
                key={color}
                onClick={() => { onColorChange(color); setLeftColorOpen(false) }}
                title={color}
                style={{
                  width: 16, height: 16, borderRadius: '50%',
                  border: currentColor === color ? '1.5px solid #333' : '1.5px solid transparent',
                  background: color, cursor: 'pointer',
                }}
              />
            ))}
          </div>
        )}
      </div>

      <div style={{ width: '80%', height: 1, background: '#d2d2d7', margin: '3px 0' }} />

      {/* Reset */}
      <ToolButton onClick={() => onResetRect?.(selectedRectId)} title="重置">
        <ReloadOutlined style={{ fontSize: 15 }} />
      </ToolButton>

      {/* Export */}
      <div style={{ position: 'relative' }}>
        <button
          onClick={() => { if (!selAnn.generatedCode) return; setExportOpen((v) => !v) }}
          title="导出"
          style={{
            width: 30, height: 30,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: 'none', borderRadius: 6,
            background: 'transparent',
            color: selAnn.generatedCode ? '#6e6e73' : '#aeaeb2',
            cursor: selAnn.generatedCode ? 'pointer' : 'default',
          }}
        >
          <ExportOutlined style={{ fontSize: 15 }} />
        </button>
        {exportOpen && (
          <>
            <div style={{ position: 'fixed', inset: 0, zIndex: 19 }} onClick={() => setExportOpen(false)} />
            <div
              style={{
                position: 'absolute',
                left: '50%', bottom: '100%',
                transform: 'translateX(-50%)',
                marginBottom: 6,
                background: '#fff',
                border: '1px solid #d2d2d7',
                borderRadius: 8,
                boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
                zIndex: 20,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
              }}
            >
              <ExportButton onClick={() => { onExportHtml?.(selectedRectId); setExportOpen(false) }}>
                <FileTextOutlined style={{ fontSize: 13 }} />
                下载 HTML
              </ExportButton>
              <ExportButton onClick={() => { onOpenInBrowser?.(selectedRectId); setExportOpen(false) }} borderTop>
                <ChromeOutlined style={{ fontSize: 13 }} />
                在浏览器中打开
              </ExportButton>
              <ExportButton onClick={() => { onExportImage?.(selectedRectId); setExportOpen(false) }} borderTop>
                <PictureOutlined style={{ fontSize: 13 }} />
                导出图片
              </ExportButton>
            </div>
          </>
        )}
      </div>

      {/* Delete */}
      <ToolButton onClick={() => onDeleteRect(selectedRectId)} title="删除">
        <DeleteOutlined style={{ fontSize: 15 }} />
      </ToolButton>
    </div>
  )
}
