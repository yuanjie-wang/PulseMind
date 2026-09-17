import type { ExecuteOptions } from './LlmConfig'

export abstract class OneShotAgent<TInput, TOutput> {
  abstract readonly name: string

  protected abstract buildSystemPrompt(input: TInput): string

  protected abstract buildUserMessages(input: TInput): { role: string; content: string }[]

  protected abstract parseResponse(raw: string, input: TInput): TOutput

  protected abstract getDefaultOutput(input: TInput): TOutput

  async execute(input: TInput, options: ExecuteOptions): Promise<TOutput> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await options.llmConfig.adapter.callNonStreaming(
          options.llmConfig.apiKey,
          options.llmConfig.baseURL,
          options.llmConfig.model,
          this.buildSystemPrompt(input),
          this.buildUserMessages(input),
          options.maxTokens ?? 4096,
          options.onUsage,
          options.onFinishReason,
        )
        if (!raw) {
          if (attempt === 0) {
            console.warn(`[${this.name}] LLM returned null, retrying (1/1)...`)
            continue
          }
          console.warn(`[${this.name}] LLM returned null after retry, using default`)
          return this.getDefaultOutput(input)
        }
        return this.parseResponse(raw, input)
      } catch (err) {
        if (attempt === 0) {
          console.warn(`[${this.name}] execution failed, retrying (1/1):`, err)
          continue
        }
        console.warn(`[${this.name}] execution failed after retry:`, err)
        return this.getDefaultOutput(input)
      }
    }
    return this.getDefaultOutput(input)
  }
}
