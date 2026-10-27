// ── 记忆 wiki 化数据迁移（PLAN-memory-wiki M5，2026-10-25）──
// 两条一次性路径，幂等（settings 旗标 + 确定性页 id）：
//   ① 经验池 → experience 页：确定性字节平移，无 LLM——SKILL.md 正文与
//      scripts 原样搬运（红线：不经 LLM 重写，防丢内容），name+triggers 沉淀为
//      别名种子，use_count/last_used_at 平移。旧池（表 + 目录）冻结只读。
//   ② 扁平 memories → 页：LLM 归页一批（复用 v2 写协议的 create 形态）；
//      type='experience' 的旧行跳过（legacy，早前已迁 KB）。
// 旧表一律不删——回滚面（PLAN 4）。
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { getDb } from '../storage/database'
import { EXPERIENCES_DIR } from '../storage/index'
import { upsertMemoryPage } from '../storage/memory-pages-store'
import { parseExperienceMd } from '../../shared/experience/frontmatter'
import type { MemoryPageFile, MemoryPageType } from '../../shared/memory-pages'

interface ExperienceRow {
  id: string
  name: string
  title: string
  description: string
  category: string
  source_conversation_id: string | null
  created_at: string
  last_used_at: string | null
  use_count: number
  triggers: string
  updated_at?: string
  files_json: string | null
}

function listExperienceRows(): ExperienceRow[] {
  const db = getDb()
  const cols = db.prepare('PRAGMA table_info(experiences)').all() as Array<{ name: string }>
  // 老库可能缺 updated_at/content_hash/outcome_json（ALTER 补列前的形状）
  const has = (c: string) => cols.some((x) => x.name === c)
  const rows = db.prepare(`
    SELECT id, name, title, description, category, source_conversation_id, created_at,
      last_used_at, use_count, triggers${has('files_json') ? ', files_json' : ', NULL as files_json'}${has('updated_at') ? ', updated_at' : ', NULL as updated_at'}
    FROM experiences
  `).all() as ExperienceRow[]
  return rows
}

function parseJsonArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return []
  try { const p = JSON.parse(raw); return Array.isArray(p) ? (p as T[]) : [] } catch { return [] }
}

/** ① 经验池 → experience 页（字节平移）。返回迁移条数；幂等：已存在的确定性 id 被 upsert 覆写为同值。 */
export function migrateExperiencesToPages(): number {
  const rows = listExperienceRows()
  let migrated = 0
  for (const row of rows) {
    const mdPath = join(EXPERIENCES_DIR, row.name, 'SKILL.md')
    // 正文以磁盘 SKILL.md 为准（双存储的正典侧）；缺文件回落 description
    const raw = existsSync(mdPath) ? readFileSync(mdPath, 'utf-8') : null
    const body = raw ? parseExperienceMd(raw, row.title).content : (row.description || row.title)
    const files = parseJsonArray<MemoryPageFile>(row.files_json)
    const aliases = [...new Set([row.name, ...parseJsonArray<string>(row.triggers)].filter(Boolean))]
    upsertMemoryPage({
      id: `page_mig_exp_${row.id}`,
      title: row.title || row.name,
      type: 'experience',
      body,
      aliases,
      links: [],
      sourceConversationId: row.source_conversation_id,
      files: files.length > 0 ? files : null,
      useCount: row.use_count,
      lastUsedAt: row.last_used_at,
      createdAt: row.created_at,
    })
    migrated++
  }
  return migrated
}

interface FlatMemoryRow {
  id: string
  content: string
  type: string
  category: string
  created_at: string
}

/** 迁移源清单（② 的输入；① 的行经此处过滤）——experience 旧行跳过（已 KB 迁移的 legacy）。 */
export function listFlatMemoriesForMigration(): FlatMemoryRow[] {
  const db = getDb()
  return db.prepare(`
    SELECT id, content, type, category, created_at FROM memories
    WHERE type IN ('auto', 'manual', 'fact', 'decision', 'preference')
  `).all() as FlatMemoryRow[]
}

/** ② 扁平记忆 → 归页 ops（LLM 产出的消费端在 MemoryManager.migrateFlatMemoriesToPages，
 *  这里给确定性兜底：LLM 不可用时按 type 直接建页，title 取结论头部——宁可先
 *  落库可检索，等 compile pass 归并，也不让存量悬空）。 */
export function fallbackFlatMemoryOps(rows: FlatMemoryRow[]): Array<{
  id?: string
  title: string
  type: MemoryPageType
  content: string
  aliases: string[]
  createdAt: string
}> {
  const typeMap: Record<string, MemoryPageType> = { decision: 'decision', preference: 'preference', fact: 'fact', auto: 'fact', manual: 'preference' }
  return rows.map((r) => ({
    id: `page_mig_mem_${r.id}`,
    title: r.content.slice(0, 24),
    type: typeMap[r.type] ?? 'fact',
    content: r.content,
    aliases: [],
    createdAt: r.created_at,
  }))
}

/** ② 的落库（LLM 或兜底产物统一走这里，确定性 id 保幂等）。 */
export function applyFlatMemoryMigration(
  pages: Array<{ id?: string; title: string; type: MemoryPageType; content: string; aliases: string[]; createdAt: string }>
): number {
  let n = 0
  for (const p of pages) {
    upsertMemoryPage({ ...p, body: p.content, links: [] })
    n++
  }
  return n
}
