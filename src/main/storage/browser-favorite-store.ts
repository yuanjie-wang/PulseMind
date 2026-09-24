// ── Browser favorites store (PLAN-browser-favorites) ──
// 收藏是「要去」，历史是「去过」(裁定 L1 的精神延伸)：只有用户（或用户明说
// 时的模型）策展，agent 打开的 URL 永不自动进收藏。全局一份，不分会话
// (L2)；键 = 规范化 URL（host 小写、去尾斜杠、去 hash，L3）；不做 LRU
// 淘汰——被静默删掉的收藏是用户发现不了的数据丢失，上限 200 只防炸，到顶
// add 报错提示先删 (L4)。读写 best-effort：收藏失败绝不影响导航本身。

import { getDb } from './database'
import { auditStore } from './audit-store'
import { normalizeFavoriteUrl } from '../../shared/browser/pane'

/** Hard cap, pinned (裁定 L4). Not an LRU — an over-cap add FAILS with a
 *  model/user-facing message instead of silently dropping anything. */
export const MAX_BROWSER_FAVORITES = 200

export interface BrowserFavoriteRow {
  url: string
  title: string | null
  createdAt: number
  updatedAt: number
}

function toRow(r: Record<string, unknown>): BrowserFavoriteRow {
  return {
    url: String(r.url),
    title: (r.title as string) || null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  }
}

export const browserFavoriteStore = {
  /** Idempotent upsert by normalized URL: same page re-added refreshes the
   *  title (when one is given) and counts as ONE entry (裁定 L3). Returns the
   *  stored row and whether it was newly created; throws the over-cap error
   *  for the caller to surface. */
  add(url: string, title?: string, at = Date.now()): { url: string; title: string | null; created: boolean } {
    const normalized = normalizeFavoriteUrl(url)
    if (!normalized) throw new Error('无法收藏：URL 为空或无法规范化')
    try {
      const db = getDb()
      const existing = db.prepare('SELECT url FROM browser_favorites WHERE url = ?').get(normalized)
      if (existing) {
        if (title) {
          db.prepare('UPDATE browser_favorites SET title = ?, updated_at = ? WHERE url = ?').run(title, at, normalized)
        }
        return { url: normalized, title: title ?? null, created: false }
      }
      const count = (db.prepare('SELECT COUNT(*) AS c FROM browser_favorites').get() as { c: number }).c
      if (count >= MAX_BROWSER_FAVORITES) {
        throw new Error(`收藏已满（${MAX_BROWSER_FAVORITES} 条）——先删除一些再收藏`)
      }
      db.prepare(
        'INSERT INTO browser_favorites (url, title, created_at, updated_at) VALUES (?, ?, ?, ?)'
      ).run(normalized, title ?? null, at, at)
      return { url: normalized, title: title ?? null, created: true }
    } catch (err) {
      if (err instanceof Error && err.message.includes('收藏已满')) throw err
      console.warn('[BrowserFavorites] add failed:', err)
      throw err instanceof Error ? err : new Error(String(err))
    }
  },

  remove(url: string): boolean {
    const normalized = normalizeFavoriteUrl(url)
    if (!normalized) return false
    try {
      const r = getDb().prepare('DELETE FROM browser_favorites WHERE url = ?').run(normalized)
      return r.changes > 0
    } catch (err) {
      console.warn('[BrowserFavorites] remove failed:', err)
      return false
    }
  },

  list(): BrowserFavoriteRow[] {
    try {
      return (getDb()
        .prepare('SELECT url, title, created_at, updated_at FROM browser_favorites ORDER BY created_at DESC')
        .all() as Array<Record<string, unknown>>).map(toRow)
    } catch (err) {
      console.warn('[BrowserFavorites] list failed:', err)
      return []
    }
  },

  /** Substring match over url + title, newest first (dropdown 联想). */
  query(text: string, limit = 8): BrowserFavoriteRow[] {
    const needle = text.trim()
    try {
      const rows = (
        needle
          ? getDb()
              .prepare(
                `SELECT url, title, created_at, updated_at FROM browser_favorites
                 WHERE url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\'
                 ORDER BY updated_at DESC LIMIT ?`
              )
              .all(`%${needle.replace(/[%_]/g, (c) => `\\${c}`)}%`, `%${needle.replace(/[%_]/g, (c) => `\\${c}`)}%`, limit)
          : getDb()
              .prepare('SELECT url, title, created_at, updated_at FROM browser_favorites ORDER BY updated_at DESC LIMIT ?')
              .all(limit)
      ) as Array<Record<string, unknown>>
      return rows.map(toRow)
    } catch (err) {
      console.warn('[BrowserFavorites] query failed:', err)
      return []
    }
  },

  has(url: string): boolean {
    const normalized = normalizeFavoriteUrl(url)
    if (!normalized) return false
    try {
      return !!getDb().prepare('SELECT url FROM browser_favorites WHERE url = ?').get(normalized)
    } catch (err) {
      console.warn('[BrowserFavorites] has failed:', err)
      return false
    }
  },

  clear(): void {
    try {
      getDb().prepare('DELETE FROM browser_favorites').run()
      // Clearing is a privacy action — audited (same as history, 裁定 L4).
      auditStore.record({ scope: 'browser', action: 'browser.favoritesClear', decision: 'allowed' })
    } catch (err) {
      console.warn('[BrowserFavorites] clear failed:', err)
    }
  },
}
