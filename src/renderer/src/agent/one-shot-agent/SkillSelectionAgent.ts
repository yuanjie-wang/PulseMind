import { OneShotAgent } from './OneShotAgent'

export interface SkillSelectionInput {
  intent: string
  skillsList: string
}

export class SkillSelectionAgent extends OneShotAgent<SkillSelectionInput, string | null> {
  readonly name = 'SkillSelectionAgent'

  protected buildSystemPrompt(): string {
    return 'You are a skill selection system. Given user intent and available skills, select the single most relevant skill. If none match, respond with "none". Return ONLY the skill name.'
  }

  protected buildUserMessages(input: SkillSelectionInput): { role: string; content: string }[] {
    return [{
      role: 'user',
      content: `User intent: ${input.intent}\n\nAvailable skills:\n${input.skillsList}`
    }]
  }

  protected parseResponse(raw: string): string | null {
    const cleaned = raw.toLowerCase().trim()
    return cleaned === 'none' ? null : raw.trim()
  }

  protected getDefaultOutput(): string | null {
    return null
  }
}
