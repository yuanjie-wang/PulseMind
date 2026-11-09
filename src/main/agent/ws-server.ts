/**
 * Local agent service over WebSocket (PLAN-0.3.5 M2.1; browser-extension
 * protocol: PLAN-browser-extension M0).
 *
 * Loopback-only JSON-RPC 2.0 server exposing the main-hosted session manager
 * to remote clients (browser extension, web clients). Wire protocol: the
 * shared agent-protocol package (hello handshake → session.create → agent.ask
 * → agent.event notifications; ping heartbeat; token auth, ?token=<token>).
 *
 * M0 additions on top of the M2.1 surface:
 *   - reverse RPC: tool.call → client → tool.result (hostedToolProxy) and
 *     approval/ask_user/iteration_limit routing (hostedPromptRouter)
 *   - session resume / list / delete / rename + pageContext on create & ask
 *   - deterministic port scan (8765..8779) so the extension can discover us,
 *     GET /token pairing (extension origins only) and a browser-origin check
 *     at connect time (web pages are never allowed, token or not)
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { shortUuid } from '../utils/id'
import { WebSocketServer, WebSocket } from 'ws'
import {
  CloseCodes,
  ErrorCodes,
  Methods,
  Notifications,
  PROTOCOL_VERSION,
  makeError,
  makeResult,
  type AgentEventData,
  type ApprovalResponseParams,
  type AskUserResponseParams,
  type IterationLimitResponseParams,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type PageContext,
  type ToolCallResultParams,
} from '../../shared/agent-protocol'
import { agentSessionManager } from './session-manager'
import type { AgentServiceSessions } from './service-sessions'
import { agentClientRegistry, isHostedClientId, type ClientTransport } from './client-registry'
import { hostedToolProxy } from './hosted/proxy'
import { hostedPromptRouter } from './hosted/prompts'
import {
  adoptUnscopedConversations,
  claimLegacyScopeConversations,
  getConversationApprovalMode,
  getConversationOrigin,
  getConversationTitle,
  hydrateConversation,
  listConversationsByOrigin,
  releaseDeadScopeConversations,
  saveConversation,
  updateConversationTitle,
  updateConversationOrigin,
} from '../storage/conversation.db'
import { deleteConversationWithWorkspace } from '../storage/conversation-workspace'
import { installHostedPersistence, type HostedPersistenceDeps } from './hosted-persistence'
import { PANE_SESSION_PARTITION } from '../../shared/browser/pane'
import { handoffCookieDetails, sanitizeHandoffCookies } from './handoff-cookies'
import { ensureHostedConversationWorkspace } from '../storage/conversation-workspace'
import { SERVICE_DEFAULT_PORT } from '../service-config'
import { toSandboxApprovalMode, type SandboxApprovalMode } from '../../shared/sandbox/policy'

const SERVICE_VERSION = `0.4.0`

/** session.handoff 的回合边界守卫（PLAN-extension-handoff）：活跃态拒绝移交。
 *  与 mirror 的 isActiveStatus 同一名单——那边吃 AgentStatus 联合、这边只有
 *  协议层的 StatusSnapshot（status: string），点名比对比联合收窄更直白。 */
const HANDOFF_ACTIVE_STATUSES = new Set(['streaming', 'executing', 'retrying', 'awaiting_approval', 'awaiting_user_input', 'awaiting_extension'])

/** How far past the requested port the EADDRINUSE scan walks. The extension's
 *  discovery scans the identical range (8765..8779). */
const PORT_SCAN_ATTEMPTS = 15

/** The conversation-store slice the session surface needs. Injectable so
 *  protocol tests can run without better-sqlite3 (Electron-ABI native module,
 *  unloadable under plain Node — a known coverage gap). */
export interface AgentServiceConversations {
  /** Stored conversation for resume (tool_result content filled in), or null. */
  hydrate(id: string): { title: string; messages: unknown[]; historySummary?: string; historySummaryFrontier?: string } | null
  /** Rows for `session.list`. Carries the conversation's stored 授权 level so a
   *  remote client's approval control can show the same value the desktop
   *  composer shows (absent = never chosen). `tabKey` scopes to one client-side
   *  history scope (the extension's per-tab list); omitted = unscoped. */
  listByOrigin(origin: string, limit: number, tabKey?: string): Array<{ id: string; title: string; updatedAt: string; approvalMode?: SandboxApprovalMode }>
  /** Hand this origin's unscoped conversations to `tabKey` — the upgrade path
   *  for rows written before per-tab history existed (and any row the desktop
   *  side stamped). Optional so lightweight test stores need not implement it. */
  adoptUnscoped?(origin: string, tabKey: string): void
  /** Drop the tab_key of rows whose scope is not in `liveScopes` — the
   *  browser-restart path (review_20261104 中3): chrome.storage.session cleared,
   *  so every old stamp is dead and the row strands in every UI. Released rows
   *  become adoptable by the next tab. Optional like `adoptUnscoped`. */
  releaseDeadScopes?(origin: string, liveScopes: string[]): void
  /** Move pre-instance-id rows of the base origin onto this install's origin
   *  (2026-11-05). Chrome and 360 load the same extension binary, so before
   *  `instanceId` they shared one origin; history written under the bare
   *  `pulsemind-extension` origin must follow the install that opens the panel,
   *  or it is stranded in an origin no instance lists. `liveScopes` bounds what
   *  may be claimed: rows of ANOTHER browser's live tabs (or any scope this
   *  install does not hold live) stay put — a still-running old-version install
   *  must not have its current history stolen. Rows with dead scopes stay with
   *  the legacy origin (unreachable either way; the conservative trade-off is
   *  deliberate). Optional like the two scope hooks. */
  claimLegacyScopes?(fromOrigin: string, toOrigin: string, liveScopes: string[]): void
  origin(id: string): string | null
  /** The conversation's STORED 授权 level (undefined = never chosen / row
   *  gone) — `session.create` echoes it so a panel can seed its cache even
   *  while the fresh session is invisible to `session.list` (EXISTS(messages)):
   *  doCreateSession's last-used seed would otherwise run the engine at a
   *  level the panel cannot see (review_20261103 高3). */
  approvalMode(id: string): SandboxApprovalMode | undefined
  /** The stored title alone (null = row gone) — the hosted-transcript writer
   *  keeps a user rename across its turn-end rewrite (hosted-persistence.ts). */
  title(id: string): string | null
  /** Write a hosted session's transcript (2026-11-02): main-hosted sessions
   *  have no renderer to persist for them — see hosted-persistence.ts. */
  persist: HostedPersistenceDeps['save']
  /** May return a promise (the production impl deletes the minted workspace
   *  folder before the row); the delete handler awaits it when present. */
  remove(id: string): void | Promise<void>
  rename(id: string, title: string): void
  /** session.handoff（PLAN-extension-handoff）：origin 重戳为 'local'——写
   *  所有权移交桌面渲染端（hosted-persistence 的 isHostedClientId 门随之停写），
   *  桌面列表/搜索立即可见。Optional so lightweight test stores need not
   *  implement it. */
  stampOrigin?(id: string, origin: string): void
}

const storageConversations: AgentServiceConversations = {
  hydrate: (id) => hydrateConversation(id),
  listByOrigin: (origin, limit, tabKey) => listConversationsByOrigin(origin, limit, tabKey),
  adoptUnscoped: (origin, tabKey) => adoptUnscopedConversations(origin, tabKey),
  releaseDeadScopes: (origin, liveScopes) => releaseDeadScopeConversations(origin, liveScopes),
  claimLegacyScopes: (fromOrigin, toOrigin, liveScopes) => claimLegacyScopeConversations(fromOrigin, toOrigin, liveScopes),
  origin: (id) => getConversationOrigin(id),
  approvalMode: (id) => getConversationApprovalMode(id),
  title: (id) => getConversationTitle(id),
  persist: (conversation) => saveConversation(conversation),
  remove: (id) => deleteConversationWithWorkspace(id),
  rename: (id, title) => updateConversationTitle(id, title),
  stampOrigin: (id, origin) => updateConversationOrigin(id, origin),
}

export interface AgentServiceHandle {
  port: number
  token: string
  /** Connections that completed `hello` (clientId + session count) — the
   *  settings panel's 已连接的客户端. A socket that has not said hello yet
   *  (`clientId === 'unknown'`, sub-second) is not a client worth listing. */
  clients(): Array<{ clientId: string; sessions: number }>
  close(): Promise<void>
}

interface ClientConn {
  socket: WebSocket
  /** Protocol clientId, base form: capability gates read THIS (the hosted
   *  registry keys on the binary's identity, not the install's). */
  clientId: string
  /** Sanitized per-install suffix from hello (undefined = legacy client). */
  instanceId?: string
  /** Conversation namespace stamped on rows this connection creates. Same as
   *  `clientId` for legacy clients, `clientId:instanceId` otherwise — two
   *  installs of the same binary must not share one history. */
  origin: string
  /** `byClient` key: clientId plus instanceId, so installs that share a binary
   *  coexist (2026-11-05) while a reconnect of the SAME install still replaces
   *  its own ghost. */
  key: string
  /** Session ids this client created or addressed (event routing). */
  sessions: Set<string>
  /** Transports minted for in-flight asks — dropped together on disconnect. */
  transports: Set<ClientTransport>
  alive: boolean
}

/** Accept only the same charset the DB origin can carry. Anything else is
 *  treated as absent: a malformed suffix must degrade to legacy behaviour, not
 *  create an origin nobody else can ever name. */
function sanitizeInstanceId(raw: unknown): string | undefined {
  return typeof raw === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(raw) ? raw : undefined
}

function parseEnvelopes(raw: WebSocket.RawData): JsonRpcRequest[] {
  const text = raw.toString()
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return [{ jsonrpc: '2.0', method: '__parse_error__' }]
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Accept only well-formed page context; junk from a client must not reach the
 *  engine. Content (compact DOM) is rarely set at ask time — get_content is. */
function sanitizePageContext(raw: unknown): PageContext | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const p = raw as Record<string, unknown>
  const url = typeof p.url === 'string' ? p.url : undefined
  const title = typeof p.title === 'string' ? p.title : undefined
  const content = typeof p.content === 'string' ? p.content.slice(0, 20_000) : undefined
  if (!url && !title && !content) return undefined
  return { url, title, content }
}

function isLoopbackHost(hostHeader: string | undefined): boolean {
  const host = (hostHeader ?? '').split(':')[0].toLowerCase()
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]'
}

/** Browser-extension origins may pair and connect; web pages may not. An absent
 *  Origin means a non-browser client (CLI, tests) — allowed, token still gates. */
function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true
  return /^chrome-extension:\/\//i.test(origin) || /^moz-extension:\/\//i.test(origin)
}

export async function startAgentService(
  opts: {
    port?: number
    token?: string
    sessions?: AgentServiceSessions
    store?: AgentServiceConversations
    /** session.handoff 成功后的桌面广播（PLAN-extension-handoff）：窗口保障与
     *  webContents.send 都在注入方（electron 不进本模块——vitest 的 electron
     *  stub 撑不起窗口面）。缺席 = 不广播（测试）。 */
    broadcast?: (payload: { sessionId: string; title: string; url: string }) => void
  } = {},
): Promise<AgentServiceHandle> {
  const { readFileSync, writeFileSync, mkdirSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { DATA_DIR } = await import('../storage')

  // ── Token: single fact persisted on disk so desktop settings UI and manual
  // clients read the same value. Tests inject one instead. ──
  const tokenPath = join(DATA_DIR, 'service-token')
  let token: string
  if (opts.token) {
    token = opts.token
  } else {
    try {
      token = readFileSync(tokenPath, 'utf-8').trim()
    } catch { token = '' }
    if (!token) {
      token = randomUUID().replace(/-/g, '')
      mkdirSync(DATA_DIR, { recursive: true })
      writeFileSync(tokenPath, token, 'utf-8')
    }
  }

  const sessions: AgentServiceSessions = opts.sessions ?? agentSessionManager
  const store: AgentServiceConversations = opts.store ?? storageConversations

  const port = opts.port ?? SERVICE_DEFAULT_PORT
  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/token') {
      // Pairing endpoint: loopback Host + extension Origin only. A web page
      // must never read the token (its Origin fails here; DNS-rebinding
      // fails the Host check). No CORS headers on purpose.
      const ok = isLoopbackHost(req.headers.host) && isAllowedOrigin(req.headers.origin)
      if (!ok) {
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'forbidden' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ token }))
      return
    }
    // HTTP surface: liveness only (admin REST arrives with M5). The extension's
    // discovery probe matches on the service field.
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ service: 'pulsemind-agent', protocolVersion: PROTOCOL_VERSION }))
  })

  const wss = new WebSocketServer({ server: httpServer })
  const conns = new Set<ClientConn>()
  /** connection identity (clientId + instanceId) → current connection. A newer
   *  connection from the same INSTALL replaces — kicks — the old one (browser
   *  restart / duplicate content scripts); another install sharing the same
   *  binary id lives alongside (2026-11-05: Chrome and 360 otherwise kicked
   *  each other in an endless reconnect loop). */
  const byClient = new Map<string, ClientConn>()

  wss.on('connection', (socket, req: IncomingMessage) => {
    // Web pages never get in — even with a stolen token. Extensions and
    // non-browser clients pass (the token check below still applies).
    if (!isAllowedOrigin(req.headers.origin)) {
      socket.close(4403, 'browser origins are not allowed')
      return
    }
    // Token auth: ?token= must equal the service token.
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.searchParams.get('token') !== token) {
      socket.close(4401, 'unauthorized')
      return
    }

    const conn: ClientConn = {
      socket,
      clientId: 'unknown',
      origin: 'unknown',
      key: 'unknown',
      sessions: new Set(),
      transports: new Set(),
      alive: true,
    }
    conns.add(conn)

    const send = (res: JsonRpcResponse): void => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(res))
    }
    const notify = (method: string, params: unknown): void => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ jsonrpc: '2.0', method, params }))
    }
    // One transport per *connection*, not per ask: `clientId` is still
    // 'unknown' until `hello` arrives, so it is read through a getter.
    const transport: ClientTransport = {
      id: randomUUID(),
      get clientId() {
        return conn.clientId
      },
      sendToolCall: (p) => notify(Methods.toolCall, p),
      sendApprovalRequest: (p) => notify(Methods.approvalRequest, p),
      sendAskUserRequest: (p) => notify(Methods.askUserRequest, p),
    }
    conn.transports.add(transport)

    socket.on('pong', () => { conn.alive = true })

    socket.on('message', (raw) => {
      for (const msg of parseEnvelopes(raw)) {
        if (typeof msg.method !== 'string') {
          send(makeError(msg.id ?? null, ErrorCodes.invalidRequest, 'missing method'))
          continue
        }
        if (msg.method === '__parse_error__') {
          send(makeError(msg.id ?? null, ErrorCodes.parse, 'invalid JSON payload'))
          continue
        }
        const params = (msg.params ?? {}) as Record<string, unknown>
        switch (msg.method) {
          case Methods.hello: {
            const base = typeof params.clientId === 'string' && params.clientId ? params.clientId : 'anonymous'
            const instanceId = sanitizeInstanceId(params.instanceId)
            if (conn.key !== 'unknown' && byClient.get(conn.key) === conn) byClient.delete(conn.key)
            conn.clientId = base
            conn.instanceId = instanceId
            // The namespace split is what keeps two installs' histories apart;
            // the identity split is what keeps their connections apart. Both
            // come from the same hello field so they can never disagree.
            conn.origin = instanceId ? `${base}:${instanceId}` : base
            conn.key = `${base}\u0000${instanceId ?? ''}`
            // Same-INSTALL replacement: kick the ghost connection (M2.2).
            const prior = byClient.get(conn.key)
            if (prior && prior !== conn) {
              prior.socket.close(4409, 'replaced by a newer connection')
              conns.delete(prior)
            }
            byClient.set(conn.key, conn)
            if (params.protocolVersion !== PROTOCOL_VERSION) {
              send(makeError(msg.id ?? null, ErrorCodes.protocolVersionMismatch,
                `protocol version mismatch: client ${String(params.protocolVersion)}, service ${PROTOCOL_VERSION}`))
              // Close instead of leaving the socket half-alive: the client has
              // its answer, and a connection that can never speak the protocol
              // must not sit in `conns` (it would be kicked only by the NEXT
              // hello of the same install).
              socket.close(CloseCodes.protocolMismatch, 'protocol version mismatch')
              break
            }
            send(makeResult(msg.id ?? null, { protocolVersion: PROTOCOL_VERSION, serviceVersion: SERVICE_VERSION }))
            break
          }
          case Methods.sessionCreate: {
            const requestedId = typeof params.sessionId === 'string' && params.sessionId ? params.sessionId : undefined
            const agentId = typeof params.agentId === 'string' ? params.agentId : undefined
            const pageContext = sanitizePageContext(params.pageContext)
            const title = (typeof params.title === 'string' && params.title.trim()) || pageContext?.title || undefined
            // The client's history scope (the extension's per-tab list). Cheap
            // junk-proofing: a scope is an opaque token, nothing else.
            const tabKey =
              typeof params.tabKey === 'string' && params.tabKey && params.tabKey.length <= 128 ? params.tabKey : undefined
            void (async () => {
              let sessionId = requestedId
              let resumed = false
              if (sessionId && !sessions.hasSession(sessionId)) {
                const conv = store.hydrate(sessionId)
                if (conv) {
                  // Resume (M0.4): rehydrate the engine from the stored
                  // conversation so a desktop restart or a fresh SW keeps the
                  // thread going. Same fill-in of tool_result content the
                  // desktop "continue conversation" path uses.
                  await sessions.createSession(sessionId, { agentId, title: title || conv.title, clientId: conn.origin, tabKey })
                  await sessions.hydrate(
                    sessionId,
                    conv.messages,
                    conv.historySummary ? { text: conv.historySummary, firstKeptId: conv.historySummaryFrontier || '' } : null,
                  )
                  resumed = true
                } else {
                  sessionId = undefined // stale id → fall through to a fresh session
                }
              }
              if (!sessionId) {
                sessionId = `ws_${Date.now()}_${shortUuid(8)}`
                await sessions.createSession(sessionId, { agentId, title, clientId: conn.origin, tabKey })
              }
              conn.sessions.add(sessionId)
              // Bind here too (2026-10-10): agentAsk was the ONLY bind site, so
              // an MV3 service-worker restart reconnected via sessionCreate and
              // the panel showed connected while every page_* call failed with
              // "当前会话没有连接的浏览器客户端" — the drop() of the dead socket had
              // unbound the session, and nothing re-bound until the next ask.
              // Answer relays (approval/ask_user) don't bind either, so a parked
              // session resumed mid-prompt stayed page-tool-less for its whole
              // continuation. Hosted clients only: the registry's isHostedCapable
              // gate keeps page tools extension-owned.
              if (isHostedClientId(conn.clientId)) agentClientRegistry.bind(sessionId, transport)
              // The seeded 授权 rides the answer (review_20261103 高3): a fresh
              // normal session was just seeded with the global last-used level,
              // and neither session.list (EXISTS(messages)) nor a cold snapshot
              // (the bridge already holds a mirror) will surface it. Best-effort
              // like every column read — a storage failure must not cost the
              // client its create answer.
              let approvalMode: SandboxApprovalMode | undefined
              try { approvalMode = store.approvalMode(sessionId) } catch { /* best effort */ }
              send(makeResult(msg.id ?? null, { sessionId, agentId: agentId ?? 'default', resumed, approvalMode }))
            })().catch((err) => send(makeError(msg.id ?? null, ErrorCodes.internal, errorMessage(err))))
            break
          }
          case Methods.sessionList: {
            const rawLimit = typeof params.limit === 'number' ? params.limit : 50
            const limit = Math.min(Math.max(Math.floor(rawLimit), 1), 200)
            const tabKey =
              typeof params.tabKey === 'string' && params.tabKey && params.tabKey.length <= 128 ? params.tabKey : undefined
            // The extension's live scope set (review_20261104 中3): scopes from
            // previous browser sessions are dead — release their stamps BEFORE
            // the adoption below so the released rows land in this very list.
            const liveScopes = Array.isArray(params.liveScopes)
              ? params.liveScopes.filter((s): s is string => typeof s === 'string' && s.length > 0 && s.length <= 128).slice(0, 256)
              : []
            if (tabKey && liveScopes.length > 0) {
              try {
                store.releaseDeadScopes?.(conn.origin, liveScopes)
              } catch {
                /* best effort */
              }
            }
            // Pre-instance-id rows sit under the bare client id: an install
            // that now has its own origin takes them along — otherwise its
            // upgrade would show an empty 历史会话 while the old rows stay in a
            // namespace nothing lists (2026-11-05). Live other-install scopes
            // are NOT claimable (see claimLegacyScopes).
            if (conn.instanceId && tabKey) {
              try {
                store.claimLegacyScopes?.(conn.clientId, conn.origin, liveScopes)
              } catch {
                /* best effort */
              }
            }
            // Rows stamped before the column existed (and every row the desktop
            // side stamped with an extension origin) carry no scope. Hand them to
            // this tab on first sight instead of hiding the user's history.
            if (tabKey) {
              try { store.adoptUnscoped?.(conn.origin, tabKey) } catch { /* best effort */ }
            }
            const rows = store.listByOrigin(conn.origin, limit, tabKey)
            // The conversation store's rows are `{ id, title, updatedAt, … }`;
            // the protocol's list items are `{ sessionId, … }` like every other
            // session.* payload. Shipping the raw row made every panel row's
            // `sessionId` undefined: the 历史会话 menu rendered titles but no row
            // could be resumed (clicking one unbound the tab and answered an
            // empty snapshot) and `currentId` never matched (2026-11-02).
            const listed = rows.map((r) => ({
              sessionId: r.id,
              title: r.title,
              updatedAt: r.updatedAt,
              approvalMode: r.approvalMode,
            }))
            // The model state rides along: every panel snapshot calls this
            // anyway, so the picker's inventory costs no extra round trip. A
            // failure to read settings must not cost the caller the list it
            // actually asked for.
            void sessions
              .modelState()
              .catch(() => undefined)
              .then((model) => send(makeResult(msg.id ?? null, { sessions: listed, model })))
            break
          }
          case Methods.modelList: {
            // With a sessionId the active id is THAT session's effective model
            // (its conversation's own choice under the create-time pin);
            // without one, the global default.
            const sessionId = typeof params.sessionId === 'string' && params.sessionId ? params.sessionId : undefined
            void sessions
              .modelState(sessionId)
              .then((model) => send(makeResult(msg.id ?? null, model)))
              .catch((err) => send(makeError(msg.id ?? null, ErrorCodes.internal, errorMessage(err))))
            break
          }
          case Methods.modelSetActive: {
            // With a sessionId this pins THAT conversation's model (its own
            // `conversations.profile_id`); without one it moves the global
            // default. Either way the request is not scoped to the caller's
            // origins — any paired client may switch, like 授权.
            const profileId = String(params.profileId ?? '')
            if (!profileId) {
              send(makeError(msg.id ?? null, ErrorCodes.invalidParams, 'profileId is required'))
              break
            }
            const sessionId = typeof params.sessionId === 'string' && params.sessionId ? params.sessionId : undefined
            const applied = sessionId
              ? sessions.setSessionProfile(sessionId, profileId)
              : sessions.setActiveProfile(profileId)
            void applied
              .then((model) => send(makeResult(msg.id ?? null, { ok: true, model })))
              .catch((err) => send(makeError(msg.id ?? null, ErrorCodes.invalidParams, errorMessage(err))))
            break
          }
          case Methods.sessionDelete: {
            const sessionId = String(params.sessionId ?? '')
            void (async () => {
              if (!sessionId) throw new Error('sessionId is required')
              const origin = store.origin(sessionId)
              if (origin && origin !== conn.origin) {
                send(makeError(msg.id ?? null, ErrorCodes.forbidden, 'not your session'))
                return
              }
              if (sessions.hasSession(sessionId)) await sessions.engineCall(sessionId, 'dispose').catch(() => {})
              await store.remove(sessionId)
              conn.sessions.delete(sessionId)
              send(makeResult(msg.id ?? null, { ok: true }))
            })().catch((err) => send(makeError(msg.id ?? null, ErrorCodes.internal, errorMessage(err))))
            break
          }
          case Methods.sessionRename: {
            const sessionId = String(params.sessionId ?? '')
            const title = String(params.title ?? '').trim()
            if (!sessionId || !title) {
              send(makeError(msg.id ?? null, ErrorCodes.invalidParams, 'sessionId and title are required'))
              break
            }
            const origin = store.origin(sessionId)
            if (origin && origin !== conn.origin) {
              send(makeError(msg.id ?? null, ErrorCodes.forbidden, 'not your session'))
              break
            }
            store.rename(sessionId, title)
            send(makeResult(msg.id ?? null, { ok: true }))
            break
          }
          case Methods.sessionSetApprovalMode: {
            // The remote 授权 button. Same field the desktop composer writes
            // (`conversations.approval_mode`), so it is not gated on origins any
            // more than the model switch is — and the reply carries the level
            // *in force* afterwards, which the panel echoes instead of assuming
            // its click took (a pinned unattended run keeps its own level).
            const sessionId = String(params.sessionId ?? '')
            const mode = toSandboxApprovalMode(params.mode)
            if (!sessionId || !mode) {
              send(makeError(msg.id ?? null, ErrorCodes.invalidParams, 'sessionId and a valid mode are required'))
              break
            }
            void sessions
              .setApprovalMode(sessionId, mode)
              .then((applied) => send(makeResult(msg.id ?? null, { ok: true, mode: applied })))
              .catch((err) => send(makeError(msg.id ?? null, ErrorCodes.internal, errorMessage(err))))
            break
          }
          case Methods.agentAsk: {
            const sessionId = String(params.sessionId ?? '')
            const content = String(params.content ?? '')
            const pageContext = sanitizePageContext(params.pageContext)
            if (!sessionId) {
              send(makeError(msg.id ?? null, ErrorCodes.invalidParams, 'sessionId is required'))
              break
            }
            conn.sessions.add(sessionId)
            // Bound to the connection, not to this ask: the engine parks on the
            // client (awaiting_approval / awaiting_user_input) and this RPC
            // resolves long before the prompt is answered — an ask-scoped
            // unbind would cut the transport seconds too early (see
            // client-registry.ts).
            agentClientRegistry.bind(sessionId, transport)
            sessions.ask(sessionId, content, pageContext)
              .then(() => send(makeResult(msg.id ?? null, { accepted: true, status: 'completed' })))
              .catch((err) => {
                const message = errorMessage(err)
                const code = message.startsWith('session not found') ? ErrorCodes.sessionNotFound : ErrorCodes.internal
                send(makeError(msg.id ?? null, code, message))
              })
            break
          }
          case Methods.agentCancel: {
            sessions.cancel(String(params.sessionId ?? ''))
            send(makeResult(msg.id ?? null, { canceled: true }))
            break
          }
          case Methods.agentHistory: {
            void sessions.history(String(params.sessionId ?? ''))
              .then((r) => send(makeResult(msg.id ?? null, r)))
              .catch((err) => send(makeError(msg.id ?? null, ErrorCodes.sessionNotFound, errorMessage(err))))
            break
          }
          case Methods.agentSnapshot: {
            // The re-attach still-life (2026-10-31): everything the live event
            // stream would have folded by now. A session the service does not
            // hold answers sessionNotFound — the caller falls back to history.
            void sessions.snapshot(String(params.sessionId ?? ''))
              .then((r) => {
                if (!r) return send(makeError(msg.id ?? null, ErrorCodes.sessionNotFound, 'session not found'))
                send(makeResult(msg.id ?? null, r))
              })
              .catch((err) => send(makeError(msg.id ?? null, ErrorCodes.sessionNotFound, errorMessage(err))))
            break
          }
          case Methods.toolResult: {
            hostedToolProxy.handleResult(params as unknown as ToolCallResultParams)
            break
          }
          case Methods.approvalResponse: {
            // Reply only to real requests (id-carrying frames): the extension's
            // panel sends these as requests so an unknown callId (server-side
            // timeout already rejected it) reaches the button as an error;
            // notification senders (Anywhere compat) get no reply, as before.
            const handled = hostedPromptRouter.handleApprovalResponse(params as unknown as ApprovalResponseParams)
            if (msg.id !== undefined && msg.id !== null) {
              if (handled) send(makeResult(msg.id, { ok: true }))
              else send(makeError(msg.id, ErrorCodes.invalidParams, `unknown callId: ${String((params as { callId?: unknown }).callId)}`))
            }
            break
          }
          case Methods.askUserResponse: {
            const handled = hostedPromptRouter.handleAskUserResponse(params as unknown as AskUserResponseParams)
            if (msg.id !== undefined && msg.id !== null) {
              if (handled) send(makeResult(msg.id, { ok: true }))
              else send(makeError(msg.id, ErrorCodes.invalidParams, `unknown callId: ${String((params as { callId?: unknown }).callId)}`))
            }
            break
          }
          case Methods.iterationLimitResponse: {
            // The status event is the decision's only feedback channel, so the
            // reply is just delivery confirmation: a session that is already
            // gone must error here, or the panel's loop-limit card would sit
            // there forever with a dead 继续/停止 pair.
            const itSessionId = String(params.sessionId ?? '')
            const sessionLive = itSessionId !== '' && sessions.hasSession(itSessionId)
            if (sessionLive) hostedPromptRouter.handleIterationLimit(params as unknown as IterationLimitResponseParams)
            if (msg.id !== undefined && msg.id !== null) {
              if (sessionLive) send(makeResult(msg.id, { ok: true }))
              else send(makeError(msg.id, ErrorCodes.sessionNotFound, `session not found: ${itSessionId}`))
            }
            break
          }
          case Methods.sessionHandoff: {
            // PLAN-extension-handoff：换客户端驱动同一个会话。引擎本就在主进程
            // （扩展只是 ws 远程客户端），移交 = ① 校验回合边界 ② cookie 落
            // persist:pane ③ origin 重戳 'local'（写所有权移交桌面）④ 双向解绑
            // ⑤ 广播 CONVERSATION_HANDOFF。单向：v1 不做桌面转回扩展。
            const sessionId = String(params.sessionId ?? '')
            const page = sanitizePageContext(params.page)
            const cookies = sanitizeHandoffCookies(params.cookies)
            void (async () => {
              if (!sessionId) throw Object.assign(new Error('sessionId is required'), { code: ErrorCodes.invalidParams })
              const origin = store.origin(sessionId)
              if (!origin) throw Object.assign(new Error('会话不存在'), { code: ErrorCodes.sessionNotFound })
              if (origin === 'local') throw Object.assign(new Error('该会话已在桌面端'), { code: ErrorCodes.invalidParams })
              if (!isHostedClientId(origin)) throw Object.assign(new Error('不是扩展端的会话'), { code: ErrorCodes.forbidden })
              // 回合边界守卫：活跃态（流式中 / 待审批 / 待回答 / 排队）一律拒绝——
              // 审批卡孤儿化比等一拍更贵。引擎已死（snapshot null）反而无事可守，
              // 放行：转过去等于续聊一条静默会话。
              const snap = await sessions.snapshot(sessionId).catch(() => null)
              if (snap?.status && HANDOFF_ACTIVE_STATUSES.has(snap.status.status)) {
                throw Object.assign(new Error('当前回合仍在进行，请等它结束或先停止再转出'), { code: ErrorCodes.invalidParams })
              }
              // ② Cookie 写入持久分区（persist:pane，pane.ts 的常量是唯一真源）。
              // electron 动态导入：本模块不顶层依赖 electron（vitest stub 撑不起
              // session API）；cookie 采集失败在扩展侧本就可选，这里的失败也如实
              // 报错——静默丢登录态比报错更难排查。
              if (cookies.length > 0 && page?.url) {
                const { session } = await import('electron')
                const pane = session.fromPartition(PANE_SESSION_PARTITION)
                for (const cookie of cookies) {
                  await pane.cookies.set(handoffCookieDetails(page.url, cookie))
                }
              }
              // ③ origin 重戳：桌面列表/搜索立即可见（hostedOriginExclusion 不再
              //   命中），hosted-persistence 的 isHostedClientId 门自动停写——写
              //   所有权干净移交桌面渲染端自己的 10s 保存管线，无双写窗口。
              store.stampOrigin?.(sessionId, 'local')
              // ③' 工作区修复（user 2026-11-08 实机反馈「工作区不对」）：hosted
              //    会话的 workspace 兜底是全局根且被持久化——重铸会话独立目录；
              //    活引擎经 engineCall 就地修补 sandbox ctx，引擎已死则行级修复
              //    （桌面下次 createSession 的 isLocalUiSession 路径读到新值）。
              try {
                if (sessions.hasSession(sessionId)) await sessions.engineCall(sessionId, 'ensureConversationWorkspace', [])
                else await ensureHostedConversationWorkspace(sessionId)
              } catch { /* 工作区修复失败不挡移交——诚实缺口，桌面端首回合仍可自愈 */ }
              // ④ 双向解绑：事件停止推给扩展 + registry 释放反向通道。
              conn.sessions.delete(sessionId)
              agentClientRegistry.unbindSession(sessionId)
              // ⑤ 广播（窗口保障在注入方）。
              opts.broadcast?.({ sessionId, title: store.title(sessionId) ?? page?.title ?? '', url: page?.url ?? '' })
              send(makeResult(msg.id ?? null, { ok: true }))
            })().catch((err) => {
              const code = (err as { code?: number }).code
              send(makeError(msg.id ?? null, typeof code === 'number' ? code : ErrorCodes.internal, errorMessage(err)))
            })
            break
          }
          case Methods.ping: {
            send(makeResult(msg.id ?? null, { pong: true, serviceTime: new Date().toISOString() }))
            break
          }
          default:
            send(makeError(msg.id ?? null, ErrorCodes.methodNotFound, `unknown method: ${msg.method}`))
        }
      }
    })

    const drop = (): void => {
      conns.delete(conn)
      if (byClient.get(conn.key) === conn) byClient.delete(conn.key)
      // Settle everything this connection owed: in-flight tool calls reject,
      // pending confirmations are rejected/answered per timeout semantics.
      for (const transport of conn.transports) {
        agentClientRegistry.unbindTransport(transport)
        hostedToolProxy.dropTransport(transport)
        hostedPromptRouter.dropTransport(transport)
      }
      conn.transports.clear()
    }
    socket.on('close', drop)
    socket.on('error', drop)
  })

  // ── Heartbeat: terminate half-open connections ──
  const heartbeat = setInterval(() => {
    for (const conn of conns) {
      if (!conn.alive) { conn.socket.terminate(); conns.delete(conn); if (byClient.get(conn.key) === conn) byClient.delete(conn.key); continue }
      conn.alive = false
      conn.socket.ping()
    }
  }, 30_000)

  // ── Session events → subscribed clients ──
  const unsubEvents = sessions.onEvent((sessionId, data: AgentEventData) => {
    let payload: string
    try {
      payload = JSON.stringify({ jsonrpc: '2.0', method: Notifications.agentEvent, params: { sessionId, data } })
    } catch (err) {
      // One unserializable event must not kill the engine's notify chain — the
      // caller (session-manager emit) isolates sinks, but the throw would
      // otherwise land here first and abort every sink after this one.
      console.warn(`[AgentWS] event serialize failed (${sessionId}):`, err)
      return
    }
    for (const conn of conns) {
      if (conn.sessions.has(sessionId) && conn.socket.readyState === WebSocket.OPEN) {
        // A socket can close between the readyState check and the send; ws then
        // throws synchronously (or emits a session-killing 'error'). Drop the
        // event for that client only — the poll/re-subscribe path heals it.
        try { conn.socket.send(payload) } catch { /* client vanishing mid-send */ }
      }
    }
  })

  hostedPromptRouter.attach(sessions)

  // Hosted transcripts persist at turn end (2026-11-02): the extension's
  // sessions have no renderer to save for them, so without this every
  // extension conversation stayed a message-less stub the 历史会话 menu could
  // not list (session.list's EXISTS(messages)) and a desktop restart lost.
  // Runs on the same event sink chain; its own failures are caught inside.
  const unsubHostedPersistence = installHostedPersistence({
    // An arrow, not the method reference `sessions.onEvent`: detached, its
    // `this` is gone and the real manager's eventSinks read throws.
    onEvent: (sink) => sessions.onEvent(sink),
    snapshot: (id) => sessions.snapshot(id),
    origin: store.origin,
    title: store.title,
    // The engine's summary cache rides the turn-end save (review_20261103
    // 中2): the upsert writes history_summary unconditionally, so a save
    // without it NULLed the column every turn and compacted sessions paid a
    // fresh compaction LLM call after every restart.
    historySummary: async (id) => {
      try {
        return ((await sessions.engineCall(id, 'getHistorySummary')) as { text: string; firstKeptId?: string } | null) ?? null
      } catch {
        return null // session gone / engine closed — save summary-less
      }
    },
    save: store.persist,
  })

  // ── Listen (loopback only) with a deterministic EADDRINUSE scan: the
  // extension discovers us by probing the same range, so a random port from
  // listen(0) would be unfindable. port 0 (tests) attempts once.
  // NOTE: `ws` re-emits the http server's 'error' on the WebSocketServer, so
  // BOTH emitters need listeners during the scan or a failed attempt crashes
  // the process (the crash also strands the awaiting scan → hang). ──
  const maxAttempts = port === 0 ? 1 : PORT_SCAN_ATTEMPTS
  // Holder object on purpose: a bare `let` gets control-flow-narrowed to null
  // inside the loop (the assignment happens in a callback TS cannot see).
  const bindState: { failure: NodeJS.ErrnoException | null } = { failure: null }
  const onBindError = (err: NodeJS.ErrnoException): void => { bindState.failure = err }
  /** Indirect read: TS flow analysis would otherwise narrow the property to
   *  `null` and call the failure branch `never`. */
  const failureOf = (): NodeJS.ErrnoException | null => bindState.failure
  httpServer.on('error', onBindError)
  const swallowWsError = (): void => { /* mirrored from httpServer via onBindError */ }
  wss.on('error', swallowWsError)

  let boundPort: number | null = null
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const candidate = port + attempt
    bindState.failure = null
    await new Promise<void>((resolve) => {
      // Both outcomes resolve; failure is recorded by onBindError below.
      const onListening = (): void => { cleanup(); resolve() }
      const onError = (): void => { cleanup(); resolve() }
      const cleanup = (): void => {
        httpServer.off('listening', onListening)
        httpServer.off('error', onError)
      }
      httpServer.once('listening', onListening)
      httpServer.once('error', onError)
      httpServer.listen(candidate, '127.0.0.1')
    })
    const failure = failureOf()
    if (!failure) { boundPort = candidate; break }
    if (failure.code !== 'EADDRINUSE' || attempt === maxAttempts - 1) {
      wss.off('error', swallowWsError)
      httpServer.off('error', onBindError)
      throw failure
    }
  }
  httpServer.off('error', onBindError)
  wss.off('error', swallowWsError)
  // Runtime errors: log instead of the default crash-the-process behavior.
  httpServer.on('error', (err) => console.error('[AgentService] http server error:', err))
  wss.on('error', (err) => console.error('[AgentService] ws server error:', err))

  const address = httpServer.address()
  const finalPort = typeof address === 'object' && address ? address.port : (boundPort ?? port)

  console.log(`[AgentService] listening on ws://127.0.0.1:${finalPort} (token in ${'~/.pulsemind/service-token'})`)

  return {
    port: finalPort,
    token,
    clients: () =>
      [...conns.values()]
        .filter((conn) => conn.clientId !== 'unknown')
        // The ORIGIN, not the base id: two installs of the same extension
        // binary are two clients and must be distinguishable in 已连接的客户端
        // (legacy clients have origin === clientId, unchanged).
        .map((conn) => ({ clientId: conn.origin, sessions: conn.sessions.size })),
    close: async () => {
      clearInterval(heartbeat)
      unsubEvents()
      unsubHostedPersistence()
      hostedPromptRouter.detach()
      for (const conn of conns) conn.socket.terminate()
      wss.close()
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    },
  }
}
