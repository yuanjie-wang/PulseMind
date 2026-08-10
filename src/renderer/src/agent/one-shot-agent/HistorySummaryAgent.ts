import { OneShotAgent } from './OneShotAgent'

export interface HistorySummaryInput {
  /** Condensed text of the conversation region being dropped (built by AgentEngine). */
  regionText: string
  locale?: string
}

/**
 * Summarizes a dropped conversation region before hardTruncate discards it.
 * The output is injected into the API copy only — it never reaches this.messages
 * or the UI, so it can stay a plain string summary with no formatting markers.
 */
export class HistorySummaryAgent extends OneShotAgent<HistorySummaryInput, string> {
  readonly name = 'HistorySummaryAgent'

  protected buildSystemPrompt(input: HistorySummaryInput): string {
    const isZh = input.locale === 'zh'
    if (isZh) {
      return `你是对话历史摘要器。
任务：将下面的对话历史压缩为一段 150-300 字的摘要。
必须保留的信息：项目/任务目标、用户的关键需求与已作决策、当前进度、尚未完成的事项、重要文件路径与约定。
约束：
1. 只输出摘要正文，不要标题、列表编号、解释或任何额外文字；
2. 严禁向用户提问、请求澄清或索要更多信息；
3. 用对话本身的语言输出。`
    }
    return `You are a conversation-history summarizer.
Task: Compress the following conversation history into a summary of 150-300 words.
Must preserve: project/task goals, the user's key requirements and decisions, current progress, unfinished items, important file paths and conventions.
Rules:
1. Output only the summary body — no headings, numbered lists, explanations, or extra text;
2. Never ask the user questions, request clarification, or ask for more information;
3. Output in the same language as the conversation.`
  }

  protected buildUserMessages(input: HistorySummaryInput): { role: string; content: string }[] {
    return [{ role: 'user', content: input.regionText }]
  }

  protected parseResponse(raw: string): string {
    // Strip markdown fences and lead-ins, keep the plain summary body.
    let cleaned = raw.replace(/```[\s\S]*?(?:```|$)/g, '').trim()
    cleaned = cleaned.replace(/^(?:摘要(?:为|是)?|总结(?:为|是)?|历史摘要)[:：]?\s*/i, '').trim()
    return cleaned.slice(0, 800)
  }

  protected getDefaultOutput(): string {
    // Empty → AgentEngine falls back to plain truncation (current behavior).
    return ''
  }
}
