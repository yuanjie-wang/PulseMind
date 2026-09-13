/**
 * Client-side mirror of a main-hosted session (PLAN-0.3.5 M1.4).
 *
 * Engines live in the main process; every renderer that shows one keeps a local
 * copy of its observable state and folds the session event stream into it. The
 * reducer here is that fold — shared by the chat client (useConversationEngine)
 * and the tool studio client so both interpret the wire protocol identically.
 */
import type { AgentMessage, AgentStatus, ContentBlock, Plan } from '../types/agent'
import type { AgentEventData } from '../../../shared/agent-protocol'
import { applyMessagesAppend } from './session-messages'

export interface SessionState {
  messages: AgentMessage[]
  agentStatus: AgentStatus
  streamingBlocks: ContentBlock[]
  plan: Plan | null
  /** Last known windowed-history summary (best-effort cache for sync saves). */
  historySummary: { firstKeptId: string; text: string } | null
  /** Resolved working directory (PLAN-0.4.0 M8), reported back on session create. */
  workspaceDir?: string
}

export function freshSessionState(): SessionState {
  return { messages: [], agentStatus: { status: 'idle' }, streamingBlocks: [], plan: null, historySummary: null }
}

export function isActiveStatus(status: AgentStatus): boolean {
  return status.status === 'streaming'
    || status.status === 'awaiting_approval'
    || status.status === 'awaiting_user_input'
    || status.status === 'executing'
    || status.status === 'awaiting_extension'
    || status.status === 'retrying'
}

/** Fold one session event into the mirror. Returns false when the event is one
 *  the mirror does not consume (the richer transport events), so the caller can
 *  skip its own follow-up work. */
export function applySessionEvent(state: SessionState, data: AgentEventData): boolean {
  switch (data.type) {
    case 'messages_append': {
      state.messages = applyMessagesAppend(state.messages, data.fromIndex, data.items as AgentMessage[])
      return true
    }
    case 'messages': {
      state.messages = data.messages as AgentMessage[]
      return true
    }
    case 'streaming_blocks': {
      state.streamingBlocks = data.blocks as ContentBlock[]
      return true
    }
    case 'status': {
      state.agentStatus = { status: data.status } as AgentStatus
      return true
    }
    case 'plan_update': {
      state.plan = (data.plan as Plan | null) ?? null
      return true
    }
    case 'tool_status': {
      // In-place tool_use mutations arrive diffed — patch the mirrored
      // messages by (messageId, toolUseId).
      const byId = new Map(state.messages.map((m) => [m.id, m]))
      for (const u of data.updates) {
        const msg = byId.get(u.messageId)
        if (!msg) continue
        for (const block of msg.contentBlocks ?? []) {
          if (block.type !== 'tool_use' || (block as { id?: string }).id !== u.toolUseId) continue
          const tu = block as { status?: string; exitCode?: number; output?: string }
          if (u.status !== undefined) tu.status = u.status
          if (u.exitCode !== undefined) tu.exitCode = u.exitCode
          if (u.output !== undefined) tu.output = u.output
        }
      }
      return true
    }
    case 'error': {
      state.agentStatus = { status: 'error', error: data.message }
      return true
    }
    default:
      return false
  }
}

/** Seed a mirror from a main-side snapshot (reactivating a live session). */
export function seedSessionState(state: SessionState, snapshot: {
  messages: unknown[]
  status: { status: string }
  streamingBlocks: unknown[]
  plan: unknown
}): void {
  state.messages = snapshot.messages as AgentMessage[]
  state.agentStatus = { status: snapshot.status.status } as AgentStatus
  state.streamingBlocks = snapshot.streamingBlocks as ContentBlock[]
  state.plan = (snapshot.plan as Plan | null) ?? null
}
