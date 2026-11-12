// ── Memory page compile pass（PLAN-memory-wiki M6，2026-10-25；retire 硬删 2026-11-12）──
// 低频页面整理：合并近似页（迁移兜底臂的 per-row 页在此归并）、别名卫生、
// links 补全、过时页删除。输出复用 PageOp 协议；**只允许 supersede/alias/update/
// retire，不允许 create**——整理是收敛不是生产。两种收敛的后果**不同**，别混为一谈：
//   supersede —— 旧页保留（记 superseded_by，取代链谱系可追溯，merge 的首选）；
//   retire   —— **永久删除**：行、FTS 影子行、（经验的）整个目录连脚本一并消失，
//               不可恢复、没有 UI 逃生面；reason 是必填项，但只落主进程日志。
// 带脚本的页（SOP）禁止 retire：固化流程管辖，本 pass 删不动。
import { OneShotAgent } from './OneShotAgent'
import { extractJson } from './json-utils'
import { MEMORY_PAGE_TYPES, type MemoryPageType, type PageIndexEntry, type PageOp } from '../../../../shared/memory-pages'

export interface MemoryPageCompileInput {
  /** 本轮待整理的页面视图——大池子按游标分区轮转的一片，预算由调用侧选页保证；
   *  mode 保留 bucketed 契约位（titles-only 降级视图禁 supersede/update/retire），
   *  分区选页后正常不可达。 */
  pagesText: string
  mode: 'full' | 'bucketed'
  /** 活页索引（target 校验用，不进 prompt）。 */
  pageIndex: PageIndexEntry[]
  locale?: string
}

export interface MemoryPageCompileOutput {
  pages: PageOp[]
}

type RawOp = Partial<Record<'action' | 'target' | 'title' | 'type' | 'content' | 'reason', unknown>> & {
  aliases?: unknown
  links?: unknown
}

export class MemoryPageCompileAgent extends OneShotAgent<MemoryPageCompileInput, MemoryPageCompileOutput> {
  readonly name = 'MemoryPageCompileAgent'

  protected buildSystemPrompt(): string {
    return `\
You are the memory-wiki compile pass. The page list below is a SLICE of the store's LIVE pages (a large pool is compiled in rotating slices). Tidy it — you are a gardener, not an author.

Allowed actions, per insight:
- **supersede** — two or more pages cover the SAME topic (near-duplicates, or fragments of one subject): merge them into ONE canonical page. Emit one op per duplicate, all naming the SAME new title and the SAME complete merged body: {"action":"supersede","target":"<duplicate's exact title or alias>","title":"<canonical title>","type":"preference|decision|fact|experience","content":"<COMPLETE merged body — keep every still-valid sentence from every merged page, never truncate>","aliases":["<union of their aliases + likely search terms>"]}. The store marks each old page superseded_by the new page; lineage is preserved.
- **alias** — a page is findable under another obvious name: {"action":"alias","target":"...","aliases":["..."]}.
- **update** — ONLY for a page whose full body is shown without the 「正文被截断」 marker, and only to fix structure, fill "links", or add a missing "summary": {"action":"update","target":"...","content":"<FULL revised body>","summary":"<ONE sentence, max 50 chars — include this whenever the page has no summary line>","links":["<related page title>"]}.
- **retire** — a page is OBSOLETE and must GO: factually wrong now, about something the user explicitly retracted, or fully subsumed by another listed page so that merging would add nothing new. {"action":"retire","target":"...","reason":"<ONE sentence — why this page no longer belongs in the live pool>"}. Retire DELETES the page permanently — it is not a soft state and there is no undo. Judged from the page's own content and the 使用/重现 counters on its line:
  - retire is the LAST resort: prefer supersede whenever the content still has value — merge, don't discard;
  - NEVER retire a page merely for being old, short, or rarely used — low usage alone is not obsolescence;
  - never retire a page whose insight contradicts no other page and is not wrong.
  When in doubt, leave it alone: a wrong retire destroys content, a missed retire only leaves clutter.

Experience pages are DRAFT SKILLS — their bodies follow the SKILL.md manual standard:
- The manual structure is: ## 适用场景 (when to apply) / ## 步骤 (numbered imperative procedure) / ## 注意事项 (pitfalls, optional). A merged or restructured experience body KEEPS this structure.
- Converting an old case-narrative body (## 背景 / ## 过程 / ## 问题 / ## 优化 or free prose) INTO this manual structure is exactly the "fix structure" case: turn the narration into instructions a future session can execute.
- An experience "summary" is the skill-standard description (what it does + when to use), not an outcome report.

Hard rules:
- **Addressing** — a page's line may carry a bracketed id (\`[#page_xxx]\`) right after its type. That id is only present when the pool holds MORE THAN ONE page under that same title: such pages are indistinguishable by title, so target them by \`"target":"#<id>"\` (a bare duplicate title is AMBIGUOUS and your op will be dropped). Pages without a bracketed id are addressed by title or alias as usual.
- NEVER create a new topic. The ONLY way a page leaves the pool is retire, which deletes it permanently along with its search index entry (and, for an experience, its whole folder including scripts) — the reason you give goes to the main-process log, nowhere else. Merging still goes through supersede: the old pages are KEPT as lineage.
- A merged page inherits the most fitting type of its parts; "type" is required on supersede.
- You only see a SLICE: judge each page on its own merits and the pages visible here — never assume pages exist beyond the list.
- If nothing needs tidying, return {"pages": []} — a fully successful outcome.

Return ONLY a JSON object: {"pages":[{"action":"supersede|alias|update|retire","target":"...","title":"...","type":"...","content":"...","aliases":["..."],"links":["..."],"reason":"..."}]}`
  }

  protected buildUserMessages(input: MemoryPageCompileInput): { role: string; content: string }[] {
    const lang = input.locale === 'zh' ? '请用中文写 content。' : 'Write content in English.'
    const modeNote = input.mode === 'bucketed'
      ? '\n(catalog over budget, grouped by type — supersede/update are unavailable this round; alias-only)'
      : ''
    return [{
      role: 'user',
      content: `Tidy these memory pages.\n${lang}${modeNote}\n\nPAGES (live):\n${input.pagesText}`,
    }]
  }

  protected parseResponse(raw: string, input: MemoryPageCompileInput): MemoryPageCompileOutput {
    const parsed = extractJson<{ pages?: unknown[] }>(raw)
    if (!parsed || !Array.isArray(parsed.pages)) return { pages: [] }

    // target 解析（2026-11-12 记忆防重）：裸名（title/alias）命中多页时是**歧义**——
    // 旧实现 refs.set 让后者覆盖前者，两个 supersede 会双双落到同一页，合并组只
    // 取代一页。现在歧义名一律不收：agent 必须用目录里的 [#id] 精确指认。唯一名
    // 仍解析成 title（apply 层按 title 寻址的老契约不变）；显式 id 解析成 id。
    const refToId = new Map<string, string>()
    const ambiguous = new Set<string>()
    const idToId = new Map<string, string>()
    for (const p of input.pageIndex) {
      idToId.set(p.id.toLowerCase(), p.id)
      for (const name of [p.title, ...p.aliases]) {
        const key = name.trim().toLowerCase()
        if (!key) continue
        const prev = refToId.get(key)
        if (prev !== undefined && prev !== p.id) {
          ambiguous.add(key)
          refToId.delete(key)
        } else if (!ambiguous.has(key)) {
          refToId.set(key, p.id)
        }
      }
    }
    const resolveRef = (raw: string, pageIndex: readonly PageIndexEntry[]): string | null => {
      const ref = raw.trim()
      if (!ref) return null
      const key = ref.toLowerCase()
      const byId = key.startsWith('#') ? idToId.get(key.slice(1)) : idToId.get(key)
      if (byId) return byId
      const hit = refToId.get(key)
      if (!hit) return null // 幻觉或歧义 target：丢弃（整理宁缺毋滥）
      return pageIndex.find((p) => p.id === hit)?.title ?? hit
    }
    const ops: PageOp[] = []
    for (const r of parsed.pages as RawOp[]) {
      const action = typeof r.action === 'string' ? r.action : ''
      const target = typeof r.target === 'string' ? resolveRef(r.target, input.pageIndex) : null
      if (!target) continue // 幻觉/歧义 target：丢弃（整理宁缺毋滥）
      const content = typeof r.content === 'string' ? r.content : ''
      const aliases = Array.isArray(r.aliases) ? r.aliases.filter((a): a is string => typeof a === 'string' && !!a.trim()) : []
      const links = Array.isArray(r.links) ? r.links.filter((l): l is string => typeof l === 'string' && !!l.trim()) : []

      if (action === 'supersede') {
        if (input.mode === 'bucketed') continue
        if (typeof r.title !== 'string' || !r.title.trim() || !content) continue
        if (!MEMORY_PAGE_TYPES.includes(r.type as MemoryPageType)) continue
        ops.push({ action: 'supersede', target, title: r.title.trim(), type: r.type as MemoryPageType, content, aliases, links })
      } else if (action === 'update') {
        if (input.mode === 'bucketed') continue
        if (!content) continue
        const summary = typeof (r as { summary?: unknown }).summary === 'string' && (r as { summary: string }).summary.trim()
          ? (r as { summary: string }).summary.trim() : undefined
        ops.push({ action: 'update', target, content, aliases, links, ...(summary ? { summary } : {}) })
      } else if (action === 'alias') {
        if (aliases.length === 0) continue
        ops.push({ action: 'alias', target, aliases, links })
      } else if (action === 'retire') {
        // retire 只在满目视图放行：titles-only 的降级视图看不足以判「过时」——
        // 而 retire 是永久删除，看漏一页就是永久丢内容。
        if (input.mode === 'bucketed') continue
        const reason = typeof r.reason === 'string' ? r.reason.trim() : ''
        if (!reason) continue // 无理由的删除一律丢弃（删除必须留审计理由，apply 层同门）
        ops.push({ action: 'retire', target, reason })
      }
      // create / 其它 action 一律丢弃：整理不生产新主题
    }
    // 防御帽：单轮整理 ≤12 个 op（watermark 门已保证低频，这里只挡失控输出）
    return { pages: ops.slice(0, 12) }
  }

  protected getDefaultOutput(): MemoryPageCompileOutput {
    return { pages: [] }
  }
}
