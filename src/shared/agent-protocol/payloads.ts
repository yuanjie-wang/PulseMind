/** Payload types for the agent protocol. Transport-agnostic: the WS server
 *  serializes these as JSON-RPC params; the Electron renderer bridge passes
 *  the same shapes over ipcRenderer. */

// ── hello ────────────────────────────────────────────────────────────

export interface HelloParams {
  clientId: string
  clientVersion: string
  protocolVersion: number
}

export interface HelloResult {
  protocolVersion: number
  serviceVersion: string
}

// ── session ──────────────────────────────────────────────────────────

export interface SessionCreateParams {
  /** Explicit agent instance; omitted → resolved from clientId / site rules (M5). */
  agentId?: string
  /** Optional label shown in the session list. */
  title?: string
}

export interface SessionCreateResult {
  sessionId: string
  agentId: string
}

/** Session creation options as passed by the local renderer over the Electron
 *  bridge: the WS client's [SessionCreateParams] plus the local working
 *  directory / project binding, and the per-session engine overrides that
 *  derived sessions (tool studio) pin for their whole lifetime. */
export interface AgentSessionCreateOptions {
  agentId?: string
  title?: string
  /** Owning client: 'local' (desktop UI) or a ws clientId. */
  clientId?: string
  projectId?: string
  workspaceDir?: string
  sandbox?: unknown
  /** Full system-prompt replacement for derived sessions. */
  systemPromptOverride?: string
  /** Tool allowlist for the session; omitted = every enabled tool. */
  allowedTools?: string[]
  /** Per-session approval override; omitted = sandbox policy, then the global toggle. */
  yoloMode?: boolean
}

export interface SessionListResult {
  sessions: Array<{
    sessionId: string
    agentId: string
    title?: string
    updatedAt?: string
  }>
}

// ── agent.ask / cancel / history ─────────────────────────────────────

export interface PageContext {
  url?: string
  title?: string
  /** Compact text DOM / page summary supplied by browser clients. */
  content?: string
}

export interface AgentAskParams {
  sessionId: string
  /** Plain user content. Rich input (files, images) rides in blocks (M-scope later). */
  content: string
  pageContext?: PageContext
}

export interface AgentCancelParams {
  sessionId: string
}

export interface AgentHistoryParams {
  sessionId: string
}

export interface AgentHistoryResult {
  /** Serialized message list, service-defined shape (conversation JSON). */
  messages: unknown[]
  agentId: string
}

// ── agent.event (notification) ───────────────────────────────────────

export interface AgentEventParams {
  sessionId: string
  data: AgentEventData
}

/** Streaming progress events. One notification per event; ordering within a
 *  session is guaranteed per-connection. */
export type AgentEventData =
  | { type: 'status'; status: string; attempt?: number; delayMs?: number; toolUseId?: string; error?: string }
  /** Transport-level events for UI parity with the renderer engine (M1.5):
   *  full message list / coalesced streaming block snapshots. */
  | { type: 'messages'; messages: unknown[] }
  /** Incremental transport: items appended at fromIndex (full 'messages' event on truncation). */
  | { type: 'messages_append'; fromIndex: number; items: unknown[] }
  /** In-place tool_use block mutations (status/exitCode/output) — diffed, only changed entries. */
  | { type: 'tool_status'; updates: Array<{ messageId: string; toolUseId: string; status?: string; exitCode?: number; output?: string }> }
  | { type: 'streaming_blocks'; blocks: unknown[] }
  | { type: 'token'; blockType: 'text' | 'thinking'; text: string }
  | { type: 'block_start'; blockType: 'text' | 'thinking' | 'tool_use'; toolName?: string }
  | { type: 'tool_input_preview'; toolUseId: string; partialJson: string }
  | { type: 'tool_start'; toolUseId: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean; exitCode?: number }
  | { type: 'plan_update'; plan: PlanSnapshot | null }
  | { type: 'spawn_progress'; message: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; promptCacheHitTokens?: number; processingMs?: number }
  | { type: 'done'; stopReason: string }
  | { type: 'error'; message: string }

export interface PlanSnapshot {
  objective: string
  mode: string
  steps: Array<{ text: string; state: 'pending' | 'done' | 'fail' }>
}

// ── hosted tools (service → client reverse RPC) ─────────────────────

export interface ToolCallParams {
  callId: string
  sessionId: string
  tool: string
  args: unknown
  timeoutMs?: number
}

export interface ToolCallResultParams {
  callId: string
  ok: boolean
  result?: unknown
  error?: string
}

// ── approvals / ask_user ─────────────────────────────────────────────

export type ApprovalKind = 'write' | 'shell' | 'browser_write' | 'mcp'

export interface ApprovalRequestParams {
  sessionId: string
  callId: string
  kind: ApprovalKind
  summary: string
  detail?: string
}

export interface ApprovalResponseParams {
  callId: string
  approved: boolean
}

export interface AskUserRequestParams {
  sessionId: string
  callId: string
  question: string
}

export interface AskUserResponseParams {
  callId: string
  response: string
}

export interface IterationLimitParams {
  sessionId: string
  loopCount: number
}

export interface IterationLimitResponseParams {
  approved: boolean
}

// ── ping ─────────────────────────────────────────────────────────────

export interface PingResult {
  pong: true
  serviceTime: string
}
