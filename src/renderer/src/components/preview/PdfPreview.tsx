// ── PDF preview (PLAN-pdf-preview) ── renders in-app with pdfjs-dist, the
// third office format to escape the markitdown raw-text path (after docx and
// xlsx). Pages raster to <canvas> with the backing store sized at
// zoom × devicePixelRatio (crisp at every scale), and render lazily: only the
// visible band plus PDF_RENDER_BUFFER_PAGES hold canvases — placeholder boxes
// sized from each page's scale-1 viewport keep the scrollbar honest from the
// moment the file opens. Zoom rides the shared ZoomControls; canvases
// re-render on a short debounce so a wheel gesture does not queue hundreds of
// render tasks.
//
// The load identity is a React KEY, not an effect: `PdfPreview` remounts
// `PdfDocument` whenever the path or the reload tick changes, so every load
// starts from fresh useState initialisers and the effect body only kicks off
// async work — no synchronous state resets, and a stale parse is impossible
// (the stale instance is gone before it could land one).
//
// Honesty rules, the read-side twin of the office-editing posture:
//   · raster only — text is not selectable here; the conversion the `read`
//     tool uses remains the way to get a PDF's text out;
//   · embedded fonts render fully, non-embedded standard-14 fonts ride the
//     system fonts; non-embedded CJK CID encodings (cMap-dependent) may fall
//     back — the packaged file:// page cannot fetch pdf.js's asset
//     directories, so cMapUrl/standardFontDataUrl are deliberately not wired;
//   · encrypted PDFs land on their own card (never a blank pane), oversized
//     files never cross the bridge at all, and documents beyond
//     PDF_PREVIEW_MAX_PAGES pages truncate with an amber note.
//
// pdfjs-dist loads through a dynamic import (the exceljs chunk pattern —
// do not hoist it, the ~1.5MB belongs to its own chunk). The worker is a
// Vite ?url asset; where the environment refuses module workers (the
// packaged file:// page under this app's CSP) pdf.js falls back to its
// in-thread fake worker on its own. `isEvalSupported: false` keeps the font
// machinery inside the CSP's script-src.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import type { FileKind } from '../../../../shared/preview/file-kind'
import {
  base64Bytes,
  currentPageIndex,
  isPdfPasswordError,
  pdfFitScale,
  pdfLayout,
  pdfPageWindow,
  PDF_MAX_BYTES,
  PDF_PAGE_GAP,
  PDF_PREVIEW_MAX_PAGES,
  PDF_RENDER_BUFFER_PAGES,
  type PdfPageSize,
  type PdfPageWindow,
} from '../../../../shared/preview/pdf'
import { formatFileSize } from '../../../../shared/file-size'
import { FallbackCard } from './FallbackCard'
import { FileInfoBar } from './FileInfoBar'
import { ZoomControls, MIN_ZOOM, ZOOM_BUTTON, ZOOM_STEP_FACTOR, clampZoom } from './ZoomControls'
import { useWheelZoom, anchoredScroll, type ZoomAnchor } from './useWheelZoom'
import { useTranslation } from '../../i18n/useTranslation'

type PdfStatus = 'loading' | 'ready' | 'error' | 'encrypted' | 'oversized'

/** One page's raster. Backing store at zoom × DPR (1:1 with display pixels),
 *  CSS size 100% of the placeholder box. Re-runs when the settled zoom
 *  changes; the render task is cancelled on unmount/retune. */
function PageCanvas({
  doc,
  index,
  zoom,
}: {
  doc: PDFDocumentProxy
  index: number
  zoom: number
}): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    let cancelled = false
    let task: RenderTask | null = null
    const dpr = window.devicePixelRatio || 1
    doc.getPage(index + 1)
      .then((page) => {
        if (cancelled) return
        const canvas = canvasRef.current
        if (!canvas) return
        const viewport = page.getViewport({ scale: zoom * dpr })
        canvas.width = Math.max(1, Math.floor(viewport.width))
        canvas.height = Math.max(1, Math.floor(viewport.height))
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        task = page.render({ canvasContext: ctx, viewport })
        return task.promise
      })
      .catch((err) => {
        // pdf.js paints the page white itself; a render that dies here leaves
        // the grey backdrop visible through the transparent canvas — never
        // re-hide that behind a silent catch (the blank-page bug hid here).
        if (!cancelled) console.warn('[PdfPreview] page render failed', err)
      })
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [doc, index, zoom])
  return <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
}

const PAGE_NOTE_STYLE: React.CSSProperties = {
  flexShrink: 0,
  padding: '4px 12px',
  fontSize: 11,
  color: 'var(--pm-warn)',
  background: 'var(--pm-warn-bg)',
  borderBottom: '1px solid var(--pm-warn-border)',
}

export function PdfPreview({
  path,
  kind,
  reloadTick,
}: {
  path: string
  kind: FileKind
  reloadTick: number
}): React.ReactElement {
  // The remount key IS the load identity: a path change or a toolbar refresh
  // throws the parsed document, the scroll position and every in-flight page
  // render away in one move.
  return <PdfDocument key={`${path}:${reloadTick}`} path={path} kind={kind} />
}

function PdfDocument({ path, kind }: { path: string; kind: FileKind }): React.ReactElement {
  const { t } = useTranslation()
  const [status, setStatus] = useState<PdfStatus>('loading')
  /** Scale-1 viewports of the first PDF_PREVIEW_MAX_PAGES pages (the only
   *  ones that get placeholders). The real page count lives separately so
   *  the page bar can say "1 / 412" over a capped document. */
  const [pages, setPages] = useState<PdfPageSize[] | null>(null)
  const [totalPages, setTotalPages] = useState(0)
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const taskRef = useRef<PDFDocumentLoadingTask | null>(null)
  const [zoom, setZoom] = useState(1)
  const zoomRef = useRef(1)
  /** The settled zoom the canvases render at — placeholders and the read-out
   *  move with every wheel tick, canvases re-render 120ms after it stops. */
  const [renderZoom, setRenderZoom] = useState(1)
  const containerRef = useRef<HTMLDivElement>(null)
  const [win, setWin] = useState<PdfPageWindow>({ first: 0, last: -1 })
  const [current, setCurrent] = useState(1)
  /** Draft of the page-input while typed; null shows the live page number. */
  const [jumpDraft, setJumpDraft] = useState<string | null>(null)
  const scrollRafRef = useRef<number | null>(null)
  /** Scroll offsets captured from a zoom anchor, applied once the layout at
   *  the new zoom has committed (the xlsx imperative-zoom equivalent). */
  const pendingScrollRef = useRef<{ left: number; top: number } | null>(null)

  const layout = useMemo(() => (pages ? pdfLayout(pages, zoom) : []), [pages, zoom])
  const truncated = totalPages > PDF_PREVIEW_MAX_PAGES

  useEffect(() => {
    let stale = false
    void (async () => {
      const base64 = await window.electronAPI.readFileBinary(path).catch(() => null)
      if (stale) return
      if (!base64) {
        setStatus('error')
        return
      }
      // The byte gate fires on the base64 string — an oversized file never
      // materialises as bytes at all.
      if (base64Bytes(base64) > PDF_MAX_BYTES) {
        setStatus('oversized')
        return
      }
      try {
        const bin = atob(base64)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        const pdfjs = await import('pdfjs-dist')
        const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default
        const task = pdfjs.getDocument({ data: bytes, isEvalSupported: false })
        taskRef.current = task
        const loaded = await task.promise
        if (stale) {
          void loaded.destroy()
          return
        }
        const metas: PdfPageSize[] = []
        for (let i = 1; i <= Math.min(loaded.numPages, PDF_PREVIEW_MAX_PAGES); i++) {
          const page = await loaded.getPage(i)
          const viewport = page.getViewport({ scale: 1 })
          metas.push({ width: viewport.width, height: viewport.height })
          if (stale) {
            void loaded.destroy()
            return
          }
        }
        setDoc(loaded)
        setPages(metas)
        setTotalPages(loaded.numPages)
        setStatus('ready')
        const fit = pdfFitScale(containerRef.current?.clientWidth ?? 0, metas.map((m) => m.width), MIN_ZOOM)
        zoomRef.current = fit
        setZoom(fit)
        setRenderZoom(fit)
      } catch (err) {
        if (stale) return
        if (!isPdfPasswordError(err)) console.warn('[PdfPreview] failed to load', path, err)
        setStatus(isPdfPasswordError(err) ? 'encrypted' : 'error')
      }
    })()
    return () => {
      stale = true
      // Destroys the worker and the parsed doc with it; in-flight PageCanvas
      // render tasks were already cancelled by their own cleanups (React
      // cleans children first).
      void taskRef.current?.destroy()
      taskRef.current = null
    }
  }, [path])

  const syncViewport = useCallback(() => {
    const container = containerRef.current
    if (!container || layout.length === 0) return
    setWin(pdfPageWindow(layout, container.scrollTop, container.clientHeight, PDF_RENDER_BUFFER_PAGES))
    setCurrent(currentPageIndex(layout, container.scrollTop, container.clientHeight) + 1)
  }, [layout])

  const scheduleSync = useCallback(() => {
    if (scrollRafRef.current !== null) return
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null
      syncViewport()
    })
  }, [syncViewport])

  const onScroll = useCallback(() => scheduleSync(), [scheduleSync])

  useEffect(
    () => () => {
      // Null the handle after cancelling: StrictMode's simulated unmount runs
      // this between the two mount passes, and a stale non-null handle here
      // would block scheduleSync forever (pages parse fine, canvases never
      // mount — the blank-pages-with-correct-count report).
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current)
        scrollRafRef.current = null
      }
    },
    []
  )

  // After every layout commit (load, zoom): apply a captured zoom anchor,
  // then re-decide the render window on the next frame.
  useLayoutEffect(() => {
    const container = containerRef.current
    const pending = pendingScrollRef.current
    pendingScrollRef.current = null
    if (container && pending) {
      container.scrollLeft = pending.left
      container.scrollTop = pending.top
    }
    scheduleSync()
  }, [scheduleSync])

  // The pane can mount at zero size (opening while its container is still
  // laying out) — the one-shot sync above would then compute an empty render
  // window and every page would stay a white placeholder forever. The
  // observer re-syncs when the box becomes real, and on pane resizes.
  useEffect(() => {
    const container = containerRef.current
    if (!container || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => scheduleSync())
    observer.observe(container)
    return () => observer.disconnect()
  }, [scheduleSync])

  const zoomTo = useCallback((to: number, anchor?: ZoomAnchor) => {
    const container = containerRef.current
    const clamped = clampZoom(to)
    if (container && anchor) {
      const from = zoomRef.current
      pendingScrollRef.current = anchoredScroll(container, anchor, from > 0 ? clamped / from : 1)
    }
    zoomRef.current = clamped
    setZoom(clamped)
  }, [])

  const zoomBy = useCallback((factor: number, anchor?: ZoomAnchor) => zoomTo(zoomRef.current * factor, anchor), [zoomTo])

  const fitZoom = useCallback(() => {
    const container = containerRef.current
    if (!container || !pages) return
    zoomTo(pdfFitScale(container.clientWidth, pages.map((p) => p.width), MIN_ZOOM))
  }, [pages, zoomTo])

  useWheelZoom(containerRef, zoomBy)

  useEffect(() => {
    const timer = setTimeout(() => setRenderZoom(zoom), 120)
    return () => clearTimeout(timer)
  }, [zoom])

  const goToPage = useCallback(
    (page: number) => {
      const container = containerRef.current
      const entry = layout[Math.min(Math.max(1, page), Math.min(totalPages, PDF_PREVIEW_MAX_PAGES)) - 1]
      if (!container || !entry) return
      container.scrollTop = entry.top
      syncViewport()
    },
    [layout, totalPages, syncViewport]
  )

  if (status === 'error') return <FallbackCard path={path} kind={kind} />
  if (status === 'encrypted') return <FallbackCard path={path} kind={kind} hint={t('previewPane.pdfEncrypted')} />
  if (status === 'oversized') {
    return <FallbackCard path={path} kind={kind} hint={t('previewPane.pdfOversized', { size: formatFileSize(PDF_MAX_BYTES) })} />
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {truncated && status === 'ready' && (
        <div style={PAGE_NOTE_STYLE}>{t('previewPane.pdfTruncatedPages', { total: totalPages, count: PDF_PREVIEW_MAX_PAGES })}</div>
      )}
      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <div
          ref={containerRef}
          data-pdf-scroll
          onScroll={onScroll}
          style={{ position: 'absolute', inset: 0, overflow: 'auto', background: 'var(--pm-desk)' }}
        >
          {pages && doc && (
            <div data-pdf-doc style={{ width: 'fit-content', margin: '0 auto', padding: PDF_PAGE_GAP }}>
              {layout.map((box, i) => {
                const inWindow = i >= win.first && i <= win.last
                return (
                  <div
                    key={i}
                    data-pdf-page={i + 1}
                    style={{
                      width: box.width,
                      height: box.height,
                      marginBottom: PDF_PAGE_GAP,
                      // The page itself is paper (the document's face): white
                      // in both modes. What follows it is the edge — the desk
                      // darkens and the shadow deepens so the white sheet
                      // still reads as a sheet (M4/T1).
                      background: '#fff',
                      boxShadow: 'var(--pm-shadow-page)',
                      position: 'relative',
                    }}
                  >
                    {inWindow && <PageCanvas doc={doc} index={i} zoom={renderZoom} />}
                  </div>
                )
              })}
            </div>
          )}
        </div>
        {status === 'loading' && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--pm-text-faint)', fontSize: 12, background: 'var(--pm-bg)' }}>…</div>
        )}
      </div>
      {pages && pages.length > 0 && (
        <div
          data-pdf-pagebar
          style={{
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            padding: '3px 8px',
            borderTop: '1px solid var(--pm-separator-faint)',
          }}
        >
          <div style={ZOOM_BUTTON} title={t('previewPane.pdfPrevPage')} onClick={() => goToPage(current - 1)}>
            <ChevronLeft size={12} />
          </div>
          <input
            data-pdf-page-input
            value={jumpDraft ?? String(current)}
            title={t('previewPane.pdfPageInput')}
            onChange={(e) => setJumpDraft(e.target.value.replace(/[^0-9]/g, ''))}
            onBlur={() => setJumpDraft(null)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                if (jumpDraft !== null && jumpDraft !== '') goToPage(parseInt(jumpDraft, 10))
                setJumpDraft(null)
              }
            }}
            style={{
              width: 36,
              textAlign: 'center',
              fontSize: 11,
              color: 'var(--pm-text-strong)',
              border: '1px solid var(--pm-input-border)',
              borderRadius: 4,
              padding: '1px 2px',
              outline: 'none',
              fontVariantNumeric: 'tabular-nums',
            }}
          />
          <span style={{ fontSize: 11, color: 'var(--pm-text-secondary)', fontVariantNumeric: 'tabular-nums' }}>/ {totalPages}</span>
          <div style={ZOOM_BUTTON} title={t('previewPane.pdfNextPage')} onClick={() => goToPage(current + 1)}>
            <ChevronRight size={12} />
          </div>
        </div>
      )}
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 2, padding: '4px 12px', borderTop: '1px solid var(--pm-border-hairline)' }}>
        <FileInfoBar path={path} />
        <span style={{ flex: 1 }} />
        <ZoomControls zoom={zoom} fitKey="fitWidth" onFit={fitZoom} onZoomOut={() => zoomBy(1 / ZOOM_STEP_FACTOR)} onZoomIn={() => zoomBy(ZOOM_STEP_FACTOR)} />
      </div>
    </div>
  )
}
