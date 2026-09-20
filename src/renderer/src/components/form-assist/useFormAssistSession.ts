// ── Shared assistant session behind a conversational form-filler column ──
// Wraps useHostedAgentSession with the form-assist protocol (form-assist.ts).
// The session is a main-process hosted agent session pinned by the spec's
// system-prompt override: persisted, resumable across restarts, cancellable,
// and excluded from the memory / experience pipeline by session-manager's
// derived-session rule.
//
// 自动填入 (user ruling 2026-09-20, 「不要草稿模式，生成结论后直接填入表单，
// 给撤销按钮」): there is no review card and no apply/dismiss step. Whenever
// the latest assistant reply changes, planAutoApply decides whether its patch
// is new (form-assist.ts owns the fire-once rules: hydrated history only
// records, a same-message mutation never re-fires, a text growth re-decides)
// and this hook hands it to the host's onPatch — the host writes it into the
// form and shows an undo bar bound to `appliedPatch`. The render pipeline
// still strips what the user must never see as raw text: the proposal fences
// in assistant bubbles, the trailing [当前表单] JSON in user bubbles (D1: it
// still rides the wire and persists — only the render drops it), and
// incomplete fences in streaming text (D2: a streaming fence is incomplete by
// construction, so it is cut, not parsed).

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AgentMessage, AgentStatus, ContentBlock } from '../../types/agent'
import { useHostedAgentSession } from '../../hooks/useHostedAgentSession'
import { useTranslation } from '../../i18n/useTranslation'
import { buildFormAnnotation, planAutoApply, stripFormAnnotation, stripProposalFences, stripStreamingFences } from './form-assist'
import type { AutoApplyRecord, FormAssistSpec } from './form-assist'
import type { ExpertProfile } from '../../../../shared/types/expert'
import type { SandboxApprovalMode } from '../../../../shared/sandbox/policy'

export interface FormAssistSession<P extends object> {
  messages: AgentMessage[]
  agentStatus: AgentStatus
  /** streamingBlocks with incomplete proposal fences already cut (D2). */
  streamingBlocks: ContentBlock[]
  isBusy: boolean
  restoring: boolean
  /** The patch the latest assistant reply auto-applied — the undo bar binds
   *  to this. It clears when a NEWER assistant reply carries no patch (a
   *  prose answer retires the undo), the conversation switches, or the host
   *  calls clearAppliedPatch. */
  appliedPatch: P | null
  /** Manual clear (撤销 clicked): drops the undo bar only — the fire-once
   *  ledger is untouched, so a later mutation of the same message still will
   *  not re-apply. */
  clearAppliedPatch: () => void
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
  /** Bump after discarding the conversation (新会话 / a fresh create-flow):
   *  the mirror re-restores empty under the SAME convId — one slot per entity
   *  — and the auto-apply ledger + undo bar die with the old thread. */
  resetKey?: number
  /** Receives every newly auto-applied patch. Keep it stable (a useCallback
   *  / instance method): it fires from an effect keyed on the message list.
   *  The patch is ALSO readable as `appliedPatch` for the undo bar, so the
   *  callback never needs to store it. */
  onPatch: (patch: P) => void
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

export function useFormAssistSession<P extends object>({ convId, title, spec, systemPrompt, allowedTools, expertProfile, resetKey, onPatch }: FormAssistSessionOptions<P>): FormAssistSession<P> {
  const session = useHostedAgentSession({
    convId,
    title,
    createOptions: { clientId: spec.clientId, systemPromptOverride: systemPrompt, allowedTools, expertProfile },
    resetKey,
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

  // ── 自动填入：latest-reply trigger, exactly once per change ──
  // The trigger reads the RAW assistant text (fences intact) — parseFormPatch
  // needs the fence. planAutoApply's ledger lives in state so the effect can
  // compare runs; `appliedPatch` mirrors the last handed-over patch for the
  // host's undo bar. The empty-bubble window between the optimistic user
  // message and the engine's reply is a no-op by construction (messageId
  // null), which is exactly what keeps the previous turn's fence from
  // re-firing when the message list shifts underneath it.
  const [appliedRecord, setAppliedRecord] = useState<AutoApplyRecord | null>(null)
  const [appliedPatch, setAppliedPatch] = useState<P | null>(null)
  // 新会话/reset: the ledger and the undo bar belong to the discarded thread —
  // they die with it, or a reply from the fresh thread could be compared
  // against the old record (or an old applied patch would keep its bar up).
  // Mount runs this too; both states start null, so React bails out.
  /* eslint-disable react-hooks/set-state-in-effect -- same subscription-fold shape as the effect below */
  useEffect(() => {
    setAppliedRecord(null)
    setAppliedPatch(null)
  }, [resetKey])
  /* eslint-enable react-hooks/set-state-in-effect */
  const lastAssistant = [...session.messages].reverse().find((m) => m.role === 'assistant')
  const lastAssistantId = lastAssistant?.id ?? null
  const lastAssistantRaw = lastAssistant ? assistantText(lastAssistant) : ''
  /* eslint-disable react-hooks/set-state-in-effect -- folding a subscription-driven event stream into state: the mirror's sync() is the external system, and each setState runs at most once per genuine message change (planAutoApply's ledger) */
  useEffect(() => {
    if (appliedRecord && appliedRecord.convId !== convId) {
      // Conversation switched live (no remount): the undo belongs to the
      // previous form, and the new conversation starts as a fresh mount does.
      setAppliedRecord(null)
      setAppliedPatch(null)
      return
    }
    // Hydration in flight: the mirror is being wiped and reseeded, so whatever
    // message is momentarily "latest" is not a reply. The ledger waits for the
    // restored baseline; when restoring flips false, planAutoApply sees
    // prev === null and RECORDS that baseline without firing — history never
    // replays into the form.
    if (session.restoring) return
    const decision = planAutoApply(appliedRecord, convId ?? '', lastAssistantId, lastAssistantRaw, spec)
    if (decision.record !== appliedRecord) setAppliedRecord(decision.record)
    if (decision.patch) {
      setAppliedPatch(decision.patch)
      onPatch(decision.patch)
    }
  }, [appliedRecord, convId, lastAssistantId, lastAssistantRaw, spec, onPatch, session.restoring])
  /* eslint-enable react-hooks/set-state-in-effect */

  const send = useCallback(
    (text: string, snapshot?: Record<string, unknown>): void => {
      session.send(text, snapshot ? buildFormAnnotation(snapshot) : undefined)
    },
    [session],
  )

  const clearAppliedPatch = useCallback((): void => setAppliedPatch(null), [])

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
    appliedPatch,
    clearAppliedPatch,
    send,
    cancel: session.cancel,
    engineCall: session.engineCall,
    refreshOptions: session.refreshOptions,
    approvalMode: session.approvalMode,
    setApprovalMode: session.setApprovalMode,
  }
}
