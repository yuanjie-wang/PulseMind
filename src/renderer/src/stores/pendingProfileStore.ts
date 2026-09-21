// ── Pending 模型 store ──
// The model picked on the welcome composer, before the conversation it applies
// to exists. `createNewConversation` clears the active key and the id is only
// generated when the first message materializes the row, so a click there had
// no conversation to write and the picker would snap back to the default. The
// choice is held here instead — the picker reads it, and useChatController
// applies it to the conversation the first message creates, before the session
// starts (main reads conversations.profile_id in doCreateSession). Same
// one-shot shape as pendingApprovalStore.

import { create } from 'zustand'

interface PendingProfileState {
  /** Profile chosen for the conversation about to be created; null = none. */
  profileId: string | null
  setProfileId: (profileId: string) => void
  clearProfileId: () => void
}

export const usePendingProfileStore = create<PendingProfileState>((set) => ({
  profileId: null,
  setProfileId: (profileId) => set({ profileId }),
  clearProfileId: () => set({ profileId: null }),
}))

/** Read-and-clear, as a plain function so the non-React materialization path in
 *  useChatController can consume the choice without subscribing to it. */
export function takePendingProfileId(): string | null {
  const { profileId, clearProfileId } = usePendingProfileStore.getState()
  if (profileId !== null) clearProfileId()
  return profileId
}
