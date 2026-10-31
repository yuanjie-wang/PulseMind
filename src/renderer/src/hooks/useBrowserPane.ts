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
//
// 沉浸窗口（2026-10-31 三面板裁定）：曾经 IS_PROJECT_WINDOW 早退——现在右卡
// 有自己的三面板（对话/浏览器/工作计划），浏览器面板在前的判定是
// secondaryLayoutStore.rightPanel（不是 workbench 的 activeTab）。viewKind 恒
// 'chat'（页签 scope 永远挂在当前会话上，切走面板只是 fold，页签不死），并随
// 状态带上卡片几何补偿（insets + paneWidth 直通）。

import { useCallback, useEffect, type RefObject } from 'react'
import { useNavigationStore } from '../stores/navigationStore'
import { useBrowserPaneStore } from '../stores/browserPaneStore'
import { useSecondaryLayoutStore } from '../stores/secondaryLayoutStore'
import { useWorkbenchStore } from '../stores/workbenchStore'
import { DRAFT_CONVERSATION_KEY } from '../stores/previewPaneStore'
import { IS_PROJECT_WINDOW } from '../popout/boot'
import {
  IMMERSIVE_BROWSER_BOTTOM_INSET,
  IMMERSIVE_BROWSER_RIGHT_INSET,
  IMMERSIVE_BROWSER_TOP_INSET,
} from '../popout/ImmersivePanels'
import { clampPaneWidth, type BrowserPaneAction } from '../../../shared/browser/pane'

/** The pane-action/pushWidth pair without the push effect — the immersive
 *  browser panel (ImmersivePanels) needs the same gestures the ChatView-bound
 *  binding returns, but must NOT run a second what-is-on-screen push. */
export function useBrowserPaneActions() {
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

  return { pushWidth, action }
}

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
  // 沉浸窗口读右卡面板态（订阅对其它窗口无害——selector 结果只在项目分支用）。
  const rightPanel = useSecondaryLayoutStore((s) => s.rightPanel)
  const immersiveCardWidth = useBrowserPaneStore((s) => s.immersiveCardWidth)
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
  // The push registers THIS window as its own pane target: the dock registry
  // is per-window (PLAN-popout-browser-pane 2026-10-31 — main + conversation
  // popouts each dock the tabs of the conversation they show), and the watch
  // guards keep one conversation in one window, so two windows' panes never
  // contend for a view.
  useEffect(() => {
    if (IS_PROJECT_WINDOW) {
      // 沉浸分支（2026-10-31）：右卡三面板，浏览器在前才 unfold；页签 scope
      // 恒挂当前会话（切面板/切会话都只是 fold + re-bind）。卡片几何随状态
      // 走：insets 把原生 view 收进卡的内容盒，paneWidth = 卡宽直通。
      void window.electronAPI.browserPaneSetState({
        viewKind: 'chat',
        conversationId: conversationId ?? null,
        chatAreaWidth,
        browserActive: rightPanel === 'browser',
        chromeOverlayHeight,
        topInset: IMMERSIVE_BROWSER_TOP_INSET,
        rightInset: IMMERSIVE_BROWSER_RIGHT_INSET,
        bottomInset: IMMERSIVE_BROWSER_BOTTOM_INSET,
        // 卡内容宽 + 3 = 卡矩形宽 + 1：让 webviewBox 的「pane−3 / +2」内缩
        // 恰好把原生 view 落进卡的内容盒（右缝 1px = 卡右边框）。
        ...(immersiveCardWidth != null ? { paneWidth: immersiveCardWidth + 3 } : {}),
      })
      return
    }
    void window.electronAPI.browserPaneSetState({
      viewKind,
      conversationId: viewKind === 'chat' ? (conversationId ?? null) : null,
      chatAreaWidth,
      browserActive: viewKind === 'chat' ? browserActive : false,
      chromeOverlayHeight,
    })
  }, [viewKind, conversationId, chatAreaWidth, browserActive, chromeOverlayHeight, rightPanel, immersiveCardWidth])

  const { pushWidth, action } = useBrowserPaneActions()

  return { chatAreaWidth, pushWidth, action }
}
