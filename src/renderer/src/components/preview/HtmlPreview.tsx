// ── HTML renderer for the preview pane (PLAN-preview-pane D8;
//    PLAN-html-element-edit M1/M3) ──
// Sandboxed iframe pointed at the local-file:// protocol: scripts run, no
// same-origin (no same-origin DOM/cookie access), subresources (relative
// css/js/img) load through the protocol. Requires the CSP `frame-src
// local-file:` opened in index.html. `reloadTick` remounts the frame so an
// agent edit shows up without a manual refresh.
//
// Element-edit mode appends ?pmPreview=1 — the protocol handler serves a
// preview copy with the picker injected — and bridges the pm:* message
// protocol into htmlEditStore. Every inbound frame message is trusted only
// when `event.source === iframe.contentWindow`; the frame is opaque-origin,
// so this is the only channel it has.
//
// The footer's zoom keeps the frame's PHYSICAL width pinned to the pane and
// varies the rendering viewport it provides to the page instead: zoom z means
// the page lays out against pane/z and is painted z× smaller — the browser's
// own Ctrl+± model, which CSS `zoom` implements for an iframe directly
// (probed: inner viewport 800→1600 at zoom 0.5, the element keeps filling the
// pane). Zooming out therefore ENLARGES the viewport, so fixed-width content
// (a 960px slide deck) becomes fully visible once pane/z reaches its width —
// that is what 缩小 is for. The price is that a page wider than its viewport
// anchors left (LTR auto margins collapse on overflow); the
// measurePreviewFrame channel below re-parks the frame's own scroll at the
// middle after every zoom command so that case gets a center anchor too.

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  isFrameToParentMessage,
  type ParentToFrameMessage,
} from '../../../../shared/html-edit/messages'
import {
  registerFrameSender,
  unregisterFrameSender,
  useHtmlEditStore,
  consumeFailure,
  STALE_WRITE_TOAST_PREFIX,
  type ElementSelection,
} from '../../stores/htmlEditStore'
import { usePreviewPaneStore } from '../../stores/previewPaneStore'
import { notify } from '../../utils/notify'
import { FileInfoBar } from './FileInfoBar'
import { ZoomControls, ZOOM_STEP_FACTOR, zoomByFactor, clampZoom } from './ZoomControls'
import { localFileUrl } from '../../../shared/preview/local-file-url'

/** A per-mount secret the served picker echoes on every pm:* message (M9):
 *  the frame's page scripts share the picker's realm and event.source, so
 *  the nonce — not source-matching — is what tells their messages apart. */
function generateNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

interface Props {
  path: string
  reloadTick: number
  /** Raw disk text from PreviewContent — initializes the edit session. */
  text?: string
  elementMode?: boolean
}

export function HtmlPreview({ path, reloadTick, text, elementMode = false }: Props): React.ReactElement {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const paneRef = useRef<HTMLDivElement | null>(null)
  // Unique per mount: the main process finds THIS frame by name among the
  // renderer's child frames (the sandboxed frame's DOM is unreachable from
  // here — the name is the only handle the measure channel needs).
  const frameName = useId()
  // The zoom actually on screen — 1 until a footer command changes it, and it
  // survives a reloadTick (only the iframe remounts, this component doesn't).
  const [zoom, setZoom] = useState(1)

  // 适应宽度: the pane's width over the page's natural width — the provided
  // viewport (pane/zoom) then equals the content and nothing is cut. No
  // measurement (frame gone, still loading, page answered garbage) falls back
  // to 100%.
  const fitWidth = useCallback(() => {
    const paneWidth = paneRef.current?.clientWidth
    if (!paneWidth) return
    void window.electronAPI
      .measurePreviewFrame(frameName)
      .then((metrics) => setZoom(metrics && metrics.width > 0 ? clampZoom(paneWidth / metrics.width) : 1))
      .catch(() => setZoom(1))
  }, [frameName])

  // Every zoom command re-parks the frame's own horizontal scroll at the
  // middle of its overflow — the one centering lever that works across the
  // opaque-origin frame — so an overflowing page stays center-anchored. A
  // scroll the user made is not fought until the next command.
  const reparkCenter = useCallback((): void => {
    void window.electronAPI.measurePreviewFrame(frameName, true).catch(() => {})
  }, [frameName])
  useEffect(() => {
    reparkCenter()
  }, [zoom, reparkCenter])
  // The park rides the frame's OWN load event too: on first mount the zoom
  // effect measured about:blank (the navigation had not finished — over=0/null,
  // the park no-ops), and every reloadTick remounts the iframe with zoom and
  // frameName unchanged, so without this the docking was lost on initial load
  // AND on every agent edit (review_20261007 中8).
  // Stable per (path, elementMode) so a reload tick (key={reloadTick} remount
  // of the iframe) re-serves the SAME nonce; a different file gets a fresh one.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- generateNonce reads neither dep ON PURPOSE: the deps are the reset contract, not data
  const nonce = useMemo(() => generateNonce(), [path, elementMode])
  // 编码过的单一构造器（full_20261011 M3-P1-2）：裸拼曾让含 % 的路径吃 403、
  // 含 # 的路径读错文件（pmPreview=1 供 served 页面读 location.search）。
  const src = localFileUrl(path, elementMode ? 'pmPreview=1' : undefined)

  // M10: the nonce is registered in the MAIN process (per mount) and the
  // protocol handler stamps it into the served picker — the URL no longer
  // carries it, because the served page reads location.search. The frame is
  // held until registration lands so the serve can never race the register.
  const [registeredTick, setRegisteredTick] = useState<number | null>(null)
  useEffect(() => {
    if (!elementMode) return
    let cancelled = false
    // Optional-call + Promise.resolve: a harness stubbing electronAPI without
    // this method must not crash the pane — it just serves without a nonce
    // and the parent drops pm:* messages.
    const registered = window.electronAPI.registerPreviewNonce?.({ filePath: path, nonce })
    Promise.resolve(registered)
      .catch(() => { /* serve will carry no nonce; the parent drops pm:* */ })
      .then(() => { if (!cancelled) setRegisteredTick(reloadTick) })
    return () => { cancelled = true }
  }, [elementMode, path, nonce, reloadTick])
  const holdFrame = elementMode && registeredTick !== reloadTick

  // Keep the session alive with the disk text PreviewContent read.
  useEffect(() => {
    if (elementMode && text !== undefined) {
      useHtmlEditStore.getState().initSession(path, text)
    }
  }, [elementMode, path, text])

  useEffect(() => {
    if (!elementMode) return

    // The frame posts to window.parent; messages TO the frame go through
    // this sender, registered so store actions reach the live DOM.
    registerFrameSender(path, (msg: ParentToFrameMessage) => {
      iframeRef.current?.contentWindow?.postMessage(msg, '*')
    })

    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return
      const data: unknown = event.data
      if (!isFrameToParentMessage(data)) return
      // Nonce check (M9): a page script posting from inside the frame passes
      // the source test but not this one; the real picker stamps the value
      // the served copy carries.
      if (data.nonce !== nonce) return
      const store = useHtmlEditStore.getState()
      const session = store.sessions[path]
      switch (data.type) {
        case 'pm:ready': {
          // Editor state rides every (re)load: mode is on from injection,
          // so only restore the selection/scroll a structural edit asked for.
          const pending = store.consumePendingReselect(path)
          const frame = iframeRef.current?.contentWindow
          if (!frame) return
          if (pending) {
            if (pending.pmPath) frame.postMessage({ type: 'pm:reselect', pmPath: pending.pmPath } satisfies ParentToFrameMessage, '*')
            frame.postMessage({ type: 'pm:scroll-to', y: session?.scrollY ?? 0 } satisfies ParentToFrameMessage, '*')
          } else if (session?.scrollY) {
            frame.postMessage({ type: 'pm:scroll-to', y: session.scrollY } satisfies ParentToFrameMessage, '*')
          }
          break
        }
        case 'pm:select': {
          const selection: ElementSelection = {
            pmPath: data.pmPath,
            tag: data.tag,
            rect: data.rect,
            text: data.text,
            ancestors: data.ancestors,
            computed: data.computed,
          }
          store.select(path, selection)
          break
        }
        case 'pm:deselect':
          store.deselect(path)
          break
        case 'pm:commit-text':
          void store.commitInPlaceText(path, data.pmPath, data.html).then((ok) => {
            if (!ok) {
              const reason = consumeFailure()
              notify.error(reason)
              // Only a STALE refusal reloads (disk moved — D8's re-read takes
              // over). A plain refusal (unresolvable element) must NOT: the
              // remount would drop the selection the user just made, and an
              // in-place edit typed into the frame is reverted with it.
              if (reason.startsWith(STALE_WRITE_TOAST_PREFIX)) usePreviewPaneStore.getState().bumpReload(path)
            }
          })
          break
        case 'pm:request-edit':
          // D7 double-click: the store decides whether the element resolves
          // against the disk; enable-edit comes back only when it does.
          void store.requestInPlaceEdit(path, data.pmPath).then((ok) => {
            if (!ok) notify.error(consumeFailure())
          })
          break
        case 'pm:scroll':
          store.setScroll(path, data.y)
          break
        case 'pm:hover':
          // Hover is drawn entirely in-frame; the message exists for future
          // surfaces and is deliberately not stored.
          break
      }
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
      unregisterFrameSender(path)
    }
  }, [elementMode, path, nonce])

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div ref={paneRef} style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <iframe
          ref={iframeRef}
          name={frameName}
          key={holdFrame ? `hold-${reloadTick}` : `go-${reloadTick}`}
          src={holdFrame ? undefined : src}
          onLoad={reparkCenter}
          sandbox="allow-scripts"
          title="preview"
          style={{ display: 'block', width: '100%', height: '100%', border: 'none', background: '#fff', zoom }}
        />
      </div>
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 2, padding: '4px 12px', borderTop: '1px solid var(--pm-border-hairline)' }}>
        <FileInfoBar path={path} />
        <ZoomControls
          zoom={zoom}
          fitKey="fitWidth"
          onFit={fitWidth}
          onZoomSet={setZoom}
          onZoomOut={() => setZoom((z) => zoomByFactor(z, 1 / ZOOM_STEP_FACTOR))}
          onZoomIn={() => setZoom((z) => zoomByFactor(z, ZOOM_STEP_FACTOR))}
        />
      </div>
    </div>
  )
}


