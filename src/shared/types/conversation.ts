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
  hourly: Array<{ time: string; inputTokens: number; outputTokens: number }>
  daily: Array<{ date: string; inputTokens: number; outputTokens: number }>
  monthly: Array<{ month: string; inputTokens: number; outputTokens: number }>
}
