// ── Composer draft store ──
// One-shot channel for dropping text into the composer from outside it —
// currently the welcome page's starter prompts. The composer subscribes and
// consumes; a click on a starter lands in the input even though the two
// components share no props.

import { create } from 'zustand'

interface ComposerDraftState {
  /** Pending text to place in the composer, null when nothing is pending. */
  draft: string | null
  setDraft: (text: string) => void
  clearDraft: () => void
}

export const useComposerDraftStore = create<ComposerDraftState>((set) => ({
  draft: null,
  setDraft: (text) => set({ draft: text }),
  clearDraft: () => set({ draft: null }),
}))
