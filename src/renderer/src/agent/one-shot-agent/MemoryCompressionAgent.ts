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
      'You are a memory consolidation system performing an INCREMENTAL merge (P2 of the memory dedup plan). ' +
      'Rules, in priority order: ' +
      '(1) USER-EDITED memories are authoritative — never drop, rewrite or paraphrase them; carry them over verbatim. ' +
      '(2) Two memories stating the same fact merge into ONE entry; a LATER correction overrides an earlier statement. ' +
      '(3) Merge related items; keep only genuinely important, durable information. ' +
      '(4) Keep the total soft-capped at 20 entries. ' +
      'Return a JSON array of objects, each with keys: ' +
      '"content" (string, the consolidated memory), "type" (one of: "fact", "decision", "preference"), ' +
      '"category" (one of: "code", "architecture", "user_pref", "decision", "general"). ' +
      'Return ONLY the JSON array, no other text.'
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
