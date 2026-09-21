/**
 * Client-side mirror of a main-hosted session (PLAN-0.3.5 M1.4).
 *
 * Engines live in the main process; every client that shows one keeps a local
 * copy of its observable state and folds the session event stream into it. The
 * reducer here is that fold — shared by the chat client (useConversationEngine),
 * the tool studio client and the browser extension panel so all three interpret
 * the wire protocol identically (PLAN-browser-extension §3.1.4).
 *
 * DOM-free by construction: the extension runs this inside a content script.
 */
import type { AgentMessage, AgentStatus, ContentBlock, Plan, ToolUseBlock } from '../../renderer/src/types/agent'
import type { AgentEventData } from '../agent-protocol'
import { applyMessagesAppend } from './messages'

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

/** Fold the wire's (status, error) pair into a mirrored status.
 *
 *  The error text IS the payload of a failed status: main's `onStatusChanged`
 *  carries it deliberately (session-manager.ts — "Loop failures carry their
 *  reason") so a client can say why the turn died, and every client renders it
 *  (`agentStatus.error` — ChatView / TranscriptView, the panel's ErrorCard).
 *  A fold that keeps only the status word leaves all of them falling back to
 *  their own copy (Unknown error / 未知错误), which is what turned every engine
 *  failure into a mystery. One place interprets the pair: the event fold, the
 *  desktop snapshot seed and the panel's snapshot seed all call this.
 *
 *  `error` is left OFF when the wire did not carry one (a status emitted
 *  without it, an older main) — the clients' fallback is then honest. */
export function mirroredStatus(status: string, error?: string): AgentStatus {
  if (status === 'error' && error !== undefined) return { status: 'error', error }
  return { status } as AgentStatus
}

export function isActiveStatus(status: AgentStatus): boolean {
  return status.status === 'streaming'
    || status.status === 'awaiting_approval'
    || status.status === 'awaiting_user_input'
    || status.status === 'executing'
    || status.status === 'awaiting_extension'
    || status.status === 'retrying'
}

/** One entry of the engine's diffed tool_use mutation stream (see the
 *  `tool_status` case in applySessionEvent). */
type ToolStatusUpdate = Extract<AgentEventData, { type: 'tool_status' }>['updates'][number]

/** A block carrying one patch, as a NEW object — the fold never edits a mirrored
 *  block in place (see the tool_status case for why). */
function patchToolUse(block: ToolUseBlock, u: ToolStatusUpdate): ToolUseBlock {
  return {
    ...block,
    ...(u.status !== undefined ? { status: u.status as ToolUseBlock['status'] } : {}),
    ...(u.exitCode !== undefined ? { exitCode: u.exitCode } : {}),
    ...(u.output !== undefined ? { output: u.output } : {}),
    // The spawn link arrives after the block did (spawn_agent writes it while
    // executing), which is exactly what this diff exists for.
    ...(u.subConvId !== undefined ? { subConvId: u.subConvId } : {}),
    ...(u.planNodeId !== undefined ? { planNodeId: u.planNodeId } : {}),
  }
}

/** One entry of the engine's diffed message-level stat stream (see the
 *  `message_stats` case in applySessionEvent). */
type MessageStatsUpdate = Extract<AgentEventData, { type: 'message_stats' }>['updates'][number]

/** A message carrying one stats patch, as a NEW object — the identity discipline
 *  `patchToolUse` documents below applies here too: the views that render a
 *  message are memoized on it, so an edit in place reads as "nothing happened". */
function patchMessageStats(msg: AgentMessage, u: MessageStatsUpdate): AgentMessage {
  return {
    ...msg,
    ...(u.processingMs !== undefined ? { processingMs: u.processingMs } : {}),
    ...(u.inputTokens !== undefined ? { inputTokens: u.inputTokens } : {}),
    ...(u.outputTokens !== undefined ? { outputTokens: u.outputTokens } : {}),
    ...(u.promptCacheHitTokens !== undefined ? { promptCacheHitTokens: u.promptCacheHitTokens } : {}),
  }
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
    case 'messages_update': {
      const byId = new Map((data.items as AgentMessage[]).map(message => [message.id, message]))
      state.messages = state.messages.map(message => {
        const update = byId.get(message.id)
        return update ? { ...message, ...update, contentBlocks: update.contentBlocks.map(block => ({ ...block })) } : message
      })
      return true
    }
    case 'message_stats': {
      // The turn's wall clock is stamped on the final message after it was
      // already appended (shared/agent-session/message-stats.ts) — without this
      // fold the mirror keeps whatever the message carried at append time.
      const byId = new Map(data.updates.map((u) => [u.messageId, u]))
      state.messages = state.messages.map((msg) => {
        const u = byId.get(msg.id)
        return u ? patchMessageStats(msg, u) : msg
      })
      return true
    }
    case 'streaming_blocks': {
      state.streamingBlocks = data.blocks as ContentBlock[]
      return true
    }
    case 'status': {
      state.agentStatus = mirroredStatus(data.status, data.error)
      return true
    }
    case 'plan_update': {
      // PlanSnapshot is the engine's own Plan (a type alias, not a projection),
      // so the wire bytes are the shape the event names — no cast, no drift.
      state.plan = data.plan ?? null
      return true
    }
    case 'tool_status': {
      // The engine mutates tool_use blocks in place and the wire carries only the
      // diff — patch the mirrored messages by (messageId, toolUseId). The patch
      // REPLACES the touched message and block objects instead of writing into
      // them, because identity is the contract every view that renders a tool
      // block is memoized on: MessageGroup, ExecutionSegment and CommandCard are
      // React.memo, and matchSegment() decides a segment changed by comparing
      // tool_use statuses. A block edited in place keeps its identity, so all of
      // them concluded nothing had happened — which is how an answered question
      // kept its chips and its input box on screen, still clickable, after the
      // answer landed.
      const byMessage = new Map<string, ToolStatusUpdate[]>()
      for (const u of data.updates) {
        const list = byMessage.get(u.messageId)
        if (list) list.push(u)
        else byMessage.set(u.messageId, [u])
      }
      state.messages = state.messages.map((msg) => {
        const updates = byMessage.get(msg.id)
        if (!updates) return msg
        let touched = false
        const blocks = msg.contentBlocks.map((block) => {
          if (block.type !== 'tool_use') return block
          const u = updates.find((x) => x.toolUseId === block.id)
          if (!u) return block
          touched = true
          return patchToolUse(block, u)
        })
        return touched ? { ...msg, contentBlocks: blocks } : msg
      })
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
  status: { status: string; error?: string }
  streamingBlocks: unknown[]
  plan: unknown
}): void {
  state.messages = snapshot.messages as AgentMessage[]
  state.agentStatus = mirroredStatus(snapshot.status.status, snapshot.status.error)
  state.streamingBlocks = snapshot.streamingBlocks as ContentBlock[]
  state.plan = (snapshot.plan as Plan | null) ?? null
}
