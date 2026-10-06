import type { AgentMessage } from '../types/agent'
import type { ToolDefinition } from '../tools/types'
import type { LlmRequestParams, LLMProvider } from './types'
import type { StreamEventHandlers, StreamParser, LlmUsage } from './stream-types'

/**
 * Abstract LLM provider adapter.
 *
 * Each provider (Anthropic, OpenAI, etc.) implements this interface to
 * translate between PulseMind's internal types and the provider's API format.
 */

/**
 * One-shot calls disable thinking outright via `thinking:{type:'disabled'}`:
 * thinking gateways settle reasoning_tokens INSIDE wire max_tokens (measured
 * on all three wires 2026-10-06: DeepSeek zen/openai, api.deepseek.com openai
 * and anthropic), which ate one-shot content caps before any text appeared —
 * memory consolidation and session review length-finished with ~zero visible
 * output. With thinking off, `maxTokens` means exactly the final-output cap.
 *
 * Gateways that reject the unknown param (real OpenAI treats it as an
 * unrecognized argument, real Anthropic only accepts thinking.type 'enabled')
 * are discovered at runtime: when a param'd call fails and the plain retry
 * succeeds, the baseURL lands here and later calls skip the param — one failed
 * round-trip per gateway, ever, per process. Keyed by baseURL because param
 * rejection is a gateway-level contract; a baseURL is only memoized after a
 * SUCCESSFUL plain retry, so transient errors never poison the set.
 */
const thinkingParamUnsupportedBaseURLs = new Set<string>()

export function thinkingParamUnsupported(baseURL: string): boolean {
  return thinkingParamUnsupportedBaseURLs.has(baseURL)
}

export function markThinkingParamUnsupported(baseURL: string): void {
  thinkingParamUnsupportedBaseURLs.add(baseURL)
}
export interface LlmAdapter {
  readonly provider: LLMProvider

  /** Build the full HTTP request (URL + headers + body) given params. */
  buildRequest(baseURL: string, apiKey: string, params: LlmRequestParams): {
    url: string
    headers: Record<string, string>
    body: Record<string, unknown>
  }

  /** Create a stream parser that emits normalized events. */
  createStreamParser(handlers: StreamEventHandlers): StreamParser

  /**
   * Build the messages array for the API request body.
   * For Anthropic, system prompt is returned separately as systemField.
   */
  buildMessages(messages: AgentMessage[], systemPrompt: string): {
    apiMessages: unknown[]
    systemField?: string
  }

  /** Build the tools array for the API request body. */
  buildTools(toolDefinitions: ToolDefinition[]): unknown[]

  /**
   * Optional: reconcile internal messages to meet API requirements before
   * building the request (e.g., ensure every tool_use has a tool_result).
   */
  reconcileMessages?(messages: AgentMessage[]): void

  /**
   * Non-streaming API call for background tasks (title generation, memory extraction).
   * Internally uses streaming (stream: true) to support APIs that only accept streaming,
   * collects all SSE chunks, and returns the extracted text content.
   *
   * `onUsage` reports the provider's token accounting for the call when the
   * response carries it; callers that show token counts pass it, the rest omit it.
   *
   * `onFinishReason` reports the provider finish/stop reason ('stop' | 'length'
   * | 'max_tokens' | …) before the promise settles — compilation (K1) treats a
   * truncated completion as a failure and must be able to see it.
   *
   * `maxTokens` is the final-output cap, sent as-is on the wire. Thinking is
   * disabled for these background calls (`thinking:{type:'disabled'}` — see
   * the memo above); gateways that reject the param fall back to a plain
   * request after one failed attempt.
   */
  callNonStreaming(
    apiKey: string,
    baseURL: string,
    model: string,
    systemPrompt: string,
    messages: { role: string; content: string }[],
    maxTokens?: number,
    onUsage?: (usage: LlmUsage) => void,
    onFinishReason?: (reason: string | null) => void
  ): Promise<string | null>

  /** Extract plain text from a non-streaming provider response. */
  extractTextContent(response: string | null): string | null
}
