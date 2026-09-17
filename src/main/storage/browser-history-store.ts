// ── Browser history store (PLAN-browser-pane-ux T3) ──
// Address-bar history for the in-app browser pane. Only MANUAL navigation is
// recorded (裁定 L1: what the agent opens via its browser tools is not "where
// the user went"), and the table is GLOBAL — one shared history, not per
// conversation (裁定 L3). Writes are best-effort like the audit store: a
// history failure must never break the navigation it is remembering.

import { getDb } from './database'
import { auditStore } from './audit-store'

/** Hard cap, pinned like MAX_PARALLEL_SUBAGENTS — 裁定 L3. */
export const MAX_BROWSER_HISTORY = 500

export interface BrowserHistoryRow {
  url: string
  title: string | null
  visitCount: number
  lastVisitAt: number
}

export const browserHistoryStore = {
  /** Upsert one visit: +1 count, refresh title/timestamp, then evict beyond
   *  the cap by last_visit_at (LRU). `at` is injectable for tests. */
  recordVisit(url: string, title?: string, at = Date.now()): void {
    if (!url) return
    try {
      const db = getDb()
      const insert = db.transaction(() => {
        db.prepare(
          `INSERT INTO browser_history (url, title, visit_count, last_visit_at)
           VALUES (?, ?, 1, ?)
           ON CONFLICT(url) DO UPDATE SET
             title = COALESCE(excluded.title, browser_history.title),
             visit_count = browser_history.visit_count + 1,
             last_visit_at = excluded.last_visit_at`
        ).run(url, title ?? null, at)
        const overflow = (db.prepare('SELECT COUNT(*) AS c FROM browser_history').get() as { c: number }).c - MAX_BROWSER_HISTORY
        if (overflow > 0) {
          db.prepare(
            'DELETE FROM browser_history WHERE url IN (SELECT url FROM browser_history ORDER BY last_visit_at ASC LIMIT ?)'
          ).run(overflow)
        }
      })
      insert()
    } catch (err) {
      console.warn('[BrowserHistory] recordVisit failed:', err)
    }
  },

  /** Substring match over url + title, newest first. `limit` caps the panel's
   *  dropdown; ranking happens in shared/browser/pane.ts (pure). */
  query(text: string, limit = 50): BrowserHistoryRow[] {
    const needle = text.trim()
    if (!needle) return []
    try {
      const like = `%${needle.replace(/[%_]/g, (c) => `\\${c}`)}%`
      const rows = getDb()
        .prepare(
          `SELECT url, title, visit_count, last_visit_at FROM browser_history
           WHERE url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\'
           ORDER BY last_visit_at DESC LIMIT ?`
        )
        .all(like, like, limit) as Array<Record<string, unknown>>
      return rows.map((r) => ({
        url: String(r.url),
        title: (r.title as string) || null,
        visitCount: Number(r.visit_count),
        lastVisitAt: Number(r.last_visit_at),
      }))
    } catch (err) {
      console.warn('[BrowserHistory] query failed:', err)
      return []
    }
  },

  clear(): void {
    try {
      getDb().prepare('DELETE FROM browser_history').run()
      // Clearing is a privacy action — audited wherever it comes from (裁定 L4).
      auditStore.record({ scope: 'browser', action: 'browser.historyClear', decision: 'allowed' })
    } catch (err) {
      console.warn('[BrowserHistory] clear failed:', err)
    }
  },
}
