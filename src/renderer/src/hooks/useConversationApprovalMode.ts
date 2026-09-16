// ── Per-conversation 授权 level, shared by every hosted-session composer ──
// The main chat reads the level off its conversation list and writes it through
// useConversationPersistence; these surfaces have no list row — the session hook
// owns the conversation id instead. One hook so the routine run transcript, the
// tool studio and the form-assist columns cannot fork the semantics:
//
//   · read: the conversation row's column on activate; a row that does not
//     exist yet (a thread nothing was ever sent to) reads undefined and the
//     composer falls back to the shared default 按需确认 — the same fallback
//     rule the engine's own resolver (pickApprovalMode) follows;
//   · write: optimistic locally, then the main chat's exact two steps — the
//     `conversations.approval_mode` write lands BEFORE the engine refresh, or
//     the re-resolved options would still carry the old level on the next ask.
//
// A session whose approval was PINNED at creation (an unattended run, before
// its runner releases the pin) keeps the pin main-side regardless of this
// column — session-manager.effectiveApprovalMode gives the override precedence.
import { useCallback, useEffect, useState } from 'react'
import { conversationKeyOf } from '../../../shared/conversation-key'
import type { SandboxApprovalMode } from '../../../shared/sandbox/policy'

export interface ConversationApprovalMode {
  /** The conversation's level; `undefined` = never chosen (row absent or the
   *  column null) — the composer renders the shared default 按需确认. */
  approvalMode: SandboxApprovalMode | undefined
  /** Pick a level: the optimistic local move happens synchronously, the
   *  durable column write and the live-engine refresh follow in order. */
  setApprovalMode: (mode: SandboxApprovalMode) => void
}

export function useConversationApprovalMode(convId: string | null | undefined): ConversationApprovalMode {
  // The state carries its convId and the read is derived — switching entities
  // (same mount, new convId) must not show the previous thread's level while
  // the next fetch is in flight; a mismatch reads as "never chosen". Truthiness
  // via conversationKeyOf, never a typeof test — the empty string is "nothing
  // open", not an id.
  const [state, setState] = useState<{ convId: string | null | undefined; mode: SandboxApprovalMode | undefined }>({ convId, mode: undefined })
  const approvalMode = state.convId === convId ? state.mode : undefined

  useEffect(() => {
    const id = conversationKeyOf(convId)
    if (!id) return
    let alive = true
    window.electronAPI
      .getConversation(id)
      .then((conv) => {
        if (alive) setState({ convId, mode: conv?.approvalMode })
      })
      .catch(() => { /* unreadable row — the default stands */ })
    return () => {
      alive = false
    }
  }, [convId])

  const setApprovalMode = useCallback(
    (mode: SandboxApprovalMode): void => {
      const id = conversationKeyOf(convId)
      if (!id) return
      setState({ convId, mode })
      void (async () => {
        try {
          await window.electronAPI.setConversationApprovalMode(id, mode)
          await window.electronAPI.agentSessionRefreshOptions(id)
        } catch (err) {
          console.warn('[ApprovalMode] update failed:', err)
        }
      })()
    },
    [convId],
  )

  return { approvalMode, setApprovalMode }
}
