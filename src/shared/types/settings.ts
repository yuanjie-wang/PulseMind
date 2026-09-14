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
  locale?: 'zh' | 'en'
  /** Launch the app at OS login (applied via app.setLoginItemSettings; also toggled from the tray). */
  launchAtLogin?: boolean
  /** Local agent service (loopback WebSocket for browser extensions). Default on. */
  serviceEnabled?: boolean
  servicePort?: number
  git?: { contextInjection?: boolean }
  /** 记忆系统总开关：会话后自动提取 + 记忆注入系统提示。默认开。手动记忆编辑不受影响。 */
  memoryEnabled?: boolean
  /** 经验系统总开关：会话后自动沉淀 + 经验索引注入系统提示。默认开。已有经验保留可查看。 */
  experienceEnabled?: boolean
  /** Browser runtime (A-M4). */
  browser?: {
    /** Default backend for conversations that never chose one ('managed'). */
    backend?: 'managed' | 'app-view'
    /** Launch the managed Chromium headless (default true). */
    headless?: boolean
    /** Per-call wall-clock budget in ms (default 60000, cap 300000). */
    timeoutMs?: number
    /** In-app pane width in px (A-M5) — remembered globally across sessions. */
    paneWidth?: number
  }
}
