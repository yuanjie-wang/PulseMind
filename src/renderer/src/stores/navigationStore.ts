// ── Navigation store ──
// PLAN-0.4.0 M1.2: central navigation state. Replaces the canvasMode /
// knowledgeMode booleans and the settings-modal `view` string that used to be
// scattered across AppLayout. Same zustand pattern as canvasStore.

import { create } from 'zustand'
import { CHAT_VIEW, type AppView } from '../navigation/types'

interface NavigationState {
  /** The currently displayed top-level view. */
  view: AppView
  /** Whether the top-left menu popover is open. */
  menuOpen: boolean
  /** Navigate to a view and close the menu. */
  navigate: (view: AppView) => void
  setMenuOpen: (open: boolean) => void
}

export const useNavigationStore = create<NavigationState>((set) => ({
  view: CHAT_VIEW,
  menuOpen: false,
  navigate: (view) => set({ view, menuOpen: false }),
  setMenuOpen: (menuOpen) => set({ menuOpen }),
}))
