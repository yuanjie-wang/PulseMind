// ── Navigation store ──
// PLAN-0.4.0 M1.2: central navigation state. Replaces the canvasMode /
// knowledgeMode booleans and the settings-modal `view` string that used to be
// scattered across AppLayout. Same zustand pattern as canvasStore.

import { create } from 'zustand'
import { CHAT_VIEW, type AppView } from '../navigation/types'

interface NavigationState {
  /** The currently displayed top-level view. */
  view: AppView
  /** Navigate to a view. */
  navigate: (view: AppView) => void
}

export const useNavigationStore = create<NavigationState>((set) => ({
  view: CHAT_VIEW,
  navigate: (view) => set({ view }),
}))
