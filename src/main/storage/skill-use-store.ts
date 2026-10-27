// ── 技能使用计数（2026-10-27）──
// pick_skill 选中已注册技能时 +1，与经验页的 touchMemoryPage（memory_pages.use_count）
// 对称：两类卡片都展示「使用 N 次」。按技能名键控——内置技能不在任何表里，这里是
// 它们唯一的持久化落点；删技能不清行（重装同名即续计，无害）。
import { getDb } from './database'

export interface SkillUseRecord {
  name: string
  useCount: number
  lastUsedAt: string | null
}

export function recordSkillUse(name: string): void {
  const database = getDb()
  database
    .prepare(`
      INSERT INTO skill_uses (name, use_count, last_used_at) VALUES (?, 1, ?)
      ON CONFLICT(name) DO UPDATE SET use_count = use_count + 1, last_used_at = excluded.last_used_at
    `)
    .run(name, new Date().toISOString())
}

export function listSkillUses(): SkillUseRecord[] {
  const database = getDb()
  const rows = database.prepare('SELECT name, use_count, last_used_at FROM skill_uses').all() as Array<{
    name: string
    use_count: number
    last_used_at: string | null
  }>
  return rows.map((r) => ({ name: r.name, useCount: r.use_count, lastUsedAt: r.last_used_at }))
}
