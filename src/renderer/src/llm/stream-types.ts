/**
 * Normalized stream event handlers — provider-agnostic interface
 * used by the agent loop to accumulate response blocks.
 *
 * Both AnthropicAdapter and OpenAIAdapter emit these normalized events.
 */

/** Token accounting for one model call, as the provider reported it. The cache
 *  field is Anthropic's cache-read count / DeepSeek's hit count; endpoints that
 *  report neither leave it undefined. */
export interface LlmUsage {
  inputTokens?: number
  outputTokens?: number
  promptCacheHitTokens?: number
}

export interface StreamEventHandlers {
  onContentBlockStart: (index: number, block: {
    type: string
    id?: string
    name?: string
  }) => void

  onContentBlockDelta: (index: number, delta: {
    type: string
    text?: string
    partial_json?: string
  }) => void

  onContentBlockStop: (index: number) => void

  /** Stream is complete. stopReason is normalized (end_turn, tool_use, max_tokens, content_filter). */
  onStreamComplete: (stopReason: string | null, usage?: LlmUsage) => void

  onError: (error: string) => void
}

export interface StreamParser {
  processChunk: (text: string) => void
  flush: () => void
}
