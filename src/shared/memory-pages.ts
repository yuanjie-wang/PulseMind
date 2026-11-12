// 记忆页（PLAN-memory-wiki，2026-10-25）——共享纯逻辑层：类型、取代链解析、
// 名称冲突判定、提取目录构造、检索词分解。主进程存储（memory-pages-store）与
// 渲染端（面板/工具格式化）共同消费；不依赖 DB、不依赖 Electron，vitest 直接覆盖。
//
// 检索栈的形状由 scripts/probe-memory-fts-recall.mjs 实测钉死（M0a，2026-10-25）：
// 整句改写查询对平铺内容的 trigram 短语/LIKE 双双 0% 命中；页面层（title+aliases）
// + 词拆分匹配（≥3 字符词走 FTS 短语、短词与 CJK 长串滑窗二元组走 LIKE 兜底、
// bm25 排序 + LIKE 恒后位）把改写召回拉到 90%。改这里之前先跑那个探针。

export type MemoryPageType = 'preference' | 'decision' | 'fact' | 'experience'

export const MEMORY_PAGE_TYPES: readonly MemoryPageType[] = ['preference', 'decision', 'fact', 'experience'] as const

export interface MemoryPageFile {
  path: string
  content: string
}

export interface MemoryPageRecord {
  id: string
  title: string
  type: MemoryPageType
  /** 一句话结论（≤50 字；提取协议产出、compile pass 补齐）；NULL = 未补。
   *  recall 长页信封与卡片描述消费——「长文档一律摘要化」的数据基础。 */
  summary: string | null
  body: string
  aliases: string[]
  links: string[]
  /** 被哪一页取代（页 id）；null = 活页。读侧永远经 resolveSupersedeChain 解析到活页。 */
  supersededBy: string | null
  sourceConversationId: string | null
  files: MemoryPageFile[] | null
  useCount: number
  lastUsedAt: string | null
  createdAt: string
  updatedAt: string
  /** PLAN-experience-sop 刀一：'clue' = 一阶段叙事线索（默认）；'sop' = 携带
   *  验证过脚本的经验页。派生规则（存储层执法，不进 wire）：create/supersede
   *  带 files ⇒ 'sop'。 */
  maturity: MemoryPageMaturity
  /** reinforce 次数（同一线索在后续会话重现的计数，二阶段自动固化的资格信号）。 */
  recurrence: number
  lastReinforcedAt: string | null
  /** 自动固化的失败尝试记账（PLAN-experience-sop 刀四）：24h 退避 + 3 次退役的
   *  数据面；成功的尝试 supersede 掉页面，不留在候选里。手动按钮不受此门。 */
  sopAttempts: number
  sopLastAttemptAt: string | null
  /** 退役两字段（compile pass 的 retire op）：2026-11-12 用户裁定改为**硬删除**——
   *  retire 走 deleteMemoryPage，行与 FTS 影子行一并消失，不再有可恢复软态，
   *  这两个列因此在活页上恒为 NULL（保留列定义只为让旧库平稳 ALTER，勿再写入）。
   *  与 supersededBy 独立：取代（supersede）仍保留旧页并挂链，谱系可追溯。 */
  retiredAt: string | null
  retireReason: string | null
  /** 启用开关（2026-10-27，经验也是技能——技能卡有开关，经验卡同样有）。
   *  false = 不进 pick_skill 候选表、不进 state block 经验提示、不进 SOP 自动
   *  固化；显式按名拉取仍可解析（与 SkillManager.getSkill 对停用技能的行为一致）。
   *  supersede 的继任页继承该态。非经验页恒为 true（列在页上、查询面单列）。 */
  enabled: boolean
  /** 经验页磁盘真源的绝对路径（2026-11-12 起经验以 EXPERIENCE.md 为真源）。
   *  仅经验页有值；其它类型的页住在 DB 里，字段缺席。 */
  filePath?: string
}

/** 经验页成熟度：'clue' = 一阶段叙事线索；'sop' = 携带脚本的经验页（存储层按
 *  files 派生）。非经验页恒为 'clue'——列在页上而非按 type 分叉，查询面单列。 */
export type MemoryPageMaturity = 'clue' | 'sop'

export type PageOpAction = 'create' | 'update' | 'alias' | 'supersede' | 'reinforce' | 'retire'

/** 写协议的一次操作。target = 既有页的 title 或 alias（NOCASE，update/alias/supersede/reinforce/retire 必填），
 *  也可以是页 id 或 `#<id>`（同名页无法按 title 区分时的精确指认，2026-11-12）；
 *  title = 新页标题（create/supersede 必填，update 忽略）。 */
export interface PageOp {
  action: PageOpAction
  target?: string
  title?: string
  type?: MemoryPageType
  content?: string
  /** 一句话结论（create/supersede 可给；preference/fact 短页可省）。 */
  summary?: string
  aliases?: string[]
  links?: string[]
  /** 经验页脚本（content 里的 ### File: 围栏由解析侧拆出，存 files_json）。 */
  files?: MemoryPageFile[]
  /** reinforce 专用：一行说明什么重现了（进页尾「## 重现记录」节）。 */
  note?: string
  /** retire 专用：退役理由（必填，进库审计；UI 已退役标签的 tooltip）。 */
  reason?: string
}

/** 活页判定（全消费面共用）：未被取代且未退役。supersededBy 是谱系演进
 *  （读侧经 resolveSupersedeChain 解析到活页）；retiredAt 是园丁出口（链到此为止，
 *  不回落旧页——退役判的是内容本身过时）。 */
export function isLivePage(p: Pick<MemoryPageRecord, 'supersededBy' | 'retiredAt'>): boolean {
  return !p.supersededBy && !p.retiredAt
}

/** files ⇒ maturity 的唯一派生规则（PLAN-experience-sop 刀一）：带脚本的页就是
 *  SOP。create/supersede 的落库分支与迁移 upsert 共用，别处不许自定标准。 */
export function deriveMaturity(files?: MemoryPageFile[] | null): MemoryPageMaturity {
  return files && files.length > 0 ? 'sop' : 'clue'
}

/** 经验页重现节（reinforce 的落点）：note 追加到 body 尾部「## 重现记录」节，
 *  每行 `- <日期> <note>`；超 max 条 FIFO 截尾（最新在上）。纯函数，vitest 直测。 */
export const RECURRENCE_SECTION = '## 重现记录'
export const RECURRENCE_NOTE_MAX = 10

export function appendRecurrenceNote(body: string, note: string, dateStamp: string, max: number = RECURRENCE_NOTE_MAX): string {
  const line = `- ${dateStamp} ${note.trim()}`
  const marker = `${RECURRENCE_SECTION}\n`
  const idx = body.indexOf(marker)
  if (idx === -1) {
    const sep = body.trim().length > 0 ? '\n\n' : ''
    return `${body.trimEnd()}${sep}${RECURRENCE_SECTION}\n${line}`
  }
  const head = body.slice(0, idx).trimEnd()
  const tail = body.slice(idx + marker.length)
  const existing = tail.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- '))
  const next = [line, ...existing].slice(0, max)
  return `${head}\n\n${RECURRENCE_SECTION}\n${next.join('\n')}`
}

/** 单个 op 的执行结果（op 级隔离：一个坏 op 不拖垮同批其它 op）。 */
export interface PageOpResult {
  op: PageOp
  ok: boolean
  pageId?: string
  error?: string
}

/** ≤ 该长度的页在 recall 结果里内联全文；超长只给摘要 + id 取回。 */
export const MEMORY_PAGE_INLINE_MAX = 2000

/** 提取目录的全量预算：活页数超过它就回落按 type 分桶（红线：不许静默截断）。 */
export const MEMORY_PAGE_CATALOG_BUDGET = 400

// ── 基础 ──

export function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ')
}

function hasCjk(s: string): boolean {
  return /[\u4e00-\u9fff]/.test(s)
}

/** 活页索引（目录、target 解析、冲突判定的输入）——只含未取代页。 */
export interface PageIndexEntry {
  id: string
  title: string
  type: MemoryPageType
  aliases: string[]
}

/** target 解析：id 精确（`<id>` 或 `#<id>`）优先，其次 title（NOCASE），最后 alias（NOCASE）。
 *  id 直查是 2026-11-12 加的：同名页按 title 永远命中第一个，只有 id 能指认第二个。 */
export function resolvePageByRef(pages: readonly PageIndexEntry[], ref: string): string | null {
  const raw = ref.trim()
  if (!raw) return null
  const bare = raw.startsWith('#') ? raw.slice(1).trim() : raw
  if (bare) for (const p of pages) if (p.id === bare) return p.id
  const want = normalizeTitle(raw).toLowerCase()
  if (!want) return null
  for (const p of pages) if (p.title.toLowerCase() === want) return p.id
  for (const p of pages) if (p.aliases.some((a) => a.toLowerCase() === want)) return p.id
  return null
}

/** 取代链解析：走到活页；断链/成环按起点自持处理（宁可读到旧页也不读不到）。 */
export function resolveSupersedeChain(
  byId: ReadonlyMap<string, Pick<MemoryPageRecord, 'id' | 'supersededBy'>>,
  startId: string
): string {
  let current = startId
  for (let depth = 0; depth < 16; depth++) {
    const page = byId.get(current)
    if (!page || !page.supersededBy) return current
    if (!byId.has(page.supersededBy)) return current // 断链：current 是链上最后真实存在的页，不返回幽灵 id
    current = page.supersededBy
  }
  return current
}

// ── 名称冲突（title 与 alias 共用一个 NOCASE 命名空间）──

export interface NameCollision {
  value: string
  kind: 'title' | 'alias'
  holderId: string
  holderTitle: string
}

/** 新 title/alias 与既有页的 title/alias 撞名清单（忽略 ignoreId/ignoreIds 指向的页自身）。
 *  ignoreIds 是 2026-11-12 加的：同批里会被 supersede/retire 掉的页即将离开活页池，
 *  它们占着的名字此刻该算「已腾出」——否则把一个同名组并回同名标题时，第一个 op 就
 *  撞上同批第二个 op 的目标页，合并组永远开不了工。 */
export function findNameCollisions(
  pages: readonly PageIndexEntry[],
  incoming: { title?: string; aliases?: string[]; ignoreId?: string; ignoreIds?: readonly string[] }
): NameCollision[] {
  const skip = new Set<string>(incoming.ignoreIds ?? [])
  if (incoming.ignoreId) skip.add(incoming.ignoreId)
  const owned = new Set<string>()
  const holders = new Map<string, PageIndexEntry>()
  for (const p of pages) {
    if (skip.has(p.id)) continue
    for (const value of [p.title, ...p.aliases]) {
      const key = value.toLowerCase()
      if (!owned.has(key)) {
        owned.add(key)
        holders.set(key, p)
      }
    }
  }
  const collisions: NameCollision[] = []
  const check = (value: string, kind: 'title' | 'alias') => {
    const key = normalizeTitle(value).toLowerCase()
    if (key && owned.has(key)) {
      const holder = holders.get(key)!
      collisions.push({ value, kind, holderId: holder.id, holderTitle: holder.title })
    }
  }
  if (incoming.title) check(incoming.title, 'title')
  for (const a of incoming.aliases ?? []) check(a, 'alias')
  return collisions
}

// ── 提取目录（进 SessionReviewAgent prompt 的全量标题+别名目录）──

export interface PageCatalog {
  text: string
  mode: 'full' | 'bucketed'
  liveCount: number
}

export function buildPageCatalog(pages: readonly PageIndexEntry[], budget: number = MEMORY_PAGE_CATALOG_BUDGET): PageCatalog {
  // 调用方（listPageIndex）只喂活页；这里的 budget 判定基于全量输入
  if (pages.length === 0) return { text: '(no pages yet)', mode: 'full', liveCount: 0 }
  if (pages.length <= budget) {
    const lines = pages.map((p) => {
      const alias = p.aliases.length > 0 ? ` 别名: ${p.aliases.join(', ')}` : ''
      return `- ${p.title} (${p.type})${alias}`
    })
    return { text: lines.join('\n'), mode: 'full', liveCount: pages.length }
  }
  // 回落：按 type 分桶，桶内截断必须显式标注（红线：不许静默截断）。
  const parts: string[] = [`(catalog over budget — grouped by type; ${pages.length} live pages total)`]
  for (const type of MEMORY_PAGE_TYPES) {
    const bucket = pages.filter((p) => p.type === type)
    if (bucket.length === 0) continue
    const shown = bucket.slice(0, Math.floor(budget / MEMORY_PAGE_TYPES.length))
    const more = bucket.length - shown.length
    parts.push(`## ${type} (${bucket.length})`)
    parts.push(...shown.map((p) => `- ${p.title}${p.aliases.length > 0 ? ` 别名: ${p.aliases.join(', ')}` : ''}`))
    if (more > 0) parts.push(`… +${more} more (use exact titles when updating; unknown targets degrade to create)`)
  }
  return { text: parts.join('\n'), mode: 'bucketed', liveCount: pages.length }
}

// ── 检索词分解（M0a 定形的匹配栈）──

export interface SearchNeedles {
  /** FTS5 MATCH 表达式（OR 连接的短语）；空串 = 无 FTS 项 */
  ftsExpr: string
  /** LIKE 兜底 needle（已小写、去重、截到 16 个）；覆盖 <3 字符词与 CJK 滑窗二元组 */
  likeNeedles: string[]
}

export function buildSearchNeedles(query: string): SearchNeedles {
  const tokens = query.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const ftsTerms: string[] = []
  const needles: string[] = []
  const seen = new Set<string>()
  const push = (n: string) => {
    if (n.length >= 2 && !seen.has(n)) { seen.add(n); needles.push(n) }
  }
  for (const token of tokens) {
    if (token.length >= 3) ftsTerms.push('"' + token.replace(/"/g, '""') + '"')
    push(token.toLowerCase())
    // CJK 长串滑窗二元组：「怎么称呼我」里的「称呼」只有这里够得着（trigram 下限 3 字符）
    if (hasCjk(token) && token.length >= 4) {
      for (let i = 0; i + 2 <= token.length; i++) push(token.slice(i, i + 2))
    }
  }
  return { ftsExpr: ftsTerms.join(' OR '), likeNeedles: needles.slice(0, 16) }
}

// ── 提取目录（进 SessionReviewAgent prompt；写时归页的承重面）──

/** 目录里经验页正文摘录的帽：全文 ≤ 此长度才「可修订」（截断禁修订纪律）。 */
export const CATALOG_BODY_EXCERPT = 600
export const CATALOG_TRUNCATION_MARK = '「正文被截断」'

export interface CatalogPage {
  title: string
  type: MemoryPageType
  aliases: string[]
  body: string
}

export interface ExtractionCatalog {
  text: string
  mode: 'full' | 'bucketed'
  /** update 可用的页 title（全文可见且未截断——只有经验页展示正文）。 */
  revisableTitles: string[]
}

export function buildExtractionCatalog(pages: readonly CatalogPage[], budget: number = MEMORY_PAGE_CATALOG_BUDGET): ExtractionCatalog {
  if (pages.length === 0) return { text: '(no pages yet)', mode: 'full', revisableTitles: [] }
  const revisableTitles: string[] = []
  if (pages.length > budget) {
    // 分桶回落：只给标题，update 不可用（prompt 侧有对应禁令）
    const parts: string[] = [`(catalog over budget — grouped by type; ${pages.length} live pages total; update is unavailable this round)`]
    for (const type of MEMORY_PAGE_TYPES) {
      const bucket = pages.filter((p) => p.type === type)
      if (bucket.length === 0) continue
      const shown = bucket.slice(0, Math.floor(budget / MEMORY_PAGE_TYPES.length))
      const more = bucket.length - shown.length
      parts.push(`## ${type} (${bucket.length})`)
      parts.push(...shown.map((p) => `- ${p.title}${p.aliases.length > 0 ? ` 别名: ${p.aliases.join(', ')}` : ''}`))
      if (more > 0) parts.push(`… +${more} more`)
    }
    return { text: parts.join('\n'), mode: 'bucketed', revisableTitles: [] }
  }
  const lines = pages.map((p) => {
    const alias = p.aliases.length > 0 ? ` 别名: ${p.aliases.join(', ')}` : ''
    if (p.type !== 'experience') return `- ${p.title} (${p.type})${alias}`
    // 经验页带正文摘录：全文可见 → 可修订；截断 → 只读（update 会被降级）
    if (p.body.length <= CATALOG_BODY_EXCERPT) {
      revisableTitles.push(p.title)
      return `- ${p.title} (${p.type})${alias}\n  正文: ${p.body.replace(/\n/g, ' ')}`
    }
    return `- ${p.title} (${p.type})${alias}\n  正文: ${p.body.slice(0, CATALOG_BODY_EXCERPT).replace(/\n/g, ' ')} ${CATALOG_TRUNCATION_MARK}`
  })
  return { text: lines.join('\n'), mode: 'full', revisableTitles }
}
