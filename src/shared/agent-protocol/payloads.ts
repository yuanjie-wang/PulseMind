/** Payload types for the agent protocol. Transport-agnostic: the WS server
 *  serializes these as JSON-RPC params; the Electron renderer bridge passes
 *  the same shapes over ipcRenderer. */
import type { SandboxApprovalMode } from '../sandbox/policy'
import type { Plan } from '../types/plan'
import type { ExpertProfile } from '../types/expert'

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
  /** Resume this session: when storage still has it, the service rehydrates
   *  the engine from the conversation row instead of creating a fresh one. */
  sessionId?: string
  /** Explicit agent instance; omitted → resolved from clientId / site rules (M5). */
  agentId?: string
  /** Optional label shown in the session list. */
  title?: string
  /** Page the client is on at creation time (title seeds the session title). */
  pageContext?: PageContext
}

export interface SessionCreateResult {
  sessionId: string
  agentId: string
  /** True when an existing stored session was resumed rather than created. */
  resumed?: boolean
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
  /** Full system-prompt replacement for derived sessions. */
  systemPromptOverride?: string
  /** Tool allowlist for the session; omitted = every enabled tool. */
  allowedTools?: string[]
  /** Internal expert config pack pinned at creation (the assistants): composed
   *  into an ExpertRuntimeContext ONCE by session-manager, rides on top of the
   *  systemPromptOverride (identity over mechanics), and survives refreshes —
   *  DB-bound experts never apply to a session that carries one. */
  expertProfile?: ExpertProfile
  /** Per-session approval override for a session whose conversation cannot speak
   *  for itself (unattended runs); omitted = the conversation's own stored level
   *  (`conversations.approval_mode`), then the shared DEFAULT_APPROVAL_MODE. */
  approvalMode?: SandboxApprovalMode
  /** Per-session model override (a routine pinned to one profile); omitted =
   *  the active profile. Pinned for the session's life: a global model switch
   *  does not move it, and a deleted profile falls back to the active one. */
  profileId?: string
}

export interface SessionListResult {
  sessions: Array<{
    sessionId: string
    agentId: string
    title?: string
    updatedAt?: string
    /** The conversation's stored 授权 level, so a remote client's approval
     *  control shows the same value the desktop composer shows. */
    approvalMode?: SandboxApprovalMode
  }>
  /** The selectable models + the active one. Rides on this call because every
   *  panel snapshot already makes it: a client gets its picker without a second
   *  round trip, and it cannot show a session list from one moment next to a
   *  model list from another. */
  model?: ModelState
}

/** session.setApprovalMode — the remote 授权 button. Writes the conversation's
 *  stored level, so the engine picks it up on the session's next message. */
export interface SessionSetApprovalModeParams {
  sessionId: string
  mode: SandboxApprovalMode
}

// ── model.* — the remote 模型下拉 ─────────────────────────────────────

/** A selectable model, as a remote client may see it. Deliberately narrower
 *  than the stored profile: `apiKey` / `headers` stay in the main process, and
 *  so does `baseURL` (a gateway URL can carry a token in its query string).
 *  A client only draws a label, so a label is all it is given. */
export interface ModelOption {
  id: string
  name?: string
  /** API 规范（'anthropic' | 'openai'）—— 旧字段语义，回退标签还在用。 */
  provider?: string
  /** 所属供应商的显示名（两层模型配置的连接层）；分组/前缀用。 */
  providerName?: string
  model: string
}

/** The selectable models + the active one. `activeId` is the *effective* model
 *  for the requested scope: a session's own choice (`conversations.profile_id`,
 *  under its create-time pin) when a `sessionId` is in play, else the global
 *  default (`settings.activeProfileId`) that new/unpinned conversations follow. */
export interface ModelState {
  profiles: ModelOption[]
  activeId: string
}

/** How a profile is labelled — its name, else `provider:model`. Shared because
 *  two clients render this list (the desktop's picker and the extension panel's)
 *  and a fork would make the same profile read differently in each. */
export function modelLabel(option: ModelOption): string {
  return option.name || `${option.provider ?? ''}:${option.model}`
}

/** The tooltip label: 供应商前缀 + modelLabel. Menu items render modelLabel
 *  alone — the grouped header already names the provider, and a single
 *  provider has nothing to disambiguate — while hover (`title`) carries this
 *  full form, as does the collapsed button's tooltip in the extension panel. */
export function fullModelLabel(option: ModelOption): string {
  const base = modelLabel(option)
  return option.providerName ? `${option.providerName} · ${base}` : base
}

/** model.list — the state a client renders its picker from. */
export type ModelListResult = ModelState

export interface ModelSetActiveParams {
  profileId: string
  /** Present = set THIS session's model (the conversation's own `profile_id`
   *  column, under its create-time pin); absent = the global default
   *  (`settings.activeProfileId`) that unpinned conversations follow. */
  sessionId?: string
}

/** model.setActive result: the state *after* the write, so a caller reconciles
 *  against the service instead of trusting its own optimistic guess. */
export interface ModelSetActiveResult {
  ok: boolean
  model: ModelState
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

/** Tool summaries carried on `awaiting_approval` / `awaiting_user_input`
 *  status events so a remote client can render confirmation cards without
 *  holding engine internals. */
export interface StatusToolInfo {
  toolUseId: string
  name: string
  /** Short JSON preview of the call input (first ~200 chars). */
  detail?: string
  /** Full input, only for small interactive payloads (ask_user prompt/choices). */
  args?: unknown
}

// ── compaction ───────────────────────────────────────────────────────

/** One compaction pass over the outgoing API copy. Emitted by the engine when
 *  a request build actually changed the copy ('request'), when the post-turn
 *  prewarm ran ('post-turn' — the summary is warmed, the drop lands on the
 *  next request), on an explicit /compact ('manual') and on the model's own
 *  `context_compact` tool call ('tool' — same landing semantics as 'manual':
 *  the summary is warmed mid-task, the drop rides the next request build).
 *  `summary` rides only when the cached history summary changed, so the
 *  mirror's persisted copy stays fresh without re-shipping the text every
 *  request. */
export interface CompactionEvent {
  ts: number
  source: 'request' | 'post-turn' | 'manual' | 'tool'
  /** Pipeline layers that changed the copy, in order. */
  strategies: string[]
  /** Messages the copy shed (light + hard truncation; nano is 1:1). */
  droppedMessages: number
  /** Dropped-region user messages replayed verbatim into the copy. */
  replayedUserMessages: number
  tokensBefore: number
  tokensAfter: number
  /** The history-summary frontier: the id of the NEWEST message the summary
   *  text covers (the last dropped one). Historical field name — light drops
   *  holes (whole tool cycles), not a clean prefix, so "first kept message"
   *  was never a stable key; every consumer treats this as an opaque id. */
  summary?: { firstKeptId: string; text: string } | null
}

/** The status word plus the optional carriers each word needs downstream —
 *  shared by the live status event and the re-attach snapshot so the two cannot
 *  drift (an event spelling its own field list and a snapshot spelling a second
 *  one is how the retry count got dropped from both, user report 2026-09-24).
 *  `error`'s reason, `retrying`'s attempt/maxRetries/delayMs/message and
 *  `awaiting_extension`'s currentCount/limit ride only when the engine had
 *  them: an honest absence beats a fake zero. */
export type StatusSnapshot = { status: string; error?: string; attempt?: number; maxRetries?: number; delayMs?: number; message?: string; currentCount?: number; limit?: number }

/** Streaming progress events. One notification per event; ordering within a
 *  session is guaranteed per-connection. */
export type AgentEventData =
  | ({ type: 'status' } & StatusSnapshot & { toolUseId?: string; tools?: StatusToolInfo[] })
  /** Transport-level events for UI parity with the renderer engine (M1.5):
   *  full message list / coalesced streaming block snapshots. */
  | { type: 'messages'; messages: unknown[] }
  /** Incremental transport: items appended at fromIndex (full 'messages' event on truncation). */
  | { type: 'messages_append'; fromIndex: number; items: unknown[] }
  /** Replace existing messages by ID when their content changes without an append. */
  | { type: 'messages_update'; items: unknown[] }
  /** In-place tool_use block mutations (status/exitCode/output, and the spawn
   *  link — subConvId/planNodeId — which is written at dispatch time and has no
   *  other carrier) — diffed, only changed entries. */
  | { type: 'tool_status'; updates: Array<{ messageId: string; toolUseId: string; status?: string; exitCode?: number; output?: string; subConvId?: string; planNodeId?: string }> }
  /** In-place MESSAGE-level stat mutations, diffed for the same reason and with
   *  the same shape discipline as `tool_status`: the turn's wall clock is
   *  stamped onto the last assistant message when the turn ends, i.e. after
   *  that message was already appended, so a length-diffed transport would never
   *  deliver it — and the chat showed the answer's own LLM round instead of the
   *  task's duration (user feedback 2026-09-16). This supersedes the vestigial
   *  `usage` member, which had no emitter and could not address a message. */
  | { type: 'message_stats'; updates: Array<{ messageId: string; processingMs?: number; inputTokens?: number; outputTokens?: number; promptCacheHitTokens?: number }> }
  | { type: 'streaming_blocks'; blocks: unknown[] }
  | { type: 'token'; blockType: 'text' | 'thinking'; text: string }
  | { type: 'block_start'; blockType: 'text' | 'thinking' | 'tool_use'; toolName?: string }
  | { type: 'tool_input_preview'; toolUseId: string; partialJson: string }
  | { type: 'tool_start'; toolUseId: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean; exitCode?: number }
  | { type: 'plan_update'; plan: PlanSnapshot | null }
  | { type: 'spawn_progress'; message: string }
  /** The engine compacted the outgoing context copy (or prewarmed the summary
   *  for it). Carries its own numbers so a client can show what happened —
   *  compaction is otherwise invisible, which reads to the user as "the model
   *  suddenly got worse and nothing told me why". */
  | { type: 'compaction'; event: CompactionEvent }
  | { type: 'done'; stopReason: string }
  | { type: 'error'; message: string }

/** The wire's plan payload is the engine's own `Plan` (shared/types/plan), not
 *  a projection: it used to declare `nodes: [{ id, text, status }]` while the
 *  producer shipped `description` (+ dependsOn/assignee/msgId/…) behind a
 *  double cast, so any client implementing against the protocol read `text` as
 *  `undefined`. Declaring the alias makes the cast unnecessary on both sides —
 *  the declaration and the bytes can no longer drift. */
export type PlanSnapshot = Plan

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

/** kinds: 'write' (fs) · 'shell' (command exec) · 'browser_write' (page click/
 *  input/select) · 'page_exec' (arbitrary JS in the page context) · 'mcp'. */
export type ApprovalKind = 'write' | 'shell' | 'browser_write' | 'page_exec' | 'mcp'

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
  sessionId: string
  approved: boolean
}

// ── ping ─────────────────────────────────────────────────────────────

export interface PingResult {
  pong: true
  serviceTime: string
}
