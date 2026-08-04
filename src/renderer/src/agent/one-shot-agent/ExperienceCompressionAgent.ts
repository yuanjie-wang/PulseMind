import { OneShotAgent } from './OneShotAgent'
import { extractJson } from './json-utils'

export interface ExperienceCompressionInput {
  experiencesText: string
}

export interface CompressedExperience {
  content: string
  category: string
}

export class ExperienceCompressionAgent extends OneShotAgent<ExperienceCompressionInput, CompressedExperience[]> {
  readonly name = 'ExperienceCompressionAgent'

  protected buildSystemPrompt(): string {
    return (
      'You are an experience consolidation system. Merge and deduplicate the following workflow experiences ' +
      'into a concise set. Remove duplicates, merge related items, keep only genuinely useful insights. ' +
      'Return a JSON array of objects, each with keys: ' +
      '"content" (string, the consolidated explanation), ' +
      '"category" (string, one of "code", "architecture", "user_pref", "decision", "general"). ' +
      'Output at most 10 items. Return ONLY the JSON array, no other text.'
    )
  }

  protected buildUserMessages(input: ExperienceCompressionInput): { role: string; content: string }[] {
    return [{ role: 'user', content: `Consolidate these experiences:\n\n${input.experiencesText}` }]
  }

  protected parseResponse(raw: string): CompressedExperience[] {
    const parsed = extractJson<CompressedExperience[]>(raw)
    return Array.isArray(parsed) ? parsed : []
  }

  protected getDefaultOutput(): CompressedExperience[] {
    return []
  }
}
