import { OneShotAgent } from './OneShotAgent'

export interface AutoSummaryInput {
  textBlocks: string[]
  toolNames: string[]
  locale?: string
}

export class AutoSummaryAgent extends OneShotAgent<AutoSummaryInput, string | null> {
  readonly name = 'AutoSummaryAgent'

  protected buildSystemPrompt(input: AutoSummaryInput): string {
    const isZh = input.locale === 'zh'
    return isZh
      ? '你是一个对话摘要生成器。请将以下AI推理和工具执行过程浓缩为一段简洁的摘要（不超过200字）。保留关键的发现、错误、决策和文件路径。忽略无关紧要的输出和进度信息。只输出摘要本身，不要额外解释。'
      : 'You are a conversation summarizer. Condense the following AI reasoning and tool execution into one concise paragraph (under 200 tokens). Preserve key findings, errors, decisions, and file paths. Ignore trivial output and progress updates. Output only the summary text.'
  }

  protected buildUserMessages(input: AutoSummaryInput): { role: string; content: string }[] {
    const text = input.textBlocks.join('\n').slice(0, 3000)
    const tools = input.toolNames.join(', ')
    if (text && tools) return [{ role: 'user', content: `Reasoning:\n${text}\n\nTools used: ${tools}` }]
    if (text) return [{ role: 'user', content: `Reasoning:\n${text}` }]
    return [{ role: 'user', content: `Tools used: ${tools}` }]
  }

  protected parseResponse(raw: string): string | null {
    const cleaned = raw.trim()
    return cleaned.length > 0 ? cleaned : null
  }

  protected getDefaultOutput(): string | null {
    return null
  }
}
