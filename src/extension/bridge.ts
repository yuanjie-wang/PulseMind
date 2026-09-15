/** Extension-internal message contract (PLAN-browser-extension §3.6).
 *
 * Three contexts talk to each other:
 *   content script (panel UI)  ⇄  service worker (protocol client)  ⇄  desktop service (WebSocket)
 *
 * The wire protocol to the desktop lives in `src/shared/agent-protocol`; this
 * file is only the chrome.runtime channel in between, so both sides can share
 * one typed definition instead of string literals. */

import type { AgentEventData, PageContext, ModelState } from '../shared/agent-protocol'
import type { SandboxApprovalMode } from '../shared/sandbox/policy'

/** Connection state as shown in the panel header. */
export interface ConnectionState {
  state: 'connecting' | 'open' | 'closed'
  connected: boolean
  reason?: string
  serviceUrl?: string
}

export interface SessionSummary {
  sessionId: string
  title?: string
  updatedAt?: string
  /** The conversation's stored 授权 level (from `session.list`). */
  approvalMode?: SandboxApprovalMode
}

/** Everything a freshly mounted panel needs to render itself. */
export interface PanelSnapshot {
  /** The session bound to this tab, if one exists yet. */
  sessionId: string | null
  connection: ConnectionState
  /** Whether the panel was left open on this tab (survives page reloads). */
  panelOpen: boolean
  /** Message history for [sessionId] (empty when there is none yet). */
  messages: unknown[]
  streamingBlocks: unknown[]
  status: string
  sessions: SessionSummary[]
  /** The bound session's tool-approval level (授权), straight from the desktop. */
  approvalMode?: SandboxApprovalMode
  /** The selectable models + the active one (模型). Global: the desktop's own
   *  picker switches the same setting, so this is not per session. */
  model?: ModelState
}

/** content script → service worker. */
export type PanelRequest =
  | { type: 'panel/attach' }
  | { type: 'panel/ask'; content: string; pageContext?: PageContext }
  | { type: 'panel/cancel' }
  | { type: 'panel/new-session' }
  | { type: 'panel/list-sessions' }
  | { type: 'panel/resume-session'; sessionId: string }
  | { type: 'panel/delete-session'; sessionId: string }
  | { type: 'panel/rename-session'; sessionId: string; title: string }
  | { type: 'panel/set-open'; open: boolean }
  /** 授权按钮: set the conversation's tool-approval level. */
  | { type: 'panel/set-approval'; mode: SandboxApprovalMode }
  /** 模型: switch the active LLM profile (global, like the desktop's picker). */
  | { type: 'panel/set-model'; profileId: string }
  /** Answer a held tool call. `callId` is the tool_use id the prompt carried. */
  | { type: 'panel/approval-response'; callId: string; approved: boolean }
  /** Answer the model's ask_user question. */
  | { type: 'panel/answer'; callId: string; response: string }

/** service worker → content script. */
export type PanelNotification =
  | { type: 'panel/snapshot'; payload: PanelSnapshot }
  | { type: 'panel/event'; sessionId: string; data: AgentEventData }
  | { type: 'panel/connection'; payload: ConnectionState }
  | { type: 'panel/sessions'; payload: SessionSummary[] }
  /** The active model changed (any tab's picker, or the desktop's own). The
   *  switch is global, so every open panel is told, not just the one that
   *  clicked — otherwise the other tabs keep showing the previous model. */
  | { type: 'panel/model'; payload: ModelState }

/** service worker → content script: run one `page_*` tool in this tab
 *  (PLAN-browser-extension M2.3). Sent with chrome.tabs.sendMessage, whose
 *  async reply is the `PageToolOutcome`. */
export interface PageToolRequest {
  type: 'pulsemind/page-tool'
  tool: string
  args: Record<string, unknown>
}

export const PAGE_TOOL_MESSAGE_TYPE = 'pulsemind/page-tool'

/** The content script's answer to a PageToolRequest. */
export interface PageToolOutcome {
  ok: boolean
  result?: string
  error?: string
  /** Set when the failure looks like a page CSP eval refusal, so the worker
   *  can retry the call through chrome.debugger instead of giving up. */
  cspEvalBlocked?: boolean
}

/** Distinguishes a page-tool request from a panel notification on the same
 *  chrome.runtime channel. `key in msg` rather than truthiness: the tool name
 *  is always present, and an empty one is still a (failing) request. */
export function isPageToolRequest(msg: unknown): msg is PageToolRequest {
  if (!msg || typeof msg !== 'object') return false
  const m = msg as Partial<PageToolRequest>
  return m.type === PAGE_TOOL_MESSAGE_TYPE && typeof m.tool === 'string'
}

/** Response of every PanelRequest (sendMessage's async reply). */
export interface PanelResponse<T = unknown> {
  ok: boolean
  error?: string
  /** Present on attach and on requests that (re)bind the tab's session. */
  snapshot?: PanelSnapshot
  data?: T
}

export const PANEL_REQUEST_TYPES: ReadonlySet<string> = new Set<PanelRequest['type']>([
  'panel/attach',
  'panel/ask',
  'panel/cancel',
  'panel/new-session',
  'panel/list-sessions',
  'panel/resume-session',
  'panel/delete-session',
  'panel/rename-session',
  'panel/set-open',
  'panel/set-approval',
  'panel/set-model',
  'panel/approval-response',
  'panel/answer',
])

export function isPanelRequest(msg: unknown): msg is PanelRequest {
  return !!msg && typeof msg === 'object' && PANEL_REQUEST_TYPES.has(String((msg as { type?: unknown }).type))
}
