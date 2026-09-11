import { OneShotAgent } from './OneShotAgent'
import { extractJson } from './json-utils'

export interface RoutineExtractionInput {
  /** Flattened conversation transcript (user/assistant lines). */
  conversationText: string
  locale?: 'zh' | 'en'
}

export interface RoutineDraft {
  name: string
  description: string
  prompt: string
  cron: string
}

/**
 * Extracts a routine draft (PLAN-0.4.0 M4.4) — a reusable, possibly schedulable
 * task — from a conversation. The draft always lands in a review editor; the
 * user confirms before anything is saved.
 */
export class RoutineExtractionAgent extends OneShotAgent<RoutineExtractionInput, RoutineDraft | null> {
  readonly name = 'RoutineExtractionAgent'

  protected buildSystemPrompt(): string {
    return 'You extract reusable daily-work routines from conversations. You reply with JSON only.'
  }

  protected buildUserMessages(input: RoutineExtractionInput): { role: string; content: string }[] {
    const localeNote = input.locale === 'en'
      ? 'Write name/description/prompt in English.' : 'name、description、prompt 用中文书写。'
    const prompt =
      '从下面的对话中提炼一个「日常工作」任务草稿：一个可以反复执行、也可以定时执行的提示词任务。\n\n' +
      '要求：\n' +
      '- prompt 必须是独立可执行的指令（脱离原对话也能跑），保留关键上下文与步骤\n' +
      '- 如果对话是重复性工作（如每周整理、每日检查、定期报告），给出合理的 cron 表达式（5 字段）；否则 cron 留空字符串\n' +
      `- ${localeNote}\n` +
      '- 只返回 JSON 对象，不要其他文字：\n' +
      '{"name":"...","description":"...","prompt":"...","cron":"..."}\n\n' +
      '对话内容：\n' +
      input.conversationText.slice(0, 24_000)
    return [{ role: 'user', content: prompt }]
  }

  protected parseResponse(raw: string): RoutineDraft | null {
    const parsed = extractJson<Partial<RoutineDraft>>(raw)
    if (!parsed || typeof parsed !== 'object' || !parsed.name || !parsed.prompt) return null
    return {
      name: String(parsed.name),
      description: String(parsed.description ?? ''),
      prompt: String(parsed.prompt),
      cron: String(parsed.cron ?? ''),
    }
  }

  protected getDefaultOutput(): RoutineDraft | null {
    return null
  }
}
