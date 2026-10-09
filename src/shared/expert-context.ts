// ── Expert config pack (PLAN-0.5.0 专家重构) ──
// Pure logic shared by both expert runtimes: the @-summoned main-conversation
// role switch (system-prompt-builder) and the spawn_agent delegation
// (tool-executors). No I/O here — composition in, markdown out.

import type { ExpertProfile } from './types/expert'
import type { Plan } from './types/plan'

/** A resolved capability entry: 技能名（id 与 name 同值）或连接器（id 为 MCP 服务 id）。 */
export interface ExpertReference {
  id: string
  name: string
  /** 一句话用途，目录里带就写上。 */
  summary?: string
}

/** 专家 id → 给人看的名字。计划节点存的是 **id**（稳定引用，改名不该动历史数据），
 *  凡是要显示「负责人」的地方都在这里解析，免得同一个专家在图上、在 spawn 报错里、
 *  在工具清单里三个名字（`modelLabel()` 就是这么被抽出来统一 profile 命名的）。
 *  查不到时回落成 id —— 专家被删掉、或这份计划来自另一个安装，仍得说出点东西。 */
export function expertLabel(profiles: readonly ExpertProfile[] | undefined, id: string): string {
  return profiles?.find((p) => p.id === id)?.name?.trim() || id
}

/** 可用能力的解析目录。**缺省整个字段** 表示这侧拿不到目录，此时按 profile 里
 *  写的名字原样注入；给了数组就只注入目录里存在的条目（已卸载的技能不再出现在
 *  指令里）。目录读取是各 runtime 的事，这里只做纯解析。 */
export interface ExpertRefCatalogs {
  skills?: ExpertReference[]
  connectors?: ExpertReference[]
}

/** Compose the expert's full instruction block: identity header + the four
 *  structured sections (persona / methodology / output spec / constraints),
 *  skipping empty ones, plus the capabilities this expert is allowed to use.
 *  可用技能 / 连接器是白名单 —— 会话侧会同步把工具集合收敛到这几项
 *  （见 AgentEngine.applyExpertContext），指令只是把同一件事说清楚。 */
export function composeExpertInstructions(
  profile: Pick<
    ExpertProfile,
    'name' | 'basePrompt' | 'methodology' | 'outputSpec' | 'constraints' | 'skillNames' | 'mcpServerIds'
  >,
  catalogs: ExpertRefCatalogs = {}
): string {
  const lines: string[] = [
    `# Expert Mode: ${profile.name}`,
    '',
    `You are now operating as **${profile.name}**, a domain expert config pack. The instructions below take precedence over the default assistant persona — behave as this expert, not as a general assistant.`
  ]

  const section = (title: string, body?: string): void => {
    const trimmed = body?.trim()
    if (!trimmed) return
    lines.push('', `## ${title}`, trimmed)
  }
  section('Role & Persona', profile.basePrompt)
  section('Methodology', profile.methodology)
  section('Output Specification', profile.outputSpec)
  section('Constraints', profile.constraints)

  const listRefs = (refs: ExpertReference[]): string[] =>
    refs.map((r) => (r.summary ? `- ${r.name} — ${r.summary}` : `- ${r.name}`))

  const skills = resolveReferences(profile.skillNames, catalogs.skills)
  if (skills.length > 0) {
    lines.push(
      '',
      '## Allowed Skills',
      'These are the ONLY skills available to you in this session — everything else is unavailable, so do not plan around it or claim to have used it. If a task needs something outside this list, say so instead of improvising.',
      '',
      ...listRefs(skills)
    )
  } else if (profile.skillNames) {
    // 白名单存在但是空的：明确说「没有」，否则模型会以为只是没列出来。
    lines.push(
      '',
      '## Allowed Skills',
      'No skills are available to you in this session — the user allowed none. Do not call pick_skill, and do not claim to have applied any skill.'
    )
  }

  const connectors = resolveReferences(profile.mcpServerIds, catalogs.connectors)
  if (connectors.length > 0) {
    lines.push(
      '',
      '## Allowed Connectors',
      'These are the ONLY connectors (MCP servers) available to you in this session — every other server is unavailable. Same rule as the skills above: work within this list, and say so when a task needs something outside it.',
      '',
      ...listRefs(connectors)
    )
  } else if (profile.mcpServerIds) {
    lines.push(
      '',
      '## Allowed Connectors',
      'No connectors (MCP servers) are available to you in this session — the user allowed none. Do not call pick_tool, and say so when a task needs an outside service.'
    )
  }

  return lines.join('\n')
}

/** 两个 runtime 取目录的来源不同（main 侧 manager / host 桥），映射规则相同：
 *  技能用 name 当标识、description 当用途；连接器 id + name + summary。 */
export function toExpertRefCatalogs(input: {
  skills?: ReadonlyArray<{ name: string; description?: string }>
  connectors?: ReadonlyArray<{ id: string; name: string; summary?: string }>
}): ExpertRefCatalogs {
  const catalogs: ExpertRefCatalogs = {}
  if (input.skills) catalogs.skills = input.skills.map((s) => ({ id: s.name, name: s.name, summary: s.description }))
  if (input.connectors) catalogs.connectors = input.connectors.map((c) => ({ id: c.id, name: c.name, summary: c.summary }))
  return catalogs
}

/** profile 里记的 id：目录缺省就原样列出，给了目录就只保留目录里存在的条目。 */
function resolveReferences(ids: string[] | undefined, catalog: ExpertReference[] | undefined): ExpertReference[] {
  if (!ids || ids.length === 0) return []
  if (!catalog) return ids.map((id) => ({ id, name: id }))
  const byId = new Map(catalog.map((c) => [c.id, c]))
  return ids.map((id) => byId.get(id)).filter((c): c is ExpertReference => !!c)
}

/** A consumed `@<name>` token, as offsets into the text it was found in. */
export interface MentionSpan {
  start: number
  end: number
}

/** Resolve the @-mentions in a message to enabled experts. A mention is a
 *  literal `@<name>` — robust for CJK names, where whitespace tokenization
 *  would glue trailing punctuation onto the token — and at each `@` the LONGEST
 *  matching name wins, so "翻译专家" is not read as a hypothetical "翻译" plus
 *  the characters "专家". Every occurrence is consumed, so several experts can
 *  be summoned at once; the roster comes back in the order the user mentioned
 *  them (their own list, which the plan brief then reads back) with duplicates
 *  dropped.
 *  The `@` tokens are NOT cut from `text` (user 2026-10-09: the mention's words
 *  are message content too — the transcript, the persistence row and the model
 *  all read what the user typed). Callers that need the words BESIDE the
 *  mentions read `task` (tokens cut, seams collapsed — "先让 @甲 看看" reads
 *  "先让 看看"), and `spans` marks each consumed token in `text` so a
 *  downstream mention parser (the knowledge-base scope) can skip them — the
 *  既有语义优先 rule survives the tokens staying put. */
export function parseExpertMentions(
  text: string,
  experts: ExpertProfile[]
): { experts: ExpertProfile[]; text: string; task: string; spans: MentionSpan[] } {
  const candidates = experts
    .filter((e) => (e.enabled ?? true) && e.name)
    .sort((a, b) => b.name.length - a.name.length)
  const found: ExpertProfile[] = []
  const spans: MentionSpan[] = []
  let i = 0
  while (i < text.length) {
    if (text[i] === '@') {
      const hit = candidates.find((e) => text.startsWith(`@${e.name}`, i))
      if (hit) {
        if (!found.includes(hit)) found.push(hit)
        const end = i + 1 + hit.name.length
        spans.push({ start: i, end })
        i = end
        continue
      }
    }
    i += 1
  }
  if (found.length === 0) return { experts: [], text, task: text, spans: [] }
  let rest = ''
  let cursor = 0
  for (const span of spans) {
    rest += text.slice(cursor, span.start)
    cursor = span.end
  }
  rest += text.slice(cursor)
  return { experts: found, text, task: rest.replace(/[ \t]{2,}/g, ' ').trim(), spans }
}

/** A knowledge base the user @-mentioned. Same wire shape as SummonedExpert
 *  so the ask channel carries them alike. */
export type MentionedKnowledgeBase = { id: string; name: string }

/** Scope ONE @-mention against the base list: the first matching base name
 *  wins (v1 = single-base scope), and that one token is cut from the text the
 *  way the expert parse's `task` field cuts expert tokens. `claimed` carries
 *  the expert parse's spans (parseExpertMentions) — the token now STAYS in the
 *  outgoing text, so the skip is positional: an `@` inside a claimed span is
 *  expert material and never a base candidate (既有语义优先). Runs AFTER the
 *  expert parse; pure; a malformed list yields null, never a throw. */
export function parseKnowledgeBaseMention(
  text: string,
  bases: ReadonlyArray<{ id: string; name: string }>,
  claimed: ReadonlyArray<MentionSpan> = []
): { base: MentionedKnowledgeBase | null; text: string } {
  const candidates = bases
    .filter((b) => b.id && b.name)
    .sort((a, b) => b.name.length - a.name.length)
  const isClaimed = (pos: number): boolean => claimed.some((s) => pos >= s.start && pos < s.end)
  let i = 0
  while (i < text.length) {
    if (text[i] === '@' && !isClaimed(i)) {
      const hit = candidates.find((b) => text.startsWith(`@${b.name}`, i))
      if (hit) {
        const rest = (text.slice(0, i) + text.slice(i + 1 + hit.name.length))
          .replace(/[ \t]{2,}/g, ' ')
          .trim()
        return { base: { id: hit.id, name: hit.name }, text: rest }
      }
    }
    i += 1
  }
  return { base: null, text }
}

/** Single-expert view of `parseExpertMentions` — the @-summon's original
 *  contract (one mention = delegate to that one expert). Kept as a wrapper so
 *  the two paths can never disagree about what a mention is. `text` is the
 *  input verbatim: the tokens stay in the message (see parseExpertMentions). */
export function parseExpertMention(
  text: string,
  experts: ExpertProfile[]
): { expert: ExpertProfile | null; text: string } {
  const { experts: found } = parseExpertMentions(text, experts)
  return { expert: found[0] ?? null, text }
}

// ── @-summon (召唤) ─────────────────────────────────────────────────────

/** An expert the user summoned by @-mention, as it travels from the mention
 *  parser to the engine and across the IPC boundary. The name is carried
 *  alongside the id because the brief the model reads is written in names
 *  (an id alone reads as a machine handle) and the receiving side may not have
 *  the expert list handy. */
export interface SummonedExpert {
  id: string
  name: string
}

/** Per-turn state of a multi-expert @-summon. Null outside such a turn.
 *  `nudged` — the one corrective re-issue has already happened, so a second
 *  turn end must not loop again; `engaged` — the plan manager has been written
 *  to since the summons (a plan was created, or a node settled), which is what
 *  says the summons was honored and no correction is owed. */
export interface SummonState {
  experts: SummonedExpert[]
  nudged: boolean
  engaged: boolean
  /** M3 (review 2026-09-18): the plan that already existed when this turn
   *  opened (planManager.plan survives across turns). `engaged` may only be
   *  set for a plan that is not this one — an advance_plan / spawn against
   *  the PREVIOUS turn's plan would otherwise retire the nudge while the
   *  summoned experts never got a node. Null = no plan at turn start. */
  planAtStart?: Plan | null
}

/** Normalize a wire roster: ids are trimmed and de-duplicated, a nameless entry
 *  falls back to its id. Pure and total — a malformed roster yields fewer
 *  experts, never a throw (it arrives over IPC). */
export function normalizeSummonedExperts(input: readonly SummonedExpert[] | undefined): SummonedExpert[] {
  const out: SummonedExpert[] = []
  for (const e of input ?? []) {
    const id = String(e?.id ?? '').trim()
    if (!id || out.some((o) => o.id === id)) continue
    out.push({ id, name: String(e?.name ?? '').trim() || id })
  }
  return out
}

/** The `## Summoned Experts` state-block section for a multi-expert @-summon.
 *  Null when no summons is in flight. It rides the per-turn state block (never
 *  the invariant core) for the same reason every other volatile line does: the
 *  core is a cache prefix. */
export function formatSummonForPrompt(summon: SummonState | null): string | null {
  if (!summon || summon.experts.length === 0) return null
  const list = summon.experts.map((e) => `**${e.name}** (id: \`${e.id}\`)`).join(', ')
  const lines = [
    '## Summoned Experts (plan mode)',
    '',
    `The user summoned ${summon.experts.length} experts by @-mention for THIS turn: ${list}.`,
    'Their work is the deliverable: plan it, hand each one their part, and never do their work yourself.',
    '',
    '1. Call `create_plan` first. EVERY summoned expert above must be the `assignee` of at least one node — a node that names an un-summoned expert (or none) does not discharge that expert\'s summons. Write each node description as the assignment for the expert named as its assignee.',
    '2. Once created, the scheduler dispatches every READY node to its assignee (in parallel) and settles each delivery — do NOT call `spawn_agent` or `advance_plan` for those yourself.',
    '3. You are consulted when a node FAILED: re-dispatch it with `spawn_agent` (subAgentId = its assignee, planNode = its number) to retry, or `advance_plan` action="fail" / action="skip" with node=<number>.',
    '4. Your own output is the synthesis the user reads once the plan completes — not a substitute for their work.'
  ]
  if (summon.nudged) {
    lines.push(
      '',
      '**You ended the previous turn without creating the plan**, so none of the summoned experts has been asked to work yet. Do that now: `create_plan` with all of them assigned — the scheduler takes the READY nodes from there.'
    )
  }
  return lines.join('\n')
}

// ── Sub-agent hosting defaults ──

/** Persona of a delegated sub-agent with no expert config pack: spawn_agent's
 *  fallback when no sub-agent id is given (or the id no longer resolves). */
export const GENERAL_SUBAGENT_PROMPT = `You are a sub-agent executing a delegated task.

Guidelines:
- Focus exclusively on the task above. Ignore anything not relevant to it.
- You CANNOT install skills or modify tool preferences.
- When you complete the task, provide a concise summary of your findings.
- Do NOT ask the user for input — work autonomously.`
