import { OneShotAgent } from './OneShotAgent'

export interface SkillSelectionInput {
  intent: string
  skillsList: string
}

export class SkillSelectionAgent extends OneShotAgent<SkillSelectionInput, string | null> {
  readonly name = 'SkillSelectionAgent'

  protected buildSystemPrompt(): string {
    // [experience] 行（PLAN-experience-sop B1）是记忆页经验草稿，同样可选——
    // 返回其 title 原文，调用侧按注册表未命中再解析经验页。
    return 'You are a skill selection system. Given user intent and available skills, select the single most relevant entry. Lines marked [experience] are drafted experience pages and are equally selectable. If none match, respond with "none". Return ONLY the entry name (the title, verbatim).'
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
