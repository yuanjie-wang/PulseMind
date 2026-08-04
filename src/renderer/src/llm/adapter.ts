import type { AgentMessage } from '../types/agent'
import type { ToolDefinition } from '../tools/types'
import type { LlmRequestParams, LLMProvider } from './types'
import type { StreamEventHandlers, StreamParser } from './stream-types'

/**
 * Abstract LLM provider adapter.
 *
 * Each provider (Anthropic, OpenAI, etc.) implements this interface to
 * translate between PulseMind's internal types and the provider's API format.
 */
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
   */
  callNonStreaming(
    apiKey: string,
    baseURL: string,
    model: string,
    systemPrompt: string,
    messages: { role: string; content: string }[],
    maxTokens?: number
  ): Promise<string | null>

  /** Extract plain text from a non-streaming provider response. */
  extractTextContent(response: string | null): string | null
}
