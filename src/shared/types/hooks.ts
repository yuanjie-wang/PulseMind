/** Handle to a window opened via `ctx.browser.open` (login flows). */
export interface HookWindowHandle {
  /** Close the window and resolve once it is actually gone. Idempotent —
   *  resolving immediately when already destroyed (including a manual close
   *  by the user). Destroy, not close: a page's beforeunload dialog must not
   *  be able to block the hook. */
  close(): Promise<void>
}

export interface HookWindowOptions {
  title?: string
  width?: number
  height?: number
}

/**
 * Built-in browser windows available to the app-start hook: the app's own
 * Chromium in a standalone window on the default (persistent) session — the
 * login page a flow opens before the main window exists.
 */
export interface HookBrowserApi {
  open(url: string, options?: HookWindowOptions): Promise<HookWindowHandle>
}

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
  browser: HookBrowserApi
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
