// ── Sidebar store (2026-10-26) ──
// The nav sidebar's dragged width. Persisted like the workbench pane's width
// (zustand persist → localStorage): the width is a preference about the user,
// not about a conversation. Collapse state stays component-local
// (AppLayout's useState) — a restart opens expanded, at this width.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { SIDEBAR_DEFAULT_WIDTH } from '../../../shared/ui/layout-widths'

interface SidebarState {
  width: number
  setWidth: (width: number) => void
}

export const useSidebarStore = create<SidebarState>()(
  persist(
    (set) => ({
      width: SIDEBAR_DEFAULT_WIDTH,
      setWidth: (width) => set({ width }),
    }),
    {
      name: 'pulsemind-sidebar',
      partialize: (s) => ({ width: s.width }) as SidebarState,
    },
  ),
)
