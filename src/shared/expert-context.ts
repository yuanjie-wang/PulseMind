// ── Expert config pack (PLAN-0.5.0 专家重构) ──
// Pure logic shared by both expert runtimes: the @-summoned main-conversation
// role switch (system-prompt-builder) and the spawn_agent delegation
// (tool-executors). No I/O here — composition in, markdown out.

import type { ExpertProfile } from './types/expert'

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

/** Resolve an @-mention to an enabled expert and strip the token from the text.
 *  Candidates are matched longest-name-first (so "翻译专家" wins over a
 *  hypothetical "翻译") by literal `@<name>` occurrence — robust for CJK names
 *  where whitespace tokenization would glue trailing punctuation onto the token. */
export function parseExpertMention(
  text: string,
  experts: ExpertProfile[]
): { expert: ExpertProfile | null; text: string } {
  const candidates = experts
    .filter((e) => (e.enabled ?? true) && e.name)
    .sort((a, b) => b.name.length - a.name.length)
  for (const expert of candidates) {
    const token = `@${expert.name}`
    const idx = text.indexOf(token)
    if (idx === -1) continue
    const cleaned = `${text.slice(0, idx).trimEnd()} ${text.slice(idx + token.length).trimStart()}`.trim()
    return { expert, text: cleaned }
  }
  return { expert: null, text }
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
