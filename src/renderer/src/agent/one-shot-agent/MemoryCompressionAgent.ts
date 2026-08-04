import { OneShotAgent } from './OneShotAgent'
import { extractJson } from './json-utils'

export interface MemoryCompressionInput {
  memoriesText: string
}

export interface CompressedMemory {
  content: string
  type: string
  category: string
}

export class MemoryCompressionAgent extends OneShotAgent<MemoryCompressionInput, CompressedMemory[]> {
  readonly name = 'MemoryCompressionAgent'

  protected buildSystemPrompt(): string {
    return (
      'You are a memory consolidation system. Merge and deduplicate the following memories ' +
      'into a concise set. Remove duplicates, merge related items, keep only genuinely important information. ' +
      'Return a JSON array of objects, each with keys: ' +
      '"content" (string, the consolidated memory), "type" (one of: "fact", "decision", "preference"), ' +
      '"category" (one of: "code", "architecture", "user_pref", "decision", "general"). ' +
      'Output at most 20 items. Return ONLY the JSON array, no other text.'
    )
  }

  protected buildUserMessages(input: MemoryCompressionInput): { role: string; content: string }[] {
    return [{ role: 'user', content: `Consolidate these memories:\n\n${input.memoriesText}` }]
  }

  protected parseResponse(raw: string): CompressedMemory[] {
    const parsed = extractJson<CompressedMemory[]>(raw)
    return Array.isArray(parsed) ? parsed : []
  }

  protected getDefaultOutput(): CompressedMemory[] {
    return []
  }
}
