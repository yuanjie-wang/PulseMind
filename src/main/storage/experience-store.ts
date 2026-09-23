import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { ExperienceRecord, ExperienceDraft } from '../../shared/types/experience-types'
import { MAX_EXPERIENCES } from '../../shared/types/experience-types'
import { EXPERIENCES_DIR } from './index'
import { getDb } from './database'

function generateId(): string {
  return `exp_${Date.now()}_${randomBytes(4).toString('hex')}`
}

export function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80)
  return slug || `experience-${Date.now()}`
}

function localTimestamp(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function parseTriggers(raw: unknown): string[] | undefined {
  if (typeof raw !== 'string' || !raw) return undefined
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((k) => typeof k === 'string') : undefined
  } catch {
    return undefined
  }
}

function formatExperienceMd(rec: ExperienceRecord, content: string): string {
  const lines = [
    '---',
    `name: ${rec.name}`,
    `title: ${rec.title}`,
    `description: ${rec.description}`,
    `category: ${rec.category}`,
    `createdAt: ${rec.createdAt}`
  ]
  if (rec.triggers && rec.triggers.length > 0) {
    lines.push('triggers:', ...rec.triggers.map((t) => `  - ${t}`))
  }
  if (rec.sourceConversationId) lines.push(`sourceConversationId: ${rec.sourceConversationId}`)
  if (rec.lastUsedAt) lines.push(`lastUsedAt: ${rec.lastUsedAt}`)
  lines.push(`useCount: ${rec.useCount}`, '---', '', content)
  return lines.join('\n')
}

function rowToRecord(r: any): ExperienceRecord {
  return {
    id: r.id,
    name: r.name,
    title: r.title,
    description: r.description,
    category: r.category,
    sourceConversationId: r.source_conversation_id ?? undefined,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    useCount: r.use_count,
    triggers: parseTriggers(r.triggers)
  }
}

export class ExperienceStore {
  // ── Reads ──

  list(): ExperienceRecord[] {
    const rows = getDb()
      .prepare('SELECT * FROM experiences ORDER BY COALESCE(last_used_at, created_at) DESC')
      .all() as any[]
    return rows.map(rowToRecord)
  }

  async read(name: string): Promise<string | null> {
    try {
      return await readFile(join(EXPERIENCES_DIR, name, 'SKILL.md'), 'utf-8')
    } catch {
      return null
    }
  }

  // ── Writes ──

  /**
   * Persist an experience as a standalone SKILL.md under ~/.pulsemind/experiences/.
   * Enforces the MAX_EXPERIENCES cap with LRU eviction (least recently used wins
   * the old age first; never-used entries are evicted before used ones).
   */
  async save(draft: ExperienceDraft): Promise<{ record: ExperienceRecord; evicted?: ExperienceRecord }> {
    const name = slugifyTitle(draft.title)
    const existing = getDb().prepare('SELECT * FROM experiences WHERE name = ?').get(name) as any
    const now = localTimestamp()
    const record: ExperienceRecord = {
      id: existing?.id ?? generateId(),
      name,
      title: draft.title,
      description: draft.description,
      category: draft.category,
      sourceConversationId: draft.sourceConversationId,
      createdAt: existing?.created_at ?? now,
      lastUsedAt: existing?.last_used_at ?? null,
      useCount: existing?.use_count ?? 0,
      triggers: draft.triggers && draft.triggers.length > 0
        ? draft.triggers
        : parseTriggers(existing?.triggers)
    }
    await mkdir(join(EXPERIENCES_DIR, name), { recursive: true })
    await writeFile(join(EXPERIENCES_DIR, name, 'SKILL.md'), formatExperienceMd(record, draft.content), 'utf-8')
    getDb()
      .prepare(
        `INSERT INTO experiences (id, name, title, description, category, source_conversation_id, created_at, last_used_at, use_count, triggers)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           title = excluded.title,
           description = excluded.description,
           category = excluded.category,
           source_conversation_id = excluded.source_conversation_id,
           triggers = excluded.triggers`
      )
      .run(record.id, record.name, record.title, record.description, record.category, record.sourceConversationId ?? null, record.createdAt, record.lastUsedAt ?? null, record.useCount, JSON.stringify(record.triggers ?? []))
    const evicted = await this.enforceLimit()
    return { record, evicted }
  }

  /** Evict experiences beyond MAX_EXPERIENCES using LRU ordering.
   *  The count read and the row deletes run inside ONE synchronous
   *  transaction (PLAN-parallel-experts T11): two concurrent saves used to
   *  compute deletions from a stale total and over-evict. File removal
   *  happens after — outside the transaction, best-effort. */
  private async enforceLimit(): Promise<ExperienceRecord | undefined> {
    const db = getDb()
    const evict = db.transaction((): any[] => {
      const total = (db.prepare('SELECT COUNT(*) as c FROM experiences').get() as { c: number }).c
      if (total <= MAX_EXPERIENCES) return []
      const rows = db
        .prepare(
          `SELECT * FROM experiences
           ORDER BY (last_used_at IS NULL) DESC, COALESCE(last_used_at, '0') ASC, use_count ASC
           LIMIT ?`
        )
        .all(total - MAX_EXPERIENCES) as any[]
      const del = db.prepare('DELETE FROM experiences WHERE name = ?')
      for (const row of rows) del.run(row.name)
      return rows
    })
    const rows = evict()
    let evicted: ExperienceRecord | undefined
    for (const row of rows) {
      evicted = rowToRecord(row)
      await rm(join(EXPERIENCES_DIR, row.name), { recursive: true, force: true }).catch(() => {})
    }
    return evicted
  }

  async delete(name: string): Promise<void> {
    await rm(join(EXPERIENCES_DIR, name), { recursive: true, force: true })
    getDb().prepare('DELETE FROM experiences WHERE name = ?').run(name)
  }

  /** Remove every experience: all record dirs + the whole table. Returns the
   *  count that was removed. */
  async clear(): Promise<number> {
    const rows = getDb().prepare('SELECT name FROM experiences').all() as { name: string }[]
    getDb().prepare('DELETE FROM experiences').run()
    for (const row of rows) {
      await rm(join(EXPERIENCES_DIR, row.name), { recursive: true, force: true }).catch(() => {})
    }
    return rows.length
  }

  /** Record a trigger of an experience (called when the LLM reads it). */
  async touch(name: string): Promise<void> {
    getDb()
      .prepare('UPDATE experiences SET last_used_at = ?, use_count = use_count + 1 WHERE name = ?')
      .run(localTimestamp(), name)
  }
}

export const experienceStore = new ExperienceStore()
