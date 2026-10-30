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
import { useWorkbenchStore } from '../stores/workbenchStore'
import { DRAFT_CONVERSATION_KEY } from '../stores/previewPaneStore'
import { IS_POPOUT, IS_PROJECT_WINDOW } from '../popout/boot'
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
  // PLAN-workbench W3: the native WebView only shows while the workbench's
  // browser tab is frontmost; other tabs fold it, tabs stay alive. Pane state
  // is per conversation, so the flag read is this conversation's own.
  const workbenchOpen = useWorkbenchStore(
    (s) => s.openByConversation[conversationId ?? DRAFT_CONVERSATION_KEY] ?? false,
  )
  const workbenchTab = useWorkbenchStore((s) => s.activeTab)
  const browserActive = workbenchOpen && workbenchTab === 'browser'
  // The address bar's suggestion dropdown overhangs the webview area — the
  // dock must shift the WebContentsView down while it is open (T3.5).
  const chromeOverlayHeight = useBrowserPaneStore((s) => s.chromeOverlayHeight)

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
  // switch, and report whether the browser tab is frontmost (W3). Runs again
  // whenever any input changes (view switch back to chat included) — this is
  // the fold/restore path, not an unmount cleanup.
  // The push is what registers this window as BrowserService's dock target
  // (a per-sender subscription). A secondary window NEVER pushes: the native
  // WebContentsView is parented by appViewDock to the MAIN window (a
  // singleton slot), so a popout- or project-window-driven state would
  // composite the live browser over the wrong window. Secondary workbenches
  // therefore never show the browser tab (tabs only arrive via this
  // subscription) — the honest gap recorded in AGENTS.md.
  useEffect(() => {
    if (IS_POPOUT || IS_PROJECT_WINDOW) return
    void window.electronAPI.browserPaneSetState({
      viewKind,
      conversationId: viewKind === 'chat' ? (conversationId ?? null) : null,
      chatAreaWidth,
      browserActive: viewKind === 'chat' ? browserActive : false,
      chromeOverlayHeight,
    })
  }, [viewKind, conversationId, chatAreaWidth, browserActive, chromeOverlayHeight])

  const pushWidth = useCallback((width: number, areaWidth: number) => {
    void window.electronAPI.browserPaneSetWidth(clampPaneWidth(width, areaWidth))
  }, [])

  const action = useCallback((a: BrowserPaneAction) => {
    window.electronAPI.browserPaneAction(a as unknown as Record<string, unknown>).catch((err) => {
      // Bad input (e.g. an unparseable host) rejects the invoke — keep it out
      // of the unhandled-rejection channel; the tab simply stays put.
      console.warn('[browser-pane] action failed:', err instanceof Error ? err.message : err)
    })
  }, [])

  return { chatAreaWidth, pushWidth, action }
}
