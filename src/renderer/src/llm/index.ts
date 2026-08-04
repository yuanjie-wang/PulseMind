import type { LLMProvider } from './types'
import type { LlmAdapter } from './adapter'
import { anthropicAdapter } from './AnthropicAdapter'
import { openaiAdapter } from './OpenAIAdapter'

const adapters: Record<LLMProvider, LlmAdapter> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter
}

export function createLlmAdapter(provider: LLMProvider): LlmAdapter {
  const adapter = adapters[provider]
  if (!adapter) {
    throw new Error(`Unknown LLM provider: ${provider}`)
  }
  return adapter
}

export { anthropicAdapter, openaiAdapter }
export type { LlmAdapter } from './adapter'
export type { LLMProvider, LlmRequestParams, LlmRequest } from './types'
export type { StreamEventHandlers, StreamParser } from './stream-types'
