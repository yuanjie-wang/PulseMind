// ── Session review one-shot（v3，PLAN-experience-sop 刀一，2026-10-26）──
// 单次 LLM 调用同时产出记忆页与经验页（pages 协议），取代 v1 的
// 「memories 扁平行 + 独立经验池」双产物。目录只给 title+别名（经验页带全文摘录），
// 因此：
//   - update 只对「全文可见且未截断」的经验页开放（v1 截断禁修订纪律的延续）；
//   - 其余修订一律 supersede——旧正文留在取代链谱系里，新页自含完整正文，天然安全。
// v3 变更：①脚本协议整体退出（一阶段产不出经验证的脚本——输入有损、无执行回路；
// 脚本固化是二阶段 SOP 代理的职责）；②经验洞见命中既有页由「跳过」改「reinforce」
// ——同一线索反复出现恰是最值得固化的信号，去重纪律不再吞掉它。
// 结构性纪律（≤3 条、100 字帽）从 v1 原样继承。

import { OneShotAgent } from './OneShotAgent'
import { extractJson } from './json-utils'
import { parseScriptFences } from '../../../../shared/experience/script-fence'
import { MEMORY_PAGE_TYPES, type MemoryPageFile, type MemoryPageType, type PageIndexEntry, type PageOp } from '../../../../shared/memory-pages'

export interface SessionReviewInput {
  sessionSummary: string
  /** 全量页面目录（buildExtractionCatalog 产物，进 prompt）。 */
  catalogText: string
  catalogMode: 'full' | 'bucketed'
  /** 活页索引（target 校验用，不进 prompt）。 */
  pageIndex: PageIndexEntry[]
  /** update 可用的页 title 集合（全文可见且未截断）。 */
  revisableTitles: string[]
  locale?: string
}

export interface SessionReviewOutput {
  pages: PageOp[]
  summary?: string
  keywords?: string[]
}

/** 模型输出的单条 op（content 内可携带 ### File: 脚本围栏，解析时拆出）。 */
type RawPageOp = Partial<Record<'action' | 'target' | 'title' | 'type' | 'content', unknown>> & {
  aliases?: unknown
  links?: unknown
}

export class SessionReviewAgent extends OneShotAgent<SessionReviewInput, SessionReviewOutput> {
  readonly name = 'SessionReviewAgent'

  protected buildSystemPrompt(): string {
    return `\
You are a session review system. Analyze the conversation below and maintain the user's MEMORY PAGES in a single pass.

## A. Page model
The memory store is a wiki of pages. Every page has a title (unique), a type, a body, optional aliases and links.
- "type" is exactly one of: "preference" (how the user wants things done — tone, formats, workflow habits, and every correction they made to the agent's behavior), "decision" (a choice the USER made or ratified — scope, approach, tool pick, deliverable spec), "fact" (a durable truth about the USER THEMSELVES: role, organization, personal assets/accounts, the user's own projects, their skill level and standing constraints — NEVER tooling behavior, codebase trivia, environment gotchas or third-party repo info; those are work notes about the system, not about the person), "experience" (a reusable playbook/lesson — see section B).
- A page is knowledge about THE USER or a durable lesson, never a recap of one task's execution. Every page must be attributable to the user — something they decided, prefer, corrected, or their durable background. The transcript is only EVIDENCE.
- Litmus test: if this page disappeared, would the NEXT conversation for this user be visibly worse? If not, skip it.
- USER LENS — before emitting any preference/decision/fact page, answer all three. If ANY answer fails, do not emit it:
  1. Is this a statement about the USER (who they are, what they have, what they decided, how they want things done), or about a TOOL/CODEBASE/ENVIRONMENT's behavior?
  2. If it describes a tool, API, CLI flag, error message, version requirement, artifact size, dependency, repo layout, DB schema or machine setup — it is NOT a page of these three types. The user happening to be the one who hit it does not make it about them. Drop it, or write it as an experience ONLY if section B's gate passes.
  3. Does a future session know this PERSON better because of this page? If the only gain is "the agent knows the tool better", skip it.
- PORTABILITY — a "preference" or "fact" must still be true OUTSIDE this project. If the statement only holds because this codebase, this task or this machine is what it is (a module's internal gate order, how many op kinds the store has, where a particular helper must run, this repo's layout), it is project knowledge, NOT knowledge about the person. Drop it, or keep it as a "decision" ONLY if the user personally ratified it in their own words. Ask: if the user moved to a different project tomorrow, would this page still be worth carrying? If not, do not emit it as preference/fact.
- Yield bar: SELECTIVE, not exhaustive. At most 3 non-experience pages per review; Most conversations correctly yield ZERO. "pages": [] is a fully successful outcome, never pad and never lower the bar. One high-value memory beats five marginal ones.

NOT pages — never extract:
- The assistant's own analysis, frameworks, research findings, or summaries of files/webpages it read. The model's output is work product, not user knowledge — UNLESS the user explicitly approved or adopted it, which turns it into a "decision". Adoption must be VISIBLE in the transcript: the user said so, or told you to do it that way. Your own proposal that the user never answered is NOT adoption, and neither is the user silently letting a plan stand. When a page rests on adoption, put the user's own words in the body — otherwise you cannot tell adoption from agreement you imagined.
- A log of what was done in one task — execution narration is not durable knowledge. Casual chat.
- Tooling trivia: how a tool, API, build step, dependency or machine behaves (flags, error strings, version floors, bundle sizes, DB schemas, repo layouts, env workarounds). Work notes about the SYSTEM, not knowledge about the USER — a reusable procedure may become an experience page, everything else is dropped.

## B. Experience pages (QUALIFICATION GATE first)
The summary begins with "(Conversation statistics: N tool call(s), M tool error(s))". Write an experience page ONLY if at least ONE holds:
1. Complex task completed successfully (5+ tool calls)
2. The agent hit a wall and eventually found a viable path — the struggle is the lesson
3. The user corrected the agent's behavior/approach
4. A non-trivial reusable workflow was discovered
Otherwise NO experience page this round.

An experience page is a DRAFT SKILL — its graduation path is promotion to an installed skill — so its body follows the SKILL.md standard: a manual written for a FUTURE session, never a report of what happened this time. Body template (keep the headings verbatim):
\`\`\`markdown
## 适用场景
<the trigger situations where this playbook applies — when to use it>
## 步骤
<the reusable procedure — numbered, imperative voice>
## 注意事项
<pitfalls and guardrails learned the hard way — optional section>
\`\`\`

Rules:
- INSTRUCTIONS, never narration: convert every episode into what a future agent should DO ("做 X 时先 Y 再 Z"), never "这次我先…后来发现…" case narration.
- Self-contained: a future session reading ONLY this page must be able to execute the workflow — name the tools, the order, the acceptance check.
- "summary" is the skill-standard DESCRIPTION: what this playbook does + when to use it (the pick_skill candidate list shows exactly this line), max 50 chars.
- Write the content in the conversation's language; keep the headings verbatim.

## C. The PAGE CATALOG and the five actions
You are given the PAGE CATALOG (all live pages). Every new insight must meet it in exactly one way — pick per insight:

- **create** — nothing covers it: {"action":"create","title":"<unique topic title>","type":"...","content":"<body>","summary":"<ONE sentence, max 50 chars — a use-when description for experience pages (see B), a conclusion for decision pages — required for both>","aliases":["<likely search terms>"],"links":["<related page title>"]}. Aliases are the words a future query would use — 2-4 per page. For preference/fact pages content is ONE short sentence, HARD CAP 100 chars. decision/experience pages may be long.
- **update** — ONLY for a catalog page whose FULL body is shown (no 「正文被截断」 marker; bucketed catalogs offer none): {"action":"update","target":"<exact title>","content":"<FULL revised document merging old + new>"}. Never truncate; a much-shorter revision is rejected by the store.
- **supersede** — the page's conclusion changed (a decision or preference evolved): {"action":"supersede","target":"<exact title or alias>","title":"<new title>","type":"...","content":"<complete self-contained body; the old page stays readable in lineage>","summary":"<ONE sentence, max 50 chars — same rule as create>"}. You do NOT need the old body for this — write the new one completely.
- **alias** — only adding search aliases to an existing page: {"action":"alias","target":"<title>","aliases":["..."]}.
- **reinforce** — an EXPERIENCE page already covers an optimizable pattern that appeared AGAIN in this conversation: {"action":"reinforce","target":"<exact title>","note":"<ONE line: what recurred this time>"}. Repetition is the strongest signal that a pattern is worth distilling — never stay silent when a known experience topic recurs; reinforce it. Reinforce is ONLY for experience pages.
- Non-experience duplicates: an insight about preferences/decisions/facts NOT already covered by the catalog is the bar — if a live page covers it (even worded differently), output nothing for that insight.

## Output Format
Return ONLY a JSON object:
{
  "pages": [
    {"action":"create|update|alias|supersede|reinforce", "target":"<only for update/alias/supersede/reinforce>", "title":"<for create/supersede>", "type":"preference|decision|fact|experience", "content":"...", "aliases":["..."], "links":["..."], "note":"<reinforce only>"}
  ],
  "summary": "<max 200 chars describing this conversation>",
  "keywords": ["<max 10, prefer the conversation's language>"]
}`
  }

  protected buildUserMessages(input: SessionReviewInput): { role: string; content: string }[] {
    const langInstruction = input.locale === 'zh'
      ? '请用中文编写页面 content。'
      : 'Write page content in English.'
    const modeNote = input.catalogMode === 'bucketed'
      ? '\n(catalog is over budget and grouped by type — update is unavailable this round; use create/alias/supersede only)'
      : ''
    return [{
      role: 'user',
      content: `Review this conversation and maintain the memory pages.\n${langInstruction}\n\nPAGE CATALOG (every live page; update targets must come verbatim from here):${modeNote}\n${input.catalogText}\n\n${input.sessionSummary}`,
    }]
  }

  protected parseResponse(raw: string, input: SessionReviewInput): SessionReviewOutput {
    const parsed = extractJson<{ pages?: unknown[]; summary?: string; keywords?: unknown[] }>(raw)
    if (!parsed) return this.getDefaultOutput()

    const refs = new Set<string>()
    for (const p of input.pageIndex) {
      refs.add(p.title.toLowerCase())
      for (const a of p.aliases) refs.add(a.toLowerCase())
    }
    const revisable = new Set(input.revisableTitles.map((t) => t.toLowerCase()))
    // 目录里 target（title 或 alias）→ 该页的 title（update 需要按 title 寻址且可修订）
    const refToTitle = new Map<string, string>()
    for (const p of input.pageIndex) {
      refToTitle.set(p.title.toLowerCase(), p.title)
      for (const a of p.aliases) refToTitle.set(a.toLowerCase(), p.title)
    }

    const memoryOps: PageOp[] = []
    const experienceOps: PageOp[] = []
    const reinforceOps: PageOp[] = []
    for (const raw of Array.isArray(parsed.pages) ? (parsed.pages as RawPageOp[]) : []) {
      const op = normalizeOp(raw, refs, revisable, refToTitle)
      if (!op) continue
      if (op.action === 'reinforce') reinforceOps.push(op)
      else if (op.type === 'experience') experienceOps.push(op)
      else memoryOps.push(op)
    }
    // 结构性纪律：非经验页 ≤3（帽是保证，prompt 是前半）；经验页 ≤1（资格门的兜底）；
    // reinforce ≤3（重现记账不是新页，不占经验页帽——它在攒二阶段的资格信号）
    return {
      pages: [...memoryOps.slice(0, 3), ...experienceOps.slice(0, 1), ...reinforceOps.slice(0, 3)],
      summary: typeof parsed.summary === 'string' ? parsed.summary : undefined,
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords.filter((k: unknown) => typeof k === 'string') : undefined,
    }
  }

  protected getDefaultOutput(): SessionReviewOutput {
    return { pages: [] }
  }
}

/** 单条模型 op 的校验/降级（poolNamesOf 纪律的推广：幻觉 target 降级而非丢弃洞见）。 */
function normalizeOp(
  raw: RawPageOp,
  refs: Set<string>,
  revisable: Set<string>,
  refToTitle: Map<string, string>
): (PageOp & { files?: MemoryPageFile[] }) | null {
  const action = typeof raw.action === 'string' ? raw.action : 'create'
  const type = MEMORY_PAGE_TYPES.includes(raw.type as MemoryPageType) ? (raw.type as MemoryPageType) : 'fact'
  const content = typeof raw.content === 'string' ? raw.content : ''
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  const summary = typeof (raw as { summary?: unknown }).summary === 'string' ? ((raw as { summary: string }).summary.trim() || undefined) : undefined
  const aliases = Array.isArray(raw.aliases) ? raw.aliases.filter((a): a is string => typeof a === 'string' && !!a.trim()).map((a) => a.trim()) : []
  const links = Array.isArray(raw.links) ? raw.links.filter((l): l is string => typeof l === 'string' && !!l.trim()) : []
  // 经验页脚本围栏：拆出 files，content 留正文
  const { content: body, files } = parseScriptFences(content)

  /** 幻觉 target 的降级出口：create（宁可多一页，compile pass 会并）。 */
  const mkCreate = (): (PageOp & { files?: MemoryPageFile[] }) | null => {
    if (!title || !body) return null
    if ((type === 'preference' || type === 'fact') && body.length > 100) return null
    const op: PageOp & { files?: MemoryPageFile[] } = { action: 'create', title, type, content: body, aliases, links }
    if (summary) op.summary = summary
    if (type === 'experience' && files.length > 0) op.files = files
    return op
  }

  if (action === 'create' || action === 'supersede') {
    let target: string | undefined
    if (action === 'supersede') {
      target = typeof raw.target === 'string' ? raw.target.trim() : ''
      const resolved = target ? refToTitle.get(target.toLowerCase()) : undefined
      if (!resolved) {
        // 幻觉 target：降级 create，宁可多一页（compile pass 会并）
        console.warn(`[SessionReviewAgent] supersede target "${target}" not in catalog — degrading to create`)
        return mkCreate()
      }
      target = resolved
    }
    if (!title || !body) return null
    // 100 字帽是 preference/fact 的结构性半边（decision/experience 允许长正文）
    if ((type === 'preference' || type === 'fact') && body.length > 100) return null
    const op: PageOp & { files?: MemoryPageFile[] } =
      action === 'supersede'
        ? { action: 'supersede', target, title, type, content: body, aliases, links }
        : { action: 'create', title, type, content: body, aliases, links }
    if (type === 'experience' && files.length > 0) op.files = files
    return op
  }

  if (action === 'update') {
    const target = typeof raw.target === 'string' ? raw.target.trim() : ''
    const resolved = target ? refToTitle.get(target.toLowerCase()) : undefined
    if (!resolved || !body) return null
    if (!revisable.has(resolved.toLowerCase())) {
      // 目录没给全文（或分桶模式）：改写看不到的正文是破坏——降级为 create，
      // title 取目标页 title（update op 自带不了 title），交给 compile pass 归并
      console.warn(`[SessionReviewAgent] update target "${target}" body not fully shown — degrading to create`)
      if ((type === 'preference' || type === 'fact') && body.length > 100) return null
      const degraded: PageOp & { files?: MemoryPageFile[] } = { action: 'create', title: resolved, type, content: body, aliases, links }
      if (type === 'experience' && files.length > 0) degraded.files = files
      return degraded
    }
    return { action: 'update', target: resolved, content: body, aliases, links }
  }

  if (action === 'reinforce') {
    const target = typeof raw.target === 'string' ? raw.target.trim() : ''
    const resolved = target ? refToTitle.get(target.toLowerCase()) : undefined
    if (!resolved) return null // 幻觉 target：静默丢弃（记账宁缺毋滥，不降级 create）
    const note = typeof (raw as { note?: unknown }).note === 'string' ? (raw as { note: string }).note.trim() : ''
    if (!note) return null
    return { action: 'reinforce', target: resolved, note }
  }

  if (action === 'alias') {
    const target = typeof raw.target === 'string' ? raw.target.trim() : ''
    const resolved = target ? refToTitle.get(target.toLowerCase()) : undefined
    if (!resolved || aliases.length === 0) return null
    return { action: 'alias', target: resolved, aliases, links }
  }

  return null
}
