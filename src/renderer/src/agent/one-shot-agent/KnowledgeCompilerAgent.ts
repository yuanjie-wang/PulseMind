import { OneShotAgent } from './OneShotAgent'
import { extractJson } from './json-utils'

export interface RawFileInfo {
  id: string
  filePath: string
  title: string
  content: string
}

export interface WikiAction {
  type: 'write_source' | 'write_entity' | 'write_concept' | 'write_synthesis'
  filePath: string    // relative path within wiki/
  content: string     // full markdown content
}

export interface CompilerInput {
  schema: string
  existingIndex: string
  rawFiles: RawFileInfo[]
  /** Existing wiki pages the model asked to merge into (K8): full bodies so
   *  the second pass can MERGE instead of overwrite. */
  existingPages?: { filePath: string; content: string }[]
}

export interface CompilerOutput {
  actions: WikiAction[]
  logEntry: string
  /** K1: true when the response could not be trusted (unparseable JSON or a
   *  truncated completion). Callers keep the source in `raw` and surface the
   *  failure — they must NOT mark the file compiled. */
  failed?: boolean
  /** K1: actions dropped by validation, with reasons (for the panel log). */
  rejected?: string[]
}

/** Wiki page paths must stay inside the four page directories — anything else
 *  (index.md, log.md, `../` escapes, absolute paths, unknown dirs) is refused
 *  by the compiler AND again by applyWikiChanges (defence in depth, K1). */
const WIKI_PATH_RE = /^(sources|entities|concepts|syntheses)\/[A-Za-z0-9._-]+\.md$/

export function isValidWikiPath(filePath: string): boolean {
  return WIKI_PATH_RE.test(filePath) && !/(^|\/)(index|log)\.md$/.test(filePath)
}

/** A wiki action's content must carry YAML frontmatter with title + type —
 *  the schema convention the compiler is instructed to follow (K1/K2). */
export function hasRequiredFrontmatter(content: string): boolean {
  const trimmed = content.trimStart()
  if (!trimmed.startsWith('---')) return false
  const end = trimmed.indexOf('---', 3)
  if (end === -1) return false
  const fm = trimmed.slice(3, end)
  return /^title:\s*\S/m.test(fm) && /^type:\s*\S/m.test(fm)
}

/** Pure: validate one action. Returns the normalized action or a rejection reason. */
export function validateWikiAction(raw: {
  type?: unknown; filePath?: unknown; content?: unknown
}): { ok: true; action: WikiAction } | { ok: false; reason: string } {
  const TYPES = ['write_source', 'write_entity', 'write_concept', 'write_synthesis']
  if (!TYPES.includes(raw.type as string)) return { ok: false, reason: `非法 type: ${String(raw.type).slice(0, 40)}` }
  const filePath = typeof raw.filePath === 'string' ? raw.filePath.replace(/^wiki\//, '') : ''
  if (!isValidWikiPath(filePath)) return { ok: false, reason: `非法 wiki 路径: ${filePath.slice(0, 80)}` }
  if (typeof raw.content !== 'string' || raw.content.trim().length < 10) {
    return { ok: false, reason: `内容为空: ${filePath}` }
  }
  if (!hasRequiredFrontmatter(raw.content)) return { ok: false, reason: `缺少 title/type frontmatter: ${filePath}` }
  return { ok: true, action: { type: raw.type as WikiAction['type'], filePath, content: raw.content } }
}

/** KnowledgeCompilerAgent — LLM-driven compilation of raw files into structured wiki pages. */
export class KnowledgeCompilerAgent extends OneShotAgent<CompilerInput, CompilerOutput> {
  readonly name = 'KnowledgeCompilerAgent'

  protected getDefaultOutput(_input: CompilerInput): CompilerOutput {
    return { actions: [], logEntry: 'Compilation failed: LLM error', failed: true }
  }

  protected buildSystemPrompt(input: CompilerInput): string {
    return `You are a knowledge wiki compiler. Your job is to analyze raw source files and compile them into a structured wiki.

${input.schema}

## Rules

1. Every raw file must produce a source summary page in \`sources/\`.
2. Extract entities (people, products, organizations, technologies) and concepts (ideas, patterns, methodologies).
   - Create/update entity pages in \`entities/\` and concept pages in \`concepts/\`.
   - If the same entity appears in multiple sources, merge into one page.
3. Write synthesis pages in \`syntheses/\` when multiple sources cover the same topic — distill cross-source insights.
4. All pages use YAML frontmatter per the schema convention. Frontmatter MUST include:
   - \`title\` and \`type\`
   - \`sources:\` — the YAML list of raw file paths (e.g. \`2026-09-17_notes.md\`) this page's content came from. When UPDATING an existing page, carry over its existing \`sources\` entries and append the new ones; never drop attributions.
   - \`updated:\` — today's date (ISO).
5. File paths must match \`sources/…\`, \`entities/…\`, \`concepts/…\`, \`syntheses/…\` with a \`.md\` extension. Never write \`index.md\` or \`log.md\`.
${input.existingPages && input.existingPages.length > 0 ? `
6. Some target pages already exist — their CURRENT full bodies are provided below. MERGE into them (combine, deduplicate, keep everything still true) instead of overwriting, and extend their \`sources:\` lists. Existing pages:
${input.existingPages.map((p) => `--- existing ${p.filePath} ---\n${p.content.slice(0, 6000)}`).join('\n\n')}
` : ''}

## Output Format

Return a JSON object with this exact structure:

\`\`\`json
{
  "actions": [
    {
      "type": "write_source",
      "filePath": "sources/source-slug.md",
      "content": "---\\ntitle: ...\\ntype: source\\nsources:\\n  - raw-file.md\\nupdated: 2026-09-17\\n---\\n\\nFull markdown content here..."
    }
  ],
  "logEntry": "Compiled source-slug.md → created source page, updated entity-1, entity-2"
}
\`\`\`

Return ONLY the JSON object, no other text.`
  }

  protected buildUserMessages(input: CompilerInput): { role: string; content: string }[] {
    const rawSection = input.rawFiles
      .map((f, i) => `## Raw File ${i + 1}: ${f.filePath}\n\nTitle: ${f.title}\n\n${f.content.slice(0, 30000)}`)
      .join('\n\n---\n\n')

    return [{
      role: 'user',
      content: `Existing wiki index:\n\n${input.existingIndex.slice(0, 10000)}\n\n---\n\nRaw files to compile (their relative paths are what \`sources:\` must list):\n\n${rawSection}`
    }]
  }

  /** K1: an untrustworthy response produces NO pages. The old fallback wrote
   *  the whole raw LLM response to `sources/compilation-<ts>.md` and the file
   *  was marked compiled — half a JSON blob固化成了"知识"。 */
  protected parseResponse(raw: string, _input: CompilerInput): CompilerOutput {
    const parsed = extractJson<{ actions?: unknown; logEntry?: unknown }>(raw)

    if (!parsed) {
      return {
        actions: [],
        logEntry: 'Compilation failed: the model response was not valid JSON (kept raw, nothing written)',
        failed: true,
      }
    }

    const rejected: string[] = []
    const actions: WikiAction[] = []
    if (Array.isArray(parsed.actions)) {
      for (const item of parsed.actions as Record<string, unknown>[]) {
        const verdict = validateWikiAction(item)
        if (verdict.ok) actions.push(verdict.action)
        else rejected.push(verdict.reason)
      }
    }
    return {
      actions,
      rejected: rejected.length > 0 ? rejected : undefined,
      logEntry: typeof parsed.logEntry === 'string' && parsed.logEntry.trim()
        ? parsed.logEntry
        : `Compiled ${actions.length} wiki page(s)`,
    }
  }
}


// ── K8 pass 1: page planning ──

export interface WikiPlanInput {
  schema: string
  rawFile: { filePath: string; title: string; content: string }
}

export interface WikiPlanOutput {
  pages: Array<{ filePath: string }>
}

/** One small request: which wiki pages should this source create or update?
 *  The merge pass then reads only THOSE pages' bodies — merging without this
 *  step meant regenerating entities/x.md from source B silently dropped
 *  everything source A contributed. */
export class WikiPlanAgent extends OneShotAgent<WikiPlanInput, WikiPlanOutput> {
  readonly name = 'WikiPlanAgent'

  protected getDefaultOutput(): WikiPlanOutput {
    return { pages: [] }
  }

  protected buildSystemPrompt(input: WikiPlanInput): string {
    return `You are a knowledge wiki planner. Given the wiki schema and ONE raw source file, list the wiki pages that should be created or updated because of this source.

${input.schema.slice(0, 4000)}

Rules:
- Only pages inside sources/, entities/, concepts/, syntheses/ with .md extension.
- Always include the source summary page: sources/<slug>.md
- File name slugs must be stable (derive from the entity/concept NAME, not the date) so repeated compilation finds the same page.
- Output ONLY JSON: {"pages": [{"filePath": "entities/example.md"}, ...]}`
  }

  protected buildUserMessages(input: WikiPlanInput): { role: string; content: string }[] {
    return [{
      role: 'user',
      content: `Raw file: ${input.rawFile.filePath}
Title: ${input.rawFile.title}

${input.rawFile.content}`
    }]
  }

  protected parseResponse(raw: string): WikiPlanOutput {
    const parsed = extractJson<{ pages?: unknown }>(raw)
    const pages = parsed && Array.isArray(parsed.pages)
      ? (parsed.pages as Array<{ filePath?: unknown }>)
          .map((p) => (typeof p?.filePath === 'string' ? p.filePath.replace(/^wiki\//, '') : ''))
          .filter((fp) => isValidWikiPath(fp))
          .map((filePath) => ({ filePath }))
      : []
    return { pages }
  }
}
