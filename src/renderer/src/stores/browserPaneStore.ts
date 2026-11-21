// ── Browser pane store (A-M5) ──
// Live pane state pushed from the main process (tab list, url/title, width,
// visibility) plus the measured chat width, held in a module-level zustand
// store so any component can read it without prop drilling — and without a
// custom hook boundary the react-hooks/refs rule could flag. The
// main→renderer subscription is wired once at module load (the preload
// bridge is available before any import).

import { create } from 'zustand'
import type { BrowserPaneUpdate, PaneFreezeFrame } from '../../../shared/browser/pane'

interface BrowserPaneStore {
  update: BrowserPaneUpdate
  /** Measured chat-column width — the clamp input for pane width. */
  chatAreaWidth: number
  /** Clicked-this-frame active tab id (PLAN-browser-pane-ux T1.1): the
   *  highlight lands on the click, one IPC round-trip ahead of main's
   *  authoritative snapshot — under load that round-trip is the whole of
   *  "页签慢、网页快". Main is the source of truth: every arriving snapshot
   *  clears it, so it only ever papers the transit window. */
  optimisticActiveId: string | null
  /** Pixel height of chrome UI overhanging the webview area (suggestion
   *  dropdown) — rides the pane-state push so the dock can shift the
   *  WebContentsView down while it is open (PLAN-browser-pane-ux T3.5). */
  chromeOverlayHeight: number
  /** 沉浸窗口右卡的实测量宽（2026-10-31 三面板）——浏览器面板占满整卡，
   *  paneWidth 直通不带 chatArea clamp；主窗恒 null 走旧 clamp。 */
  immersiveCardWidth: number | null
  /** 主窗浏览器主视图卡的内容盒宽（PLAN-layout-modes 2026-11-03）——
   *  ChatView 的主卡 ResizeObserver 实测，paneWidth 直通绕开 clamp
   *  （沉浸卡同款算术：paneWidth = 内容宽 + 3）。恒 null = 侧栏形态。 */
  primaryPaneWidth: number | null
  /** 浮窗让位（十三期）：可见浮窗越过浏览器主卡 webview 左/右缘的 px
   *  （useFloatOverlayShift 实测），随 pane-state 推给 dock 内收 view。
   *  无浮窗恒 {left:0,right:0}。 */
  floatOverlay: { left: number; right: number }
  /** 整窗浮层在屏上（2026-11-21）：useBrowserOcclusion 实测的 Modal/遮罩态。
   *  原生 view 画在一切 DOM 之上，这类浮层只能靠折叠让开——useBrowserPane
   *  把它与 browserActive 相与（false = 收成 0×0，页签与页面都活着）。 */
  occluded: boolean
  /** 冻结帧（方案 ③）：折叠前抓下的那一屏 + 它该待的矩形（主进程给的窗口内容
   *  区坐标），BrowserFreezeLayer 铺回 DOM，观感是「页面定格」而不是「卡片空白」。
   *  null = 没抓到（空页签/抓图失败/还没回来）。 */
  freeze: PaneFreezeFrame | null
  /** 抓帧这件事有结论了（拿到图或确定没有）。**折叠等它**：先折后抓会让页面
   *  先黑一下，先抓后折才是原子替换；一直没有结论时由 useBrowserFreeze 的超时
   *  兜底置 true——弹窗不能被页面永远盖着。 */
  freezeSettled: boolean
  setUpdate: (update: BrowserPaneUpdate) => void
  setOptimisticActive: (id: string | null) => void
  setChromeOverlayHeight: (px: number) => void
  setChatAreaWidth: (width: number) => void
  setImmersiveCardWidth: (width: number | null) => void
  setPrimaryPaneWidth: (width: number | null) => void
  setFloatOverlay: (overlay: { left: number; right: number }) => void
  setOccluded: (occluded: boolean) => void
  setFreeze: (freeze: PaneFreezeFrame | null) => void
  setFreezeSettled: (freezeSettled: boolean) => void
}

export const useBrowserPaneStore = create<BrowserPaneStore>((set) => ({
  update: { visible: false, width: 380, conversationId: null, tabs: [] },
  chatAreaWidth: Math.max(600, typeof window !== 'undefined' ? window.innerWidth - 240 : 800),
  optimisticActiveId: null,
  chromeOverlayHeight: 0,
  immersiveCardWidth: null,
  primaryPaneWidth: null,
  floatOverlay: { left: 0, right: 0 },
  occluded: false,
  freeze: null,
  freezeSettled: false,
  setUpdate: (update) => set({ update, optimisticActiveId: null }),
  setOptimisticActive: (id) => set({ optimisticActiveId: id }),
  setChromeOverlayHeight: (px) => set({ chromeOverlayHeight: px }),
  setChatAreaWidth: (width) => set({ chatAreaWidth: width }),
  setImmersiveCardWidth: (immersiveCardWidth) => set({ immersiveCardWidth }),
  setPrimaryPaneWidth: (primaryPaneWidth) => set({ primaryPaneWidth }),
  setFloatOverlay: (floatOverlay) => set({ floatOverlay }),
  setOccluded: (occluded) => set({ occluded }),
  setFreeze: (freeze) => set({ freeze }),
  setFreezeSettled: (freezeSettled) => set({ freezeSettled }),
}))

if (typeof window !== 'undefined' && window.electronAPI?.onBrowserPaneUpdate) {
  window.electronAPI.onBrowserPaneUpdate((update) => useBrowserPaneStore.getState().setUpdate(update))
}
