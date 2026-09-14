/** WebSocket JSON-RPC 2.0 client for the extension service worker
 *  (PLAN-browser-extension M0.5). Chrome-free (WebSocket is injectable) so
 *  protocol behaviour is unit-testable without a browser.
 *
 * Pattern ported from the Anywhere extension's ws-client: hello handshake
 * gates `connected`, id-keyed pending map with per-request timeout, exponential
 * backoff reconnect (suppressed on manual close), server→client notifications
 * (tool.call / approval.request / ask_user.request) dispatched to handlers. */

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
  onEvent?: (params: { sessionId: string; data: unknown }) => void
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
  private readyResolve: (() => void) | null = null

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

  /** Connect and complete the hello handshake. Repeated calls while a
   *  connection attempt is in flight share the same ready promise. */
  connect(): Promise<void> {
    if (this.readyPromise) return this.readyPromise
    this.manualClose = false
    this.readyPromise = new Promise<void>((resolve) => { this.readyResolve = resolve })
    this.setState('connecting')
    const url = `${this.cfg.wsUrl.replace(/\/+$/, '')}/?token=${encodeURIComponent(this.cfg.token)}`
    const socket = new this.WebSocketCtor(url)
    this.socket = socket

    socket.onopen = () => {
      this.request('hello', {
        clientId: this.cfg.clientId,
        clientVersion: this.cfg.clientVersion,
        protocolVersion: this.cfg.protocolVersion,
      }, 10_000)
        .then(() => {
          this.helloDone = true
          this.connected = true
          this.backoffMs = this.cfg.reconnectBaseMs ?? 1_000
          this.setState('open')
          this.readyResolve?.()
        })
        .catch(() => {
          // Version mismatch / rejected hello: tear down and back off.
          this.teardown(new Error('hello rejected'))
        })
    }
    socket.onmessage = (event) => this.handleMessage(String(event.data))
    socket.onclose = () => this.teardown(new Error('连接已断开'))
    socket.onerror = () => { /* close event follows */ }

    return this.readyPromise
  }

  /** Force a fresh connection (config changed, user asked to reconnect). */
  reopen(): Promise<void> {
    this.manualClose = false
    this.teardown(new Error('reopening'))
    return this.connect()
  }

  close(): void {
    this.manualClose = true
    this.teardown(new Error('closed by client'))
  }

  request(method: string, params?: unknown, timeoutMs = this.cfg.requestTimeoutMs ?? 30_000): Promise<unknown> {
    if (!this.socket || this.socket.readyState !== this.WebSocketCtor.OPEN || !this.helloDone) {
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
      if (err) entry.reject(new Error(`${err.message} (code ${err.code})`))
      else entry.resolve((msg as JsonRpcResponse).result)
      return
    }
    if ('method' in msg && typeof msg.method === 'string') {
      const params = (msg.params ?? {}) as Record<string, unknown>
      if (msg.method === 'agent.event') this.handlers.onEvent?.(params as { sessionId: string; data: unknown })
      else this.handlers.onNotification?.(msg.method, params)
    }
  }

  private teardown(reason: Error): void {
    const wasConnected = this.connected
    this.connected = false
    this.helloDone = false
    this.readyPromise = null
    this.readyResolve = null
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
    if (!this.manualClose) this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.manualClose) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.backoffMs = Math.min(this.backoffMs * 2, this.cfg.reconnectMaxMs ?? 30_000)
      void this.connect()
    }, this.backoffMs)
  }

  private setState(state: 'connecting' | 'open' | 'closed'): void {
    this.handlers.onStateChange?.(state)
  }
}
