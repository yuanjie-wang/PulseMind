// ── Popout watch registry (PLAN-conversation-popout 2026-10-30) ──
// Which conversations currently have a popout window attached. Only the MAIN
// window's consumers read this: the unread light judges 已读 at event time
// (a conversation the user is watching in a popout must not light the main
// window's sidebar green), and the mirror-eviction candidates exclude popped
// conversations (their popout is a live client; disposing the engine under
// it would kill the view). Fed by POPOUT_EVENT broadcasts from main — the
// popout windows themselves never subscribe.
// Nothing persists; the registry is rebuilt from events on every window load
// (a popout opened before a main-window reload re-announces nothing, but the
// popout window outlives only while the main window lives — see the closed
// wiring — so the states stay consistent in practice).
import { create } from 'zustand'

interface PopoutWatchState {
  byConversation: Record<string, true>
  add: (convId: string) => void
  remove: (convId: string) => void
}

export const usePopoutWatchStore = create<PopoutWatchState>()((set) => ({
  byConversation: {},
  add: (convId) => set((s) => (s.byConversation[convId] ? s : { byConversation: { ...s.byConversation, [convId]: true } })),
  remove: (convId) => set((s) => {
    if (!s.byConversation[convId]) return s
    const next = { ...s.byConversation }
    delete next[convId]
    return { byConversation: next }
  }),
}))

/** Non-reactive read for event handlers and sweep filters. */
export function isPoppedOut(convId: string): boolean {
  return !!usePopoutWatchStore.getState().byConversation[convId]
}
