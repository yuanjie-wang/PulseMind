import type { LlmAdapter } from '../../llm/adapter'
import type { LlmUsage } from '../../llm/stream-types'

export interface LlmConfig {
  apiKey: string
  baseURL: string
  model: string
  adapter: LlmAdapter
}

export interface ExecuteOptions {
  llmConfig: LlmConfig
  maxTokens?: number
  /** Reports the provider's token accounting for the call. Optional: only the
   *  callers that show token counts (the expert editor's chat panel) pass it. */
  onUsage?: (usage: LlmUsage) => void
}
