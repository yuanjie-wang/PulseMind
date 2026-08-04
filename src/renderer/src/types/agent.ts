import type { ContentBlock, TextBlock, ToolUseBlock, ToolResultBlock, ThinkingBlock, RedactedThinkingBlock } from '../../../shared/types/agent'

export type { ContentBlock, TextBlock, ToolUseBlock, ToolResultBlock, ThinkingBlock, RedactedThinkingBlock }

// --- Agent Loop Status ---

export type AgentStatus =
  | { status: 'idle' }
  | { status: 'streaming' }
  | { status: 'retrying'; message: string; attempt: number; maxRetries: number; delay: number }
  | { status: 'awaiting_approval'; tools: ToolUseBlock[] }
  | { status: 'awaiting_user_input'; tools: ToolUseBlock[] }
  | { status: 'executing'; toolUseId: string }
  | { status: 'completed' }
  | { status: 'error'; error: string }
  | { status: 'awaiting_extension'; currentCount: number; limit: number }
  | { status: 'awaiting_continue'; subAgentCount?: number }

// --- Agent Message ---

export interface AgentMessage {
  id: string
  role: 'user' | 'assistant'
  contentBlocks: ContentBlock[]
  createdAt: string
  processingMs?: number
  inputTokens?: number
  outputTokens?: number
  promptCacheHitTokens?: number
  liked?: boolean
  favorited?: boolean
  autoSummary?: boolean
  compressedIds?: string[]
}

// --- Plan ---

export interface PlanStep {
  description: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  /** Message ID to jump to for this step's conversation round. */
  msgId?: string
}

export interface Plan {
  objective: string
  steps: PlanStep[]
  currentStepIndex: number
  completed: boolean
  mode?: 'direct' | 'delegated'
}

// --- Helper: convert content blocks to Anthropic API format ---

export function contentBlocksToApi(
  blocks: ContentBlock[]
): string | Array<Record<string, unknown>> {
  if (blocks.length === 1 && blocks[0].type === 'text') {
    return blocks[0].text
  }

  return blocks.map((block) => {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: block.text }
      case 'thinking':
        return {
          type: 'thinking',
          thinking: block.thinking,
          ...(block.signature ? { signature: block.signature } : {})
        }
      case 'redacted_thinking':
        return { type: 'redacted_thinking', data: block.data }
      case 'tool_use':
        return {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input
        }
      case 'tool_result':
        return {
          type: 'tool_result',
          tool_use_id: block.tool_use_id,
          content: block.content,
          ...(block.is_error ? { is_error: true } : {})
        }
      default:
        return { type: 'text', text: '' }
    }
  })
}
