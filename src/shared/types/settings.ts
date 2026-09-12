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
  /** Launch the app at OS login (applied via app.setLoginItemSettings; also toggled from the tray). */
  launchAtLogin?: boolean
  /** Local agent service (loopback WebSocket for browser extensions). Default on. */
  serviceEnabled?: boolean
  servicePort?: number
  git?: { contextInjection?: boolean }
  /** Browser runtime (A-M4). */
  browser?: {
    /** Default backend for conversations that never chose one ('managed'). */
    backend?: 'managed' | 'app-view'
    /** Launch the managed Chromium headless (default true). */
    headless?: boolean
    /** Per-call wall-clock budget in ms (default 60000, cap 300000). */
    timeoutMs?: number
  }
}
