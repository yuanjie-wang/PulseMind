export type LLMProvider = 'anthropic' | 'openai'

export interface LlmProfile {
  id: string
  name: string
  provider?: LLMProvider
  baseURL: string
  model: string
  maxTokens: number
  contextLength?: number
  apiKey?: string
  headers?: Record<string, string>
}

export interface AppSettings {
  activeProfileId: string
  profiles: LlmProfile[]
  theme: 'light' | 'dark'
  myName: string
  soul: string
  yourName: string
  workspaceDir?: string
  autoCleanup?: boolean
  yoloMode?: boolean
  locale?: 'zh' | 'en'
  git?: { contextInjection?: boolean }
}
