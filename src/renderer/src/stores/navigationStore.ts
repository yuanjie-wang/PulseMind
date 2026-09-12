// ── Navigation store ──
// PLAN-0.4.0 M1.2: central navigation state. Replaces the canvasMode /
// knowledgeMode booleans and the settings-modal `view` string that used to
// live in AppLayout. Same zustand pattern as canvasStore.

import { create } from 'zustand'
import { CHAT_VIEW, type AppView, type AppViewKind } from '../navigation/types'

interface NavigationState {
  /** The currently displayed top-level view. */
  view: AppView
  /** Last view per kind. Re-entering a kind via navigateKind restores its
   *  params — e.g. the tool center's selected tool / editing state survives a
   *  detour to capability and back (M5R §二). */
  lastViewByKind: Partial<Record<AppViewKind, AppView>>
  /** Navigate to a view. */
  navigate: (view: AppView) => void
  /** Go to a kind's remembered view (fallback: the bare kind). */
  navigateKind: (kind: AppViewKind) => void
}

export const useNavigationStore = create<NavigationState>((set, get) => ({
  view: CHAT_VIEW,
  lastViewByKind: { chat: CHAT_VIEW },
  navigate: (view) => set((s) => ({ view, lastViewByKind: { ...s.lastViewByKind, [view.kind]: view } })),
  navigateKind: (kind) => {
    const remembered = get().lastViewByKind[kind]
    get().navigate(remembered ?? { kind })
  },
}))
