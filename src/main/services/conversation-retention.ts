// ── Conversation retention (对话管理 · 最长保留时长) ──
// Enforces settings.conversationRetentionDays: unpinned normal conversations
// whose last update predates the window are deleted (deleteConversation's FK
// cascade takes their messages with them). Runs at startup and after each
// settings save, so a tightened policy takes effect without a restart. A
// conversation with a live agent session is never deleted — the session
// manager decides what "live" means.

import { settingsStore } from '../storage/settings-store'
import { listExpiredConversationIds, deleteConversation } from '../storage/conversation.db'
import { agentSessionManager } from '../agent/session-manager'

/** Delete conversations past the retention window; returns how many went. */
export async function cleanupExpiredConversations(): Promise<number> {
  const { conversationRetentionDays } = await settingsStore.get()
  if (!conversationRetentionDays || conversationRetentionDays <= 0) return 0
  let removed = 0
  for (const id of listExpiredConversationIds(conversationRetentionDays)) {
    if (agentSessionManager.hasSession(id)) continue
    try {
      deleteConversation(id)
      removed += 1
    } catch (err) {
      console.warn('[retention] delete failed:', id, err)
    }
  }
  if (removed > 0) console.log(`[retention] removed ${removed} conversation(s) older than ${conversationRetentionDays}d`)
  return removed
}
