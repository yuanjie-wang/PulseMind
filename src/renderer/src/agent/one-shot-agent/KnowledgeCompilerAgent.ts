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
}

export interface CompilerOutput {
  actions: WikiAction[]
  logEntry: string
}

/** KnowledgeCompilerAgent — LLM-driven compilation of raw files into structured wiki pages. */
export class KnowledgeCompilerAgent extends OneShotAgent<CompilerInput, CompilerOutput> {
  readonly name = 'KnowledgeCompilerAgent'

  protected getDefaultOutput(_input: CompilerInput): CompilerOutput {
    return { actions: [], logEntry: 'Compilation failed: LLM error' }
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
4. All pages use YAML frontmatter per the schema convention.

## Output Format

Return a JSON object with this exact structure:

\`\`\`json
{
  "actions": [
    {
      "type": "write_source",
      "filePath": "sources/source-slug.md",
      "content": "---\\ntitle: ...\\ntype: source\\n...\\n---\\n\\nFull markdown content here..."
    },
    {
      "type": "write_entity",
      "filePath": "entities/entity-name.md",
      "content": "---\\ntitle: Entity Name\\ntype: entity\\n...\\n---\\n\\nContent..."
    },
    {
      "type": "write_concept",
      "filePath": "concepts/concept-name.md",
      "content": "..."
    },
    {
      "type": "write_synthesis",
      "filePath": "syntheses/topic.md",
      "content": "..."
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
      content: `Existing wiki index:\n\n${input.existingIndex.slice(0, 10000)}\n\n---\n\nRaw files to compile:\n\n${rawSection}`
    }]
  }

  protected parseResponse(raw: string, _input: CompilerInput): CompilerOutput {
    const parsed = extractJson<{ actions?: Array<{ type: string; filePath: string; content: string }>; logEntry?: string }>(raw)

    if (!parsed) {
      // Fallback: wrap raw response as a single source write
      return {
        actions: [{
          type: 'write_source',
          filePath: `sources/compilation-${Date.now()}.md`,
          content: raw
        }],
        logEntry: 'Compilation generated raw output (JSON parsing failed)'
      }
    }

    const actions = Array.isArray(parsed.actions) ? parsed.actions as WikiAction[] : []
    return {
      actions: actions.map((a) => ({
        ...a,
        filePath: a.filePath.replace(/^wiki\//, '')
      })),
      logEntry: typeof parsed.logEntry === 'string' ? parsed.logEntry : `Compiled ${actions.length} wiki page(s)`
    }
  }
}
