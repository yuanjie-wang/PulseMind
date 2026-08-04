import { OneShotAgent } from './OneShotAgent'
import { extractJson } from './json-utils'

export interface SkillKeywordInput {
  rawContent: string
}

export class SkillKeywordAgent extends OneShotAgent<SkillKeywordInput, string[]> {
  readonly name = 'SkillKeywordAgent'

  protected buildSystemPrompt(): string {
    return 'You extract trigger keywords from skill descriptions.'
  }

  protected buildUserMessages(input: SkillKeywordInput): { role: string; content: string }[] {
    const prompt =
      'You are a skill trigger keyword extraction system. Given the content of a skill\'s SKILL.md file, ' +
      'extract trigger keywords that can be used to automatically activate this skill.\n\n' +
      'Requirements:\n' +
      '- Extract at least 6 trigger keywords total\n' +
      '- Include both English and Chinese keywords\n' +
      '- Keywords should be relevant to the skill\'s purpose and use cases\n' +
      '- Return ONLY a valid JSON array of strings, nothing else\n\n' +
      'SKILL.md content:\n' +
      input.rawContent
    return [{ role: 'user', content: prompt }]
  }

  protected parseResponse(raw: string): string[] {
    const parsed = extractJson<string[]>(raw)
    if (Array.isArray(parsed)) return parsed

    // Fallback: extract quoted strings
    const matches = raw.trim().match(/"([^"]*)"/g)
    if (matches && matches.length > 0) {
      return matches.map((w) => w.replace(/"/g, ''))
    }

    return []
  }

  protected getDefaultOutput(): string[] {
    return []
  }
}
