/**
 * Local agent service over WebSocket (PLAN-0.3.5 M2.1).
 *
 * Loopback-only JSON-RPC 2.0 server that exposes the main-hosted session
 * manager to remote clients (browser extension, web clients). Wire protocol:
 * the shared agent-protocol package (hello handshake → session.create →
 * agent.ask → agent.event notifications; ping heartbeat; token auth at
 * upgrade, ?token=<service-token>).
 */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import {
  ErrorCodes,
  Methods,
  Notifications,
  PROTOCOL_VERSION,
  makeError,
  makeResult,
  type AgentEventData,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from '../../shared/agent-protocol'
import { agentSessionManager } from './session-manager'
import { SERVICE_DEFAULT_PORT } from '../service-config'

const SERVICE_VERSION = `0.3.5`

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

export async function startAgentService(opts: { port?: number } = {}): Promise<AgentServiceHandle> {
  const { readFileSync, writeFileSync, mkdirSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { homedir } = await import('node:os')
  const { DATA_DIR } = await import('../storage')

  // ── Token: single fact persisted on disk so desktop settings UI and manual
  // clients read the same value. ──
  const tokenPath = join(DATA_DIR, 'service-token')
  let token: string
  try {
    token = readFileSync(tokenPath, 'utf-8').trim()
  } catch { token = '' }
  if (!token) {
    token = randomUUID().replace(/-/g, '')
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(tokenPath, token, 'utf-8')
  }

  const port = opts.port ?? SERVICE_DEFAULT_PORT
  const httpServer = createServer((_req, res) => {
    // HTTP surface: liveness only (admin REST arrives with M5).
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ service: 'pulsemind-agent', protocolVersion: PROTOCOL_VERSION }))
  })

  const wss = new WebSocketServer({ server: httpServer })
  const conns = new Set<ClientConn>()
  /** clientId → current connection. A newer connection with the same clientId
   *  (browser restart, profile duplicate) replaces — kicks — the old one. */
  const byClient = new Map<string, ClientConn>()

  wss.on('connection', (socket, req) => {
    // Token auth at upgrade: ?token= must equal the service token.
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.searchParams.get('token') !== token) {
      socket.close(4401, 'unauthorized')
      return
    }

    const conn: ClientConn = { socket, clientId: 'unknown', sessions: new Set(), alive: true }
    conns.add(conn)

    const send = (res: JsonRpcResponse): void => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(res))
    }
    const notify = (method: string, params: unknown): void => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ jsonrpc: '2.0', method, params }))
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
            const sessionId = `ws_${Date.now()}_${randomUUID().slice(0, 8)}`
            const agentId = typeof params.agentId === 'string' ? params.agentId : undefined
            const title = typeof params.title === 'string' ? params.title : undefined
            agentSessionManager.createSession(sessionId, { agentId, title, clientId: conn.clientId })
              .then((r) => { conn.sessions.add(sessionId); send(makeResult(msg.id ?? null, r)) })
              .catch((err) => send(makeError(msg.id ?? null, ErrorCodes.internal, err instanceof Error ? err.message : String(err))))
            break
          }
          case Methods.agentAsk: {
            const sessionId = String(params.sessionId ?? '')
            const content = String(params.content ?? '')
            conn.sessions.add(sessionId)
            agentSessionManager.ask(sessionId, content)
              .then(() => send(makeResult(msg.id ?? null, { accepted: true })))
              .catch((err) => send(makeError(msg.id ?? null, ErrorCodes.sessionNotFound, err instanceof Error ? err.message : String(err))))
            break
          }
          case Methods.agentCancel: {
            agentSessionManager.cancel(String(params.sessionId ?? ''))
            send(makeResult(msg.id ?? null, { canceled: true }))
            break
          }
          case Methods.agentHistory: {
            try {
              send(makeResult(msg.id ?? null, agentSessionManager.history(String(params.sessionId ?? ''))))
            } catch (err) {
              send(makeError(msg.id ?? null, ErrorCodes.sessionNotFound, err instanceof Error ? err.message : String(err)))
            }
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
  const unsubEvents = agentSessionManager.onEvent((sessionId, data: AgentEventData) => {
    const payload = JSON.stringify({ jsonrpc: '2.0', method: Notifications.agentEvent, params: { sessionId, data } })
    for (const conn of conns) {
      if (conn.sessions.has(sessionId) && conn.socket.readyState === WebSocket.OPEN) {
        conn.socket.send(payload)
      }
    }
  })

  // ── Listen (loopback only) with random-port fallback ──
  const requestedPort = port
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(port, '127.0.0.1', resolve)
  }).catch(async (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EADDRINUSE') throw err
    console.warn(`[AgentService] port ${requestedPort} in use — falling back to a random port`)
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  })

  const address = httpServer.address()
  const boundPort = typeof address === 'object' && address ? address.port : port

  console.log(`[AgentService] listening on ws://127.0.0.1:${boundPort} (token in ${'~/.pulsemind/service-token'})`)

  return {
    port: boundPort,
    token,
    close: async () => {
      clearInterval(heartbeat)
      unsubEvents()
      for (const conn of conns) conn.socket.terminate()
      wss.close()
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    },
  }
}
