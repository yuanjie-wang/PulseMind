// ── Browser pane store (A-M5) ──
// Live pane state pushed from the main process (tab list, url/title, width,
// visibility) plus the measured chat width, held in a module-level zustand
// store so any component can read it without prop drilling — and without a
// custom hook boundary the react-hooks/refs rule could flag. The
// main→renderer subscription is wired once at module load (the preload
// bridge is available before any import).

import { create } from 'zustand'
import type { BrowserPaneUpdate } from '../../../shared/browser/pane'

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
  setUpdate: (update: BrowserPaneUpdate) => void
  setOptimisticActive: (id: string | null) => void
  setChromeOverlayHeight: (px: number) => void
  setChatAreaWidth: (width: number) => void
}

export const useBrowserPaneStore = create<BrowserPaneStore>((set) => ({
  update: { visible: false, width: 380, conversationId: null, tabs: [] },
  chatAreaWidth: Math.max(600, typeof window !== 'undefined' ? window.innerWidth - 240 : 800),
  optimisticActiveId: null,
  chromeOverlayHeight: 0,
  setUpdate: (update) => set({ update, optimisticActiveId: null }),
  setOptimisticActive: (id) => set({ optimisticActiveId: id }),
  setChromeOverlayHeight: (px) => set({ chromeOverlayHeight: px }),
  setChatAreaWidth: (width) => set({ chatAreaWidth: width }),
}))

if (typeof window !== 'undefined' && window.electronAPI?.onBrowserPaneUpdate) {
  window.electronAPI.onBrowserPaneUpdate((update) => useBrowserPaneStore.getState().setUpdate(update))
}
