import React, { useCallback, useRef, useEffect } from 'react'
import type { Annotation } from '../../types/canvas'
import { drawAnnotation } from '../../utils/canvasDrawUtils'
import { useCanvasStore } from '../../stores/canvasStore'
import { useSettings } from '../../hooks/SettingsContext'
import Grainient from './Grainient'

interface ToolCallInfo {
  toolName: string
  args: string
  status: 'running' | 'done'
  summary?: string
}

interface RectFrameProps {
  annotation: Annotation
  childAnnotations: Annotation[]
  isSelected: boolean
  isCtrlHeld: boolean
  isDragging: boolean
  isGenerating: boolean
  generationError?: string
  toolCalls?: ToolCallInfo[]
  onCancelGenerate: (id: string) => void
  onStartDrag?: (rectId: string, e: React.MouseEvent) => void
  onStartResize?: (rectId: string, edge: string, e: React.MouseEvent) => void
  zoom: number
  panX: number
  panY: number
}

function wrapContent(html: string): string {
  const baseStyle = `<style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#fff}*{box-sizing:border-box}img,video,table,pre,code,svg{max-width:100%;height:auto}#_ps{width:100%;height:100%;overflow:hidden}</style>`
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${baseStyle}</head><body><div id="_ps">${html}</div></body></html>`
}

const handleStyle = (edge: string, isGenerating?: boolean): React.CSSProperties => {
  const base: React.CSSProperties = {
    position: 'absolute',
    zIndex: isGenerating ? 220 : 202,
    width: 10,
    height: 10,
    background: '#fff',
    border: '2px solid #4f8cff',
    borderRadius: 2,
    pointerEvents: 'auto',
  }
  switch (edge) {
    case 'n':
      return { ...base, top: -5, left: '50%', marginLeft: -5, cursor: 'ns-resize' }
    case 's':
      return { ...base, bottom: -5, left: '50%', marginLeft: -5, cursor: 'ns-resize' }
    case 'w':
      return { ...base, left: -5, top: '50%', marginTop: -5, cursor: 'ew-resize' }
    case 'e':
      return { ...base, right: -5, top: '50%', marginTop: -5, cursor: 'ew-resize' }
    case 'nw':
      return { ...base, top: -5, left: -5, cursor: 'nwse-resize' }
    case 'ne':
      return { ...base, top: -5, right: -5, cursor: 'nesw-resize' }
    case 'sw':
      return { ...base, bottom: -5, left: -5, cursor: 'nesw-resize' }
    case 'se':
      return { ...base, bottom: -5, right: -5, cursor: 'nwse-resize' }
    default:
      return base
  }
}

const HANDLE_EDGES = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se']

export default function RectFrame({ annotation, childAnnotations, isSelected, isCtrlHeld, isDragging, isGenerating, generationError, toolCalls, onCancelGenerate, onStartDrag, onStartResize, zoom, panX, panY }: RectFrameProps) {
  const bb = annotation.boundingBox
  const childCanvasRef = useRef<HTMLCanvasElement>(null)
  const currentTool = useCanvasStore(s => s.currentTool)
  const settings = useSettings()
  const isDark = settings.settings.theme === 'dark'

  if (!bb) return null

  const screenX = bb.x * zoom + panX
  const screenY = bb.y * zoom + panY
  const screenW = bb.width * zoom
  const screenH = bb.height * zoom

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    onStartDrag?.(annotation.id, e)
  }, [annotation.id, onStartDrag])

  const handleResizeStart = useCallback((edge: string, e: React.MouseEvent) => {
    e.stopPropagation()
    onStartResize?.(annotation.id, edge, e)
  }, [annotation.id, onStartResize])

  // Draw child annotations on per-rect clipped canvas
  useEffect(() => {
    const canvas = childCanvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const cssW = bb.width
    const cssH = bb.height
    const targetW = cssW * dpr
    const targetH = cssH * dpr
    // Only resize if dimensions changed (avoids GPU compositor churn)
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW
      canvas.height = targetH
      canvas.style.width = cssW + 'px'
      canvas.style.height = cssH + 'px'
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssW, cssH)
    for (let i = 0; i < childAnnotations.length; i++) {
      const ann = childAnnotations[i]
      drawAnnotation(ctx, {
        ...ann,
        points: ann.points.map(p => ({ x: p.x - bb.x, y: p.y - bb.y })),
        boundingBox: ann.boundingBox
          ? {
              ...ann.boundingBox,
              x: ann.boundingBox.x - bb.x,
              y: ann.boundingBox.y - bb.y,
            }
          : undefined,
      }, i, zoom)
    }
  }, [childAnnotations, bb, zoom])

  return (
    <div
      style={{
        position: 'absolute',
        left: screenX,
        top: screenY,
        width: screenW,
        height: screenH,
        zIndex: isSelected ? 65 : 60,
      }}
    >
      {/* Content area — scaled by zoom, renders at original size then scales up */}
      <div style={{
        width: bb.width,
        height: bb.height,
        transform: `scale(${zoom})`,
        transformOrigin: '0 0',
      }}>
        {annotation.generatedCode ? (
          <iframe
            srcDoc={wrapContent(annotation.generatedCode)}
            style={{
              width: bb.width,
              height: bb.height,
              border: 'none',
              borderRadius: 4,
              pointerEvents: isSelected && !isCtrlHeld && !isDragging && currentTool === 'cursor' ? 'auto' : 'none',
              background: '#fff',
              display: 'block',
            }}
            sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-same-origin"
            title={annotation.id}
          />
        ) : (
          <div style={{
            width: bb.width,
            height: bb.height,
            borderRadius: 4,
            background: '#fff',
            border: '1px dashed #d0d0d0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#aeaeb2',
            fontSize: 12,
          }}>
            输入提示词生成页面
          </div>
        )}

        {/* Child annotation overlay — clipped to rect bounds */}
        {childAnnotations.length > 0 && (
          <canvas
            ref={childCanvasRef}
            style={{
              position: 'absolute',
              inset: 0,
              width: bb.width,
              height: bb.height,
              pointerEvents: 'none',
              zIndex: 50,
              borderRadius: 4,
            }}
          />
        )}
      </div>

      {/* Selection outline — above generating overlay */}
      {isSelected && (
        <div style={{
          position: 'absolute',
          inset: 0,
          border: '2px solid #4f8cff',
          borderRadius: 4,
          pointerEvents: 'none',
          zIndex: isGenerating ? 220 : 200,
        }} />
      )}

      {/* Size badge */}
      {isSelected && (
        <div style={{
          position: 'absolute',
          bottom: -20,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 201,
          padding: '1px 6px',
          background: '#4f8cff',
          color: '#fff',
          fontSize: 10,
          fontFamily: 'monospace',
          lineHeight: '16px',
          borderRadius: 4,
          pointerEvents: 'none',
          whiteSpace: 'nowrap',
        }}>
          {Math.round(bb.width)} × {Math.round(bb.height)}
        </div>
      )}

      {/* Title bar — always visible, drag handle */}
      <div
        data-rect-control="true"
        onMouseDown={handleDragStart}
        style={{
          position: 'absolute',
          top: -29,
          left: 0,
          right: 0,
          height: 24,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          padding: '0 8px',
          cursor: isDragging ? 'grabbing' : 'grab',
          pointerEvents: 'auto',
          userSelect: 'none',
          background: isSelected
            ? 'rgba(248,248,248,0.85)'
            : 'rgba(248,248,248,0.6)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          border: isSelected
            ? '1px solid rgba(210,210,215,0.5)'
            : '1px solid rgba(210,210,215,0.3)',
          borderRadius: 8,
          zIndex: isSelected ? 62 : 61,
        }}
      >
        <span style={{
          fontSize: 11,
          color: '#1d1d1f',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {annotation.text || '画布'}
        </span>
      </div>

      {/* Resize handles */}
      {isSelected && HANDLE_EDGES.map((edge) => (
        <div
          key={edge}
          data-rect-control="true"
          style={handleStyle(edge, isGenerating)}
          onMouseDown={(e) => handleResizeStart(edge, e)}
        />
      ))}

      {/* Generating overlay */}
      {isGenerating && (
        <div style={{
          position: 'absolute',
          inset: 0,
          borderRadius: 4,
          overflow: 'hidden',
          zIndex: 210,
        }}>
          {/* Animated gradient background */}
          <Grainient
            color1={isDark ? '#4a0000' : '#f4c8c8'}
            color2={isDark ? '#0d5c1a' : '#fafbe8'}
            color3={isDark ? '#000659' : '#bad6ef'}
            timeSpeed={3.15}
            colorBalance={0}
            warpStrength={1.55}
            warpFrequency={6}
            warpSpeed={2.5}
            warpAmplitude={50}
            blendAngle={0}
            blendSoftness={0.05}
            rotationAmount={500}
            noiseScale={1.5}
            grainAmount={0.02}
            grainScale={8}
            grainAnimated={false}
            contrast={1.2}
            gamma={1}
            saturation={1}
            centerX={0}
            centerY={0}
            zoomValue={1}
          />
          {/* Foreground content */}
          <div style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
          }}>
            <span style={{
              fontSize: 13,
              color: '#202020',
              fontWeight: 700,
              letterSpacing: '0.4px',
              animation: 'text-breath 1.8s ease-in-out infinite',
            }}>
              正在生成中，请稍候...
            </span>
            {(() => {
              const latestTc = toolCalls && toolCalls.length > 0 ? toolCalls[toolCalls.length - 1] : null
              const isRunning = latestTc ? latestTc.status === 'running' : true
              const label = latestTc ? `${latestTc.toolName} ${latestTc.status === 'running' ? '执行中...' : '已完成，准备下一步...'}` : '准备中...'
              return (
                <div key={latestTc ? latestTc.toolName + latestTc.args + latestTc.status + toolCalls!.length : 'idle'} style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 11,
                  color: '#999',
                  fontFamily: 'ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace',
                  lineHeight: '20px',
                  animation: 'toolFadeIn 0.25s ease',
                }}>
                  {isRunning ? (
                    <span style={{
                      display: 'inline-block',
                      width: 10,
                      height: 10,
                      border: '2px solid rgba(79,140,255,0.25)',
                      borderTopColor: '#4f8cff',
                      borderRadius: '50%',
                      animation: 'toolSpin 0.7s linear infinite',
                      flexShrink: 0,
                    }} />
                  ) : (
                    <span style={{ color: '#30d158', fontSize: 12, flexShrink: 0 }}>✓</span>
                  )}
                  <span>{label}</span>
                </div>
              )
            })()}
            <button
              onClick={() => onCancelGenerate(annotation.id)}
              style={{
                padding: '2px 12px',
                background: 'rgba(0,0,0,0.6)',
                color: '#fff',
                border: 'none',
                borderRadius: 4,
                cursor: 'pointer',
                fontSize: 11,
                pointerEvents: 'auto',
              }}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* Error overlay */}
      {!isGenerating && generationError && (
        <div style={{
          position: 'absolute',
          inset: 0,
          borderRadius: 4,
          background: 'rgba(255,255,255,0.85)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          zIndex: 210,
          padding: 12,
        }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ff453a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span style={{ fontSize: 11, color: '#ff453a', textAlign: 'center', lineHeight: 1.4, wordBreak: 'break-all' }}>
            {generationError}
          </span>
          <button
            onClick={() => onCancelGenerate(annotation.id)}
            style={{
              padding: '2px 12px',
              background: '#ff453a',
              color: '#fff',
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: 11,
              pointerEvents: 'auto',
            }}
          >
            关闭
          </button>
        </div>
      )}
    </div>
  )
}
