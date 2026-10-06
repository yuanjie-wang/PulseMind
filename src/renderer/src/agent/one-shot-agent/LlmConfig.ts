import type { LlmAdapter } from '../../llm/adapter'
import type { LlmUsage } from '../../llm/stream-types'

export interface LlmConfig {
  apiKey: string
  baseURL: string
  model: string
  adapter: LlmAdapter
  /**
   * The model's configured per-response output limit (settings `maxTokens`,
   * the same number the main loop sends). Thinking gateways settle
   * reasoning_tokens INSIDE wire max_tokens (measured on three wires
   * 2026-10-06 — and the off-switch itself is NOT portable across model
   * families: Anthropic/GLM-style `thinking:{type:'disabled'}`, Qwen
   * `enable_thinking`, OpenRouter `reasoning:{enabled}`, …), so one-shot
   * calls do not try to suppress thinking: the wire budget is this number —
   * reasoning and content both live inside it — and the consumer cap
   * (ExecuteOptions.maxTokens) degrades to a content expectation enforced
   * after the call (e.g. the summary's 800-char truncation).
   */
  modelMaxTokens?: number
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
