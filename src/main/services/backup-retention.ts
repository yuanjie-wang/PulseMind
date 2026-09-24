// ── Backup retention (PLAN-security-hardening P3-a) ──
// db/ held three unmanaged plaintext backups from August (158/45/148MB) that
// no cleanup policy touched — full copies of the conversation database sitting
// next to the live one. This module expires them by name pattern + mtime, at
// startup and after each settings save (the retention family's existing
// rhythm, mirroring conversation-retention.ts).
//
// The name pattern is deliberately STRICT: only the two shapes this app's own
// tooling ever produced (`pulsemind.backup_<ts>.db` / `pulsemind.db.bak_<tag>.db`)
// are expirable, so `pulsemind.db`, its -wal/-shm siblings and any file a user
// dropped there under another name are physically outside the pattern's reach.
// UI is deliberately not built this wave (debugLlmRequests precedent): the
// settings.json field + this module are the whole delivery.

import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from '../storage'
import { auditStore } from '../storage/audit-store'

const DB_DIR = join(DATA_DIR, 'db')

/** Covers both measured shapes: `pulsemind.backup_20260811_153730.db` and
 *  `pulsemind.db.bak_experience_dedup_20260804` — note the second has NO
 *  trailing `.db`, so the suffix is optional; the `_tag` part is what makes
 *  it a tool-produced backup rather than any file the user dropped here. */
const EXPIRABLE_BACKUP_RE = /^pulsemind(\.db)?\.(bak|backup)_\w+(\.db)?$/

export function isExpirableBackupName(name: string): boolean {
  return EXPIRABLE_BACKUP_RE.test(name)
}

/** The pure half: which of these names are past the window. retentionDays 0
 *  = keep forever (the explicit opt-out), so nothing is ever selected. */
export function selectExpiredBackups(names: string[], nowMs: number, retentionDays: number, mtimeOf: (name: string) => number): string[] {
  if (!retentionDays || retentionDays <= 0) return []
  const cutoff = nowMs - retentionDays * 24 * 60 * 60 * 1000
  return names.filter((name) => isExpirableBackupName(name) && mtimeOf(name) < cutoff)
}

/** Delete expired db backups; returns how many went. Best-effort per file:
 *  one undeletable backup (AV lock) must not stop the rest. */
export function expireOldBackups(retentionDays?: number): number {
  const days = retentionDays
  let names: string[] = []
  try {
    names = readdirSync(DB_DIR) as string[]
  } catch {
    return 0
  }
  const mtimes = new Map<string, number>()
  const expired = selectExpiredBackups(
    names,
    Date.now(),
    days ?? 30,
    (name) => {
      if (!mtimes.has(name)) {
        try {
          mtimes.set(name, statSync(join(DB_DIR, name)).mtimeMs)
        } catch {
          mtimes.set(name, Date.now()) // unreadable → treat as fresh, never delete on a guess
        }
      }
      return mtimes.get(name)!
    },
  )
  let removed = 0
  for (const name of expired) {
    try {
      unlinkSync(join(DB_DIR, name))
      removed++
      console.log(`[retention] expired db backup: ${name}`)
      // The deletion is a privacy-relevant destruction of conversation
      // history — it goes to the audit log even though the backup itself is
      // the thing being cleaned up.
      auditStore.record({ scope: 'storage', action: 'backup.expire', decision: 'allow', target: name })
    } catch (err) {
      console.warn('[retention] backup delete failed:', name, err)
    }
  }
  return removed
}
