import React, { useState, useRef, useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ThunderboltOutlined } from '@ant-design/icons'
import { useCanvasStore } from '../../stores/canvasStore'

interface RegionConfigProps {
  annotationId: string
  isSelected: boolean
  zoom: number
  panX: number
  panY: number
  onGenerate: (id: string, prompt: string, contentType: string) => void
  onCancel: (id: string) => void
}

const CONTENT_TYPES = [
  { key: 'phoneApp', width: 375, height: 812 },
  { key: 'tabletApp', width: 768, height: 1024 },
  { key: 'web', width: 1440, height: 900 },
  { key: 'free', width: null as unknown as number, height: null as unknown as number },
]

export default function RegionConfig({ annotationId, isSelected, zoom, panX, panY, onGenerate, onCancel }: RegionConfigProps) {
  const annotation = useCanvasStore((s) => s.annotations.find((a) => a.id === annotationId))
  const childAnnotations = useCanvasStore(useShallow((s) => s.annotations.filter((a) => a.parentId === annotationId)))
  const generatingIds = useCanvasStore((s) => s.generatingAnnotationIds)
  const isBusy = generatingIds.includes(annotationId)
  const [prompt, setPrompt] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const wasBusyRef = useRef(isBusy)

  // Clear prompt when generation completes
  useEffect(() => {
    if (wasBusyRef.current && !isBusy) {
      setPrompt('')
    }
    wasBusyRef.current = isBusy
  }, [isBusy])

  if (!annotation || !annotation.boundingBox) return null

  const b = annotation.boundingBox
  const vp = {
    x: b.x * zoom + panX,
    y: b.y * zoom + panY,
    width: b.width * zoom,
    height: b.height * zoom,
  }

  const canGenerate = prompt.trim().length > 0 || childAnnotations.length > 0

  const handleContentTypeClick = (type: typeof CONTENT_TYPES[number]) => {
    if (type.key === 'free') return
    if (type.width && type.height) {
      const cx = b.x + b.width / 2
      const cy = b.y + b.height / 2
      useCanvasStore.getState().updateAnnotationBounds(annotationId, {
        x: cx - type.width / 2,
        y: cy - type.height / 2,
        width: type.width,
        height: type.height,
      })
    }
  }

  const currentType = annotation?.boundingBox
    ? (CONTENT_TYPES.find(
        (t) => t.key !== 'free' && t.width === annotation.boundingBox!.width && t.height === annotation.boundingBox!.height,
      )?.key ?? 'free')
    : 'free'

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onCancel(annotationId)
    } else if (e.key === 'Enter' && !e.shiftKey && !isBusy && canGenerate && !e.nativeEvent.isComposing) {
      e.preventDefault()
      onGenerate(annotationId, prompt, currentType === 'free' ? 'web' : currentType)
    }
  }

  return (
    <>
      {/* Config panel — right side of rect */}
      {isSelected && (
        <div
          data-rect-control="true"
          style={{
            position: 'absolute',
            left: vp.x + vp.width + 8,
            top: vp.y + vp.height / 2,
            transform: 'translateY(-50%)',
            zIndex: 510,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            background: '#f8f8f8',
            border: '1px solid #d2d2d7',
            borderRadius: 10,
            padding: '10px 12px',
            boxShadow: '0 4px 20px rgba(0,0,0,0.12)',
            minWidth: 260,
            maxWidth: '85%',
          }}
        >
          {/* Content type */}
          <div>
            <div style={{
              fontSize: 10,
              fontWeight: 600,
              color: '#aeaeb2',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              marginBottom: 6,
            }}>
              尺寸
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              {CONTENT_TYPES.map((ct) => {
                const active = currentType === ct.key
                return (
                  <button
                    key={ct.key}
                    onClick={() => handleContentTypeClick(ct)}
                    style={{
                      flex: 1,
                      border: 'none',
                      borderRadius: 6,
                      padding: '5px 6px',
                      fontSize: 11,
                      fontWeight: active ? 600 : 400,
                      color: active ? '#fff' : '#6e6e73',
                      background: active ? '#4f8cff' : 'rgba(248,248,248,0.5)',
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                      fontFamily: 'inherit',
                    }}
                  >
                    {ct.key === 'phoneApp' ? '手机' : ct.key === 'tabletApp' ? '平板' : ct.key === 'web' ? '网页' : '自由'}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Prompt */}
          <div>
            <div style={{
              fontSize: 10,
              fontWeight: 600,
              color: '#aeaeb2',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              marginBottom: 6,
            }}>
              提示词
            </div>

            {/* Annotation bubbles */}
            {childAnnotations.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
                {childAnnotations.map((ca, idx) => (
                  <div
                    key={ca.id}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '2px 6px',
                      background: 'rgba(79,140,255,0.12)',
                      border: '1px solid rgba(79,140,255,0.25)',
                      borderRadius: 6,
                      fontSize: 11,
                      color: '#4f8cff',
                      maxWidth: 180,
                    }}
                  >
                    <span style={{ flex: 1, textAlign: 'center' }}>
                      {idx + 1}
                    </span>
                    <button
                      onClick={() => useCanvasStore.getState().removeAnnotation(ca.id)}
                      style={{
                        width: 14,
                        height: 14,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        border: 'none',
                        borderRadius: '50%',
                        background: 'transparent',
                        color: '#4f8cff',
                        cursor: 'pointer',
                        fontSize: 10,
                        lineHeight: 1,
                        padding: 0,
                        flexShrink: 0,
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6 }}>
              <textarea
                ref={inputRef}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={annotation?.generatedCode ? '输入新提示词修改页面...' : '输入提示词，描述你想生成的页面...'}
                disabled={isBusy}
                rows={3}
                style={{
                  flex: 1,
                  border: '1px solid rgba(210,210,215,0.5)',
                  outline: 'none',
                  borderRadius: 6,
                  padding: '6px 8px',
                  background: isBusy ? 'rgba(248,248,248,0.2)' : 'rgba(248,248,248,0.1)',
                  fontSize: 13,
                  color: isBusy ? '#aeaeb2' : '#1d1d1f',
                  fontFamily: 'inherit',
                  resize: 'both',
                  lineHeight: 1.5,
                }}
              />
              {isBusy ? (
                <button
                  onClick={() => onCancel(annotationId)}
                  title="取消"
                  style={{
                    width: 30,
                    height: 30,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    border: 'none',
                    borderRadius: 6,
                    background: 'rgba(255,69,58,0.15)',
                    color: '#ff453a',
                    cursor: 'pointer',
                    flexShrink: 0,
                  }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              ) : (
                <button
                  onClick={() => canGenerate && onGenerate(annotationId, prompt, currentType === 'free' ? 'web' : currentType)}
                  disabled={!canGenerate}
                  title="生成"
                  style={{
                    width: 30,
                    height: 30,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    border: 'none',
                    borderRadius: 6,
                    background: canGenerate ? '#4f8cff' : 'rgba(248,248,248,0.5)',
                    color: canGenerate ? '#fff' : '#aeaeb2',
                    cursor: canGenerate ? 'pointer' : 'not-allowed',
                    flexShrink: 0,
                  }}
                >
                  <ThunderboltOutlined style={{fontSize:14}} />
                </button>
              )}
            </div>
          </div>

          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: 11,
            color: '#aeaeb2',
            userSelect: 'none',
          }}>
            <span>Shift + Enter 换行</span>
          </div>
        </div>
      )}
    </>
  )
}
