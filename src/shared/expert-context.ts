// ── Expert config pack (PLAN-0.5.0 专家重构) ──
// Pure logic shared by both expert runtimes: the @-summoned main-conversation
// role switch (system-prompt-builder) and the spawn_agent delegation
// (tool-executors). No I/O here — composition in, markdown out.

import type { SubAgentProfile } from './types/subagent'

export interface ExpertKnowledgeFile {
  id: string
  title: string
  filePath: string
}

/** Compose the expert's full instruction block: identity header + the four
 *  structured sections (persona / methodology / output spec / constraints),
 *  skipping empty ones, plus the Bound Knowledge index when files are bound.
 *  The header states precedence over the default assistant persona, so a
 *  summoned expert fully replaces the global soul in the main conversation. */
export function composeExpertInstructions(
  profile: Pick<SubAgentProfile, 'name' | 'basePrompt' | 'methodology' | 'outputSpec' | 'constraints'>,
  knowledgeFiles: ExpertKnowledgeFile[] = []
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

/** Resolve an @-mention to an enabled expert and strip the token from the text.
 *  Candidates are matched longest-name-first (so "翻译专家" wins over a
 *  hypothetical "翻译") by literal `@<name>` occurrence — robust for CJK names
 *  where whitespace tokenization would glue trailing punctuation onto the token. */
export function parseExpertMention(
  text: string,
  experts: SubAgentProfile[]
): { expert: SubAgentProfile | null; text: string } {
  const candidates = experts
    .filter((e) => (e.enabled ?? true) && !e.isBuiltIn && e.name)
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
