export interface HookContext {
  event: string
  dataDir: string
  workspaceDir: string
  skillsDir: string
  knowledgeDir: string
  platform: {
    name: string
    release: string
    arch: string
  }
  env: Record<string, string>
}

export interface HookResult {
  env?: Record<string, string>
}

/**
 * Context passed to the llm-request hook (~/.pulsemind/hooks/llm-request.js)
 * for every LLM API request right before it is sent. `body` is JSON-parsed
 * when the request body was JSON.
 */
export interface LlmRequestHookContext {
  event: 'llm-request'
  requestId: string
  url: string
  headers: Record<string, string>
  body: unknown
  profileId?: string
}

/** Result of the llm-request hook. Omitted fields keep their original values. */
export interface LlmRequestHookResult {
  /** Replace the request URL entirely. */
  url?: string
  /** Merge over the existing headers (hook wins, case-insensitive). */
  headers?: Record<string, string>
  /** Replace the request body (object or raw string). */
  body?: unknown
}
