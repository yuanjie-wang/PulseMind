export type {
  Conversation,
  ConversationIndexEntry,
  Message,
  TokenStats,
  ToolResultBatchEntry
} from '../../../shared/types/conversation'

import type { SandboxApprovalMode } from '../../../shared/sandbox/policy'

/**
 * A conversation as the sidebar renders it — the persisted index fields the list actually
 * needs. `updatedAt` is the last message time, shown as a relative duration under the title.
 */
export type ConversationListItem = {
  key: string
  label: string
  pinned?: boolean
  updatedAt?: string
  /** Owning project (welcome page picker); absent = default project. */
  projectId?: string
  /** Summoned expert bound via @-mention; absent = unbound. */
  expertId?: string
  /** Tool-approval level for this conversation; absent = never chosen, i.e. the
   *  shared DEFAULT_APPROVAL_MODE (按需确认). */
  approvalMode?: SandboxApprovalMode
}
