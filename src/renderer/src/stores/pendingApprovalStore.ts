// ── Pending 授权 store ──
// The level picked on the welcome composer, before the conversation it applies
// to exists. `createNewConversation` clears the active key and the id is only
// generated when the first message materializes the row, so a click there had
// no conversation to write and the button never moved ("权限选择无法切换"). The
// choice is held here instead — the button reads it, and useChatController
// applies it to the conversation the first message creates, before the session
// starts. Same one-shot shape as composerDraftStore.

import { create } from 'zustand'
import type { SandboxApprovalMode } from '../../../shared/sandbox/policy'

interface PendingApprovalState {
  /** Level chosen for the conversation about to be created; null = none chosen. */
  mode: SandboxApprovalMode | null
  setMode: (mode: SandboxApprovalMode) => void
  clearMode: () => void
}

export const usePendingApprovalStore = create<PendingApprovalState>((set) => ({
  mode: null,
  setMode: (mode) => set({ mode }),
  clearMode: () => set({ mode: null }),
}))

/** Read-and-clear, as a plain function so the non-React materialization path in
 *  useChatController can consume the choice without subscribing to it. */
export function takePendingApprovalMode(): SandboxApprovalMode | null {
  const { mode, clearMode } = usePendingApprovalStore.getState()
  if (mode !== null) clearMode()
  return mode
}
