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

import React, { useEffect, useRef } from 'react'
import {
  isFrameToParentMessage,
  type ParentToFrameMessage,
} from '../../../../shared/html-edit/messages'
import {
  registerFrameSender,
  unregisterFrameSender,
  useHtmlEditStore,
  consumeFailure,
  type ElementSelection,
} from '../../stores/htmlEditStore'

interface Props {
  path: string
  reloadTick: number
  /** Raw disk text from PreviewContent — initializes the edit session. */
  text?: string
  elementMode?: boolean
}

export function HtmlPreview({ path, reloadTick, text, elementMode = false }: Props): React.ReactElement {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const src = elementMode
    ? `local-file://${path.replace(/\\/g, '/')}?pmPreview=1`
    : `local-file://${path.replace(/\\/g, '/')}`

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
            if (!ok) toastFailure()
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
  }, [elementMode, path])

  return (
    <iframe
      ref={iframeRef}
      key={reloadTick}
      src={src}
      sandbox="allow-scripts"
      title="preview"
      style={{ display: 'block', width: '100%', height: '100%', border: 'none', background: '#fff' }}
    />
  )
}

function toastFailure(): void {
  // Lazy import avoided on purpose: the panel toasts action failures too;
  // commits arriving from the frame need the same surface here.
  void import('antd').then(({ message }) => {
    const reason = consumeFailure()
    if (reason) void message.error(reason)
  })
}
