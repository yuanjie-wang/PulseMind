// ── Session file-change store (2026-10-28 工作区树会话改动着色) ──
// The renderer-side copy of each live session's file-change ledger, keyed by
// conversation id, so the 工作区 tree can paint its rows without threading the
// session mirror through four component layers (ChatView → WorkbenchPane →
// WorkspacePane → WorkspaceTree). Two writers: useConversationEngine's event
// fold (the `file_changes` event lands here as it lands in the mirror) and the
// tree's own initial pull (engineCall `getFileChanges` on mount — the desktop
// mirror never snapshots, so a tree mounted after the writes happened would
// otherwise start blank). Nothing here persists: a restart gives every
// conversation a fresh engine and therefore an empty ledger.

import { create } from 'zustand'
import type { SessionFileChange } from '../../../shared/agent-protocol'

/** One shared empty list so an unpainted conversation's selector result is
 *  referentially stable (the tree memoizes its paint map on it). */
export const NO_FILE_CHANGES: SessionFileChange[] = []

interface SessionFileChangesState {
  byConversation: Record<string, SessionFileChange[]>
  set: (conversationId: string, changes: SessionFileChange[]) => void
  /** The conversation's mirror was evicted or reset: forget its ledger copy. */
  drop: (conversationId: string) => void
}

export const useSessionFileChangesStore = create<SessionFileChangesState>()((set) => ({
  byConversation: {},

  set: (conversationId, changes) =>
    set((s) => ({ byConversation: { ...s.byConversation, [conversationId]: changes } })),

  drop: (conversationId) =>
    set((s) => {
      if (!(conversationId in s.byConversation)) return s
      const next = { ...s.byConversation }
      delete next[conversationId]
      return { byConversation: next }
    }),
}))
