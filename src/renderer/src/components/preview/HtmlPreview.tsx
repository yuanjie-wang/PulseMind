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

import React, { useEffect, useMemo, useRef } from 'react'
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
  // Stable per (path, elementMode) so a reload tick (key={reloadTick} remount
  // of the iframe) re-serves the SAME nonce; a different file gets a fresh one.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- generateNonce reads neither dep ON PURPOSE: the deps are the reset contract, not data
  const nonce = useMemo(() => generateNonce(), [path, elementMode])
  const src = elementMode
    ? `local-file://${path.replace(/\\/g, '/')}?pmPreview=1&pmNonce=${nonce}`
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
              void toastFailure(reason)
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
            if (!ok) void toastFailure(consumeFailure())
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

async function toastFailure(reason: string): Promise<void> {
  // Lazy import avoided on purpose: the panel toasts action failures too;
  // commits arriving from the frame need the same surface here.
  if (!reason) return
  void import('antd').then(({ message }) => {
    void message.error(reason)
  })
}
