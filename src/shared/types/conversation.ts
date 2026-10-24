import type { ContentBlock } from './agent'
import type { SandboxApprovalMode } from '../sandbox/policy'

export interface ConversationIndexEntry {
  id: string
  title: string
  lastMessage: string | null
  messageCount: number
  createdAt: string
  updatedAt: string
  summary?: string
  keywords?: string
  pinned?: boolean
  /** Owning project (welcome page picker); 'default' = none. */
  projectId?: string
  /** Resolved working directory (PLAN-0.4.0 M8); absent until first session. */
  workspaceDir?: string
  /** Summoned expert bound to this conversation (@-mention); absent when unbound. */
  expertId?: string
  /** How this conversation gates tool calls; absent = never chosen ('auto').
   *  Approval is per conversation — a project policy has no say in it. */
  approvalMode?: SandboxApprovalMode
  /** The LLM profile this conversation pinned itself to (composer's 模型下拉);
   *  absent = never chosen — the conversation follows the global default
   *  (`settings.activeProfileId`) and moves when the default moves. */
  profileId?: string
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  contentBlocks?: ContentBlock[]
  createdAt: string
  liked?: boolean
  favorited?: boolean
  processingMs?: number
  inputTokens?: number
  outputTokens?: number
  /** Provider-reported prefix cache hits inside inputTokens (OpenAI
   *  `prompt_cache_hit_tokens` / `prompt_tokens_details.cached_tokens`,
   *  Anthropic `cache_read_input_tokens`). Persisted as messages.cached_tokens
   *  so a finished task's true billable split stays auditable after the
   *  request dumps have been pruned. */
  promptCacheHitTokens?: number
  autoSummary?: boolean
  compressedIds?: string[]
}

export interface Conversation {
  id: string
  title: string
  messages: Message[]
  createdAt: string
  updatedAt: string
  summary?: string
  /** LLM-generated summary of the leading history dropped by hardTruncate (API-copy only, never shown). */
  historySummary?: string
  /** id of the first kept message at the time the summary was generated. */
  historySummaryFrontier?: string
  /** How this conversation gates tool calls; absent = never chosen (the
   *  shared default 按需确认). Read-only here — writes go through
   *  setConversationApprovalMode, and upserts never touch the column. */
  approvalMode?: SandboxApprovalMode
  /** The LLM profile this conversation pinned itself to; absent = follows the
   *  global default. Read-only here — writes go through
   *  setConversationProfile, and upserts never touch the column. */
  profileId?: string
}

export interface ToolResultBatchEntry {
  ref_id: string
  message_id: string
  block_index: number
  tool_use_id: string
  content: string
  is_error: number
}

export interface TokenStats {
  hourly: Array<{ time: string; inputTokens: number; outputTokens: number; cachedTokens?: number }>
  daily: Array<{ date: string; inputTokens: number; outputTokens: number; cachedTokens?: number }>
  monthly: Array<{ month: string; inputTokens: number; outputTokens: number; cachedTokens?: number }>
}
