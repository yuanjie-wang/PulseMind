import type { AgentMessage, AgentStatus } from './agent'

// --- Hook Context Types ---

export interface BeforeSessionContext {
  userMessage: string
  messages: readonly AgentMessage[]
}

export interface AfterSessionContext {
  messages: readonly AgentMessage[]
  status: AgentStatus
}

export interface BeforeToolContext {
  toolUseId: string
  toolName: string
  toolInput: Record<string, unknown>
  command: string
  cwd: string
}

export interface AfterToolContext {
  toolUseId: string
  toolName: string
  content: string
  isError: boolean
}

export interface BeforeLlmCallContext {
  body: Record<string, unknown>
  messages: readonly AgentMessage[]
}

export interface AfterLlmCallContext {
  messages: readonly AgentMessage[]
  stopReason: string | null
  status: AgentStatus
}

// --- Hooks Configuration ---

export interface HooksConfig {
  beforeSession?: (context: BeforeSessionContext) => BeforeSessionContext | Promise<BeforeSessionContext>
  afterSession?: (context: AfterSessionContext) => void | Promise<void>
  beforeTool?: (context: BeforeToolContext) => BeforeToolContext | Promise<BeforeToolContext>
  afterTool?: (context: AfterToolContext) => void | Promise<void>
  beforeLlmCall?: (context: BeforeLlmCallContext) => BeforeLlmCallContext | Promise<BeforeLlmCallContext>
  afterLlmCall?: (context: AfterLlmCallContext) => void | Promise<void>
}
