import type { ContentBlock, TextBlock, ToolUseBlock, ToolResultBlock, ThinkingBlock, RedactedThinkingBlock } from '../../../shared/types/agent'

export type { ContentBlock, TextBlock, ToolUseBlock, ToolResultBlock, ThinkingBlock, RedactedThinkingBlock }

// --- Agent Loop Status ---

/** 回合是怎么收尾的（2026-11-12）：纯观测字段，不参与任何分支判定。
 *  adapter 的原始 stop_reason 经 classifyStopReason 收敛到这几个词；未识别的
 *  （pause_turn / refusal / null）落 'unknown' —— 归一化本身是另一件事，这里
 *  只做分类，不做纠偏：把 pause_turn 当完成还是当续跑，得单独裁。 */
export type TurnStopReason = 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence' | 'unknown'

export type AgentStatus =
  | { status: 'idle' }
  | { status: 'streaming' }
  | { status: 'retrying'; message: string; attempt: number; maxRetries: number; delay: number
      /** The session's effective context window when this retry armed an
       *  overflow re-aim (parsed off the provider's own rejection) — the ring
       *  denominator's live hint. Optional; only the overflow-retry shape sets
       *  it, every other retrying status leaves it out. */
      contextWindow?: number }
  | { status: 'awaiting_approval'; tools: ToolUseBlock[] }
  | { status: 'awaiting_user_input'; tools: ToolUseBlock[] }
  | { status: 'executing'; toolUseId: string }
  | { status: 'completed'; stopReason?: TurnStopReason }
  | { status: 'error'; error: string }
  | { status: 'awaiting_extension'; currentCount: number; limit: number }
  | { status: 'awaiting_continue'; subAgentCount?: number }

/** Mid-stream steering outcome (PLAN-mid-stream-steer M1): the engine's answer
 *  to a steer attempt. Rejections are structured so the UI can fall back to
 *  the staging path instead of losing the text. */
export type SteerOutcome =
  | { ok: true }
  | { ok: false; reason: 'not_streaming' | 'no_active_stream' | 'empty'; status?: AgentStatus['status'] }

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
  /** 本回合的收尾方式（2026-11-12，runtime mark——只在
   *  内存里活）：max_tokens = 输出被长度上限切断、可能半截话，与 end_turn
   *  （模型自己停的）必须能分开。messages 表还没有这一列，落库要连带 DDL、
   *  老库 ALTER 与 conversation.db 四处读写，另案处理。 */
  stopReason?: TurnStopReason
  liked?: boolean
  favorited?: boolean
  autoSummary?: boolean
  compressedIds?: string[]
}

// --- Plan (v2 DAG — the model lives in shared so the main process and the
// extension reducer see the same shape; PLAN-plan-dag D10) ---

export type { Plan, PlanNode, PlanNodeStatus } from '../../../shared/types/plan'

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
