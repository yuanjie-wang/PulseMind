import { getDb } from './database'
import { memoryContentHash, normalizeMemoryContent } from '../../shared/memory/content-hash'
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
import { compareExperienceLRU, MAX_EXPERIENCE_PAGES } from '../../shared/experience/lru'
import { experienceStore, type ExperienceFile } from './experience-store'
import {
  bumpExperienceRecurrence,
  bumpExperienceSopAttempt,
  deleteExperienceUses,
  ensureExperienceUses,
  getExperienceUses,
  markExperienceSuperseded,
  setExperienceEnabled,
  touchExperienceUse,
} from './experience-uses'

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

/** 经验虚拟行（2026-11-12 经验 SKILL 化 / n9）：经验已搬离 memory_pages，
 *  正文与静态元数据在磁盘 EXPERIENCE.md，流水在 experience_uses。
 *  合成成 MemoryPageRecord 后，上层（撞名门、target 解析、pick_skill、面板）
 *  无需感知真源变化。 */
function experienceFileToRecord(file: ExperienceFile): MemoryPageRecord {
  const id = file.meta.id
  const uses = getExperienceUses(id)
  const scripts = experienceStore.listScriptsSync(id)
  return {
    id,
    title: file.meta.title,
    type: 'experience',
    summary: file.meta.description || null,
    body: file.body,
    aliases: file.meta.aliases ?? [],
    links: [],
    supersededBy: uses?.supersededBy ?? null,
    sourceConversationId: uses?.sourceConversationId ?? file.meta.sourceConversationId ?? null,
    files: scripts.length > 0 ? scripts.map((s) => ({ path: s.relativePath, content: s.content })) : null,
    useCount: uses?.useCount ?? 0,
    lastUsedAt: uses?.lastUsedAt ?? null,
    createdAt: file.meta.createdAt ?? new Date().toISOString(),
    updatedAt: file.meta.updatedAt ?? new Date().toISOString(),
    // 带脚本即 SOP —— 与 deriveMaturity 同一规则，这里不另立标准。
    maturity: scripts.length > 0 ? 'sop' : file.meta.maturity,
    recurrence: uses?.recurrence ?? 0,
    lastReinforcedAt: uses?.lastReinforcedAt ?? null,
    sopAttempts: uses?.sopAttempts ?? 0,
    sopLastAttemptAt: uses?.sopLastAttemptAt ?? null,
    enabled: uses?.enabled ?? true,
    retiredAt: uses?.retiredAt ?? null,
    retireReason: uses?.retireReason ?? null,
    filePath: experienceStore.pathOf(id),
  }
}

/** 经验身份的判定（n9）：经验已不在 memory_pages，只能靠「流水表有行」或
 *  「磁盘有目录」认出它。记账/开关/删除这些**只拿到 id** 的入口全靠这里分流。 */
function isExperienceId(id: string): boolean {
  if (getExperienceUses(id)) return true
  return experienceStore.readSync(id) !== null
}

/** 磁盘全量经验（含退役/被取代）。读不出 frontmatter 的目录跳过并告警，
 *  不让一个坏文件拖垮整张列表——面板少一张卡好过整块白屏。 */
function allExperienceRecords(): MemoryPageRecord[] {
  return experienceStore
    .listSync((id, err) => console.warn('[memory-pages] 经验目录读取失败，已跳过', id, err))
    .map(experienceFileToRecord)
}

function isLiveExperience(rec: MemoryPageRecord): boolean {
  return !rec.retiredAt && !rec.supersededBy
}

/** 把池子压回上限，返回本轮被淘汰（硬删）的 id。
 *  `keepId` 是刚写入的那条，永不淘汰 —— 新页 use_count=0，不排除会「建好即被扔」。 */
export function enforceExperienceCap(keepId?: string): string[] {
  const live = allExperienceRecords().filter(isLiveExperience)
  const overflow = live.length - MAX_EXPERIENCE_PAGES
  if (overflow <= 0) return []
  const candidates = live.filter((r) => r.id !== keepId)
  candidates.sort(compareExperienceLRU)
  const victims = candidates.slice(0, overflow)
  for (const v of victims) {
    // 硬删（2026-11-12 用户裁定）：目录 + 流水一起物理删除，不软退役。
    // 带脚本的页被淘汰意味着脚本永久消失，日志里必须留一笔。
    if (v.files && v.files.length > 0) {
      console.warn(`[memory-pages] LRU 淘汰带脚本经验 #${v.id} "${v.title}"：${v.files.length} 个脚本将一并删除`)
    }
    experienceStore.removeSync(v.id)
    deleteExperienceUses(v.id)
  }
  return victims.map((v) => v.id)
}

// ── 读 ──

const INDEX_COLUMNS = 'id, title, type, aliases'

export function listPageIndex(): PageIndexEntry[] {
  const database = getDb()
  // type <> 'experience'：经验行已迁走，n9 清理前 DB 里可能还有残留同 id 行，
  // 这里直接排除，避免与磁盘真源重复计入（磁盘胜）。
  const rows = database
    .prepare(
      `SELECT ${INDEX_COLUMNS} FROM memory_pages WHERE superseded_by IS NULL AND retired_at IS NULL AND type <> 'experience' ORDER BY updated_at DESC`,
    )
    .all() as Array<{ id: string; title: string; type: string; aliases: string }>
  const entries: PageIndexEntry[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    type: r.type as MemoryPageType,
    aliases: parseJsonArray<string>(r.aliases),
  }))
  for (const rec of allExperienceRecords()) {
    if (!isLiveExperience(rec)) continue
    entries.push({ id: rec.id, title: rec.title, type: 'experience', aliases: rec.aliases })
  }
  return entries
}

export function listMemoryPages(type?: MemoryPageType): MemoryPageRecord[] {
  const database = getDb()
  const sql = 'SELECT * FROM memory_pages'
  const rows = (
    type
      ? database.prepare(`${sql} WHERE type = ? ORDER BY updated_at DESC`).all(type)
      : database.prepare(`${sql} WHERE type <> 'experience' ORDER BY updated_at DESC`).all()
  ) as MemoryPageRow[]
  const records = rows.map(rowToRecord)
  if (type === 'experience') return allExperienceRecords().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  if (!type) records.push(...allExperienceRecords())
  return records
}

export function getMemoryPageById(id: string): MemoryPageRecord | null {
  const database = getDb()
  const row = database.prepare('SELECT * FROM memory_pages WHERE id = ?').get(id) as MemoryPageRow | undefined
  // 经验行（n9 残留/迁移写入）一律让位磁盘真源：列表已排除该类型（磁盘胜），id 直查
  // 同样不认——否则手工迁移过的机器上，陈旧 DB 正文会永久遮蔽磁盘 EXPERIENCE.md。
  if (row && row.type !== 'experience') return rowToRecord(row)
  // 经验已不在 memory_pages：正文在磁盘，流水在 experience_uses。
  const file = experienceStore.readSync(id)
  return file ? experienceFileToRecord(file) : null
}

export function countMemoryPages(type?: MemoryPageType): number {
  const database = getDb()
  const LIVE = 'superseded_by IS NULL AND retired_at IS NULL'
  const experienceCount = allExperienceRecords().filter(isLiveExperience).length
  if (type === 'experience') return experienceCount
  const row = type
    ? (database.prepare(`SELECT COUNT(*) as c FROM memory_pages WHERE type = ? AND ${LIVE}`).get(type) as { c: number })
    : (database.prepare(`SELECT COUNT(*) as c FROM memory_pages WHERE type <> 'experience' AND ${LIVE}`).get() as { c: number })
  // 经验只属于「全部/经验」两档：单类型计数混进经验数会把偏好/决策/事实三档全部虚高
  // （review 2026-11-12 实锤：清空后三档各显示 1）。
  return row.c + (type ? 0 : experienceCount)
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
  /** 整页写入的正文撞重豁免开关（迁移重放/审计导入用）。 */
  allowDuplicateBody?: boolean
}

/** 正文撞重门的最短正文（归一化后字符数）：低于它的重合是噪声（"是"、"待补充"
 *  这类样板话撞满池子），拦了只会误伤，不设门。 */
const BODY_HASH_GATE_MIN_CHARS = 24

/** 跨页正文撞重查询（2026-11-12 记忆防重）：活页里是否存在与 body 归一化后完全相同的
 *  另一页。ignoreIds = 本批即将离池或正在被取代的页——它们不该算「名字/正文被占着」。 */
function findLivePageByBodyHash(body: string, ignoreIds: readonly string[] = []): { id: string; title: string } | null {
  if (normalizeMemoryContent(body).length < BODY_HASH_GATE_MIN_CHARS) return null
  const hash = memoryContentHash(body)
  const rows = getDb()
    .prepare("SELECT id, title FROM memory_pages WHERE content_hash = ? AND superseded_by IS NULL AND retired_at IS NULL AND type <> 'experience'")
    .all(hash) as Array<{ id: string; title: string }>
  const skip = new Set(ignoreIds)
  const hit = rows.find((r) => !skip.has(r.id))
  if (hit) return hit
  // 经验（n9）：正文已不在 memory_pages，撞重门得自己在磁盘上再比一遍，
  // 否则「同一份经验再建一遍」会绕过这道门悄悄进池子。
  for (const rec of allExperienceRecords()) {
    if (skip.has(rec.id) || !isLiveExperience(rec)) continue
    if (memoryContentHash(rec.body) === hash) return { id: rec.id, title: rec.title }
  }
  return null
}
/** 整页写入（迁移/手工路径）：按 id 插入或全量更新，不做协议校验——调用方对数据负责。
 *  唯一例外是跨页正文撞重（2026-11-12 记忆防重）：新 id 写入一段与既有活页完全相同的
 *  正文，在检索里就是两条互相打脸的证据，园丁也永远分不清该并哪一条。传
 *  allowDuplicateBody: true 可显式放行（迁移重放/审计导入）。 */
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
    // 正文撞重门（2026-11-12）：只在**新 id** 上生效（既有行的自我覆写不算跨页重复）。
    // 不抛错而是跳过——这条路径在启动期迁移里跑，抛错会拖崩宿主；返回既有页保证调用
    // 方拿到的仍是「这段正文的那个页」。
    if (!existing && !input.allowDuplicateBody) {
      const dup = findLivePageByBodyHash(input.body, [id])
      if (dup) {
        console.log(`[memory-pages] duplicate body skipped (already stored as ${dup.id} "${dup.title}")`)
        return getMemoryPageById(dup.id)!
      }
    }
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
  // 撞重短路会从事务里带回既有页——别丢弃它去查那个从未插入的新 id。
  return write() ?? getMemoryPageById(id)!
}

const TRUNCATION_GUARD_BODY = 1500
const TRUNCATION_GUARD_RATIO = 0.9

/** 写协议执行器。op 级隔离（每 op 独立事务 + 独立 try/catch）：一个坏 op 不拖垮同批
 *  其它 op——批级单事务做不到这一点（任一 op 失败即整体回滚），与 PLAN 2.2 的
 *  「op 级失败不影响同批其它 op」对齐，这里选择 op 级原子而非批级原子。 */
export function applyPageOps(ops: PageOp[]): PageOpResult[] {
  const results: PageOpResult[] = []
  // 合并组（2026-11-12 记忆防重）：同批里 supersede 到**同一个新标题**的多个 op 是
  // 「把这 N 页并成一页」。旧实现逐个 op 独立建页，第二个 op 的撞名检查立刻撞上第一个
  // 刚建的新页——合并组自己锁死自己（就算侥幸跑通也会建出 N 个同标题新页）。
  // 现在：第一个 op 建页，其余 op 只把自家旧页挂到同一个新 id。
  const groupOf = new Map<string, string>() // 新标题(NOCASE) → 已建新页 id
  const groupTargets = new Map<string, string[]>() // 新标题(NOCASE) → 同组各 op 的旧页 id
  const headIndex = listPageIndex()
  for (const op of ops) {
    if (op.action !== 'supersede' || !op.title || !op.target) continue
    const key = normalizeTitle(op.title).toLowerCase()
    const targetId = resolvePageByRef(headIndex, op.target)
    if (!targetId) continue
    const list = groupTargets.get(key) ?? []
    if (!list.includes(targetId)) list.push(targetId)
    groupTargets.set(key, list)
  }
  for (const op of ops) {
    try {
      results.push(applyOnePageOp(op, { groupOf, groupTargets, headIndex }))
    } catch (error) {
      results.push({ op, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return results
}

/** 经验页磁盘镜像（2026-11-12，经验 SKILL 化）：正文与静态元数据的真源在
 *  `~/.pulsemind/experience/<id>/EXPERIENCE.md`，DB 行只留流水与索引。
 *  调用点一律在 DB 事务**成功之后** —— 先落库再落盘：盘写失败只让磁盘落后一版，
 *  下一次 op 会重写；反过来「盘有库无」会让 listPageIndex 认不出这页，撞名门与
 *  touch 记账同时失聪。 */
function mirrorExperienceToDisk(page: {
  id: string
  title: string
  summary: string | null
  body: string
  aliases: string[]
  files: MemoryPageFile[] | null
  createdAt: string
  updatedAt: string
  sourceConversationId?: string | null
}): void {
  const prev = experienceStore.readSync(page.id)
  experienceStore.writeSync({
    meta: {
      id: page.id,
      title: page.title,
      description: page.summary ?? prev?.meta.description ?? '',
      maturity: deriveMaturity(page.files),
      aliases: page.aliases,
      sourceConversationId: page.sourceConversationId ?? prev?.meta.sourceConversationId,
      createdAt: prev?.meta.createdAt ?? page.createdAt,
      updatedAt: page.updatedAt,
    },
    body: page.body,
  })
  for (const f of page.files ?? []) experienceStore.writeScriptSync(page.id, f.path, f.content)
}

interface ApplyContext {
  groupOf: Map<string, string>
  groupTargets: Map<string, string[]>
  /** 批前快照（applyPageOps 入口取一次）。合并组重解析用：本批新建的新页不在其中，
   *  拿它解析 op.target 只会命中旧页——这正是 join 路径需要的语义。 */
  headIndex: PageIndexEntry[]
}

function applyOnePageOp(op: PageOp, ctx: ApplyContext): PageOpResult {
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
    // 正文撞重门（2026-11-12）：正文与既有活页一字不差的「新页」只是同一事实的第二个副本。
    const dupBody = findLivePageByBodyHash(op.content ?? '')
    if (dupBody) throw new Error(`正文撞重: 与「${dupBody.title}」(${dupBody.id}) 完全相同（用 update 改那一页，或 supersede 留谱系）`)
    const id = mintPageId()
    // 经验（n9）：不写 memory_pages、不进 FTS —— 正文与静态元数据在磁盘 EXPERIENCE.md，
    // 流水在 experience_uses。撞名门与正文撞重门在分流之前已跑过（index 已合成经验）。
    if (op.type === 'experience') {
      ensureExperienceUses(id, { createdAt: now, updatedAt: now })
      mirrorExperienceToDisk({
        id,
        title,
        summary: op.summary ?? null,
        body: op.content ?? '',
        aliases: op.aliases ?? [],
        files: op.files ?? null,
        createdAt: now,
        updatedAt: now,
      })
      // 30 条上限：把池子压回去，刚建的这一条不参与本轮淘汰。
      enforceExperienceCap(id)
      return { op, ok: true, pageId: id }
    }
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
    // 经验（n9）：正文/aliases 只落磁盘，memory_pages 不再保留这一行。
    if (target.type === 'experience') {
      ensureExperienceUses(targetId, { createdAt: target.createdAt, updatedAt: now })
      mirrorExperienceToDisk({
        id: targetId,
        title: target.title,
        summary: newSummary,
        body: op.content!,
        aliases: mergedAliases,
        files: target.files,
        createdAt: target.createdAt,
        updatedAt: now,
      })
      return { op, ok: true, pageId: targetId }
    }
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
    // 经验（n9）：aliases 是静态元数据，随 frontmatter 走磁盘。
    if (target.type === 'experience') {
      ensureExperienceUses(targetId, { createdAt: target.createdAt, updatedAt: now })
      mirrorExperienceToDisk({
        id: targetId,
        title: target.title,
        summary: target.summary,
        body: target.body,
        aliases: merged,
        files: target.files,
        createdAt: target.createdAt,
        updatedAt: now,
      })
      return { op, ok: true, pageId: targetId }
    }
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
    // 经验（n9）：正文追加落磁盘，recurrence / last_reinforced_at 进 experience_uses。
    ensureExperienceUses(targetId, { createdAt: target.createdAt, updatedAt: now })
    bumpExperienceRecurrence(targetId)
    mirrorExperienceToDisk({
      id: targetId,
      title: target.title,
      summary: target.summary,
      body: newBody,
      aliases: target.aliases,
      files: target.files,
      createdAt: target.createdAt,
      updatedAt: now,
    })
    return { op, ok: true, pageId: targetId }
  }

  // retire（2026-11-12 用户裁定「不要软退役，硬删除」）：过时/错误/被完全吸收的页
  // 连同行、FTS 影子、经验磁盘目录一并物理删除。理由不再入库存档，但仍是必填 ——
  // 只写进主进程日志，删了什么、为什么删必须能复盘。取代链不走这里：supersede
  // 保留旧页（谱系是决策演进，见下方分支）。
  if (op.action === 'retire') {
    const reason = (op.reason ?? '').trim()
    if (!reason) throw new Error('RETIRE 需要 reason（删除必须留审计理由）')
    // 脚本保全同款护栏：compile pass 不整理 SOP 页，也不得删它们——固化流程管辖。
    if (target.files && target.files.length > 0) {
      throw new Error(`脚本保全: "${target.title}" 携带 ${target.files.length} 个脚本，不走 retire（SOP 页由固化流程管辖）`)
    }
    console.warn(`[memory-pages] retire 硬删 #${targetId} "${target.title}" (${target.type})；理由：${reason}`)
    deleteMemoryPage(targetId)
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
  const groupKey = newTitle.toLowerCase()
  // 合并组撞名豁免：同组里正被取代掉的旧页，名字此刻该算「已腾出」；targetId 自己同理。
  const groupIds = ctx.groupTargets.get(groupKey) ?? []
  const ignoreIds = groupIds.filter((id) => id !== targetId)

  // 合并组后续 op：新页已由同组第一个 op 建好，这里只把本 op 的旧页挂到同一个新 id。
  // 不建页、不重算撞名（新页本就该占这个标题），只在旧页上补 superseded_by。
  const existingGroupNewId = ctx.groupOf.get(groupKey)
  if (existingGroupNewId) {
    // 自环守卫（2026-11-12 review P3，实际 P2）：新页 updated_at = now，在索引里排第一，
    // 而合并最常见的形态是「拿某个成员的既有标题当规范标题」——那个 op 的 target 是裸标题，
    // 在**本批新建**的索引里会解析到新页自身，于是写出 superseded_by = 自身：listPageIndex
    // 剔除它、resolveSupersedeChain 又按起点自持把它返回，结果目录看不见、recall 搜得到，
    // 而本 op 的旧页根本没被取代 = 合并静默失效。headIndex 是批前快照（里面没有本批新页），
    // 用它重解析只会命中旧页。
    let joinTargetId = targetId
    if (joinTargetId === existingGroupNewId) {
      const reResolved = resolvePageByRef(ctx.headIndex, targetRef)
      if (!reResolved || reResolved === existingGroupNewId) {
        throw new Error(`合并组 target 指向新页: "${targetRef}" 解析到本组新建的 ${existingGroupNewId}，批前快照里找不到对应旧页`)
      }
      joinTargetId = reResolved
    }
    const joinTarget = joinTargetId === targetId ? target : getMemoryPageById(joinTargetId)
    if (!joinTarget) throw new Error(`合并组目标页丢失: ${joinTargetId}`)
    const groupPage = getMemoryPageById(existingGroupNewId)
    if (!groupPage) throw new Error(`合并组新页丢失: ${existingGroupNewId}`)
    // 第 2..N 个 op 携带的 aliases/links/files 并进新页：prompt 要求各 op 带同一份
    // aliases union（协议内重复无害），但 links/files 从不要求一致——丢弃会让检索面
    // 静默缩水、收编后的继任页拿不到脚本。旧页标题同样作为 link 留痕（与首 op 同款）。
    const joinedAliases = mergeUniqueNocase(groupPage.aliases, newAliases)
    const joinedLinks = mergeUniqueNocase(groupPage.links, [...(op.links ?? []), joinTarget.title])
    const joinedFiles = mergePageFiles(groupPage.files, joinTarget.files, newFiles)
    // 经验（n9）：新页已在磁盘上，这里补并集后的 aliases/files 与旧页的取代链。
    if (groupPage.type === 'experience') {
      ensureExperienceUses(existingGroupNewId, { createdAt: groupPage.createdAt, updatedAt: now })
      // 取代链按成员真源分流：经验成员进 experience_uses；非经验成员仍在 memory_pages——
      // experience_uses 是 isExperienceId 的判定面，给 DB 页写流水行会让它的
      // touch/delete/开关永久误路由进经验分支（review 2026-11-12）。
      let dbJoinTargetId: string | null = null
      if (joinTargetId !== existingGroupNewId) {
        if (joinTarget.type === 'experience') {
          ensureExperienceUses(joinTargetId, { updatedAt: now })
          markExperienceSuperseded(joinTargetId, existingGroupNewId)
        } else {
          dbJoinTargetId = joinTargetId
        }
      }
      if (dbJoinTargetId) {
        database.prepare('UPDATE memory_pages SET superseded_by = ?, updated_at = ? WHERE id = ?').run(existingGroupNewId, now, dbJoinTargetId)
      }
      mirrorExperienceToDisk({
        id: existingGroupNewId,
        title: groupPage.title,
        summary: groupPage.summary,
        body: groupPage.body,
        aliases: joinedAliases,
        files: joinedFiles.length > 0 ? joinedFiles : null,
        createdAt: groupPage.createdAt,
        updatedAt: now,
      })
      return { op, ok: true, pageId: existingGroupNewId }
    }
    const runJoined = database.transaction(() => {
      // 经验成员（n9）的取代链在 experience_uses：memory_pages 无此行，UPDATE 落 0 行
      // 就是静默不挂链——正文已并入新页而旧经验仍活在池子里（混合类型合并组，review
      // 2026-11-12 实锤）。DB 侧只写非经验成员，经验成员在事务后补 markExperienceSuperseded。
      if (joinTarget.type !== 'experience') {
        database.prepare('UPDATE memory_pages SET superseded_by = ?, updated_at = ? WHERE id = ?').run(existingGroupNewId, now, joinTargetId)
      }
      database
        .prepare('UPDATE memory_pages SET aliases = ?, links = ?, files_json = ?, maturity = ? WHERE id = ?')
        .run(JSON.stringify(joinedAliases), JSON.stringify(joinedLinks), joinedFiles.length > 0 ? JSON.stringify(joinedFiles) : null, deriveMaturity(joinedFiles.length > 0 ? joinedFiles : null), existingGroupNewId)
      ftsUpsert({ id: existingGroupNewId, title: groupPage.title, aliases: joinedAliases, body: groupPage.body })
    })
    runJoined()
    if (joinTarget.type === 'experience') {
      ensureExperienceUses(joinTargetId, { updatedAt: now })
      markExperienceSuperseded(joinTargetId, existingGroupNewId)
    }
    return { op, ok: true, pageId: existingGroupNewId }
  }

  const collisions = findNameCollisions(index, { title: newTitle, aliases: newAliases, ignoreId: targetId, ignoreIds })
  if (collisions.length > 0) throw new Error(`撞名: ${collisions.map((c) => `${c.value} ← ${c.holderTitle}`).join('; ')}`)
  // 正文撞重门（2026-11-12）：继任页正文若与另一张活页一字不差，取代就成了「换个 id
  // 复制一份」——旧页进谱系、新页仍是重复。豁免 targetId 自己与同组正被取代的旧页。
  const dupBody = findLivePageByBodyHash(newBody, [targetId, ...groupIds])
  if (dupBody) throw new Error(`正文撞重: 与「${dupBody.title}」(${dupBody.id}) 完全相同（supersede 的正文必须是新的合并结果）`)
  const newId = mintPageId()
  const links = mergeUniqueNocase(op.links ?? [], [target.title])
  // 经验（n9）：继任页落磁盘 + 新流水行；旧页取代链同样走 experience_uses。
  if (newType === 'experience') {
    ensureExperienceUses(newId, { createdAt: now, updatedAt: now })
    mirrorExperienceToDisk({
      id: newId,
      title: newTitle,
      summary: op.summary ?? null,
      body: newBody,
      aliases: newAliases,
      files: newFiles,
      createdAt: now,
      updatedAt: now,
      sourceConversationId: target.sourceConversationId,
    })
    if (target.type === 'experience') markExperienceSuperseded(targetId, newId)
    else database.prepare('UPDATE memory_pages SET superseded_by = ?, updated_at = ? WHERE id = ?').run(newId, now, targetId)
    if ((ctx.groupTargets.get(groupKey) ?? []).length > 1) ctx.groupOf.set(groupKey, newId)
    // 30 条上限：新页顶替旧页通常不增数，但「非经验页被经验继任」会 +1，照样压回去。
    enforceExperienceCap(newId)
    return { op, ok: true, pageId: newId }
  }
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
  // 旧的**经验**页被非经验继任页取代时，取代链同样记进 experience_uses。
  if (target.type === 'experience') markExperienceSuperseded(targetId, newId)
  // 注册合并组：同批后续 supersede 到同一新标题的 op 会把各自旧页挂到这个新 id 上。
  if ((ctx.groupTargets.get(groupKey) ?? []).length > 1) ctx.groupOf.set(groupKey, newId)
  return { op, ok: true, pageId: newId }
}

/** files 并集（按 path 去重，先到先得）：合并组第 2..N 个 op 携带的脚本必须落到同一张
 *  新页上——supersede 的脚本保全护栏只保证「带了才放行」，join 不并集就等于继任页丢脚本。 */
function mergePageFiles(...groups: Array<MemoryPageFile[] | null | undefined>): MemoryPageFile[] {
  const seen = new Map<string, MemoryPageFile>()
  for (const group of groups) {
    for (const f of group ?? []) {
      if (f && !seen.has(f.path)) seen.set(f.path, f)
    }
  }
  return [...seen.values()]
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
  // 经验（n9）：物理删磁盘目录 + 流水行；取代链由 deleteExperienceUses 剪断。
  if (isExperienceId(id)) {
    experienceStore.removeSync(id)
    deleteExperienceUses(id)
    return
  }
  const database = getDb()
  const run = database.transaction(() => {
    withPagesFtsRecovery(() => database.prepare('DELETE FROM memory_pages_fts WHERE page_id = ?').run(id))
    database.prepare('DELETE FROM memory_pages WHERE id = ?').run(id)
    // 取代链上的继任页引用被删页时，把链剪断（被取代页回到活页），避免死链
    database.prepare('UPDATE memory_pages SET superseded_by = NULL WHERE superseded_by = ?').run(id)
  })
  run()
}

/** 清空提取记忆（2026-11-12 用户裁定：设置面板要「清空」按钮）。
 *  按类型整族删除，**含退役与被取代的历史行**——面板把灰卡也画出来，只清活页
 *  会留一屏灰卡，看起来像没清干净。经验页不在此列（调用方只传三类）。
 *  FTS 与取代链处理同 deleteMemoryPage：索引同步删，外部指向被删页的
 *  superseded_by 一并剪断，避免死链。返回实际删除的行数。 */
export function clearMemoryPagesByTypes(types: MemoryPageType[]): number {
  // 经验（n9）不参与整族清空：66 个磁盘目录的删除必须走面板的逐条入口，
  // 一键「清空」误伤面太大。调用方本来就只传三类，这里把危险挡在门外。
  const effective = types.filter((t) => t !== 'experience')
  if (effective.length === 0) return 0
  const database = getDb()
  const ph = effective.map(() => '?').join(', ')
  const run = database.transaction(() => {
    const ids = (database.prepare(`SELECT id FROM memory_pages WHERE type IN (${ph})`).all(...effective) as { id: string }[]).map((r) => r.id)
    if (ids.length === 0) return 0
    withPagesFtsRecovery(() => {
      const delFts = database.prepare('DELETE FROM memory_pages_fts WHERE page_id = ?')
      for (const id of ids) delFts.run(id)
    })
    database.prepare(`DELETE FROM memory_pages WHERE type IN (${ph})`).run(...effective)
    const cut = database.prepare('UPDATE memory_pages SET superseded_by = NULL WHERE superseded_by = ?')
    for (const id of ids) cut.run(id)
    return ids.length
  })
  return run() as number
}

/** 自动固化的失败记账（PLAN-experience-sop 刀四）：settleOutcome 的非升格分支
 *  调用——24h 退避 + 3 次退役的计数面。成功尝试不进来（页面已被 supersede）。 */
export function recordSopFailedAttempt(id: string): void {
  // 经验（n9）走流水表；未知 id 的老行为是 UPDATE 落空，这里同样静默。
  if (isExperienceId(id)) {
    bumpExperienceSopAttempt(id)
    return
  }
  const database = getDb()
  database
    .prepare('UPDATE memory_pages SET sop_attempts = sop_attempts + 1, sop_last_attempt_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id)
}

/** 使用侧 touch（PLAN-experience-sop B5）：pick_skill 选中经验页时记账。不是
 *  PageOp——touch 不是 wiki 编辑。hint 触达刻意不记账（逐回合命中太噪），
 *  pick 是有意图的拉取；recall 路径的记账在 searchMemoryPages 尾部。 */
export function touchMemoryPage(id: string): void {
  // 经验（n9）：use_count / last_used_at 在 experience_uses —— LRU 淘汰的判据面。
  if (isExperienceId(id)) {
    touchExperienceUse(id)
    return
  }
  const database = getDb()
  database
    .prepare('UPDATE memory_pages SET use_count = use_count + 1, last_used_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id)
}

/** 经验卡开关（2026-10-27）。不动 updated_at——开关是使用态不是内容修订，
 *  列表按 updated_at 排序，拨一下开关不该让卡片跳位。 */
export function setMemoryPageEnabled(id: string, enabled: boolean): void {
  if (isExperienceId(id)) {
    setExperienceEnabled(id, enabled)
    return
  }
  const database = getDb()
  database.prepare('UPDATE memory_pages SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
}

// ── 检索（M0a 定形的匹配栈）──

const LIKE_HEAD_SCORE = 50
// title/aliases 兜底命中的粗排中位（2026-10-28）：二字词进不了 trigram FTS，只能走
// LIKE 兜底——标题/别名命中的页压过 body-only 命中，但都让位一切 bm25 命中（负分）。
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
    // headHit 子查询（2026-10-28）：同一个兜底内部区分 title/aliases 命中（中位）
    // 与 body-only 命中（恒后），否则「标题就是查询词」的页与「正文顺带提了一嘴」
    // 的页同分、只靠 updatedAt 决胜负。
    const rows = database
      .prepare(
        `SELECT id, (title LIKE ? ESCAPE '\\' OR aliases LIKE ? ESCAPE '\\') AS headHit
         FROM memory_pages
         WHERE title LIKE ? ESCAPE '\\' OR aliases LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\'`
      )
      .all(pat, pat, pat, pat, pat) as Array<{ id: string; headHit: number }>
    for (const r of rows) {
      scores.set(r.id, Math.min(scores.get(r.id) ?? Infinity, r.headHit ? LIKE_HEAD_SCORE : LIKE_FALLBACK_SCORE))
    }
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
  // 经验（n9）的磁盘检索不依赖 resolved，ids 为空不早退（否则 type='experience' 的
  // 显式搜索在纯磁盘池上永远拿空——技能中心经验分区的搜索框就是这条路径）。
  if (ids.length === 0 && input.type !== 'experience') return []
  const records = new Map<string, MemoryPageRecord>()
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',')
    const rows = database.prepare(`SELECT * FROM memory_pages WHERE id IN (${placeholders})`).all(...ids) as MemoryPageRow[]
    for (const r of rows) records.set(r.id, rowToRecord(r))
  }

  const hits: MemoryPageSearchHit[] = []
  for (const [liveId, meta] of resolved) {
    const record = records.get(liveId)
    if (!record) continue
    if (input.type && record.type !== input.type) continue
    // 经验残留行不进检索（迁移黑洞/升级遗留）：磁盘活页才是真源，DB 里没有它们。
    if (record.type === 'experience') continue
    // 退役页不进检索结果：取代链解析到它即止——退役判的是内容本身过时，
    // 不回落链上旧页（旧页只是历史版本，不是有效内容）。
    if (record.retiredAt) continue
    hits.push({ record, viaFts: meta.viaFts })
  }
  // 经验（n9）：正文不在 DB/FTS，type='experience' 的**显式**检索在磁盘活页上比
  // （与 listPageIndex 的合成同源）。缺省检索保持排除经验——E7 纪律不变，recall 的
  // 消费方（domain-tools memory_search、记忆面板无类型视图）也各自过滤 experience。
  // 打分沿用 LIKE 档：title/alias 命中（中位）压过 body-only（恒后）。
  const diskScores = new Map<string, number>()
  if (input.type === 'experience') {
    for (const rec of allExperienceRecords()) {
      if (!isLiveExperience(rec)) continue
      const headHit = [rec.title, ...rec.aliases].some((t) => likeNeedles.some((n) => t.toLowerCase().includes(n)))
      const bodyHit = likeNeedles.some((n) => rec.body.toLowerCase().includes(n))
      if (!headHit && !bodyHit) continue
      diskScores.set(rec.id, headHit ? LIKE_HEAD_SCORE : LIKE_FALLBACK_SCORE)
      hits.push({ record: rec, viaFts: false })
    }
  }
  hits.sort((a, b) => {
    const sa = resolved.get(a.record.id)?.score ?? diskScores.get(a.record.id)!
    const sb = resolved.get(b.record.id)?.score ?? diskScores.get(b.record.id)!
    if (sa !== sb) return sa - sb
    return b.record.updatedAt.localeCompare(a.record.updatedAt)
  })
  const limited = hits.slice(0, limit)

  const now = new Date().toISOString()
  // 记账跟真源走：磁盘经验的 use_count/last_used_at 在 experience_uses（LRU 淘汰的
  // 判据面），memory_pages 的 UPDATE 对它落 0 行。
  const touch = database.transaction(() => {
    const stmt = database.prepare('UPDATE memory_pages SET use_count = use_count + 1, last_used_at = ? WHERE id = ?')
    for (const h of limited) {
      if (h.record.type === 'experience') continue
      stmt.run(now, h.record.id)
    }
  })
  touch()
  for (const h of limited) if (h.record.type === 'experience') touchExperienceUse(h.record.id)
  return limited
}
