// ── PPTX preview (PLAN-pptx-preview) ── Renders a deck in-app as slide
//  pages, the read-side twin of DocxPreview/XlsxPreview and the honest scoped
//  renderer the plan's D5 contract defines: the SLIDESHOW appearance, with
//  charts/SmartArt/media/undecodable images as labelled placeholder boxes and
//  every skip counted in the amber notes banner.
//
//  Bytes come over UTIL_READ_FILE_BINARY (a utf-8 read would mangle the ZIP).
//  The component adapts fflate's unzipped parts to the pure model's PptxParts
//  (src/shared/preview/pptx.ts) — both fflate and the model ride dynamic
//  imports so they land in their own chunk, fetched only when a pptx preview
//  opens. Zoom follows the XlsxPreview shape: `zoom` on a wrapper, 适应宽度 =
//  min(1, pane/slide) — a wide slide only ever shrinks — with the manual
//  override and pinch through useWheelZoom.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FileKind } from '../../../../shared/preview/file-kind'
import type { PptxDeck, PptxParts, PptxParagraph, PptxShapeVM, PptxSlideVM, PptxTextFrame } from '../../../../shared/preview/pptx'
import { FallbackCard } from './FallbackCard'
import { FileInfoBar } from './FileInfoBar'
import { officeFontFaceCss } from './docx-fonts'
import { ZoomControls, MIN_ZOOM, ZOOM_STEP_FACTOR, zoomByFactor } from './ZoomControls'
import { visualCenterPaddingX } from './visual-center'
import { useWheelZoom, anchoredScroll, type ZoomAnchor } from './useWheelZoom'
import { useTranslation } from '../../i18n/useTranslation'

/** The grey page backdrop — the same paint DocxPreview uses, so the two
 *  office panes read as one family. */
/** docx-preview paints `background: gray` behind its own pages; this is the
 *  pptx desk's matching value. It stays a literal on purpose (M4/T3): a
 *  mid-grey reads as neutral on both grounds, the white slide already carries
 *  its own edge, and the docx desk must stay in lockstep with the wrapper
 *  docx-preview paints itself. */
const BACKDROP = '#808080'
/** Breathing room between the slide and the pane's edges, reserved by the fit
 *  and mirrored by the centered gutters at every zoom — one value so the fit
 *  state and the manual-zoom states read as the same desk. */
const PANE_PADDING = 16
/** Gap between slide pages, px. */
const PAGE_GAP = 16

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

// ── Text rendering (shared by shapes and table cells) ──

function Runs({ frame, run }: { frame: PptxTextFrame; run: PptxParagraph['runs'][number] }): React.ReactElement {
  const scale = frame.fontScale ?? 1
  if (run.br) return <br />
  const style: React.CSSProperties = {}
  if (run.sizePt !== undefined) style.fontSize = `${run.sizePt * scale}pt`
  if (run.bold) style.fontWeight = 'bold'
  if (run.italic) style.fontStyle = 'italic'
  if (run.underline) style.textDecoration = 'underline'
  if (run.strike) style.textDecoration = `${style.textDecoration ?? ''} line-through`.trim()
  if (run.color) style.color = run.color
  if (run.font) style.fontFamily = run.font
  if (run.link) {
    // Read-only pane: the link is shown (colour + tooltip), never navigated.
    style.color = run.color ?? '#1677ff'
    style.textDecoration = 'underline'
    return <span title={run.link} style={style}>{run.text}</span>
  }
  return <span style={style}>{run.text}</span>
}

function Paragraphs({ frame }: { frame: PptxTextFrame }): React.ReactElement {
  const scale = frame.fontScale ?? 1
  return (
    <>
      {frame.paragraphs.map((para, i) => {
        const maxPt = para.runs.reduce((m, r) => Math.max(m, r.sizePt ?? 0), 0)
        const lineHeight = para.lineSpacingPt !== undefined ? `${para.lineSpacingPt * scale}pt` : para.lineSpacing !== undefined ? para.lineSpacing : undefined
        const bulletLabel =
          para.bullet === undefined
            ? undefined
            : para.bullet.kind === 'char'
              ? para.bullet.char
              : `${para.bullet.index ?? 1}.`
        return (
          <div
            key={i}
            style={{
              textAlign: para.align ?? 'left',
              paddingLeft: para.marLeftPx,
              textIndent: para.indentPx,
              lineHeight,
              marginTop: para.spaceBeforePt !== undefined ? `${para.spaceBeforePt * scale}pt` : undefined,
              marginBottom: para.spaceAfterPt !== undefined ? `${para.spaceAfterPt * scale}pt` : undefined,
              // an empty paragraph still occupies its line in PowerPoint
              minHeight: para.runs.length === 0 && maxPt === 0 ? '1em' : undefined,
              whiteSpace: frame.wrap ? 'pre-wrap' : 'nowrap',
            }}
          >
            {bulletLabel !== undefined && (
              <span style={{ color: para.bullet?.color, marginRight: '0.25em' }}>{bulletLabel}</span>
            )}
            {para.runs.length === 0
              ? '\u00A0'
              : para.runs.map((run, r) => <Runs key={r} frame={frame} run={run} />)}
          </div>
        )
      })}
    </>
  )
}

function TextFrameView({ frame }: { frame: PptxTextFrame }): React.ReactElement {
  const justify = frame.anchor === 'middle' ? 'center' : frame.anchor === 'bottom' ? 'flex-end' : 'flex-start'
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: justify,
        padding: `${frame.insetsPx.top}px ${frame.insetsPx.right}px ${frame.insetsPx.bottom}px ${frame.insetsPx.left}px`,
        overflow: 'visible', // PowerPoint lets text overflow the box, the slide clips
        pointerEvents: 'none',
      }}
    >
      <Paragraphs frame={frame} />
    </div>
  )
}

// ── Shape rendering ──

function ShapeView({ shape, idx }: { shape: PptxShapeVM; idx: number }): React.ReactElement {
  const geometry = shape.geometry
  const boxStyle: React.CSSProperties = {
    position: 'absolute',
    left: shape.x,
    top: shape.y,
    width: shape.w,
    height: shape.h,
  }
  const transform = [
    shape.rotationDeg !== undefined ? `rotate(${shape.rotationDeg}deg)` : '',
    shape.flipH ? 'scaleX(-1)' : '',
    shape.flipV ? 'scaleY(-1)' : '',
  ]
    .filter(Boolean)
    .join(' ')
  if (transform) boxStyle.transform = transform

  if (shape.kind === 'placeholder') {
    // The model always labels its placeholders; the fallback is for types.
    const label = shape.phLabel ?? 'image'
    return (
      <div
        data-shape={idx}
        data-ph={label}
        style={{
          ...boxStyle,
          border: '1.5px dashed var(--pm-text-faint)',
          background: 'var(--pm-hover-faint)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <PlaceholderLabel kind={label} />
      </div>
    )
  }

  if (shape.kind === 'image') {
    const crop = shape.srcRect
    // Visible window = the image minus the trimmed fractions. The window is
    // STRETCHED to the frame (OOXML a:stretch semantics), so the background
    // renders at 1/horizontal × 1/vertical of the element. Degenerate
    // zero-width windows are clamped — Infinity in a CSS length helps nobody.
    const horizontal = Math.max(1 - (crop?.l ?? 0) - (crop?.r ?? 0), 0.01)
    const vertical = Math.max(1 - (crop?.t ?? 0) - (crop?.b ?? 0), 0.01)
    // background-position's percentage p aligns the p% point of the image
    // with the p% point of the container: offset = (container − image)·p.
    // Showing the window that starts at fraction l needs offset = −l·image,
    // which solves to p = l/(l+r) — NOT l/horizontal (that is only correct
    // when exactly half is trimmed, where l/(l+r) = l/(1−l−r) coincides).
    const posX = crop && crop.l + crop.r > 0 ? `${((crop.l / (crop.l + crop.r)) * 100).toFixed(4)}%` : undefined
    const posY = crop && crop.t + crop.b > 0 ? `${((crop.t / (crop.t + crop.b)) * 100).toFixed(4)}%` : undefined
    return (
      <div
        data-shape={idx}
        title={shape.alt}
        style={{
          ...boxStyle,
          borderRadius: geometry?.prst === 'ellipse' ? '50%' : geometry?.prst === 'roundRect' && geometry.radiusRatio !== undefined ? `${geometry.radiusRatio * Math.min(shape.w, shape.h)}px` : undefined,
          backgroundImage: `url("${shape.src}")`,
          backgroundSize: `${(1 / horizontal) * 100}% ${(1 / vertical) * 100}%`,
          backgroundPosition: posX !== undefined || posY !== undefined ? `${posX ?? '50%'} ${posY ?? '50%'}` : undefined,
          overflow: 'hidden',
        }}
      />
    )
  }

  if (shape.kind === 'table') {
    return (
      <div data-shape={idx} style={{ ...boxStyle, overflow: 'visible' }}>
        <TableView shape={shape} />
      </div>
    )
  }

  // shape. Line presets render as an SVG stroke across the box; everything
  // else is a filled box (clip-path for the polygon families).
  if (geometry?.isLine) {
    const w = shape.line
    return (
      <svg data-shape={idx} style={{ ...boxStyle, overflow: 'visible' }}>
        <line
          x1={shape.flipH ? shape.w : 0}
          y1={shape.flipV ? shape.h : 0}
          x2={shape.flipH ? 0 : shape.w}
          y2={shape.flipV ? 0 : shape.h}
          stroke={w?.color ?? 'transparent'}
          strokeWidth={w?.widthPx ?? 1}
          strokeDasharray={w?.dash === 'dash' ? '6 4' : w?.dash === 'dot' ? '2 3' : undefined}
        />
      </svg>
    )
  }

  const border = shape.line
    ? `${shape.line.widthPx}px ${shape.line.dash === 'dash' ? 'dashed' : shape.line.dash === 'dot' ? 'dotted' : 'solid'} ${shape.line.color}`
    : undefined
  // pie: one wedge per shape — a conic-gradient inside a round box. OOXML
  // angles run clockwise from 3 o'clock; CSS conic runs clockwise from 12,
  // so the start shifts +90°. endAngle ≤ startAngle means the wedge wrapped
  // past 12 o'clock, hence the modulo (a 0° sweep is a full circle).
  const pieSlice =
    geometry?.prst === 'pie' && shape.fill && geometry.startAngleDeg !== undefined && geometry.endAngleDeg !== undefined
      ? (() => {
          const sweep = (((geometry.endAngleDeg - geometry.startAngleDeg) % 360) + 360) % 360 || 360
          return `conic-gradient(from ${(geometry.startAngleDeg + 90) % 360}deg, ${shape.fill} 0deg ${sweep}deg, transparent ${sweep}deg 360deg)`
        })()
      : undefined
  return (
    <div
      data-shape={idx}
      style={{
        ...boxStyle,
        background: pieSlice ?? shape.fill,
        border: pieSlice ? undefined : border,
        boxSizing: 'border-box',
        borderRadius:
          geometry?.prst === 'ellipse' || pieSlice
            ? '50%'
            : geometry?.prst === 'roundRect' && geometry.radiusRatio !== undefined
              ? `${geometry.radiusRatio * Math.min(shape.w, shape.h)}px`
              : undefined,
        clipPath: geometry?.clipPath,
        overflow: 'visible',
      }}
    >
      {shape.text && <TextFrameView frame={shape.text} />}
    </div>
  )
}

function TableView({ shape }: { shape: PptxShapeVM }): React.ReactElement {
  const table = shape.table!
  return (
    <table
      style={{
        tableLayout: 'fixed',
        borderCollapse: 'collapse',
        width: table.w,
      }}
    >
      <colgroup>
        {table.colWidthsPx.map((w, i) => (
          <col key={i} style={{ width: w }} />
        ))}
      </colgroup>
      <tbody>
        {table.cells.map((row, r) => (
          <tr key={r} style={{ height: table.rowHeightsPx[r] }}>
            {row.map((cell, c) => {
              if (!cell || cell.hidden) return null
              return (
                <td
                  key={c}
                  colSpan={cell.colSpan}
                  rowSpan={cell.rowSpan}
                  style={{
                    background: cell.fill,
                    borderTop: cell.borders?.top,
                    borderRight: cell.borders?.right,
                    borderBottom: cell.borders?.bottom,
                    borderLeft: cell.borders?.left,
                    padding: '4.8px 9.6px',
                    verticalAlign: 'top',
                    fontSize: '18pt',
                    lineHeight: 1.2,
                  }}
                >
                  {cell.paragraphs.length === 0
                    ? '\u00A0'
                    : cell.paragraphs.map((para, i) => (
                        <div key={i} style={{ textAlign: para.align ?? 'left', paddingLeft: para.marLeftPx, lineHeight: para.lineSpacing, whiteSpace: 'pre-wrap' }}>
                          {para.runs.map((run, k) => {
                            const style: React.CSSProperties = {}
                            if (run.sizePt !== undefined) style.fontSize = `${run.sizePt}pt`
                            if (run.bold) style.fontWeight = 'bold'
                            if (run.italic) style.fontStyle = 'italic'
                            if (run.color) style.color = run.color
                            if (run.font) style.fontFamily = run.font
                            return (
                              <span key={k} style={style}>
                                {run.text}
                              </span>
                            )
                          })}
                        </div>
                      ))}
                </td>
              )
            })}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ── Slide page ──

function SlideView({ slide, deck }: { slide: PptxSlideVM; deck: PptxDeck }): React.ReactElement {
  return (
    <div
      data-pptx-slide={slide.index}
      style={{
        position: 'relative',
        width: deck.widthPx,
        height: deck.heightPx,
        // The slide is paper (its own background from the file, white by
        // default) and its shadow is the edge that paper carries on the grey
        // desk — both stay mode-independent (M4/T3).
        background: slide.background ?? '#FFFFFF',
        overflow: 'hidden', // the slideshow clips at the slide bounds
        marginBottom: PAGE_GAP,
        boxShadow: '0 1px 4px rgba(0, 0, 0, 0.35)',
        flexShrink: 0,
      }}
    >
      {slide.shapes.map((shape, i) => (
        <ShapeView key={i} shape={shape} idx={i} />
      ))}
    </div>
  )
}

// ── The component ──

export function PptxPreview({
  path,
  kind,
  reloadTick,
}: {
  path: string
  kind: FileKind
  reloadTick: number
}): React.ReactElement {
  const { t } = useTranslation()
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [deck, setDeck] = useState<PptxDeck | null>(null)
  const deckRef = useRef<PptxDeck | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const manualZoomRef = useRef<number | null>(null)
  const appliedZoomRef = useRef(1)
  const [appliedZoom, setAppliedZoom] = useState(1)
  /** Monotonic load epoch: a parse landing after a newer load began must not
   *  repaint a stale deck (XlsxPreview's guard). */
  const loadEpochRef = useRef(0)

  /** 适应宽度 is analytic here — the slide width is exact, not measured. A
   *  wide slide only shrinks to fit the pane, never blows past 100%. The fit
   *  reserves PANE_PADDING on BOTH edges (ImagePreview's PADDING idiom): fit
   *  against the raw clientWidth lands the slide flush against the pane's
   *  left edge with only the scrollbar strip showing grey on the right — an
   *  asymmetry the user reads as missing margins. */
  const fitScaleRef = useRef(1)
  const recomputeFit = useCallback((): number => {
    const container = containerRef.current
    const d = deckRef.current
    if (!container || !d || d.widthPx <= 0) return 1
    const available = Math.max(0, container.clientWidth - PANE_PADDING * 2)
    fitScaleRef.current = Math.min(1, Math.max(MIN_ZOOM, available / d.widthPx))
    return fitScaleRef.current
  }, [])

  const applyZoom = useCallback(() => {
    const container = containerRef.current
    const wrapper = container?.querySelector<HTMLElement>('.pm-pptx-zoom')
    if (!container || !wrapper) return
    const d = deckRef.current
    const scale = manualZoomRef.current ?? fitScaleRef.current
    wrapper.style.zoom = String(scale)
    // Horizontal centering is manual (flex-start + measured padding) — see
    // visual-center.ts for why flex centering reads lopsided under a classic
    // scrollbar. Padding on the scroller rather than a margin on the wrapper:
    // the wrapper is zoomed, its own margins would scale with it.
    const painted = d ? d.widthPx * scale : container.clientWidth
    container.style.paddingLeft = `${visualCenterPaddingX(container, painted)}px`
    appliedZoomRef.current = scale
    setAppliedZoom((prev) => (Math.abs(prev - scale) < 0.0001 ? prev : scale))
  }, [])

  const zoomTo = useCallback(
    (to: number, anchor?: ZoomAnchor) => {
      const from = appliedZoomRef.current
      const container = containerRef.current
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

  const zoomBy = useCallback(
    (factor: number, anchor?: ZoomAnchor) => {
      zoomTo(zoomByFactor(appliedZoomRef.current, factor), anchor)
    },
    [zoomTo]
  )

  const resetZoom = useCallback(() => {
    manualZoomRef.current = null
    recomputeFit()
    applyZoom()
  }, [applyZoom, recomputeFit])

  useWheelZoom(containerRef, zoomBy)

  // The fit follows the pane width (ResizeObserver) while no manual zoom is
  // set; a manual zoom pins until 适应宽度 is pressed.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver(() => {
      if (manualZoomRef.current === null) {
        recomputeFit()
        applyZoom()
      }
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [applyZoom, recomputeFit])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const epoch = ++loadEpochRef.current
    setState('loading')
    deckRef.current = null
    manualZoomRef.current = null
    window.electronAPI
      .readFileBinary(path)
      .then(async (base64) => {
        if (epoch !== loadEpochRef.current) return
        if (!base64) {
          setState('error')
          return
        }
        try {
          const { unzipSync } = await import('fflate')
          const files = unzipSync(base64ToBytes(base64))
          const parts: PptxParts = {
            entryText: (n) => (files[n] ? new TextDecoder().decode(files[n]) : undefined),
            entryBytes: (n) => files[n],
            names: () => Object.keys(files),
          }
          const { parsePptxDeck } = await import('../../../../shared/preview/pptx')
          const parsed = parsePptxDeck(parts)
          if (epoch !== loadEpochRef.current) return
          if (!parsed) {
            setState('error')
            return
          }
          deckRef.current = parsed
          setDeck(parsed)
          setState('ready')
          recomputeFit()
          applyZoom()
        } catch {
          if (epoch === loadEpochRef.current) setState('error')
        }
      })
      .catch(() => {
        if (epoch === loadEpochRef.current) setState('error')
      })
  }, [path, reloadTick, applyZoom, recomputeFit])

  const notes = useMemo(() => {
    if (!deck) return []
    const out: string[] = []
    if (deck.truncatedSlides) out.push(t('previewPane.pptxTruncatedSlides', { total: deck.totalSlides, count: deck.slides.length }))
    if (deck.slides.some((s) => s.truncatedShapes)) out.push(t('previewPane.pptxTruncatedShapes', { count: deck.shapeLimit }))
    const skipped = deck.skipped
    if (skipped.charts > 0) out.push(t('previewPane.pptxSkippedCharts', { count: skipped.charts }))
    if (skipped.smartArt > 0) out.push(t('previewPane.pptxSkippedSmartArt', { count: skipped.smartArt }))
    if (skipped.media > 0) out.push(t('previewPane.pptxSkippedMedia', { count: skipped.media }))
    if (skipped.ole > 0) out.push(t('previewPane.pptxSkippedOle', { count: skipped.ole }))
    if (skipped.badImages > 0) out.push(t('previewPane.pptxSkippedImages', { count: skipped.badImages }))
    if (skipped.unknownGeoms > 0) out.push(t('previewPane.pptxSkippedShapes', { count: skipped.unknownGeoms }))
    if (skipped.hiddenSlides > 0) out.push(t('previewPane.pptxHiddenSlides', { count: skipped.hiddenSlides }))
    out.push(t('previewPane.pptxFidelityHint'))
    return out
  }, [deck, t])

  if (state === 'error') return <FallbackCard path={path} kind={kind} />

  const defaultFontStack = deck?.defaultFont
    ? `"${deck.defaultFont}", Calibri, 微软雅黑, "PingFang SC", sans-serif`
    : 'Calibri, 微软雅黑, "PingFang SC", sans-serif'

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {notes.length > 0 && (
        <div
          style={{
            flexShrink: 0,
            padding: '4px 12px',
            fontSize: 11,
            color: 'var(--pm-warn)',
            background: 'var(--pm-warn-bg)',
            borderBottom: '1px solid var(--pm-warn-border)',
          }}
        >
          {notes.join('；')}
        </div>
      )}
      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <style>{officeFontFaceCss()}</style>
        <div
          ref={containerRef}
          className="pm-pptx-scroll"
          // Horizontal centering lives in applyZoom (padding-left there), which
          // is also what keeps it correct under a classic scrollbar — a flex
          // `justify-content: center` here would balance only inside the
          // content box and leave the scrollbar strip lopsided onto the right.
          style={{ position: 'absolute', inset: 0, overflow: 'auto', background: BACKDROP, display: 'flex' }}
        >
          {deck && (
            <div className="pm-pptx-zoom" style={{ zoom: appliedZoom, fontFamily: defaultFontStack, color: '#000' }}>
              <div style={{ paddingTop: PAGE_GAP }}>
                {deck.slides.map((slide) => (
                  <SlideView key={slide.index} slide={slide} deck={deck} />
                ))}
              </div>
            </div>
          )}
        </div>
        {state === 'loading' && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ddd', fontSize: 12, background: BACKDROP }}>
            …
          </div>
        )}
      </div>
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 2, padding: '4px 12px', borderTop: '1px solid var(--pm-border-hairline)' }}>
        <FileInfoBar path={path} />
        <ZoomControls zoom={appliedZoom} fitKey="fitWidth" onFit={resetZoom} onZoomSet={(value) => zoomTo(value)} onZoomOut={() => zoomBy(1 / ZOOM_STEP_FACTOR)} onZoomIn={() => zoomBy(ZOOM_STEP_FACTOR)} />
      </div>
    </div>
  )
}

function PlaceholderLabel({ kind }: { kind: NonNullable<PptxShapeVM['phLabel']> }): React.ReactElement {
  const { t } = useTranslation()
  const key =
    kind === 'chart'
      ? 'previewPane.pptxChartLabel'
      : kind === 'smartArt'
        ? 'previewPane.pptxSmartArtLabel'
        : kind === 'media'
          ? 'previewPane.pptxMediaLabel'
          : kind === 'ole'
            ? 'previewPane.pptxOleLabel'
            : 'previewPane.pptxImageLabel'
  return <span style={{ fontSize: 12, color: 'var(--pm-text-muted)' }}>{t(key)}</span>
}
