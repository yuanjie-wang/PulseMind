import { getDb } from './database'
import { memoryContentHash } from '../../shared/memory/content-hash'
import { escapeLikePattern } from '../../shared/memory/like-pattern'
import {
  appendRecurrenceNote,
  buildPageCatalog,
  buildSearchNeedles,
  deriveMaturity,
  findNameCollisions,
  MEMORY_PAGE_TYPES,
  normalizeTitle,
  resolvePageByRef,
  resolveSupersedeChain,
  type MemoryPageFile,
  type MemoryPageMaturity,
  type MemoryPageRecord,
  type MemoryPageType,
  type PageCatalog,
  type PageIndexEntry,
  type PageOp,
  type PageOpResult,
} from '../../shared/memory-pages'

/** 记忆页存储（PLAN-memory-wiki，2026-10-25）。旧 memories/experiences 两表在本波
 *  迁移期保持冻结只读，读写都走这里。检索匹配栈的形状由 probe-memory-fts-recall.mjs
 *  实测钉死：FTS 短语（≥3 字符词）+ LIKE 兜底（短词/CJK 滑窗二元组）双路合并、
 *  bm25 排序 + LIKE 恒后位、命中页解析取代链到活页。 */

interface MemoryPageRow {
  id: string
  title: string
  type: string
  summary: string | null
  body: string
  aliases: string
  links: string
  superseded_by: string | null
  source_conversation_id: string | null
  files_json: string | null
  maturity: string
  recurrence: number
  last_reinforced_at: string | null
  sop_attempts: number
  sop_last_attempt_at: string | null
  enabled: number
  retired_at: string | null
  retire_reason: string | null
  use_count: number
  last_used_at: string | null
  content_hash: string
  created_at: string
  updated_at: string
}

function parseJsonArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

function rowToRecord(row: MemoryPageRow): MemoryPageRecord {
  return {
    id: row.id,
    title: row.title,
    type: row.type as MemoryPageType,
    summary: row.summary,
    body: row.body,
    aliases: parseJsonArray<string>(row.aliases),
    links: parseJsonArray<string>(row.links),
    supersededBy: row.superseded_by,
    sourceConversationId: row.source_conversation_id,
    files: row.files_json ? parseJsonArray<MemoryPageFile>(row.files_json) : null,
    useCount: row.use_count,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    maturity: (row.maturity === 'sop' ? 'sop' : 'clue') as MemoryPageMaturity,
    recurrence: row.recurrence ?? 0,
    lastReinforcedAt: row.last_reinforced_at ?? null,
    sopAttempts: row.sop_attempts ?? 0,
    sopLastAttemptAt: row.sop_last_attempt_at ?? null,
    // 列缺席（迁移前的行读不到）与 1 都读作启用——停用必须是显式的 0
    enabled: row.enabled !== 0,
    retiredAt: row.retired_at ?? null,
    retireReason: row.retire_reason ?? null,
  }
}

/** pages FTS 的局部损坏恢复（镜像 database.ts 的 withFtsRecovery，但重建的是本表）。 */
function withPagesFtsRecovery<T>(fn: () => T): T {
  try {
    return fn()
  } catch (error: unknown) {
    if ((error as { code?: string })?.code === 'SQLITE_CORRUPT_VTAB') {
      console.warn('[memory-pages] FTS corruption detected, rebuilding index and retrying...')
      const database = getDb()
      database.exec('DROP TABLE IF EXISTS memory_pages_fts')
      database.exec(
        "CREATE VIRTUAL TABLE IF NOT EXISTS memory_pages_fts USING fts5(title, aliases_text, body, page_id UNINDEXED, tokenize='trigram')"
      )
      database.exec(
        "INSERT INTO memory_pages_fts(title, aliases_text, body, page_id) SELECT title, aliases, body, id FROM memory_pages"
      )
      return fn()
    }
    throw error
  }
}

function ftsUpsert(page: { id: string; title: string; aliases: string[]; body: string }): void {
  const database = getDb()
  withPagesFtsRecovery(() => {
    database.prepare('DELETE FROM memory_pages_fts WHERE page_id = ?').run(page.id)
    database
      .prepare('INSERT INTO memory_pages_fts(title, aliases_text, body, page_id) VALUES (?, ?, ?, ?)')
      .run(page.title, page.aliases.join(' '), page.body, page.id)
  })
}

function mintPageId(): string {
  return `page_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

// ── 读 ──

const INDEX_COLUMNS = 'id, title, type, aliases'

export function listPageIndex(): PageIndexEntry[] {
  const database = getDb()
  const rows = database
    .prepare(`SELECT ${INDEX_COLUMNS} FROM memory_pages WHERE superseded_by IS NULL AND retired_at IS NULL ORDER BY updated_at DESC`)
    .all() as Array<{ id: string; title: string; type: string; aliases: string }>
  return rows.map((r) => ({ id: r.id, title: r.title, type: r.type as MemoryPageType, aliases: parseJsonArray<string>(r.aliases) }))
}

export function listMemoryPages(type?: MemoryPageType): MemoryPageRecord[] {
  const database = getDb()
  const sql = 'SELECT * FROM memory_pages'
  const rows = (
    type
      ? database.prepare(`${sql} WHERE type = ? ORDER BY updated_at DESC`).all(type)
      : database.prepare(`${sql} ORDER BY updated_at DESC`).all()
  ) as MemoryPageRow[]
  return rows.map(rowToRecord)
}

export function getMemoryPageById(id: string): MemoryPageRecord | null {
  const database = getDb()
  const row = database.prepare('SELECT * FROM memory_pages WHERE id = ?').get(id) as MemoryPageRow | undefined
  return row ? rowToRecord(row) : null
}

export function countMemoryPages(type?: MemoryPageType): number {
  const database = getDb()
  const LIVE = 'superseded_by IS NULL AND retired_at IS NULL'
  const row = type
    ? (database.prepare(`SELECT COUNT(*) as c FROM memory_pages WHERE type = ? AND ${LIVE}`).get(type) as { c: number })
    : (database.prepare(`SELECT COUNT(*) as c FROM memory_pages WHERE ${LIVE}`).get() as { c: number })
  return row.c
}

/** 提取目录（进 SessionReviewAgent prompt）；活页超预算回落 type 分桶。 */
export function pageCatalog(): PageCatalog {
  return buildPageCatalog(listPageIndex())
}

// ── 写 ──

export interface UpsertPageInput {
  id?: string
  title: string
  type: MemoryPageType
  summary?: string | null
  body: string
  aliases?: string[]
  links?: string[]
  supersededBy?: string | null
  sourceConversationId?: string | null
  files?: MemoryPageFile[] | null
  /** 缺省按 files 派生（deriveMaturity）；迁移路径可显式指定。 */
  maturity?: MemoryPageMaturity
  useCount?: number
  lastUsedAt?: string | null
  createdAt?: string
}

/** 整页写入（迁移/手工路径）：按 id 插入或全量更新，不做协议校验——调用方对数据负责。 */
export function upsertMemoryPage(input: UpsertPageInput): MemoryPageRecord {
  const database = getDb()
  const now = new Date().toISOString()
  const id = input.id ?? mintPageId()
  const existing = database.prepare('SELECT created_at FROM memory_pages WHERE id = ?').get(id) as
    | { created_at: string }
    | undefined
  const createdAt = input.createdAt ?? existing?.created_at ?? now
  const aliases = input.aliases ?? []
  const links = input.links ?? []
  const maturity = input.maturity ?? deriveMaturity(input.files)
  // 幂等短路：迁移/重放的确定性 upsert 在内容未变时零写入——updated_at 不动，
  // 重跑零变化（probe-memory-migration 钉住）。
  const hash = memoryContentHash(input.body)
  const prev = existing
    ? (database.prepare('SELECT title, type, summary, body, aliases, links, files_json, maturity, content_hash FROM memory_pages WHERE id = ?').get(id) as
        { title: string; type: string; summary: string | null; body: string; aliases: string; links: string; files_json: string | null; maturity: string; content_hash: string } | undefined)
    : undefined
  const filesJson = input.files ? JSON.stringify(input.files) : null
  if (
    prev && prev.content_hash === hash && prev.title === normalizeTitle(input.title) && prev.type === input.type &&
    prev.body === input.body && prev.aliases === JSON.stringify(aliases) && prev.links === JSON.stringify(links) &&
    (prev.files_json ?? null) === filesJson && prev.maturity === maturity && (prev.summary ?? null) === (input.summary ?? null)
  ) {
    return getMemoryPageById(id)!
  }
  const write = database.transaction(() => {
    database.prepare(`
      INSERT INTO memory_pages (id, title, type, summary, body, aliases, links, superseded_by, source_conversation_id,
        files_json, maturity, use_count, last_used_at, content_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title, type = excluded.type, summary = excluded.summary, body = excluded.body,
        aliases = excluded.aliases, links = excluded.links, superseded_by = excluded.superseded_by,
        files_json = excluded.files_json, maturity = excluded.maturity, content_hash = excluded.content_hash, updated_at = excluded.updated_at
    `).run(
      id,
      normalizeTitle(input.title),
      input.type,
      input.summary ?? null,
      input.body,
      JSON.stringify(aliases),
      JSON.stringify(links),
      input.supersededBy ?? null,
      input.sourceConversationId ?? null,
      input.files ? JSON.stringify(input.files) : null,
      maturity,
      input.useCount ?? 0,
      input.lastUsedAt ?? null,
      memoryContentHash(input.body),
      createdAt,
      now
    )
    ftsUpsert({ id, title: normalizeTitle(input.title), aliases, body: input.body })
  })
  write()
  return getMemoryPageById(id)!
}

const TRUNCATION_GUARD_BODY = 1500
const TRUNCATION_GUARD_RATIO = 0.9

/** 写协议执行器。op 级隔离（每 op 独立事务 + 独立 try/catch）：一个坏 op 不拖垮同批
 *  其它 op——批级单事务做不到这一点（任一 op 失败即整体回滚），与 PLAN 2.2 的
 *  「op 级失败不影响同批其它 op」对齐，这里选择 op 级原子而非批级原子。 */
export function applyPageOps(ops: PageOp[]): PageOpResult[] {
  const results: PageOpResult[] = []
  for (const op of ops) {
    try {
      results.push(applyOnePageOp(op))
    } catch (error) {
      results.push({ op, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return results
}

function applyOnePageOp(op: PageOp): PageOpResult {
  const database = getDb()
  const index = listPageIndex()
  const now = new Date().toISOString()

  if (op.action === 'create') {
    if (!op.title || !op.type) throw new Error('CREATE 需要 title 与 type')
    if (!MEMORY_PAGE_TYPES.includes(op.type)) throw new Error(`未知类型: ${op.type}`)
    const title = normalizeTitle(op.title)
    const collisions = findNameCollisions(index, { title, aliases: op.aliases })
    if (collisions.length > 0) {
      throw new Error(`撞名: ${collisions.map((c) => `${c.value} ← ${c.holderTitle}`).join('; ')}（用 update/alias 修改既有页）`)
    }
    const id = mintPageId()
    const run = database.transaction(() => {
      database.prepare(`
        INSERT INTO memory_pages (id, title, type, summary, body, aliases, links, superseded_by, source_conversation_id,
          files_json, maturity, use_count, last_used_at, content_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, 0, NULL, ?, ?, ?)
      `).run(id, title, op.type!, op.summary ?? null, op.content ?? '', JSON.stringify(op.aliases ?? []), JSON.stringify(op.links ?? []),
        op.files ? JSON.stringify(op.files) : null, deriveMaturity(op.files), memoryContentHash(op.content ?? ''), now, now)
      ftsUpsert({ id, title, aliases: op.aliases ?? [], body: op.content ?? '' })
    })
    run()
    return { op, ok: true, pageId: id }
  }

  const targetRef = op.target
  if (!targetRef) throw new Error(`${op.action.toUpperCase()} 需要 target`)
  const targetId = resolvePageByRef(index, targetRef)
  if (!targetId) throw new Error(`TARGET_NOT_FOUND: ${targetRef}`)
  const target = getMemoryPageById(targetId)!

  if (op.action === 'update') {
    if (typeof op.content !== 'string' || op.content.length === 0) throw new Error('UPDATE 需要完整修订正文 content')
    // 截断防丢守卫（experience-store.ts:293-309 同款）：长正文被显著改短多半是输出截断
    if (target.body.length > TRUNCATION_GUARD_BODY && op.content.length < target.body.length * TRUNCATION_GUARD_RATIO) {
      throw new Error(`截断防丢: 新正文 ${op.content.length} 字 < 旧正文 ${target.body.length} 字的 90%`)
    }
    const newHash = memoryContentHash(op.content)
    if (newHash === memoryContentHash(target.body) && !(op.aliases ?? []).length && !(op.links ?? []).length) {
      return { op, ok: true, pageId: targetId } // 无变化，幂等
    }
    const mergedAliases = mergeUniqueNocase(target.aliases, op.aliases)
    const mergedLinks = mergeUniqueNocase(target.links, op.links)
    const newSummary = op.summary !== undefined ? op.summary : target.summary
    const run = database.transaction(() => {
      database.prepare('UPDATE memory_pages SET body = ?, aliases = ?, links = ?, summary = ?, content_hash = ?, updated_at = ? WHERE id = ?')
        .run(op.content!, JSON.stringify(mergedAliases), JSON.stringify(mergedLinks), newSummary, newHash, now, targetId)
      ftsUpsert({ id: targetId, title: target.title, aliases: mergedAliases, body: op.content! })
    })
    run()
    return { op, ok: true, pageId: targetId }
  }

  if (op.action === 'alias') {
    const incoming = op.aliases ?? []
    if (incoming.length === 0) throw new Error('ALIAS 需要 aliases')
    const collisions = findNameCollisions(index, { aliases: incoming, ignoreId: targetId })
    if (collisions.length > 0) throw new Error(`撞名: ${collisions.map((c) => `${c.value} ← ${c.holderTitle}`).join('; ')}`)
    const merged = mergeUniqueNocase(target.aliases, incoming)
    const run = database.transaction(() => {
      database.prepare('UPDATE memory_pages SET aliases = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(merged), now, targetId)
      ftsUpsert({ id: targetId, title: target.title, aliases: merged, body: target.body })
    })
    run()
    return { op, ok: true, pageId: targetId }
  }

  // reinforce（PLAN-experience-sop 刀一）：经验页重现记账。recurrence +1、
  // last_reinforced_at、note 追加「## 重现记录」节（FIFO ≤10）。只对经验页成立——
  // 它是二阶段固化资格的信号，语义上是经验的「这条线索又出现了」。
  if (op.action === 'reinforce') {
    if (target.type !== 'experience') throw new Error(`REINFORCE 只对经验页成立（${target.title} 是 ${target.type}）`)
    const note = (op.note ?? '').trim()
    if (!note) throw new Error('REINFORCE 需要 note（一行说明什么重现了）')
    const newBody = appendRecurrenceNote(target.body, note, now.slice(0, 10))
    const run = database.transaction(() => {
      database
        .prepare('UPDATE memory_pages SET body = ?, recurrence = recurrence + 1, last_reinforced_at = ?, content_hash = ?, updated_at = ? WHERE id = ?')
        .run(newBody, now, memoryContentHash(newBody), now, targetId)
      ftsUpsert({ id: targetId, title: target.title, aliases: target.aliases, body: newBody })
    })
    run()
    return { op, ok: true, pageId: targetId }
  }

  // retire（2026-10-27）：退役软态——过时/错误/被完全吸收的页退出活页池。行保留、
  // 理由留档（审计面），UI 可恢复。不动 updated_at（与开关同纪律：是使用态不是内容
  // 修订，列表按 updated_at 排序，退役不该让卡片跳位）；不动 FTS（检索命中在解析
  // 活页后被 retired 过滤，删行反而丢掉审计可检索性）。
  if (op.action === 'retire') {
    const reason = (op.reason ?? '').trim()
    if (!reason) throw new Error('RETIRE 需要 reason（退役必须留审计理由）')
    // 脚本保全同款护栏：compile pass 不整理 SOP 页，也不得退役它们——固化流程管辖。
    if (target.files && target.files.length > 0) {
      throw new Error(`脚本保全: "${target.title}" 携带 ${target.files.length} 个脚本，不走 retire（SOP 页由固化流程管辖）`)
    }
    database
      .prepare('UPDATE memory_pages SET retired_at = ?, retire_reason = ? WHERE id = ?')
      .run(now, reason, targetId)
    return { op, ok: true, pageId: targetId }
  }

  // supersede：新建继任页 + 旧页挂 superseded_by（取代链 = 决策演进的谱系，不删旧页）
  if (!op.title || !op.content || !op.type) throw new Error('SUPERSEDE 需要 title/type/content')
  // 脚本保全护栏（PLAN-experience-sop 刀一）：带脚本的页只能被「同样携带脚本」的
  // supersede 取代——compile pass 与一切只看正文的写方理解不了脚本，这里单点顶回。
  if (target.files && target.files.length > 0 && !(op.files && op.files.length > 0)) {
    throw new Error(`脚本保全: "${target.title}" 携带 ${target.files.length} 个脚本，supersede 必须携带 files（compile pass 不整理脚本页）`)
  }
  // optional 属性的收窄进不了闭包——事务回调里只许用这些局部常量
  const newTitle = normalizeTitle(op.title)
  const newBody = op.content
  const newType = op.type
  const newAliases = op.aliases ?? []
  const newFiles = op.files ?? null
  const collisions = findNameCollisions(index, { title: newTitle, aliases: newAliases })
  if (collisions.length > 0) throw new Error(`撞名: ${collisions.map((c) => `${c.value} ← ${c.holderTitle}`).join('; ')}`)
  const newId = mintPageId()
  const links = mergeUniqueNocase(op.links ?? [], [target.title])
  const run = database.transaction(() => {
    // 继任页继承开关态：用户停用过的经验被 merge/取代后不该悄悄复活
    database.prepare(`
      INSERT INTO memory_pages (id, title, type, summary, body, aliases, links, superseded_by, source_conversation_id,
        files_json, maturity, enabled, use_count, last_used_at, content_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 0, NULL, ?, ?, ?)
    `).run(newId, newTitle, newType, op.summary ?? null, newBody, JSON.stringify(newAliases), JSON.stringify(links),
      target.sourceConversationId, newFiles ? JSON.stringify(newFiles) : null, deriveMaturity(newFiles), target.enabled ? 1 : 0, memoryContentHash(newBody), now, now)
    database.prepare('UPDATE memory_pages SET superseded_by = ?, updated_at = ? WHERE id = ?').run(newId, now, targetId)
    ftsUpsert({ id: newId, title: newTitle, aliases: newAliases, body: newBody })
  })
  run()
  return { op, ok: true, pageId: newId }
}

function mergeUniqueNocase(base: string[], incoming?: string[]): string[] {
  const seen = new Set(base.map((v) => v.toLowerCase()))
  const out = [...base]
  for (const v of incoming ?? []) {
    const key = normalizeTitle(v).toLowerCase()
    if (key && !seen.has(key)) { seen.add(key); out.push(normalizeTitle(v)) }
  }
  return out
}

export function deleteMemoryPage(id: string): void {
  const database = getDb()
  const run = database.transaction(() => {
    withPagesFtsRecovery(() => database.prepare('DELETE FROM memory_pages_fts WHERE page_id = ?').run(id))
    database.prepare('DELETE FROM memory_pages WHERE id = ?').run(id)
    // 取代链上的继任页引用被删页时，把链剪断（被取代页回到活页），避免死链
    database.prepare('UPDATE memory_pages SET superseded_by = NULL WHERE superseded_by = ?').run(id)
  })
  run()
}

/** 自动固化的失败记账（PLAN-experience-sop 刀四）：settleOutcome 的非升格分支
 *  调用——24h 退避 + 3 次退役的计数面。成功尝试不进来（页面已被 supersede）。 */
export function recordSopFailedAttempt(id: string): void {
  const database = getDb()
  database
    .prepare('UPDATE memory_pages SET sop_attempts = sop_attempts + 1, sop_last_attempt_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id)
}

/** 使用侧 touch（PLAN-experience-sop B5）：pick_skill 选中经验页时记账。不是
 *  PageOp——touch 不是 wiki 编辑。hint 触达刻意不记账（逐回合命中太噪），
 *  pick 是有意图的拉取；recall 路径的记账在 searchMemoryPages 尾部。 */
export function touchMemoryPage(id: string): void {
  const database = getDb()
  database
    .prepare('UPDATE memory_pages SET use_count = use_count + 1, last_used_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id)
}

/** 经验卡开关（2026-10-27）。不动 updated_at——开关是使用态不是内容修订，
 *  列表按 updated_at 排序，拨一下开关不该让卡片跳位。 */
export function setMemoryPageEnabled(id: string, enabled: boolean): void {
  const database = getDb()
  database.prepare('UPDATE memory_pages SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
}

/** 退役/恢复（2026-10-27，retire op 的 UI 面）：恢复 = 清空退役软态，页面回活页
 *  池；手动退役入口暂只有恢复方向（退役由 compile pass 产出）。不动 updated_at，
 *  理由同 setMemoryPageEnabled。 */
export function setMemoryPageRetired(id: string, retired: boolean, reason?: string): void {
  const database = getDb()
  database
    .prepare('UPDATE memory_pages SET retired_at = ?, retire_reason = ? WHERE id = ?')
    .run(retired ? new Date().toISOString() : null, retired ? (reason ?? 'manual').trim() || 'manual' : null, id)
}

// ── 检索（M0a 定形的匹配栈）──

const LIKE_FALLBACK_SCORE = 100
const FTS_CANDIDATE_POOL = 40

export interface MemoryPageSearchInput {
  query: string
  type?: MemoryPageType
  limit?: number
}

export interface MemoryPageSearchHit {
  record: MemoryPageRecord
  /** FTS bm25 命中为 false 表示只靠 LIKE 兜底命中（排序恒后）。 */
  viaFts: boolean
}

export function searchMemoryPages(input: MemoryPageSearchInput): MemoryPageSearchHit[] {
  const query = input.query.trim()
  if (!query) return []
  const limit = input.limit ?? 8
  const { ftsExpr, likeNeedles } = buildSearchNeedles(query)
  if (!ftsExpr && likeNeedles.length === 0) return []
  const database = getDb()

  const scores = new Map<string, number>()
  if (ftsExpr) {
    try {
      const hits = withPagesFtsRecovery(() =>
        database
          .prepare('SELECT page_id, rank FROM memory_pages_fts WHERE memory_pages_fts MATCH ? ORDER BY rank LIMIT ?')
          .all(ftsExpr, FTS_CANDIDATE_POOL) as Array<{ page_id: string; rank: number }>
      )
      for (const h of hits) scores.set(h.page_id, Math.min(scores.get(h.page_id) ?? Infinity, h.rank))
    } catch {
      // 非法 MATCH 表达式按无 FTS 命中处理（LIKE 兜底仍可命中）
    }
  }
  const ftsHitIds = new Set(scores.keys())
  for (const needle of likeNeedles) {
    const pat = `%${escapeLikePattern(needle)}%`
    const rows = database
      .prepare(
        `SELECT id FROM memory_pages
         WHERE title LIKE ? ESCAPE '\\' OR aliases LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\'`
      )
      .all(pat, pat, pat) as Array<{ id: string }>
    for (const r of rows) scores.set(r.id, Math.min(scores.get(r.id) ?? Infinity, LIKE_FALLBACK_SCORE))
  }

  // 取代链解析：命中折叠到活页（活页取更优分），再按 type 过滤
  const chainMap = new Map<string, Pick<MemoryPageRecord, 'id' | 'supersededBy'>>()
  for (const row of database.prepare('SELECT id, superseded_by FROM memory_pages').all() as Array<{
    id: string
    superseded_by: string | null
  }>) {
    chainMap.set(row.id, { id: row.id, supersededBy: row.superseded_by })
  }
  const resolved = new Map<string, { score: number; viaFts: boolean }>()
  for (const [candidateId, score] of scores) {
    const liveId = resolveSupersedeChain(chainMap, candidateId)
    const prev = resolved.get(liveId)
    const viaFts = ftsHitIds.has(candidateId) || (prev?.viaFts ?? false)
    if (!prev || score < prev.score) resolved.set(liveId, { score, viaFts })
    else if (viaFts && !prev.viaFts) resolved.set(liveId, { ...prev, viaFts })
  }

  const ids = [...resolved.keys()]
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(',')
  const rows = database.prepare(`SELECT * FROM memory_pages WHERE id IN (${placeholders})`).all(...ids) as MemoryPageRow[]
  const records = new Map(rows.map((r) => [r.id, rowToRecord(r)]))

  const hits: MemoryPageSearchHit[] = []
  for (const [liveId, meta] of resolved) {
    const record = records.get(liveId)
    if (!record) continue
    if (input.type && record.type !== input.type) continue
    // 退役页不进检索结果：取代链解析到它即止——退役判的是内容本身过时，
    // 不回落链上旧页（旧页只是历史版本，不是有效内容）。
    if (record.retiredAt) continue
    hits.push({ record, viaFts: meta.viaFts })
  }
  hits.sort((a, b) => {
    const sa = resolved.get(a.record.id)!.score
    const sb = resolved.get(b.record.id)!.score
    if (sa !== sb) return sa - sb
    return b.record.updatedAt.localeCompare(a.record.updatedAt)
  })
  const limited = hits.slice(0, limit)

  const now = new Date().toISOString()
  const touch = database.transaction(() => {
    const stmt = database.prepare('UPDATE memory_pages SET use_count = use_count + 1, last_used_at = ? WHERE id = ?')
    for (const h of limited) stmt.run(now, h.record.id)
  })
  touch()
  return limited
}
