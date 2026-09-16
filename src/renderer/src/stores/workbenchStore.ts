// ── Workbench store (PLAN-workbench W7) ──
// Single right-side pane host state: which tool tab is frontmost (files /
// browser / plan), open/closed, and the one shared width. Auto-open entries
// all funnel through openTab: create_plan → 'plan', a fresh browser tab →
// 'browser', a file preview → 'files'. Width is persisted; the pane always
// starts closed (a restart has no live plan or browser session to show).

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type WorkbenchTab = 'files' | 'browser' | 'plan'

export const WORKBENCH_DEFAULT_WIDTH = 420

interface WorkbenchState {
  open: boolean
  width: number
  activeTab: WorkbenchTab
  setOpen: (open: boolean) => void
  setWidth: (width: number) => void
  setActiveTab: (tab: WorkbenchTab) => void
  /** Bring a tab to the front, opening the workbench if closed. */
  openTab: (tab: WorkbenchTab) => void
}

export const useWorkbenchStore = create<WorkbenchState>()(
  persist(
    (set) => ({
      open: false,
      width: WORKBENCH_DEFAULT_WIDTH,
      activeTab: 'files',
      setOpen: (open) => set({ open }),
      setWidth: (width) => set({ width }),
      setActiveTab: (activeTab) => set({ activeTab }),
      openTab: (tab) => set({ open: true, activeTab: tab }),
    }),
    {
      name: 'pulsemind-workbench',
      partialize: (s) => ({ width: s.width, activeTab: s.activeTab }) as WorkbenchState,
    },
  ),
)
