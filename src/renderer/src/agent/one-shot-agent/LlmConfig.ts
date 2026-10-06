import type { LlmAdapter } from '../../llm/adapter'
import type { LlmUsage } from '../../llm/stream-types'

export interface LlmConfig {
  apiKey: string
  baseURL: string
  model: string
  adapter: LlmAdapter
  /**
   * The model's configured per-response output limit (settings `maxTokens`,
   * the same number the main loop sends). This is the ONLY wire max_tokens a
   * one-shot uses: thinking gateways settle reasoning_tokens INSIDE it
   * (measured on three wires 2026-10-06) and the thinking off-switch is NOT
   * portable across model families, so one-shot calls do not touch the wire
   * budget at all — reasoning and final content both live inside this number.
   * Scenario-level output requirements are a DIFFERENT config
   * (ExecuteOptions.maxOutputTokens) enforced on the final content, after the
   * call — never on the wire.
   */
  modelMaxTokens?: number
}

export interface ExecuteOptions {
  llmConfig: LlmConfig
  /**
   * The scenario's own maximum FINAL-OUTPUT length requirement, in estimated
   * tokens (CJK-aware heuristic). Enforced post-hoc on the returned content —
   * over-cap output is truncated — and deliberately UNRELATED to the wire
   * max_tokens, to the model, and to thinking length: the wire budget is
   * LlmConfig.modelMaxTokens alone. Optional: scenarios without a length
   * requirement omit it.
   */
  maxOutputTokens?: number
  /** Reports the provider's token accounting for the call. Optional: only the
   *  callers that show token counts (the expert editor's chat panel) pass it. */
  onUsage?: (usage: LlmUsage) => void
  /** Reports the provider finish/stop reason ('stop' | 'length' | 'max_tokens'
   *  | ...). PLAN-knowledge-base K1: compilation treats a truncated completion
   *  as a failure — it must never guess half an answer into a wiki page. */
  onFinishReason?: (reason: string | null) => void
}
