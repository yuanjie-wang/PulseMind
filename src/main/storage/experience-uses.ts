/**
 * 经验流水表 `experience_uses` 的读写层（2026-11-12 经验 SKILL 化 / n9）。
 *
 * 经验的**正文与静态元数据**（title / description / aliases / maturity）真源是磁盘
 * `~/.pulsemind/experience/<id>/EXPERIENCE.md`；这里只承接**流水**：用了几次、何时用、
 * 重现几次、采没采纳、退没退役、被谁取代。
 *
 * 行是惰性创建的：磁盘上有目录、表里没行，等价于「全新经验，计数全零」，
 * 而不是「数据丢失」——所以所有读函数都必须容忍缺失，只有写函数才建行。
 */
import { getDb } from './database'

export interface ExperienceUsesRow {
  id: string
  useCount: number
  recurrence: number
  lastUsedAt: string | null
  lastReinforcedAt: string | null
  sopAttempts: number
  sopLastAttemptAt: string | null
  supersededBy: string | null
  retiredAt: string | null
  retireReason: string | null
  sourceConversationId: string | null
  enabled: boolean
  createdAt: string
  updatedAt: string
}

interface RawRow {
  id: string
  use_count: number
  recurrence: number
  last_used_at: string | null
  last_reinforced_at: string | null
  sop_attempts: number
  sop_last_attempt_at: string | null
  superseded_by: string | null
  retired_at: string | null
  retired_reason: string | null
  source_conversation_id: string | null
  enabled: number
  created_at: string
  updated_at: string
}

function toRow(r: RawRow): ExperienceUsesRow {
  return {
    id: r.id,
    useCount: r.use_count ?? 0,
    recurrence: r.recurrence ?? 0,
    lastUsedAt: r.last_used_at ?? null,
    lastReinforcedAt: r.last_reinforced_at ?? null,
    sopAttempts: r.sop_attempts ?? 0,
    sopLastAttemptAt: r.sop_last_attempt_at ?? null,
    supersededBy: r.superseded_by ?? null,
    retiredAt: r.retired_at ?? null,
    retireReason: r.retired_reason ?? null,
    sourceConversationId: r.source_conversation_id ?? null,
    enabled: r.enabled !== 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export function getExperienceUses(id: string): ExperienceUsesRow | null {
  const row = getDb().prepare('SELECT * FROM experience_uses WHERE id = ?').get(id) as RawRow | undefined
  return row ? toRow(row) : null
}

/** 惰性建行：磁盘上新增一条经验时调用。已存在则只刷新流水里随正文走的字段。
 *  enabled 只在**显式传入**时才覆盖既有行——所有 ensure 调用方（update/alias/
 *  reinforce/supersede-join）都不传，缺省值若参与 ON CONFLICT 会把用户停用的
 *  经验打回启用（2026-11-12 review 实锤）：ensure 是「随正文走」的刷新，不是开关。 */
export function ensureExperienceUses(
  id: string,
  opts: { sourceConversationId?: string | null; enabled?: boolean; createdAt?: string; updatedAt?: string } = {},
): void {
  const now = opts.updatedAt ?? new Date().toISOString()
  getDb()
    .prepare(
      `INSERT INTO experience_uses (id, use_count, recurrence, last_used_at, last_reinforced_at,
        sop_attempts, sop_last_attempt_at, superseded_by, retired_at, retired_reason,
        source_conversation_id, enabled, created_at, updated_at)
       VALUES (?, 0, 0, NULL, NULL, 0, NULL, NULL, NULL, NULL, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         source_conversation_id = COALESCE(excluded.source_conversation_id, experience_uses.source_conversation_id),
         enabled                = COALESCE(?, experience_uses.enabled),
         updated_at             = excluded.updated_at`,
    )
    .run(
      id,
      opts.sourceConversationId ?? null,
      opts.enabled === false ? 0 : 1,
      opts.createdAt ?? now,
      now,
      opts.enabled === undefined ? null : opts.enabled ? 1 : 0,
    )
}

/** pick_skill 选中记账（对应旧 touchMemoryPage）。 */
export function touchExperienceUse(id: string): void {
  const now = new Date().toISOString()
  getDb()
    .prepare(
      `INSERT INTO experience_uses (id, use_count, last_used_at, created_at, updated_at)
       VALUES (?, 1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET use_count = use_count + 1, last_used_at = excluded.last_used_at, updated_at = excluded.updated_at`,
    )
    .run(id, now, now, now)
}

/** 重现记账（对应 reinforce：recurrence +1、last_reinforced_at）。 */
export function bumpExperienceRecurrence(id: string): void {
  const now = new Date().toISOString()
  getDb()
    .prepare(
      `INSERT INTO experience_uses (id, recurrence, last_reinforced_at, created_at, updated_at)
       VALUES (?, 1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET recurrence = recurrence + 1, last_reinforced_at = excluded.last_reinforced_at, updated_at = excluded.updated_at`,
    )
    .run(id, now, now, now)
}

/** 开关。不动 updated_at：开关是使用态不是内容修订，列表按 updated_at 排序，不该跳位。 */
export function setExperienceEnabled(id: string, enabled: boolean): void {
  const now = new Date().toISOString()
  getDb()
    .prepare(
      `INSERT INTO experience_uses (id, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled`,
    )
    .run(id, enabled ? 1 : 0, now, now)
}

/** 自动固化失败记账（对应 recordSopFailedAttempt）。 */
export function bumpExperienceSopAttempt(id: string): void {
  const now = new Date().toISOString()
  getDb()
    .prepare(
      `INSERT INTO experience_uses (id, sop_attempts, sop_last_attempt_at, created_at, updated_at)
       VALUES (?, 1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET sop_attempts = sop_attempts + 1, sop_last_attempt_at = excluded.sop_last_attempt_at, updated_at = excluded.updated_at`,
    )
    .run(id, now, now, now)
}

/** 取代链：旧页记 superseded_by（对应旧 memory_pages 的同等写入）。 */
export function markExperienceSuperseded(id: string, newId: string): void {
  const now = new Date().toISOString()
  getDb()
    .prepare(
      `INSERT INTO experience_uses (id, superseded_by, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET superseded_by = excluded.superseded_by, updated_at = excluded.updated_at`,
    )
    .run(id, newId, now, now)
}

export function deleteExperienceUses(id: string): void {
  const database = getDb()
  database.prepare('DELETE FROM experience_uses WHERE id = ?').run(id)
  // 取代链剪断：被删页若是别人的继任者，把指向它的 superseded_by 清空，避免死链
  database.prepare('UPDATE experience_uses SET superseded_by = NULL WHERE superseded_by = ?').run(id)
}
