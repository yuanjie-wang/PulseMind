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
import { agentClientRegistry, type ClientTransport } from './client-registry'
import { hostedToolProxy } from './hosted/proxy'
import { hostedPromptRouter } from './hosted/prompts'
import {
  deleteConversation,
  getConversationOrigin,
  hydrateConversation,
  listConversationsByOrigin,
  updateConversationTitle,
} from '../storage/conversation.db'
import { SERVICE_DEFAULT_PORT } from '../service-config'

const SERVICE_VERSION = `0.3.5`
/** How far past the requested port the EADDRINUSE scan walks. The extension's
 *  discovery scans the identical range (8765..8779). */
const PORT_SCAN_ATTEMPTS = 15

/** The conversation-store slice the session surface needs. Injectable so
 *  protocol tests can run without better-sqlite3 (Electron-ABI native module,
 *  unloadable under plain Node — a known coverage gap). */
export interface AgentServiceConversations {
  /** Stored conversation for resume (tool_result content filled in), or null. */
  hydrate(id: string): { title: string; messages: unknown[]; historySummary?: string; historySummaryFrontier?: string } | null
  listByOrigin(origin: string, limit: number): Array<{ id: string; title: string; updatedAt: string }>
  origin(id: string): string | null
  remove(id: string): void
  rename(id: string, title: string): void
}

const storageConversations: AgentServiceConversations = {
  hydrate: (id) => hydrateConversation(id),
  listByOrigin: (origin, limit) => listConversationsByOrigin(origin, limit),
  origin: (id) => getConversationOrigin(id),
  remove: (id) => deleteConversation(id),
  rename: (id, title) => updateConversationTitle(id, title),
}

export interface AgentServiceHandle {
  port: number
  token: string
  close(): Promise<void>
}

interface ClientConn {
  socket: WebSocket
  clientId: string
  /** Session ids this client created or addressed (event routing). */
  sessions: Set<string>
  /** Transports minted for in-flight asks — dropped together on disconnect. */
  transports: Set<ClientTransport>
  alive: boolean
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
  opts: { port?: number; token?: string; sessions?: AgentServiceSessions; store?: AgentServiceConversations } = {},
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
  /** clientId → current connection. A newer connection with the same clientId
   *  (browser restart, profile duplicate) replaces — kicks — the old one. */
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

    const conn: ClientConn = { socket, clientId: 'unknown', sessions: new Set(), transports: new Set(), alive: true }
    conns.add(conn)

    const send = (res: JsonRpcResponse): void => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(res))
    }
    const notify = (method: string, params: unknown): void => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ jsonrpc: '2.0', method, params }))
    }
    const makeTransport = (): ClientTransport => {
      const transport: ClientTransport = {
        id: randomUUID(),
        clientId: conn.clientId,
        sendToolCall: (p) => notify(Methods.toolCall, p),
        sendApprovalRequest: (p) => notify(Methods.approvalRequest, p),
        sendAskUserRequest: (p) => notify(Methods.askUserRequest, p),
      }
      conn.transports.add(transport)
      return transport
    }

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
            const clientVersion = typeof params.clientVersion === 'string' ? params.clientVersion : 'unknown'
            conn.clientId = typeof params.clientId === 'string' && params.clientId ? params.clientId : 'anonymous'
            // Same-clientId replacement: kick the ghost connection (M2.2).
            const prior = byClient.get(conn.clientId)
            if (prior && prior !== conn) {
              prior.socket.close(4409, 'replaced by a newer connection')
              conns.delete(prior)
            }
            byClient.set(conn.clientId, conn)
            if (params.protocolVersion !== PROTOCOL_VERSION) {
              send(makeError(msg.id ?? null, ErrorCodes.protocolVersionMismatch,
                `protocol version mismatch: client ${String(params.protocolVersion)}, service ${PROTOCOL_VERSION}`))
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
                  await sessions.createSession(sessionId, { agentId, title: title || conv.title, clientId: conn.clientId })
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
                await sessions.createSession(sessionId, { agentId, title, clientId: conn.clientId })
              }
              conn.sessions.add(sessionId)
              send(makeResult(msg.id ?? null, { sessionId, agentId: agentId ?? 'default', resumed }))
            })().catch((err) => send(makeError(msg.id ?? null, ErrorCodes.internal, errorMessage(err))))
            break
          }
          case Methods.sessionList: {
            const rawLimit = typeof params.limit === 'number' ? params.limit : 50
            const limit = Math.min(Math.max(Math.floor(rawLimit), 1), 200)
            const rows = store.listByOrigin(conn.clientId, limit)
            send(makeResult(msg.id ?? null, { sessions: rows }))
            break
          }
          case Methods.sessionDelete: {
            const sessionId = String(params.sessionId ?? '')
            void (async () => {
              if (!sessionId) throw new Error('sessionId is required')
              const origin = store.origin(sessionId)
              if (origin && origin !== conn.clientId) {
                send(makeError(msg.id ?? null, ErrorCodes.forbidden, 'not your session'))
                return
              }
              if (sessions.hasSession(sessionId)) await sessions.engineCall(sessionId, 'dispose').catch(() => {})
              store.remove(sessionId)
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
            if (origin && origin !== conn.clientId) {
              send(makeError(msg.id ?? null, ErrorCodes.forbidden, 'not your session'))
              break
            }
            store.rename(sessionId, title)
            send(makeResult(msg.id ?? null, { ok: true }))
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
            // The transport lives for exactly this ask: reverse traffic (tool
            // calls, approvals) goes to the connection that asked.
            const transport = makeTransport()
            agentClientRegistry.bind(sessionId, transport)
            sessions.ask(sessionId, content, pageContext)
              .then(() => send(makeResult(msg.id ?? null, { accepted: true, status: 'completed' })))
              .catch((err) => {
                const message = errorMessage(err)
                const code = message.startsWith('session not found') ? ErrorCodes.sessionNotFound : ErrorCodes.internal
                send(makeError(msg.id ?? null, code, message))
              })
              .finally(() => {
                agentClientRegistry.unbind(sessionId, transport)
                conn.transports.delete(transport)
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
          case Methods.toolResult: {
            hostedToolProxy.handleResult(params as unknown as ToolCallResultParams)
            break
          }
          case Methods.approvalResponse: {
            hostedPromptRouter.handleApprovalResponse(params as unknown as ApprovalResponseParams)
            break
          }
          case Methods.askUserResponse: {
            hostedPromptRouter.handleAskUserResponse(params as unknown as AskUserResponseParams)
            break
          }
          case Methods.iterationLimitResponse: {
            hostedPromptRouter.handleIterationLimit(params as unknown as IterationLimitResponseParams)
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
      if (byClient.get(conn.clientId) === conn) byClient.delete(conn.clientId)
      // Settle everything this connection owed: in-flight tool calls reject,
      // pending confirmations are rejected/answered per timeout semantics.
      for (const transport of conn.transports) {
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
      if (!conn.alive) { conn.socket.terminate(); conns.delete(conn); if (byClient.get(conn.clientId) === conn) byClient.delete(conn.clientId); continue }
      conn.alive = false
      conn.socket.ping()
    }
  }, 30_000)

  // ── Session events → subscribed clients ──
  const unsubEvents = sessions.onEvent((sessionId, data: AgentEventData) => {
    const payload = JSON.stringify({ jsonrpc: '2.0', method: Notifications.agentEvent, params: { sessionId, data } })
    for (const conn of conns) {
      if (conn.sessions.has(sessionId) && conn.socket.readyState === WebSocket.OPEN) {
        conn.socket.send(payload)
      }
    }
  })

  hostedPromptRouter.attach(sessions)

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
    close: async () => {
      clearInterval(heartbeat)
      unsubEvents()
      hostedPromptRouter.detach()
      for (const conn of conns) conn.socket.terminate()
      wss.close()
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    },
  }
}
