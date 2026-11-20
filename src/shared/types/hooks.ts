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
 *
 * Session identity (2026-11-20): `requestId` marks ONE wire request (fresh per
 * request, stable across the proxy's HTTP-level retries); `sessionId` the
 * conversation; `taskId`/`turnIndex` the Q&A turn (taskId minted at turn
 * start, stable across every re-issue within the turn; turnIndex the 0-based
 * position in the conversation). The triple is ABSENT (not undefined) on
 * context-less calls — probes, title/memory sidecars — which have no turn.
 * Identity rides the hook context ONLY: never headers/body (prefix-cache
 * bytes are sensitive).
 */
export interface LlmRequestHookContext {
  event: 'llm-request'
  requestId: string
  url: string
  headers: Record<string, string>
  body: unknown
  profileId?: string
  /** The conversation this request belongs to (the engine's conversationId:
   *  desktop chat, hosted session, sub-agent, pipeline/routine run). */
  sessionId?: string
  /** Identity of one Q&A turn — minted at turn start, unchanged across every
   *  re-issue inside the turn (HTTP retries AND engine continuations). */
  taskId?: string
  /** 0-based turn position in the conversation, derived from the transcript
   *  at turn start (restart-stable; a mid-turn steer text counts as its own
   *  input in the NEXT turn's index). */
  turnIndex?: number
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
