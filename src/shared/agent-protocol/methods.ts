/** Wire protocol constants. Single source of truth: service, renderer bridge
 *  and remote clients all import from here.
 *
 *  Method names that overlap with the Anywhere extension protocol
 *  (hello / session.create / agent.ask / agent.event / tool.call / approval.* /
 *  ask_user.*) intentionally keep the same spelling and semantics so a single
 *  client implementation can target both services (PLAN-0.3.5 M4). */

export const PROTOCOL_VERSION = 1

/** Client id declared during the hello handshake; the service routes
 *  extension-originated sessions based on this. */
export const EXTENSION_CLIENT_ID = 'anywhere-extension'

export const Methods = {
  hello: 'hello',
  sessionCreate: 'session.create',
  sessionList: 'session.list',
  sessionDelete: 'session.delete',
  sessionRename: 'session.rename',
  /** client → service: set a session's tool-approval level (授权) — the remote
   *  equivalent of the desktop composer's 授权 button. Writes
   *  `conversations.approval_mode`, so it takes effect on the next message. */
  sessionSetApprovalMode: 'session.setApprovalMode',
  /** client → service: the selectable LLM profiles and which one is active.
   *  `activeId` is the effective model for the requested scope: with a
   *  `sessionId`, the session's own choice (`conversations.profile_id` under
   *  its create-time pin); without it, the global default
   *  (`settings.activeProfileId`) that unpinned conversations follow. */
  modelList: 'model.list',
  /** client → service: switch a model. With a `sessionId` this pins THAT
   *  session's conversation to the profile (the remote equivalent of the
   *  desktop composer's per-conversation 模型下拉); without one it moves the
   *  global default, hot-swapping only the sessions that follow it. */
  modelSetActive: 'model.setActive',
  agentAsk: 'agent.ask',
  agentCancel: 'agent.cancel',
  agentHistory: 'agent.history',
  ping: 'ping',
  approvalRequest: 'approval.request',
  approvalResponse: 'approval.response',
  /** service → client: the ask_user tool asks the user a question (callId-correlated) */
  askUserRequest: 'ask_user.request',
  /** client → service: the answer to ask_user */
  askUserResponse: 'ask_user.response',
  /** service → client: request remote tool execution (browser.* via the extension; callId-correlated) */
  toolCall: 'tool.call',
  /** client → service: execution result for tool.call */
  toolResult: 'tool.result',
  /** client → service: user decision on continuing past the loop iteration limit */
  iterationLimitResponse: 'iteration_limit.response',
  // ── admin CRUD (M5) — names reserved now so they never re-number ──
  agentList: 'agent.list',
  agentCreate: 'agent.create',
  agentUpdate: 'agent.update',
  agentDelete: 'agent.delete',
  skillList: 'skill.list',
  skillCreate: 'skill.create',
  skillDelete: 'skill.delete',
  mcpList: 'mcp.list',
  mcpCreate: 'mcp.create',
  mcpUpdate: 'mcp.update',
  mcpDelete: 'mcp.delete',
  mcpRestart: 'mcp.restart',
  siteList: 'site.list',
  siteCreate: 'site.create',
  siteUpdate: 'site.update',
  siteDelete: 'site.delete',
  siteTest: 'site.test',
} as const

export type MethodName = (typeof Methods)[keyof typeof Methods]

/** WebSocket close codes (4400–4499 is the application-defined range).
 *  Clients act on these: `unauthorized` means re-pair, `replaced` means another
 *  connection claimed the same client id, `forbiddenOrigin` means the caller is
 *  a web page rather than an extension. */
export const CloseCodes = {
  unauthorized: 4401,
  forbiddenOrigin: 4403,
  replaced: 4409,
} as const

export const Notifications = {
  /** service → clients: streaming agent progress (see AgentEventData) */
  agentEvent: 'agent.event',
  /** service → clients: configuration hot-reload notice */
  configChanged: 'config.changed',
} as const
