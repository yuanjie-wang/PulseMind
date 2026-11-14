import type { LLMProvider } from '../../../shared/types/settings'
import type { AgentMessage } from '../types/agent'
import type { ToolDefinition } from '../tools/types'

export type { LLMProvider }

export interface LlmRequestParams {
  model: string
  maxTokens: number
  messages: AgentMessage[]
  tools: ToolDefinition[]
  systemPrompt: string
  stream: boolean
  /** Anthropic path only: emit explicit `cache_control` breakpoints (default
   *  true). An Anthropic-compatible gateway that rejects unknown fields can
   *  turn caching off without losing the rest of the adapter. Providers whose
   *  caching is automatic (OpenAI/DeepSeek prefix cache) ignore it. */
  promptCache?: boolean
}

export interface LlmRequest {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}
