// ── Audit store (PLAN-0.4.0 M3.12 / M6.7) ──
// Append-only record of sandbox decisions and capability calls. Writes are
// best-effort: an audit failure must never break the flow it is auditing.

import { randomUUID } from 'node:crypto'
import { getDb } from './database'
import type { AuditEntry } from '../../shared/types/audit'

export type { AuditEntry }

export const auditStore = {
  record(entry: Omit<AuditEntry, 'id' | 'ts'>): void {
    try {
      const full: AuditEntry = { id: `aud_${randomUUID().slice(0, 12)}`, ts: new Date().toISOString(), ...entry }
      getDb()
        .prepare('INSERT INTO audit_log (id, ts, scope, actor, action, target, decision, policy_json, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(full.id, full.ts, full.scope, full.actor ?? null, full.action, full.target ?? null, full.decision, full.policyJson ?? null, full.metaJson ?? null)
    } catch (err) {
      console.warn('[Audit] record failed:', err)
    }
  },

  list(limit = 200): AuditEntry[] {
    try {
      const rows = getDb()
        .prepare('SELECT * FROM audit_log ORDER BY ts DESC LIMIT ?')
        .all(limit) as Array<Record<string, unknown>>
      return rows.map((r) => ({
        id: String(r.id),
        ts: String(r.ts),
        scope: String(r.scope),
        actor: (r.actor as string) || undefined,
        action: String(r.action),
        target: (r.target as string) || undefined,
        decision: String(r.decision),
        policyJson: (r.policy_json as string) || undefined,
        metaJson: (r.meta_json as string) || undefined,
      }))
    } catch (err) {
      console.warn('[Audit] list failed:', err)
      return []
    }
  },
}
