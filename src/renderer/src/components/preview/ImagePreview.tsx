// ── Image preview (PLAN-preview-pane follow-up) ── The <img> streams its bytes
//  over the local-file:// protocol (no IPC read), so this component is a
//  viewer rather than a decoder: it measures the decoded natural size once and
//  does the zoom arithmetic itself.
//
//  适应窗口 is the starting state — the whole image inside the pane, never
//  enlarged past 100% (a small icon stays its own size). − / + multiply the
//  scale and the wheel drives it continuously, so the zoom is stepless; the
//  footer reports the file the way the docx / office footers do. The wheel
//  (and a trackpad pinch) zoom here too — this pane has nothing to scroll
//  while the image is fitted, so the wheel is free to mean zoom.

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from '../../i18n/useTranslation'
import { FileInfoBar } from './FileInfoBar'
import { ZoomControls, ZOOM_STEP_FACTOR, zoomByFactor } from './ZoomControls'
import { useWheelZoom, anchoredScroll, type ZoomAnchor } from './useWheelZoom'

/** Breathing room between the image and the pane's edges. */
const PADDING = 16

export function ImagePreview({ path }: { path: string }): React.ReactElement {
  const { t } = useTranslation()
  /** The scale actually on screen — drives the percentage label. */
  const [appliedZoom, setAppliedZoom] = useState(1)
  const [failed, setFailed] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  /** The image's intrinsic size, in a ref because the zoom commands read it
   *  from event handlers — no render is owed when it arrives. */
  const naturalRef = useRef<{ width: number; height: number } | null>(null)
  /** `null` = 适应窗口 (automatic); a number = the user's manual zoom. */
  const manualZoomRef = useRef<number | null>(null)
  /** The scale on screen, readable from the stable wheel handler (the state
   *  copy below is only for the label). */
  const appliedZoomRef = useRef(1)

  const url = `local-file://${path.replace(/\\/g, '/')}`

  const applyZoom = useCallback(() => {
    const container = containerRef.current
    const img = imgRef.current
    const natural = naturalRef.current
    if (!container || !img || !natural) return
    const paneWidth = container.clientWidth - PADDING * 2
    const paneHeight = container.clientHeight - PADDING * 2
    // 适应窗口 = contain, capped at 1: a photograph shrinks until both edges
    // fit, a small icon is shown at its own size instead of blown up.
    const fitScale = Math.min(1, paneWidth / natural.width, paneHeight / natural.height)
    const scale = manualZoomRef.current ?? (fitScale > 0 ? fitScale : 1)
    img.style.width = `${Math.round(natural.width * scale)}px`
    img.style.height = 'auto'
    appliedZoomRef.current = scale
    // Guarded so a resize storm does not re-render on every observer tick.
    setAppliedZoom((prev) => (Math.abs(prev - scale) < 0.0001 ? prev : scale))
  }, [])

  const zoomBy = useCallback(
    (factor: number, anchor?: ZoomAnchor) => {
      // A ratio, not a step: the wheel and the buttons both hand one in, and
      // the current scale (manual, else the fit) is what it multiplies.
      const from = manualZoomRef.current ?? appliedZoomRef.current
      const to = zoomByFactor(from, factor)
      const container = containerRef.current
      // A pinch grows out of the pointer, so the point under it has to stay
      // put; a button click has no pointer to honour and keeps the scroll.
      const target = anchor && container ? anchoredScroll(container, anchor, from > 0 ? to / from : 1) : null
      manualZoomRef.current = to
      applyZoom()
      if (target && container) {
        container.scrollLeft = target.left
        container.scrollTop = target.top
      }
    },
    [applyZoom]
  )

  const resetZoom = useCallback(() => {
    manualZoomRef.current = null
    applyZoom()
  }, [applyZoom])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver(() => applyZoom())
    observer.observe(container)
    return () => observer.disconnect()
  }, [applyZoom])

  useWheelZoom(containerRef, zoomBy, { plainWheel: true })

  if (failed) {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#999', fontSize: 13 }}>
          {t('previewPane.loadError')}
        </div>
        <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', padding: '4px 12px', borderTop: '1px solid #f0f0f0' }}>
          <FileInfoBar path={path} />
        </div>
      </div>
    )
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div
        ref={containerRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          padding: PADDING,
          display: 'flex',
          // `safe` start-aligns instead of centering once the zoomed image
          // overflows — a plain center would put the image's left/top edge
          // past the reachable scroll area (the flex-overflow trap
          // DocxPreview meets by left-anchoring its wrapper).
          alignItems: 'safe center',
          justifyContent: 'safe center',
        }}
      >
        <img
          ref={imgRef}
          src={url}
          alt=""
          onLoad={(event) => {
            const el = event.currentTarget
            naturalRef.current = { width: el.naturalWidth, height: el.naturalHeight }
            applyZoom()
          }}
          onError={() => setFailed(true)}
          style={{
            display: 'block',
            flexShrink: 0,
            maxWidth: 'none',
            border: '1px solid #e0e0e0',
            borderRadius: 4,
          }}
        />
      </div>
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 2, padding: '4px 12px', borderTop: '1px solid #f0f0f0' }}>
        <FileInfoBar path={path} />
        <ZoomControls
          zoom={appliedZoom}
          fitKey="fitWindow"
          onFit={resetZoom}
          onZoomOut={() => zoomBy(1 / ZOOM_STEP_FACTOR)}
          onZoomIn={() => zoomBy(ZOOM_STEP_FACTOR)}
        />
      </div>
    </div>
  )
}
