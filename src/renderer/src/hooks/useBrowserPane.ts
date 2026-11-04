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
import { useWorkbenchStore, useConversationPrimary } from '../stores/workbenchStore'
import { DRAFT_CONVERSATION_KEY } from '../stores/previewPaneStore'
import { IS_PROJECT_WINDOW } from '../popout/boot'
import {
  WORKBENCH_CARD_BOTTOM_INSET,
  WORKBENCH_CARD_MARGIN,
  WORKBENCH_CARD_RIGHT_INSET,
  WORKBENCH_CARD_TOP_INSET,
  PRIMARY_PANE_CHROME_HEIGHT,
} from '../../../shared/browser/pane'
import { IMMERSIVE_BROWSER_BOTTOM_INSET, IMMERSIVE_BROWSER_RIGHT_INSET, IMMERSIVE_BROWSER_TOP_INSET } from '../popout/ImmersivePanels'
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
  /** 主窗卡片形态（ChatView 的 card prop 直通）：工作台是圆角卡，浏览器 tab
   *  在前时原生 view 要收进卡的内容盒——推送随状态携带
   *  WORKBENCH_CARD_*_INSET 三补偿。主窗 App.tsx 与会话弹出窗口 PopoutApp
   *  都传 true（2026-11-04 两窗统一）；缺省 false = 项目沉浸窗口的贴边 dock
   *  几何逐字节不变。 */
  cardMode = false,
) {
  const viewKind = useNavigationStore((s) => s.view.kind)
  const chatAreaWidth = useBrowserPaneStore((s) => s.chatAreaWidth)
  // PLAN-workbench W3: the native WebView only shows while the workbench's
  // browser tab is frontmost; other tabs fold it, tabs stay alive. Pane state
  // is per conversation, so the flag read is this conversation's own.
  // 沉浸窗口读右卡面板态（订阅对其它窗口无害——selector 结果只在项目分支用）。
  const rightPanel = useSecondaryLayoutStore((s) => s.rightPanel)
  const immersiveCardWidth = useBrowserPaneStore((s) => s.immersiveCardWidth)
  const workbenchOpen = useWorkbenchStore((s) => s.openByConversation[conversationId ?? DRAFT_CONVERSATION_KEY] ?? false)
  const workbenchTab = useWorkbenchStore((s) => s.activeTab)
  // 视图模式（PLAN-layout-modes）：浏览器主视图时浏览器恒在前（它就是主卡），
  // 侧栏集合里没有浏览器 tab，workbenchTab 判定不适用。
  const primary = useConversationPrimary(conversationId ?? DRAFT_CONVERSATION_KEY)
  const workbenchWidth = useWorkbenchStore((s) => s.width)
  const primaryPaneWidth = useBrowserPaneStore((s) => s.primaryPaneWidth)
  // 浮窗让位（十三期）：useFloatOverlayShift 量出的左右内收 px。
  const floatOverlay = useBrowserPaneStore((s) => s.floatOverlay)
  const browserPrimary = primary === 'browser'
  const browserActive = browserPrimary || (workbenchOpen && workbenchTab === 'browser')
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
    if (browserPrimary) {
      // 浏览器主视图（PLAN-layout-modes 2026-11-03）：原生 view 收进主卡内容
      // 盒。几何全部经现有字段表达——dock 的右锚公式 x = w − width −
      // rightInset + 2 配 paneWidth 直通（内容宽 + 3，沉浸卡同款算术）与
      // rightInset = reserve + 卡边距 5 时，落点恰好是主卡内容盒
      // （contentW = w − reserve − 12 → x = 卡左边框内 6、右缘 = 内容右缘）。
      // chromeHeight=68：主卡没有工作台页签条，pane 页签条 32 + 地址行 36。
      // 卡片 insets 只在 cardMode 生效：主窗与会话弹出窗口都套卡（2026-11-04
      // 两窗统一），项目沉浸窗口走上面的沉浸分支；仍有宿主不套卡，此时
      // insets 必须缺席，否则原生 view 落位偏 5-6px 且右边多留一条缝。
      const reserve = workbenchOpen ? clampPaneWidth(workbenchWidth, chatAreaWidth) + (cardMode ? WORKBENCH_CARD_MARGIN : 0) : 0
      void window.electronAPI.browserPaneSetState({
        viewKind,
        conversationId: viewKind === 'chat' ? (conversationId ?? null) : null,
        chatAreaWidth,
        browserActive: viewKind === 'chat',
        chromeOverlayHeight,
        ...(cardMode ? { topInset: WORKBENCH_CARD_TOP_INSET, bottomInset: WORKBENCH_CARD_BOTTOM_INSET } : {}),
        rightInset: reserve + (cardMode ? WORKBENCH_CARD_MARGIN : 0),
        ...(primaryPaneWidth != null ? { paneWidth: primaryPaneWidth + 3 } : {}),
        chromeHeight: PRIMARY_PANE_CHROME_HEIGHT,
        leftOverlay: floatOverlay.left,
        rightOverlay: floatOverlay.right,
      })
      return
    }
    void window.electronAPI.browserPaneSetState({
      viewKind,
      conversationId: viewKind === 'chat' ? (conversationId ?? null) : null,
      chatAreaWidth,
      browserActive: viewKind === 'chat' ? browserActive : false,
      chromeOverlayHeight,
      // 卡片形态：原生 view 收进工作台卡的内容盒（沉浸分支同款补偿，常量在
      // shared/browser/pane——右缘不含边框，由 webviewBox 自身内缩吸收）。
      ...(cardMode
        ? {
            topInset: WORKBENCH_CARD_TOP_INSET,
            rightInset: WORKBENCH_CARD_RIGHT_INSET,
            bottomInset: WORKBENCH_CARD_BOTTOM_INSET,
          }
        : {}),
    })
  }, [
    viewKind,
    conversationId,
    chatAreaWidth,
    browserActive,
    browserPrimary,
    chromeOverlayHeight,
    rightPanel,
    immersiveCardWidth,
    primaryPaneWidth,
    floatOverlay,
    workbenchOpen,
    workbenchWidth,
    cardMode,
  ])

  const { pushWidth, action } = useBrowserPaneActions()

  return { chatAreaWidth, pushWidth, action }
}
