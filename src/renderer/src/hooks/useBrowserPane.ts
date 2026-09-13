// ── Browser pane binding (A-M5) ──
// The chat view's side of the pane contract: pushes "what is on screen"
// (view kind + conversation + measured chat width) so BrowserService can
// show/fold the native WebView. ChatView stays mounted while other views are
// active (display:none), so the view-kind effect is what folds the pane on
// panel switches and restores it on return.
//
// Live pane state and the measured chat width live in
// stores/browserPaneStore (zustand) — deliberately not in React state here:
// this hook must stay free of refs and of setState-in-effect patterns the
// react-hooks rules flag.

import { useCallback, useEffect, type RefObject } from 'react'
import { useNavigationStore } from '../stores/navigationStore'
import { useBrowserPaneStore } from '../stores/browserPaneStore'
import { clampPaneWidth, type BrowserPaneAction } from '../../../shared/browser/pane'

export function useBrowserPaneBinding(
  conversationId: string | undefined,
  /** The chat root element, measured for pane clamping. Owned by the caller
   *  (created with useRef there and passed to ref=) — this hook only reads
   *  it inside effects. */
  rootRef: RefObject<HTMLDivElement | null>,
) {
  const viewKind = useNavigationStore((s) => s.view.kind)
  const chatAreaWidth = useBrowserPaneStore((s) => s.chatAreaWidth)

  // Measure the chat column — main clamps the pane against it (min 320,
  // max 60%). Observer callback reports through the external store, so no
  // React setState is involved.
  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth
      if (w > 0) useBrowserPaneStore.getState().setChatAreaWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [rootRef])

  // What-is-on-screen push: fold on non-chat views, re-bind on conversation
  // switch. Runs again whenever any input changes (view switch back to chat
  // included) — this is the fold/restore path, not an unmount cleanup.
  useEffect(() => {
    void window.electronAPI.browserPaneSetState({
      viewKind,
      conversationId: viewKind === 'chat' ? (conversationId ?? null) : null,
      chatAreaWidth,
    })
  }, [viewKind, conversationId, chatAreaWidth])

  const pushWidth = useCallback((width: number, areaWidth: number) => {
    void window.electronAPI.browserPaneSetWidth(clampPaneWidth(width, areaWidth))
  }, [])

  const action = useCallback((a: BrowserPaneAction) => {
    void window.electronAPI.browserPaneAction(a as unknown as Record<string, unknown>)
  }, [])

  return { chatAreaWidth, pushWidth, action }
}
