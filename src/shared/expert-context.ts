// ── Expert config pack (PLAN-0.5.0 专家重构) ──
// Pure logic shared by both expert runtimes: the @-summoned main-conversation
// role switch (system-prompt-builder) and the spawn_agent delegation
// (tool-executors). No I/O here — composition in, markdown out.

import type { ExpertProfile } from './types/expert'

export interface ExpertKnowledgeFile {
  id: string
  title: string
  filePath: string
}

/** A resolved reference: 技能名（id 与 name 同值）或连接器（id 为 MCP 服务 id）。 */
export interface ExpertReference {
  id: string
  name: string
  /** 一句话用途，目录里带就写上。 */
  summary?: string
}

/** 引用关系的解析目录。**缺省整个字段** 表示这侧拿不到目录，此时按 profile 里
 *  写的名字原样注入；给了数组就只注入目录里存在的条目（已卸载的技能不再出现在
 *  指令里）。目录读取是各 runtime 的事，这里只做纯解析。 */
export interface ExpertRefCatalogs {
  skills?: ExpertReference[]
  connectors?: ExpertReference[]
}

/** Compose the expert's full instruction block: identity header + the four
 *  structured sections (persona / methodology / output spec / constraints),
 *  skipping empty ones, plus the Bound Knowledge index when files are bound and
 *  the Preferred Skills / Connectors the profile points at. 引用关系只是指令里
 *  的倾向提示，不是权限白名单 —— 会话的可用能力始终来自全局设置。 */
export function composeExpertInstructions(
  profile: Pick<
    ExpertProfile,
    'name' | 'basePrompt' | 'methodology' | 'outputSpec' | 'constraints' | 'skillNames' | 'mcpServerIds'
  >,
  knowledgeFiles: ExpertKnowledgeFile[] = [],
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
      '## Preferred Skills',
      'Reach for the following skills first when they fit the task. This is a preference, not a restriction — every other installed skill stays available.',
      '',
      ...listRefs(skills)
    )
  }

  const connectors = resolveReferences(profile.mcpServerIds, catalogs.connectors)
  if (connectors.length > 0) {
    lines.push(
      '',
      '## Preferred Connectors',
      'Reach for the following connectors (MCP servers) first when they fit the task. Same caveat — a preference, not a restriction, and every connected server stays available.',
      '',
      ...listRefs(connectors)
    )
  }

  if (knowledgeFiles.length > 0) {
    lines.push(
      '',
      '## Bound Knowledge',
      'This expert has a private knowledge base bound to it. It is NOT shown here — look things up with `knowledge_search` (in this session it searches exactly these documents) and read the full content with `knowledge_read`.',
      '',
      ...knowledgeFiles.map((f) => `- ${f.title} (${f.filePath})`)
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
