import { OneShotAgent } from './OneShotAgent'
import { extractJson } from './json-utils'

export interface MemoryExtractionInput {
  sessionSummary: string
}

export interface ExtractedMemory {
  content: string
  type: string
  category: string
}

export interface MemoryExtractionOutput {
  memories: ExtractedMemory[]
  summary?: string
  keywords?: string[]
}

export class MemoryExtractionAgent extends OneShotAgent<MemoryExtractionInput, MemoryExtractionOutput> {
  readonly name = 'MemoryExtractionAgent'

  protected buildSystemPrompt(): string {
    return (
      'You are a memory extraction system. Extract important facts, decisions, and user preferences ' +
      'from the conversation below. Return a JSON object with keys: ' +
      '"memories" (array of objects, each with keys: "content" (string), "type" (one of: "fact", "decision", "preference"), ' +
      '"category" (one of: "code", "architecture", "user_pref", "decision", "general")), ' +
      '"summary" (string, a short phrase describing this conversation), ' +
      '"keywords" (array of strings, max 10 keywords, in Chinese). ' +
      'Only include genuinely important, durable information in memories. Skip transient chat. ' +
      'Return ONLY the JSON object, no other text.'
    )
  }

  protected buildUserMessages(input: MemoryExtractionInput): { role: string; content: string }[] {
    return [{
      role: 'user',
      content: `Extract memories from this conversation:\n\n${input.sessionSummary}`
    }]
  }

  protected parseResponse(raw: string): MemoryExtractionOutput {
    const parsed = extractJson<{ memories?: unknown[]; summary?: string; keywords?: unknown[] }>(raw)

    if (!parsed) return this.getDefaultOutput()

    // Support both old format (array) and new format ({memories, summary, keywords})
    if (Array.isArray(parsed)) {
      return { memories: parsed }
    }

    return {
      memories: Array.isArray(parsed.memories) ? parsed.memories as ExtractedMemory[] : [],
      summary: typeof parsed.summary === 'string' ? parsed.summary : undefined,
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords.filter((k: unknown) => typeof k === 'string') : undefined
    }
  }

  protected getDefaultOutput(): MemoryExtractionOutput {
    return { memories: [] }
  }
}
