// ── Shared assistant session behind a conversational form-filler column ──
// Wraps useHostedAgentSession with the form-assist protocol (form-assist.ts):
// the proposal is derived — not accumulated — by parsing the latest assistant
// reply on every render, a fingerprint fence keeps it hidden after a dismiss
// until a NEW proposal shows up, and the render pipeline strips what the user
// must never see as raw text: the proposal fences in assistant bubbles, the
// trailing [当前表单] JSON in user bubbles (D1: it still rides the wire and
// persists — only the render drops it), and incomplete fences in streaming
// text (D2: a streaming fence is incomplete by construction, so it is cut,
// not parsed). The session itself is a main-process hosted agent session
// pinned by the spec's system-prompt override: persisted, resumable across
// restarts, cancellable, and excluded from the memory / experience pipeline
// by session-manager's derived-session rule.

import { useCallback, useMemo, useState } from 'react'
import type { AgentMessage, AgentStatus, ContentBlock } from '../../types/agent'
import { useHostedAgentSession } from '../../hooks/useHostedAgentSession'
import { useTranslation } from '../../i18n/useTranslation'
import { buildFormAnnotation, parseFormPatch, stripFormAnnotation, stripProposalFences, stripStreamingFences } from './form-assist'
import type { FormAssistSpec } from './form-assist'
import type { ExpertProfile } from '../../../../shared/types/expert'
import type { SandboxApprovalMode } from '../../../../shared/sandbox/policy'

export interface FormAssistSession<P extends object> {
  messages: AgentMessage[]
  agentStatus: AgentStatus
  /** streamingBlocks with incomplete proposal fences already cut (D2). */
  streamingBlocks: ContentBlock[]
  isBusy: boolean
  restoring: boolean
  /** Patch parsed from the latest assistant reply, awaiting apply/dismiss. */
  proposedPatch: P | null
  /** Apply-flavored hide: records the fingerprint only — the patch is already
   *  written into the form, so a restore chip would be meaningless (D5). */
  clearProposedPatch: () => void
  /** 忽略: records fingerprint AND patch — the fence stays hidden, and when
   *  the same content shows up again the host renders a restore chip (D5). */
  dismissProposal: () => void
  /** The patch hidden by the last 忽略, while an identical proposal is the
   *  latest one; null otherwise. Hosts render the restore chip for it. */
  restoreablePatch: P | null
  /** Un-ignore: the derived proposal reappears from the same message. */
  restoreProposal: () => void
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
  /** Conversation id (formAssistConversationId); null = dormant. */
  convId: string | null
  /** Session + persisted conversation title. */
  title: string
  spec: FormAssistSpec<P>
  /** System prompt, built by the caller via buildFormAssistSystemPrompt so
   *  the locale is a page decision. Pinned at session creation. */
  systemPrompt: string
  /** Built-in tools the assistant's session may use (D17 host-side pin) —
   *  the domain's `*_ASSIST_ALLOWED_TOOLS` constant. */
  allowedTools?: string[]
  /** The internal expert pack pinning this assistant's identity (D15/D16) —
   *  the domain's `*_ASSISTANT_PROFILE` constant. */
  expertProfile?: ExpertProfile
}

function assistantText(msg: AgentMessage): string {
  return (msg.contentBlocks ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text?: string }).text ?? '')
    .join('\n')
}

/** Render copy of one message: assistant bubbles lose complete proposal
 *  fences (a fence-only reply becomes the localized hint, D7), user bubbles
 *  lose the trailing [当前表单] annotation (D1). Returns the same message
 *  object when nothing changed so the mirror's identity survives untouched
 *  syncs. */
function renderMessage(msg: AgentMessage, legacyFences: string[], fenceOnlyPlaceholder: string): AgentMessage {
  if (msg.role !== 'assistant' && msg.role !== 'user') return msg
  const isAssistant = msg.role === 'assistant'
  let changed = false
  const blocks = (msg.contentBlocks ?? []).map((b) => {
    if (b.type !== 'text') return b
    const raw = (b as { text?: string }).text ?? ''
    const next = isAssistant ? stripProposalFences(raw, legacyFences, fenceOnlyPlaceholder) : stripFormAnnotation(raw)
    if (next === raw) return b
    changed = true
    return { ...b, text: next } as ContentBlock
  })
  return changed ? { ...msg, contentBlocks: blocks } : msg
}

export function useFormAssistSession<P extends object>({ convId, title, spec, systemPrompt, allowedTools, expertProfile }: FormAssistSessionOptions<P>): FormAssistSession<P> {
  const session = useHostedAgentSession({
    convId,
    title,
    createOptions: { clientId: spec.clientId, systemPromptOverride: systemPrompt, allowedTools, expertProfile },
  })
  const { t } = useTranslation()
  // D7: a fence-only reply renders as this placeholder instead of the raw
  // JSON (the old fall-back-to-original) — both hosts sit inside the
  // TranslationProvider, so the locale is read here.
  const fenceOnlyPlaceholder = t('formAssist.fenceOnlyReply')

  const legacyFences = spec.legacyFence ? [spec.legacyFence] : []
  const messages = useMemo(
    () => session.messages.map((m) => renderMessage(m, legacyFences, fenceOnlyPlaceholder)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- legacyFences derives from the stable module-level spec
    [session.messages, spec, fenceOnlyPlaceholder],
  )

  // D2: streaming text blocks carry the in-progress reply; cut everything
  // from the first fence-start marker so partial JSON never paints.
  const streamingBlocks = useMemo(() => {
    let changed = false
    const blocks = session.streamingBlocks.map((b) => {
      if (b.type !== 'text') return b
      const raw = (b as { text?: string }).text ?? ''
      const next = stripStreamingFences(raw, legacyFences)
      if (next === raw) return b
      changed = true
      return { ...b, text: next } as ContentBlock
    })
    return changed ? blocks : session.streamingBlocks
    // eslint-disable-next-line react-hooks/exhaustive-deps -- legacyFences derives from the stable module-level spec
  }, [session.streamingBlocks, spec])

  // The proposal is derived, not accumulated: parse the latest assistant
  // reply's RAW text (fences intact) on every render — one message, cheap —
  // and hide it while its fingerprint is dismissed. Apply/dismiss keeps a
  // fence hidden until a NEW one shows up, and the hide survives switching
  // conversations away and back.
  const [dismissedFingerprint, setDismissedFingerprint] = useState<string | null>(null)
  const [lastDismissed, setLastDismissed] = useState<{ fingerprint: string; patch: P } | null>(null)
  const lastAssistant = [...session.messages].reverse().find((m) => m.role === 'assistant')
  const parsed = lastAssistant ? parseFormPatch(assistantText(lastAssistant), spec) : null
  const fingerprint = parsed ? JSON.stringify(parsed) : null
  const dismissedMatch = parsed != null && fingerprint === dismissedFingerprint
  const proposedPatch = dismissedMatch ? null : parsed
  // D5: the restore chip exists only for a 忽略 (apply never stores the
  // patch), and only while the latest proposal is the very content that was
  // dismissed — any different newer patch supersedes it.
  const restoreablePatch = dismissedMatch && lastDismissed?.fingerprint === fingerprint ? lastDismissed.patch : null
  const clearProposedPatch = useCallback((): void => {
    setDismissedFingerprint(fingerprint)
  }, [fingerprint])
  const dismissProposal = useCallback((): void => {
    if (parsed && fingerprint) setLastDismissed({ fingerprint, patch: parsed })
    setDismissedFingerprint(fingerprint)
  }, [fingerprint, parsed])
  const restoreProposal = useCallback((): void => {
    setDismissedFingerprint(null)
    setLastDismissed(null)
  }, [])

  // D6: 忽略/恢复 state is per conversation. Hosted messages already rebuild
  // with the convId mirror; this useState was the one piece that survived a
  // switch — a dismissed proposal from routine A must not gate routine B's
  // editor (and the host's key={session} remount stays as a second belt).
  // Reset during render (the documented adjust-state-on-prop-change pattern):
  // an effect would fire after a paint of A's gated state under B's form.
  const [prevConvId, setPrevConvId] = useState(convId)
  if (prevConvId !== convId) {
    setPrevConvId(convId)
    setDismissedFingerprint(null)
    setLastDismissed(null)
  }

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
    streamingBlocks,
    isBusy: session.isBusy,
    restoring: session.restoring,
    proposedPatch,
    clearProposedPatch,
    dismissProposal,
    restoreablePatch,
    restoreProposal,
    send,
    cancel: session.cancel,
    engineCall: session.engineCall,
    refreshOptions: session.refreshOptions,
    approvalMode: session.approvalMode,
    setApprovalMode: session.setApprovalMode,
  }
}
