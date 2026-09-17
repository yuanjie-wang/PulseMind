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
  /** Reports the provider finish/stop reason ('stop' | 'length' | 'max_tokens'
   *  | ...). PLAN-knowledge-base K1: compilation treats a truncated completion
   *  as a failure — it must never guess half an answer into a wiki page. */
  onFinishReason?: (reason: string | null) => void
}
