// ── Shared footer zoom control ── The limits and ratio arithmetic plus the
//  适应/−/%/＋ row that the docx and image previews both put in their footer.
//  Extracted on the second consumer: the state machine stays per-viewer (each
//  one measures its own content — a page's width, an image's natural size),
//  but the range, the arithmetic and the button row are the same.
//
//  The zoom is stepless: a command multiplies the current scale by a ratio
//  instead of snapping to a ladder of stops, so a fitted 56% grows to 101% and
//  42% shrinks to 23% — the pane keeps whatever scale the user has arrived at
//  rather than jumping to a value someone else picked.

import React from 'react'
import { Minus, Plus, Scaling } from 'lucide-react'
import { useTranslation } from '../../i18n/useTranslation'

/** One − / + click multiplies the scale by this much (its reciprocal shrinks). */
export const ZOOM_STEP_FACTOR = 1.8
/** The supported range. Below MIN_ZOOM a page is illegible and a photograph is
 *  a thumbnail; above MAX_ZOOM neither has detail left to show. */
export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 8

/** Clamp a scale into the supported range. */
export function clampZoom(scale: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale))
}

export const ZOOM_BUTTON: React.CSSProperties = {
  width: 22,
  height: 22,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 6,
  color: 'var(--pm-text-secondary)',
  flexShrink: 0,
  cursor: 'pointer',
}

/** Apply a zoom command: `current` times `factor`, clamped. A ratio rather
 *  than a ladder stop — the buttons pass ZOOM_STEP_FACTOR, the wheel a factor
 *  derived from the gesture, and neither quantises the scale. */
export function zoomByFactor(current: number, factor: number): number {
  return clampZoom(current * factor)
}

/** The three buttons and the percentage read-out. `fitKey` names the fit
 *  button's tooltip: a paged document fills the pane's width, an image fits
 *  inside it. */
export function ZoomControls({
  zoom,
  fitKey,
  onFit,
  onZoomIn,
  onZoomOut,
}: {
  zoom: number
  fitKey: 'fitWidth' | 'fitWindow'
  onFit: () => void
  onZoomIn: () => void
  onZoomOut: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <>
      <div style={ZOOM_BUTTON} onClick={onFit} title={t(`previewPane.${fitKey}`)}>
        <Scaling size={12} />
      </div>
      <div style={ZOOM_BUTTON} onClick={onZoomOut} title={t('previewPane.zoomOut')}>
        <Minus size={12} />
      </div>
      <div data-zoom-label style={{ minWidth: 40, textAlign: 'center', fontSize: 11, color: 'var(--pm-text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
        {Math.round(zoom * 100)}%
      </div>
      <div style={ZOOM_BUTTON} onClick={onZoomIn} title={t('previewPane.zoomIn')}>
        <Plus size={12} />
      </div>
    </>
  )
}
