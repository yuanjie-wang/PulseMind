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
}

export interface LlmRequest {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}
