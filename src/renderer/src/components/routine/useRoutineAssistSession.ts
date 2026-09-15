// ── Hosted agent session behind the routine editor's assistant column ──
// A useHostedAgentSession bound to the routine-assist protocol
// (routine-assist.ts): the session is pinned to the assistant role via a
// system-prompt override, each ask can carry the form's live state as a
// trailing annotation, and the latest assistant reply is scanned for a
// ```routine-draft block, which surfaces as a proposal the user must
// explicitly apply (routine-form-model.applyAssistantDraft).

import { useCallback, useState } from 'react'
import type { AgentMessage, AgentStatus, ContentBlock } from '../../types/agent'
import { useHostedAgentSession } from '../../hooks/useHostedAgentSession'
import { assistConversationId, buildAssistSystemPrompt, parseRoutineDraftBlock } from './routine-assist'
import type { RoutineAssistantDraft } from './routine-assist'

export interface RoutineAssistSession {
  messages: AgentMessage[]
  agentStatus: AgentStatus
  streamingBlocks: ContentBlock[]
  isBusy: boolean
  restoring: boolean
  /** Draft parsed from the latest assistant reply, awaiting apply/dismiss. */
  proposedDraft: RoutineAssistantDraft | null
  clearProposedDraft: () => void
  /** Send a user message; `formAnnotation` is appended as live-form context. */
  send: (text: string, formAnnotation?: string) => void
  cancel: () => void
  engineCall: (method: string, ...args: unknown[]) => void
  refreshOptions: () => void
}

export interface RoutineAssistOptions {
  /** Routine whose form is being edited; null = the shared create-new draft
   *  conversation (assistConversationId's 'draft' bucket). */
  routineId: string | null
  /** Current 执行项目 — bound to the session at creation. */
  projectId?: string
  /** Form name, for the persisted conversation title. */
  routineName: string
}

function assistantText(msg: AgentMessage): string {
  return (msg.contentBlocks ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text?: string }).text ?? '')
    .join('\n')
}

export function useRoutineAssistSession({ routineId, projectId, routineName }: RoutineAssistOptions): RoutineAssistSession {
  const convId = assistConversationId(routineId)
  const title = `[日常助手] ${routineName.trim() || '新建任务'}`
  const session = useHostedAgentSession({
    convId,
    title,
    createOptions: { clientId: 'routine-assist', projectId, systemPromptOverride: buildAssistSystemPrompt() },
  })

  // The proposal is derived, not accumulated: parse the latest assistant
  // reply on every render (one message, cheap) and hide it while its
  // fingerprint is dismissed — apply/dismiss keeps a fence hidden until a
  // NEW one shows up, and the hide survives switching conversations away
  // and back.
  const [dismissedFingerprint, setDismissedFingerprint] = useState<string | null>(null)
  const lastAssistant = [...session.messages].reverse().find((m) => m.role === 'assistant')
  const parsed = lastAssistant ? parseRoutineDraftBlock(assistantText(lastAssistant)) : null
  const fingerprint = parsed ? JSON.stringify(parsed) : null
  const proposedDraft = parsed && fingerprint !== dismissedFingerprint ? parsed : null
  const clearProposedDraft = useCallback((): void => {
    setDismissedFingerprint(fingerprint)
  }, [fingerprint])

  return {
    messages: session.messages,
    agentStatus: session.agentStatus,
    streamingBlocks: session.streamingBlocks,
    isBusy: session.isBusy,
    restoring: session.restoring,
    proposedDraft,
    clearProposedDraft,
    send: session.send,
    cancel: session.cancel,
    engineCall: session.engineCall,
    refreshOptions: session.refreshOptions,
  }
}
