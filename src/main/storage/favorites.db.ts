import { getDb } from './database'

export interface FavoriteRow {
  id: string
  message_id: string
  conversation_id: string
  conversation_title: string
  role: string
  content: string
  content_blocks: string | null
  created_at: string
}

export function addFavorite(id: string, messageId: string, conversationId: string, conversationTitle: string, role: string, content: string, contentBlocks: string | null): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO favorites (id, message_id, conversation_id, conversation_title, role, content, content_blocks, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, messageId, conversationId, conversationTitle, role, content, contentBlocks, new Date().toISOString())
}

export function removeFavorite(messageId: string): void {
  getDb().prepare('DELETE FROM favorites WHERE message_id = ?').run(messageId)
}

export function listFavorites(): FavoriteRow[] {
  return getDb()
    .prepare('SELECT id, message_id, conversation_id, conversation_title, role, content, content_blocks, created_at FROM favorites ORDER BY created_at DESC')
    .all() as FavoriteRow[]
}

export function isFavorited(messageId: string): boolean {
  const row = getDb().prepare('SELECT 1 FROM favorites WHERE message_id = ? LIMIT 1').get(messageId)
  return !!row
}
