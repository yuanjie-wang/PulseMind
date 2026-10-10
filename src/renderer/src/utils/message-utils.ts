import type { Conversation, Message } from '../../../shared/types/conversation'
import type { AgentMessage, ContentBlock, ToolUseBlock } from '../types/agent'

/** Strip runtime-only fields from content blocks before persistence. */
function sanitizeContentBlocks(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.map((b) => {
    if (b.type === 'tool_use') {
      // status is a runtime UI-only concern — never persist it,
      // otherwise partially-executed tools can show stale 'running' status on reload.
      // THE exception is 'rejected' (2026-10-10): a rejection also writes a
      // tool_result (the loop needs one to continue), so the reload rule
      // "tool_result exists → completed" used to flip every rejected call to
      // completed — the rejection glyph (MessageGroup) and the execution
      // segment's rejection count (ExecutionSegment) vanished after a reload.
      // 'rejected' is terminal, cannot go stale, and nothing else restores it.
      if (b.status === 'rejected') return b
      const rest = { ...b } as ToolUseBlock & { status?: string }
      delete rest.status
      return rest as ContentBlock
    }
    return b
  })
}

/** Convert AgentMessage[] to Conversation for storage. */
export function agentMessagesToConversation(
  msgs: AgentMessage[],
  convId: string,
  title: string
): Conversation {
  const now = new Date().toISOString()
  return {
    id: convId,
    title,
    messages: msgs.map((m, i) => {
      const textContent =
        m.contentBlocks
          .filter((b) => b.type === 'text')
          .map((b) => (b as { type: 'text'; text: string }).text)
          .join('\n') || ''

      return {
        id: m.id || `msg_${convId}_${i}_${Date.now()}`,
        role: m.role,
        content: textContent,
        contentBlocks: sanitizeContentBlocks(m.contentBlocks),
        createdAt: m.createdAt || now,
        liked: m.liked,
        favorited: m.favorited,
        processingMs: m.processingMs,
        inputTokens: m.inputTokens,
        outputTokens: m.outputTokens
      }
    }),
    createdAt: now,
    updatedAt: now
  }
}

/** Convert stored Message[] to AgentMessage[]. */
export function storedMessagesToAgentMessages(msgs: Message[]): AgentMessage[] {
  const toolResultIds = new Set<string>()

  const agentMsgs: AgentMessage[] = msgs.map((m) => {
    const blocks: ContentBlock[] =
      m.contentBlocks && m.contentBlocks.length > 0
        ? m.contentBlocks
        : [{ type: 'text' as const, text: m.content || '' }]

    // Collect tool_result IDs during first pass to avoid a second iteration
    for (const b of blocks) {
      if (b.type === 'tool_result') toolResultIds.add(b.tool_use_id)
    }

    return {
      id: m.id,
      role: m.role,
      contentBlocks: blocks,
      createdAt: m.createdAt,
      liked: m.liked,
      favorited: m.favorited,
      processingMs: m.processingMs,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      autoSummary: m.autoSummary,
      compressedIds: m.compressedIds
    } as AgentMessage
  })

  // Derive tool_use status from tool_result presence (status is stripped on save
  // since it's a runtime-only concern — restore it here so the UI shows completion).
  // A block that PERSISTED a status keeps it: 'rejected' survives sanitization
  // precisely so this derivation does not overwrite it with completed.
  if (toolResultIds.size > 0) {
    for (const msg of agentMsgs) {
      for (const b of msg.contentBlocks) {
        if (b.type === 'tool_use' && toolResultIds.has(b.id)) {
          const tool = b as ToolUseBlock
          if (tool.status === undefined) tool.status = 'completed'
        }
      }
    }
  }

  return agentMsgs
}

