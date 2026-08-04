import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { addFavorite, removeFavorite, listFavorites } from '../storage/favorites.db'

export function registerFavoriteHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.FAVORITE_ADD, async (_event, data: {
    id: string
    messageId: string
    conversationId: string
    conversationTitle: string
    role: string
    content: string
    contentBlocks?: string | null
  }) => {
    try {
      addFavorite(data.id, data.messageId, data.conversationId, data.conversationTitle, data.role, data.content, data.contentBlocks ?? null)
      return { success: true }
    } catch (e) {
      console.error('[Favorites] add error:', e)
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.FAVORITE_REMOVE, async (_event, messageId: string) => {
    try {
      removeFavorite(messageId)
      return { success: true }
    } catch (e) {
      console.error('[Favorites] remove error:', e)
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.FAVORITE_LIST, async () => {
    try {
      const rows = listFavorites()
      return rows.map((r) => ({
        id: r.id,
        messageId: r.message_id,
        conversationId: r.conversation_id,
        conversationTitle: r.conversation_title,
        role: r.role,
        content: r.content,
        contentBlocks: r.content_blocks ? JSON.parse(r.content_blocks) : undefined,
        createdAt: r.created_at
      }))
    } catch (e) {
      console.error('[Favorites] list error:', e)
      return []
    }
  })
}
