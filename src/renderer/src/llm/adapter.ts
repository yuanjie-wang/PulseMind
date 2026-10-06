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
 * Wire-side reasoning allowance added to `callNonStreaming`'s max_tokens.
 * Thinking gateways settle reasoning_tokens INSIDE max_tokens (measured on all
 * three wires 2026-10-06: DeepSeek zen/openai, api.deepseek.com openai and
 * anthropic), so a cap set as a visible-content budget gets eaten by thinking
 * before any content is emitted — memory consolidation and session review
 * length-finished with ~zero visible text on deepseek-v4.1-flash. The caller's
 * number stays the content budget; the wire gets this much headroom on top.
 * Non-thinking models never reach the raised ceiling (strict mechanical
 * prompts finish at `stop`), so their behavior and cost are unchanged.
 */
export const NON_STREAMING_REASONING_ALLOWANCE = 8192
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
   * `maxTokens` is the VISIBLE-CONTENT budget. Thinking gateways count
   * reasoning into wire max_tokens, so the adapters send it plus
   * `NON_STREAMING_REASONING_ALLOWANCE` — callers' numbers mean content, not
   * the wire ceiling.
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
