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
  setUpdate: (update: BrowserPaneUpdate) => void
  setChatAreaWidth: (width: number) => void
}

export const useBrowserPaneStore = create<BrowserPaneStore>((set) => ({
  update: { visible: false, width: 380, conversationId: null, tabs: [] },
  chatAreaWidth: Math.max(600, typeof window !== 'undefined' ? window.innerWidth - 240 : 800),
  setUpdate: (update) => set({ update }),
  setChatAreaWidth: (width) => set({ chatAreaWidth: width }),
}))

if (typeof window !== 'undefined' && window.electronAPI?.onBrowserPaneUpdate) {
  window.electronAPI.onBrowserPaneUpdate((update) => useBrowserPaneStore.getState().setUpdate(update))
}
