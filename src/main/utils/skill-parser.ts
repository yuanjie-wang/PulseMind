/**
 * Minimal YAML frontmatter parser for SKILL.md files.
 *
 * Parses the Claude Code / OpenClaw SKILL.md format:
 * ```
 * ---
 * name: my-skill
 * description: Does something
 * category: engineering
 * triggers:
 *   - keyword1
 *   - keyword2
 * ---
 *
 * ## System Prompt
 * Actual system prompt content...
 * ```
 */

export interface ParsedFrontmatter {
  name: string
  description: string
  category: string
  triggers: string[]
  systemPrompt: string
  sourceConversationId?: string
  createdAt?: string
}

export function parseSkillMarkdown(
  content: string,
  fileName: string
): ParsedFrontmatter {
  // Detect BOM and normalize line endings
  const normalized = content
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')

  // Find frontmatter delimiters
  const lines = normalized.split('\n')
  if (lines[0]?.trim() !== '---') {
    throw new Error(`${fileName}: SKILL.md must start with "---" frontmatter delimiter`)
  }

  let endIndex = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endIndex = i
      break
    }
  }
  if (endIndex === -1) {
    throw new Error(`${fileName}: Missing closing "---" frontmatter delimiter`)
  }

  // Parse frontmatter lines
  const frontmatter = lines.slice(1, endIndex)
  const result: Omit<ParsedFrontmatter, 'systemPrompt'> = {
    name: '',
    description: '',
    category: 'imported',
    triggers: []
  }

  let currentKey = ''
  for (const line of frontmatter) {
    // List item: "  - value"
    const listMatch = line.match(/^\s+-\s+(.+)$/)
    if (listMatch && currentKey) {
      ;(result as Record<string, unknown>)[currentKey] = [
        ...((result as Record<string, unknown>)[currentKey] as string[] || []),
        listMatch[1].trim()
      ]
      continue
    }

    // Key-value: "key: value"
    const kvMatch = line.match(/^(\w[\w_-]*)\s*:\s*(.*)$/)
    if (kvMatch) {
      currentKey = kvMatch[1]
      const value = kvMatch[2].trim()
      if (value) {
        ;(result as Record<string, unknown>)[currentKey] = value
      } else {
        // Key with empty value — starts a list
        ;(result as Record<string, unknown>)[currentKey] = []
      }
      continue
    }

    // Empty line or comment — skip
    if (line.trim() === '' || line.trim().startsWith('#')) {
      currentKey = ''
      continue
    }
  }

  if (!result.name) {
    throw new Error(`${fileName}: Missing required "name" field in frontmatter`)
  }

  // Everything after closing "---" is the system prompt
  const promptLines = lines.slice(endIndex + 1)
  const systemPrompt = promptLines.join('\n').trim()

  if (!systemPrompt) {
    throw new Error(`${fileName}: System prompt body is empty (text after closing "---")`)
  }

  return {
    name: result.name,
    description: result.description || result.name,
    category: result.category || 'imported',
    triggers: result.triggers || [],
    systemPrompt,
    sourceConversationId: result.sourceConversationId || undefined,
    createdAt: result.createdAt || undefined
  }
}
