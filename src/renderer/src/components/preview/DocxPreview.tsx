// ── DOCX preview (PLAN-preview-pane follow-up) ── Renders a Word document
//  in-app with docx-preview: paragraphs, runs, styles, tables, images and page
//  layout — deliberately NOT the markdown conversion (markitdown) the other
//  office formats still use, which flattens every visual property.
//
//  Bytes come over UTIL_READ_FILE_BINARY as base64 (a utf-8 read would mangle
//  the ZIP). docx-preview parses in this process and appends its own DOM +
//  <style> into the container: no global head injection, and it clears both
//  containers itself on every render.
//
//  Width follows the pane while the pane is at least MIN_SCALED_WIDTH wide;
//  below that the page keeps its scale and the pane scrolls horizontally. The
//  footer's − / + / 适应宽度 override the automatic fit, and a trackpad pinch
//  (ctrl/⌘+wheel) moves the same scale — steplessly, a ratio per event — while
//  a plain wheel still scrolls.

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { renderAsync } from 'docx-preview'
import type { FileKind } from '../../../../shared/preview/file-kind'
import { FallbackCard } from './FallbackCard'
import { FileInfoBar } from './FileInfoBar'
import { ZoomControls, MIN_ZOOM, ZOOM_STEP_FACTOR, zoomByFactor } from './ZoomControls'
import { useWheelZoom, anchoredScroll, type ZoomAnchor } from './useWheelZoom'
import { paginateDocxPages } from './docx-paginate'
import { docxFontCss } from './docx-fonts'

/** Below this pane width the document stops shrinking (it would become
 *  unreadable) and the pane scrolls horizontally instead. */
const MIN_SCALED_WIDTH = 400
/** docx-preview's own `.docx-wrapper` padding (see its renderDefaultStyle) —
 *  it scales with the zoom, so it counts toward the width the page must fit. */
const WRAPPER_PADDING = 30
/** Page + wrapper-class name handed to docx-preview (its defaults are
 *  `docx` / `docx-wrapper`; naming ours keeps the query unambiguous). */
const DOCX_CLASS = 'pm-docx'
/** How long to wait for docx-preview's own tab-stop pass (a `setTimeout` of
 *  500ms scheduled at the end of its render) before the zoom is allowed to
 *  apply — see `zoomSuspendedRef` for why it must not apply before it. */
const TAB_STOP_DELAY = 650
/** The grey docx-preview paints behind the page (its wrapper's `background:
 *  gray`), reused for the container so the two never disagree. It stays a
 *  literal on purpose (M4/T3): a mid-grey reads as neutral on both grounds,
 *  and the wrapper half is painted by docx-preview itself — overriding it for
 *  dark would fork our desk from the library's. */
const BACKDROP = '#808080'

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Images are laid out at their intrinsic size once decoded, and pagination
 *  measures heights — so wait for every not-yet-complete image first. */
function waitForImages(container: HTMLElement): Promise<void> {
  const pending = Array.from(container.querySelectorAll('img')).filter((img) => !img.complete)
  return Promise.all(
    pending.map(
      (img) =>
        new Promise<void>((resolve) => {
          img.addEventListener('load', () => resolve(), { once: true })
          img.addEventListener('error', () => resolve(), { once: true })
        })
    )
  ).then(() => undefined)
}

export function DocxPreview({
  path,
  kind,
  reloadTick,
}: {
  path: string
  kind: FileKind
  reloadTick: number
}): React.ReactElement {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  /** The scale actually on screen — drives the percentage label. */
  const [appliedZoom, setAppliedZoom] = useState(1)
  const containerRef = useRef<HTMLDivElement>(null)
  /** The page's width at zoom 1, measured once per render. 0 until measured. */
  const pageWidthRef = useRef(0)
  /** docx-preview's `experimental` tab-stop pass measures the rendered DOM with
   *  `getBoundingClientRect`, which `zoom` scales, while the pt↔px factor it
   *  compares against is measured outside the zoomed subtree — so a zoom that
   *  is already applied when that pass runs lands every tab in the wrong
   *  place. The zoom therefore stays suspended from render until the pass has
   *  fired (see TAB_STOP_DELAY). */
  const zoomSuspendedRef = useRef(false)
  /** `null` = 适应宽度 (automatic fit); a number = the user's manual zoom. */
  const manualZoomRef = useRef<number | null>(null)
  /** The scale on screen, readable from the stable wheel handler (the state
   *  copy below is only for the label). */
  const appliedZoomRef = useRef(1)

  // The single point that writes the scale. 适应宽度 fills the pane while it is
  // at least MIN_SCALED_WIDTH wide and freezes below that; a manual zoom
  // overrides it. `zoom` (not transform) because it changes layout: the
  // scrollbars and heights follow the scale, and the wrapper's own padding
  // scales with the page.
  const applyZoom = useCallback(() => {
    if (zoomSuspendedRef.current) return
    const container = containerRef.current
    const wrapper = container?.querySelector<HTMLElement>(`.${DOCX_CLASS}-wrapper`)
    if (!container || !wrapper || !pageWidthRef.current) return
    const total = pageWidthRef.current + WRAPPER_PADDING * 2
    const fitScale = Math.max(container.clientWidth, MIN_SCALED_WIDTH) / total
    const scale = manualZoomRef.current ?? fitScale
    // The wrapper's width is what carries the grey backdrop: docx-preview
    // gives it `display:flex` with an automatic width, so at a scale < 1 it
    // stays only as wide as the pane while the page overflows it, leaving the
    // area past the page's right edge bare. Pin it to the page's width so the
    // grey covers the whole scroll extent.
    wrapper.style.width = `${pageWidthRef.current}px`
    wrapper.style.zoom = String(scale)
    appliedZoomRef.current = scale
    // Guarded so a resize storm does not re-render on every observer tick.
    setAppliedZoom((prev) => (Math.abs(prev - scale) < 0.0001 ? prev : scale))
  }, [])

  // Once the pane is wide enough to show the page at 100% (plus its own scaled
  // padding), shrinking further serves nothing: the whole width is already
  // visible, and going on would only make the text smaller. Narrower panes
  // keep the global floor — there 适应宽度 already sits below 1 and the pane
  // scrolls sideways. Enlarging is never blocked, so a pane that grows while a
  // small manual scale is set does not push that scale up.
  const minZoomScale = useCallback((): number => {
    const container = containerRef.current
    const pageWidth = pageWidthRef.current
    if (!container || !pageWidth) return MIN_ZOOM
    return container.clientWidth >= pageWidth + WRAPPER_PADDING * 2 ? 1 : MIN_ZOOM
  }, [])

  const zoomBy = useCallback(
    (factor: number, anchor?: ZoomAnchor) => {
      // A ratio, not a step: the wheel and the buttons both hand one in, and
      // the current scale (manual, else the fit) is what it multiplies.
      const from = manualZoomRef.current ?? appliedZoomRef.current
      const raw = zoomByFactor(from, factor)
      // The floor is a wall the scale cannot be pushed below, not a magnet: a
      // scale that is already under it (a pane widened while a small manual
      // zoom was set) keeps obeying the gesture instead of being yanked up.
      const floor = minZoomScale()
      const to = from >= floor ? Math.max(floor, raw) : raw
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
    [applyZoom, minZoomScale]
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

  // A pinch (ctrl/⌘+wheel) zooms; the plain wheel stays a scroll, because a
  // Word document is read by scrolling — unlike the image pane, whose wheel is
  // free to mean zoom.
  useWheelZoom(containerRef, zoomBy)

  useEffect(() => {
    let alive = true
    const container = containerRef.current
    if (!container) return
    container.innerHTML = ''
    pageWidthRef.current = 0
    zoomSuspendedRef.current = true
    setState('loading')
    window.electronAPI
      .readFileBinary(path)
      .then(async (base64) => {
        if (!alive) return
        if (!base64) {
          zoomSuspendedRef.current = false
          setState('error')
          return
        }
        try {
          await renderAsync(base64ToBytes(base64), container, undefined, {
            inWrapper: true,
            breakPages: true,
            className: DOCX_CLASS,
            // docx-preview has no layout engine, so it paginates only where the
            // document says to. Word records every rendered page boundary as
            // `w:lastRenderedPageBreak`; using them restores pagination for
            // Word-saved documents (the default ignores them, merging every
            // page into one long sheet). Documents written by generators that
            // omit those hints are paginated by our own height measurement.
            ignoreLastRenderedPageBreak: false,
            // Real `w:tab` stop positions instead of the default single em
            // space — the difference is visible in tab-aligned headers and in
            // dot-leader tables of contents.
            experimental: true,
            // Images and embedded fonts become `data:` URLs instead of object
            // URLs: the renderer CSP allows `blob:` images but not `blob:`
            // fonts (`font-src 'self' data:`), and docx-preview never revokes
            // the object URLs it creates.
            useBase64URL: true,
          })
          if (!alive) return
          // The alias faces (and any embedded one) decide the glyph metrics
          // that pagination measures, so wait for them to settle first.
          await document.fonts?.ready
          if (!alive) return
          await waitForImages(container)
          if (!alive) return
          // Documents generated without pagination hints arrive as one long
          // sheet; this measures the rendered content and splits it into
          // pages. A document that already paginated (or fits one page) is
          // left untouched, so failure here must not lose the render.
          try {
            paginateDocxPages(container, DOCX_CLASS)
          } catch {
            /* keep the single-sheet render */
          }
          // Widest page wins — a document may mix orientations.
          let pageWidth = 0
          container.querySelectorAll<HTMLElement>(`section.${DOCX_CLASS}`).forEach((page) => {
            pageWidth = Math.max(pageWidth, page.getBoundingClientRect().width)
          })
          pageWidthRef.current = pageWidth
          const wrapper = container.querySelector<HTMLElement>(`.${DOCX_CLASS}-wrapper`)
          // docx-preview centers pages with flex; once a page overflows the
          // frozen-width pane that centers it past the reachable scroll area
          // (the classic flex-overflow trap). Left-anchor so 滚动 can reach
          // the whole page. In fit mode the page fills the pane exactly, so
          // this is a no-op there.
          if (wrapper) wrapper.style.alignItems = 'flex-start'
          // The tab-stop pass is a 500ms `setTimeout` scheduled when the render
          // finished, so it may already have run during the awaits above (it
          // writes an `&nbsp;` into each span it processed) — only wait for the
          // remaining cases, so a document with tabs does not sit behind a
          // 650ms delay for nothing.
          const tabStops = Array.from(container.querySelectorAll<HTMLElement>(`.${DOCX_CLASS}-tab-stop`))
          if (tabStops.some((span) => !span.innerHTML)) {
            await new Promise((resolve) => setTimeout(resolve, TAB_STOP_DELAY))
            if (!alive) return
          }
          zoomSuspendedRef.current = false
          setState('ready')
          applyZoom()
        } catch {
          zoomSuspendedRef.current = false
          if (alive) setState('error')
        }
      })
      .catch(() => {
        zoomSuspendedRef.current = false
        if (alive) setState('error')
      })
    return () => {
      alive = false
      zoomSuspendedRef.current = false
    }
  }, [path, reloadTick, applyZoom])

  if (state === 'error') return <FallbackCard path={path} kind={kind} />
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        {/* Aliases document font names (宋体/Calibri/…) to the faces macOS
            actually has. Rendered BEFORE the docx container so docx-preview's
            own <style> — which carries any embedded font — comes later and
            therefore wins for the families it defines. */}
        <style>{docxFontCss(DOCX_CLASS)}</style>
        <div
          ref={containerRef}
          className="pm-docx-preview"
          style={{ position: 'absolute', inset: 0, overflow: 'auto', background: BACKDROP }}
        />
        {state === 'loading' && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--pm-text-faint)', fontSize: 12 }}>
            …
          </div>
        )}
      </div>
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 2, padding: '4px 12px', borderTop: '1px solid var(--pm-border-hairline)' }}>
        <FileInfoBar path={path} />
        <ZoomControls
          zoom={appliedZoom}
          fitKey="fitWidth"
          onFit={resetZoom}
          onZoomOut={() => zoomBy(1 / ZOOM_STEP_FACTOR)}
          onZoomIn={() => zoomBy(ZOOM_STEP_FACTOR)}
        />
      </div>
    </div>
  )
}
