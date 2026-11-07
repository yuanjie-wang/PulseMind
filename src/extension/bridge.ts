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
  /** The failing turn's reason, when `status` is 'error' and the worker still
   *  holds it — the same pair the event stream carries. A panel that attaches
   *  after the failure (worker restart, panel re-opened) has no other carrier
   *  and would show 未知错误 instead of the reason. */
  statusError?: string
  /** The retry carriers (2026-10-31): the live event stream folds them into
   *  the mirror, only the re-attach still-life lacked them — the banner hides
   *  its (n/max) rather than rendering `(/)` when they are absent. */
  attempt?: number
  maxRetries?: number
  delayMs?: number
  /** The re-attach still-life of the three folded states (2026-10-31): plan /
   *  file-change ledger / last compaction. Present only when the cold attach
   *  reached an `agent.snapshot`-aware service; an older desktop answers
   *  through the history fallback and these stay undefined. */
  plan?: unknown
  fileChanges?: unknown
  lastCompaction?: unknown
  sessions: SessionSummary[]
  /** 「已转出」空态（PLAN-extension-handoff）：本页签的会话已移交桌面端，面板
   *  显示横幅 + 「开始新对话」。页签导航后由 worker 清掉（state.ts），横幅自然消失。 */
  handedOff?: boolean
  /** The bound session's tool-approval level (授权), straight from the desktop. */
  approvalMode?: SandboxApprovalMode
  /** The selectable models + the active one (模型). `activeId` is the bound
   *  session's own model once a session exists (the conversation's
   *  `profile_id` choice, under its create-time pin); before that, the global
   *  default, overridden by a pre-session choice still waiting to be carried. */
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
  /** 模型: pin the tab session's conversation to a profile (per conversation,
   *  like 授权 — with no session yet the choice is carried once one exists). */
  | { type: 'panel/set-model'; profileId: string }
  /** Answer a held tool call. `callId` is the tool_use id the prompt carried. */
  | { type: 'panel/approval-response'; callId: string; approved: boolean }
  /** Answer the model's ask_user question. */
  | { type: 'panel/answer'; callId: string; response: string }
  /** Answer the loop-limit prompt (`awaiting_extension`): continue extends the
   *  engine's loop budget, stop ends the run. Session-scoped — no callId, the
   *  bridge injects the tab's session id. */
  | { type: 'panel/iteration-response'; approved: boolean }
  /** 转到桌面端继续（PLAN-extension-handoff）：本页签的会话移交桌面端（cookie
   *  一并搬运），成功后面板解绑进「已转出」空态。 */
  | { type: 'panel/handoff'; page: { url: string; title?: string } }

/** service worker → content script. */
export type PanelNotification =
  | { type: 'panel/snapshot'; payload: PanelSnapshot }
  | { type: 'panel/event'; sessionId: string; data: AgentEventData }
  | { type: 'panel/connection'; payload: ConnectionState }
  | { type: 'panel/sessions'; payload: SessionSummary[] }

/** service worker → content script: run one `page_*` tool in this tab
 *  (PLAN-browser-extension M2.3). Sent with chrome.tabs.sendMessage, whose
 *  async reply is the `PageToolOutcome`. */
export interface PageToolRequest {
  type: 'pulsemind/page-tool'
  tool: string
  args: Record<string, unknown>
}

export const PAGE_TOOL_MESSAGE_TYPE = 'pulsemind/page-tool'

/** content script → service worker: open the options page. `openOptionsPage`
 *  exists only in extension contexts — from a content script the property is
 *  simply ABSENT from its chrome.runtime binding (measured, Chromium 153), so
 *  a direct call throws a TypeError the panel would swallow as a silent no-op.
 *  The panel's 打开设置 button therefore routes through the worker here. */
export const OPEN_OPTIONS_MESSAGE_TYPE = 'pulsemind/open-options'

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
  'panel/iteration-response',
  'panel/handoff',
])

export function isPanelRequest(msg: unknown): msg is PanelRequest {
  return !!msg && typeof msg === 'object' && PANEL_REQUEST_TYPES.has(String((msg as { type?: unknown }).type))
}
