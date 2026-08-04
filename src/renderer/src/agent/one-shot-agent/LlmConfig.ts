import type { LlmAdapter } from '../../llm/adapter'

export interface LlmConfig {
  apiKey: string
  baseURL: string
  model: string
  adapter: LlmAdapter
}

export interface ExecuteOptions {
  llmConfig: LlmConfig
  maxTokens?: number
}
