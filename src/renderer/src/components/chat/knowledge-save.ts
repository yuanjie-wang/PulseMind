import type { KnowledgeFile } from '../../../../shared/types/knowledge'

export interface KnowledgeSaveInput {
  content: string
  messageId: string
  conversationId?: string
  title?: string
  writable: boolean
  favorited: boolean
}

export interface KnowledgeSaveDeps {
  save: (input: { content: string; messageId: string; conversationId: string; title?: string }) => Promise<KnowledgeFile>
  enqueue: (file: KnowledgeFile) => void
  pending: (value: boolean) => void
  success: () => void
  error: (error: unknown) => void
}

/**
 * Builds the one-way "save to knowledge" action behind a synchronous latch.
 *
 * - **Synchronous latch** (`pending`): two clicks that land before React
 *   commits (or before the async save resolves) still issue exactly one
 *   write, because the latch is a closure variable — not React state.
 * - **One-way**: once the save resolves, `saved` flips and every later call
 *   is a no-op. There is no unsave from here; deletion lives in the
 *   Knowledge Center. The caller's own `favorited` state guards too.
 * - **Saved only after persisted**: the caller's saved marker is flipped via
 *   `pending`/`success` only after the backend resolves — the backend stamps
 *   `messages.favorited` inside its save transaction, so a rejected save
 *   leaves the message unsaved and visibly errors, which keeps a retry
 *   possible.
 * - **No empty writes**: blank content, blank message/conversation ids, or a
 *   host that cannot write (`writable === false`) never reach the backend.
 */
export function createKnowledgeSaveAction(deps: KnowledgeSaveDeps, latch = { pending: false, saved: false }) {
  return async (input: KnowledgeSaveInput): Promise<void> => {
    if (latch.pending || latch.saved || input.favorited || !input.writable) return
    if (!input.content.trim() || !input.messageId.trim() || !input.conversationId?.trim()) return
    latch.pending = true
    deps.pending(true)
    try {
      const file = await deps.save({
        content: input.content,
        messageId: input.messageId,
        conversationId: input.conversationId,
        title: input.title
      })
      if (!file?.id) throw new Error('Knowledge save returned no file')
      latch.saved = true
      deps.enqueue(file)
      deps.success()
    } catch (error) {
      deps.error(error)
    } finally {
      latch.pending = false
      deps.pending(false)
    }
  }
}
