// ── Shared assistant session behind a conversational form-filler column ──
// Wraps useHostedAgentSession with the form-assist protocol (form-assist.ts):
// the proposal is derived — not accumulated — by parsing the latest assistant
// reply on every render, a fingerprint fence keeps it hidden after a dismiss
// until a NEW proposal shows up, and bubble text is rendered without the
// proposal fences (the proposal surfaces in the form's review banner, not as
// raw JSON in the transcript). The session itself is a main-process hosted
// agent session pinned by the spec's system-prompt override: persisted,
// resumable across restarts, cancellable, and excluded from the memory /
// experience pipeline by session-manager's derived-session rule.

import { useCallback, useMemo, useState } from 'react'
import type { AgentMessage, AgentStatus, ContentBlock } from '../../types/agent'
import { useHostedAgentSession } from '../../hooks/useHostedAgentSession'
import { buildFormAnnotation, parseFormPatch, stripProposalFences } from './form-assist'
import type { FormAssistSpec } from './form-assist'
import type { SandboxApprovalMode } from '../../../../shared/sandbox/policy'

export interface FormAssistSession<P extends object> {
  messages: AgentMessage[]
  agentStatus: AgentStatus
  streamingBlocks: ContentBlock[]
  isBusy: boolean
  restoring: boolean
  /** Patch parsed from the latest assistant reply, awaiting apply/dismiss. */
  proposedPatch: P | null
  clearProposedPatch: () => void
  /** Send a user message; `snapshot` (the form's live state) rides along as
   *  the trailing [当前表单] annotation. */
  send: (text: string, snapshot?: Record<string, unknown>) => void
  cancel: () => void
  engineCall: (method: string, ...args: unknown[]) => void
  refreshOptions: () => void
  /** The conversation's tool-approval level; `undefined` = never chosen (row
   *  absent or the column null) — the composer renders the shared default
   *  按需确认, exactly as a fresh main conversation reads. */
  approvalMode: SandboxApprovalMode | undefined
  /** Pick a level: optimistic locally, then the main chat's own two-step —
   *  write `conversations.approval_mode` (stub-inserting the row when the
   *  assistant thread has never sent anything yet), then refresh the live
   *  engine so a mid-run change lands without waiting for the next ask. */
  setApprovalMode: (mode: SandboxApprovalMode) => void
}

export interface FormAssistSessionOptions<P extends object> {
  /** Conversation id (formAssistConversationId); null = dormant. Fixed per
   *  keyed mount, mirroring useHostedAgentSession's contract. */
  convId: string | null
  /** Session + persisted conversation title. */
  title: string
  spec: FormAssistSpec<P>
  /** System prompt, built by the caller via buildFormAssistSystemPrompt so
   *  the locale is a page decision. Pinned at session creation. */
  systemPrompt: string
}

function assistantText(msg: AgentMessage): string {
  return (msg.contentBlocks ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text?: string }).text ?? '')
    .join('\n')
}

/** Bubble copy with proposal fences stripped; returns the same message object
 *  when nothing changed so the mirror's identity survives untouched syncs. */
function stripMessageFences(msg: AgentMessage, legacyFences: string[]): AgentMessage {
  if (msg.role !== 'assistant') return msg
  let changed = false
  const blocks = (msg.contentBlocks ?? []).map((b) => {
    if (b.type !== 'text') return b
    const raw = (b as { text?: string }).text ?? ''
    const next = stripProposalFences(raw, legacyFences)
    if (next === raw) return b
    changed = true
    return { ...b, text: next } as ContentBlock
  })
  return changed ? { ...msg, contentBlocks: blocks } : msg
}

export function useFormAssistSession<P extends object>({ convId, title, spec, systemPrompt }: FormAssistSessionOptions<P>): FormAssistSession<P> {
  const session = useHostedAgentSession({
    convId,
    title,
    createOptions: { clientId: spec.clientId, systemPromptOverride: systemPrompt },
  })

  const legacyFences = spec.legacyFence ? [spec.legacyFence] : []
  const messages = useMemo(
    () => session.messages.map((m) => stripMessageFences(m, legacyFences)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- legacyFences derives from the stable module-level spec
    [session.messages, spec],
  )

  // The proposal is derived, not accumulated: parse the latest assistant
  // reply's RAW text (fences intact) on every render — one message, cheap —
  // and hide it while its fingerprint is dismissed. Apply/dismiss keeps a
  // fence hidden until a NEW one shows up, and the hide survives switching
  // conversations away and back.
  const [dismissedFingerprint, setDismissedFingerprint] = useState<string | null>(null)
  const lastAssistant = [...session.messages].reverse().find((m) => m.role === 'assistant')
  const parsed = lastAssistant ? parseFormPatch(assistantText(lastAssistant), spec) : null
  const fingerprint = parsed ? JSON.stringify(parsed) : null
  const proposedPatch = parsed && fingerprint !== dismissedFingerprint ? parsed : null
  const clearProposedPatch = useCallback((): void => {
    setDismissedFingerprint(fingerprint)
  }, [fingerprint])

  const send = useCallback(
    (text: string, snapshot?: Record<string, unknown>): void => {
      session.send(text, snapshot ? buildFormAnnotation(snapshot) : undefined)
    },
    [session],
  )

  // ── 授权 (per-conversation tool-approval level) ──
  // Delegated to the shared hosted-session state (useHostedAgentSession →
  // useConversationApprovalMode): the same read/write the routine run
  // transcript and the tool studio use, so the surfaces cannot drift.

  return {
    messages,
    agentStatus: session.agentStatus,
    streamingBlocks: session.streamingBlocks,
    isBusy: session.isBusy,
    restoring: session.restoring,
    proposedPatch,
    clearProposedPatch,
    send,
    cancel: session.cancel,
    engineCall: session.engineCall,
    refreshOptions: session.refreshOptions,
    approvalMode: session.approvalMode,
    setApprovalMode: session.setApprovalMode,
  }
}
