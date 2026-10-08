/** WebSocket JSON-RPC 2.0 client for the extension service worker
 *  (PLAN-browser-extension M0.5). Chrome-free (WebSocket is injectable) so
 *  protocol behaviour is unit-testable without a browser.
 *
 * Pattern ported from the Anywhere extension's ws-client: hello handshake
 * gates `connected`, id-keyed pending map with per-request timeout, exponential
 * backoff reconnect (suppressed on manual close), server→client notifications
 * (tool.call / approval.request / ask_user.request) dispatched to handlers. */

import { ErrorCodes } from '../../shared/agent-protocol/jsonrpc'
import type { AgentEventParams } from '../../shared/agent-protocol'
import type { JsonRpcRequest, JsonRpcResponse } from '../../shared/agent-protocol/jsonrpc'


export interface WsClientConfig {
  wsUrl: string
  token: string
  clientId: string
  clientVersion: string
  protocolVersion: number
  reconnectBaseMs?: number
  reconnectMaxMs?: number
  requestTimeoutMs?: number
}

export interface WsClientHandlers {
  /** `agent.event` notifications for sessions this connection is bound to. */
  onEvent?: (params: AgentEventParams) => void
  onNotification?: (method: string, params: Record<string, unknown>) => void
  onStateChange?: (state: 'connecting' | 'open' | 'closed') => void
}

interface PendingEntry {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class WsClient {
  private socket: WebSocket | null = null
  private pending = new Map<string | number, PendingEntry>()
  private nextId = 1
  private backoffMs: number
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private manualClose = false
  private helloDone = false
  private readyPromise: Promise<void> | null = null
  private readySettle: ((err?: Error) => void) | null = null
  /** Diagnostics surfaced to the options page (close code/reason, hello errors). */
  lastError = ''
  /** Application close code from the last close event (see CloseCodes). */
  lastCloseCode: number | null = null
  /** A hello rejection no retry can fix (protocol version mismatch): reconnecting
   *  would loop forever against the same service and kick its own ghost each
   *  time. The client stops scheduling reconnects; the worker's keepalive alarm
   *  is the recovery path (it rebuilds a fatal client, so a desktop that later
   *  upgrades re-heals within one alarm period). */
  fatal = false

  connected = false

  constructor(
    private cfg: WsClientConfig,
    private handlers: WsClientHandlers = {},
    private WebSocketCtor: typeof WebSocket = WebSocket,
  ) {
    this.backoffMs = cfg.reconnectBaseMs ?? 1_000
  }

  get state(): 'connecting' | 'open' | 'closed' {
    if (this.connected) return 'open'
    return this.socket ? 'connecting' : 'closed'
  }

  /** Connect and complete the hello handshake. Always settles (resolved on a
   *  good handshake, rejected on teardown) so awaiters never hang. */
  connect(): Promise<void> {
    if (this.readyPromise) return this.readyPromise
    if (this.fatal) return Promise.reject(new Error(this.lastError || 'unrecoverable hello failure'))
    this.manualClose = false
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readySettle = (err) => (err ? reject(err) : resolve())
    })
    this.setState('connecting')
    const url = `${this.cfg.wsUrl.replace(/\/+$/, '')}/?token=${encodeURIComponent(this.cfg.token)}`
    const socket = new this.WebSocketCtor(url)
    this.socket = socket

    socket.onopen = () => {
      // The handshake goes through request() before helloDone flips — the
      // request gate below must let `hello` through or this deadlocks.
      this.request('hello', {
        clientId: this.cfg.clientId,
        clientVersion: this.cfg.clientVersion,
        protocolVersion: this.cfg.protocolVersion,
      }, 10_000)
        .then(() => {
          this.helloDone = true
          this.connected = true
          this.backoffMs = this.cfg.reconnectBaseMs ?? 1_000
          this.lastError = ''
          this.setState('open')
          this.readySettle?.()
        })
        .catch((err: Error) => {
          this.lastError = `hello 失败: ${err.message}`
          if ((err as Error & { code?: number }).code === ErrorCodes.protocolVersionMismatch) this.fatal = true
          this.teardown(err)
        })
    }
    socket.onmessage = (event) => this.handleMessage(String(event.data))
    socket.onclose = (event) => {
      this.lastCloseCode = event.code || null
      this.lastError = `连接关闭 (${event.code}${event.reason ? ` ${event.reason}` : ''})`
      this.teardown(new Error(this.lastError))
    }
    socket.onerror = () => {
      this.lastError = this.lastError || 'WebSocket 连接失败（服务不可达或被拒绝）'
    }

    return this.readyPromise
  }

  /** Force a fresh connection (config changed, user asked to reconnect). */
  reopen(): Promise<void> {
    this.manualClose = false
    this.clearReconnect()
    this.teardown(new Error('reopening'))
    return this.connect()
  }

  close(): void {
    this.manualClose = true
    this.clearReconnect()
    this.teardown(new Error('closed by client'))
  }

  request(method: string, params?: unknown, timeoutMs = this.cfg.requestTimeoutMs ?? 30_000): Promise<unknown> {
    if (!this.socket || this.socket.readyState !== this.WebSocketCtor.OPEN) {
      return Promise.reject(new Error('not connected'))
    }
    // Only the handshake itself may run before helloDone flips.
    if (!this.helloDone && method !== 'hello') {
      return Promise.reject(new Error('not connected'))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`request timeout: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.sendFrame({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params?: unknown): void {
    this.sendFrame({ jsonrpc: '2.0', method, params })
  }

  private sendFrame(frame: JsonRpcRequest | JsonRpcResponse): void {
    this.socket?.send(JSON.stringify(frame))
  }

  private handleMessage(text: string): void {
    let msg: JsonRpcResponse | (JsonRpcRequest & { result?: unknown; error?: unknown })
    try {
      msg = JSON.parse(text)
    } catch {
      return
    }
    if ('id' in msg && msg.id !== undefined && msg.id !== null && ('result' in msg || 'error' in msg)) {
      const entry = this.pending.get(msg.id as string | number)
      if (!entry) return
      this.pending.delete(msg.id as string | number)
      clearTimeout(entry.timer)
      const err = (msg as JsonRpcResponse).error
      if (err) {
        // The application code rides the rejection: callers branch on it (the
        // hello handshake turns a protocol mismatch into a fatal stop).
        const failure = new Error(`${err.message} (code ${err.code})`) as Error & { code?: number }
        failure.code = err.code
        entry.reject(failure)
      } else entry.resolve((msg as JsonRpcResponse).result)
      return
    }
    if ('method' in msg && typeof msg.method === 'string') {
      const params = (msg.params ?? {}) as Record<string, unknown>
      if (msg.method === 'agent.event') this.handlers.onEvent?.(params as unknown as AgentEventParams)
      else this.handlers.onNotification?.(msg.method, params)
    }
  }

  private teardown(reason: Error): void {
    const wasConnected = this.connected
    this.connected = false
    this.helloDone = false
    this.readyPromise = null
    this.readySettle?.(reason)
    this.readySettle = null
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(reason)
    }
    this.pending.clear()
    const socket = this.socket
    this.socket = null
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null
      try { socket.close() } catch { /* already closing */ }
    }
    if (wasConnected || this.state !== 'closed') this.setState('closed')
    if (!this.manualClose && !this.fatal) this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.manualClose || this.fatal) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.backoffMs = Math.min(this.backoffMs * 2, this.cfg.reconnectMaxMs ?? 30_000)
      void this.connect().catch(() => { /* state change already broadcast */ })
    }, this.backoffMs)
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private setState(state: 'connecting' | 'open' | 'closed'): void {
    this.handlers.onStateChange?.(state)
  }
}
