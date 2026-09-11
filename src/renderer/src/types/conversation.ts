export type {
  Conversation,
  ConversationIndexEntry,
  Message,
  TokenStats,
  ToolResultBatchEntry
} from '../../../shared/types/conversation'

/**
 * A conversation as the sidebar renders it — the persisted index fields the list actually
 * needs. `updatedAt` is the last message time, shown as a relative duration under the title.
 */
export type ConversationListItem = {
  key: string
  label: string
  pinned?: boolean
  updatedAt?: string
}
