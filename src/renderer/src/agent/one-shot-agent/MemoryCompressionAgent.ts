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

/**
 * The merge's output with a CONSUMPTION RECEIPT (2026-10-10): `dropped` lists
 * the `#N` line numbers the model deliberately discarded (merged elsewhere or
 * transient narration). The caller deletes only rows with a receipt — a row
 * the model merely FORGOT is retained and retried by the next merge, instead
 * of being deleted by an output hash comparison that could not tell
 * "consolidated" from "omitted" (the omission permanently destroyed the row).
 */
export interface MemoryMergeOutput {
  memories: CompressedMemory[]
  /** 1-based input line numbers the model intentionally discarded. */
  dropped: number[]
}

export class MemoryCompressionAgent extends OneShotAgent<MemoryCompressionInput, MemoryMergeOutput> {
  readonly name = 'MemoryCompressionAgent'

  protected buildSystemPrompt(): string {
    return (
      'You are a memory consolidation system performing an INCREMENTAL merge (P2 of the memory dedup plan). ' +
      'The input is a numbered list of memories; each line starts with its number like #7. ' +
      'Rules, in priority order: ' +
      '(1) USER-EDITED memories are authoritative — never drop, rewrite or paraphrase them; carry them over verbatim. ' +
      '(2) Two memories stating the same fact merge into ONE entry; a LATER correction overrides an earlier statement. ' +
      '(3) Merge related items; keep only genuinely important, durable information. ' +
      '(4) An entry that merely narrates what happened in one conversation (a task execution log, a recap of the assistant\'s own research or analysis) carries no durable user information — DROP it, unless it records a user decision/preference or a durable environment fact. ' +
      '(5) Keep the memories soft-capped at 20 entries, and every "content" at most 100 characters — ONE short sentence per entry stating the conclusion; drop operational detail rather than pack it into a long entry. ' +
      'ACCOUNTING: every input line you did not carry into a consolidated entry MUST be reported by number in "dropped" ' +
      '(transient narration you dropped under rule 4, or a line fully absorbed into another entry). ' +
      'A line reported NOWHERE is retained untouched for a future merge — never lose a memory by omission. ' +
      'Return ONE JSON object with exactly these keys: ' +
      '"memories": array of objects, each with keys "content" (string), "type" (one of: "fact", "decision", "preference"), ' +
      '"category" (one of: "code", "architecture", "user_pref", "decision", "general"); ' +
      '"dropped": array of input line numbers (integers). ' +
      'Return ONLY the JSON object, no other text.'
    )
  }

  protected buildUserMessages(input: MemoryCompressionInput): { role: string; content: string }[] {
    return [{ role: 'user', content: `Consolidate these memories:\n\n${input.memoriesText}` }]
  }

  protected parseResponse(raw: string): MemoryMergeOutput {
    const parsed = extractJson<MemoryMergeOutput | CompressedMemory[]>(raw)
    if (Array.isArray(parsed)) {
      // Legacy shape: the model returned the old bare array (or ignored the
      // object contract). There is no receipt — nothing may be deleted beyond
      // verbatim hash matches downstream.
      return { memories: parsed, dropped: [] }
    }
    if (!parsed || !Array.isArray(parsed.memories)) return { memories: [], dropped: [] }
    const dropped = Array.isArray(parsed.dropped)
      ? [...new Set(parsed.dropped.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1))]
      : []
    return { memories: parsed.memories, dropped }
  }

  protected getDefaultOutput(): MemoryMergeOutput {
    return { memories: [], dropped: [] }
  }
}
