import { randomUUID } from 'node:crypto'
import { StdioTransport, SSETransport, StreamableHTTPTransport, type MCPTransport } from './transport'
import { ensureLaunchHooks, getHookEnv } from '../hooks-runner'

// ── Heartbeat ─────────────────────────────────────────────────────────
// Periodic ping detects silently-dead connections (hung SSE stream, killed
// subprocess, network drop) so the manager can auto-reconnect. The ping only
// runs while idle — a busy server shouldn't be flagged dead mid-request.
const HEARTBEAT_INTERVAL_MS = 30_000
const HEARTBEAT_TIMEOUT_MS = 15_000

// ── Types ────────────────────────────────────────────────────────────

export interface MCPToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface MCPServerCapabilities {
  tools?: Record<string, unknown>
  resources?: Record<string, unknown>
  prompts?: Record<string, unknown>
}

export interface MCPClientConfig {
  command: string
  args: string[]
  env?: Record<string, string>
  /** Friendly display name */
  name: string
  /** Transport type: 'stdio' (local subprocess, default) or 'sse' (remote HTTP server) */
  transportType?: 'stdio' | 'sse' | 'streamable-http'
  /** SSE/Streamable HTTP endpoint URL (required when transportType === 'sse' or 'streamable-http') */
  url?: string
  /** Custom HTTP headers for SSE transport (e.g. Authorization) */
  headers?: Record<string, string>
  /** When true, this server's tools wait for user approval unless the session's approval mode is 'auto'. */
  requireApproval?: boolean
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timeoutHandle?: ReturnType<typeof setTimeout>
  cleanup?: () => void
}

// ── Env sanitization ──────────────────────────────────────────────────

const SENSITIVE_ENV_PATTERNS = [
  /^AWS_/i,
  /^AZURE_/i,
  /^GOOGLE_/i,
  /^GCP_/i,
  /^SSH_/i,
  /^GPG_/i,
  /^PGP_/i,
  /_TOKEN$/i,
  /_SECRET$/i,
  /_PASSWORD$/i,
  /_PASSWD$/i,
  /_KEY$/i,
  /_CREDENTIAL$/i,
  /_CREDENTIALS$/i,
  /_CERTIFICATE$/i,
  /_CERT$/i,
]

function sanitizeEnv(userEnv?: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (SENSITIVE_ENV_PATTERNS.some((p) => p.test(key))) continue
    result[key] = value
  }
  Object.assign(result, getHookEnv())
  if (userEnv) Object.assign(result, userEnv)
  return result
}

// ── Client ────────────────────────────────────────────────────────────

export class MCPClient {
  private transport: MCPTransport | null = null
  private pending = new Map<number, PendingRequest>()
  private msgId = 0
  private _connected = false
  private _tools: MCPToolDefinition[] = []
  private _serverInfo: { name: string; version: string } | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null

  readonly config: MCPClientConfig
  readonly id: string

  /** Fires when the server disconnects unexpectedly */
  onDisconnect: ((id: string) => void) | null = null

  constructor(config: MCPClientConfig, id?: string) {
    this.config = config
    this.id = id || randomUUID()
  }

  get connected(): boolean {
    return this._connected
  }

  get tools(): MCPToolDefinition[] {
    return this._tools
  }

  get serverInfo(): { name: string; version: string } | null {
    return this._serverInfo
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  async start(timeoutMs = 30_000): Promise<void> {
    if (this.transport) throw new Error('MCP client is already running')

    // stdio servers spawn with getHookEnv() env; hooks run concurrently with
    // window creation now, so the first start must wait for them to collect.
    await ensureLaunchHooks()

    if (this.config.transportType === 'streamable-http') {
      if (!this.config.url) throw new Error('Streamable HTTP transport requires url')
      this.transport = new StreamableHTTPTransport(this.config.url, this.config.headers)
    } else 
    if (this.config.transportType === 'sse') {
      if (!this.config.url) throw new Error('SSE transport requires url')
      this.transport = new SSETransport(this.config.url, this.config.headers)
    } else {
      this.transport = new StdioTransport(
        this.config.command,
        this.config.args || [],
        sanitizeEnv(this.config.env),
      )
    }

    // Wire up transport callbacks
    this.transport.onMessage = (data: string) => {
      try {
        this.handleMessage(JSON.parse(data))
      } catch {
        console.log(`[MCP:${this.config.name}] Non-JSON message:`, data.slice(0, 200))
      }
    }

    this.transport.onError = (err: Error) => {
      console.log(`[MCP:${this.config.name}] transport error:`, err.message)
    }

    this.transport.onClose = () => {
      this.handleDisconnect()
    }

    // Connect with startup timeout
    const timer = setTimeout(() => {
      this.transport?.disconnect().catch(() => {})
      this.transport = null
    }, timeoutMs)

    try {
      await this.transport.connect()
      await this.initialize()
      clearTimeout(timer)
      this._connected = true
      await this.discoverTools()
      this.startHeartbeat()
    } catch (err) {
      clearTimeout(timer)
      this.transport?.disconnect().catch(() => {})
      this.transport = null
      throw err
    }
  }

  async stop(): Promise<void> {
    this.stopHeartbeat()
    if (!this.transport) return

    this._connected = false

    // In-flight calls must reject, not dangle (PLAN-parallel-experts T11):
    // clearing `pending` without rejecting left callers awaiting forever.
    for (const [, req] of this.pending) {
      clearTimeout(req.timeoutHandle)
      req.reject(new Error('MCP client stopped'))
    }
    this.pending.clear()

    this.sendNotification('shutdown')

    await this.transport.disconnect()
    this.transport = null
    this._tools = []
    this._serverInfo = null
  }

  // ── Disconnect & heartbeat ──────────────────────────────────────────

  /** Tear down an unresponsive/dead connection and notify the manager. */
  private handleDisconnect(): void {
    this.stopHeartbeat()
    this._connected = false
    // Re-entrant calls (transport.disconnect() may trigger onClose for SSE)
    if (!this.transport) return
    // Abort any hanging transport reads/POSTs (SSE stream, Streamable HTTP)
    this.transport?.disconnect().catch(() => {})
    this.transport = null
    for (const [, req] of this.pending) {
      clearTimeout(req.timeoutHandle)
      req.cleanup?.()
      req.reject(new Error('MCP server disconnected'))
    }
    this.pending.clear()
    this.onDisconnect?.(this.id)
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      void this.ping()
    }, HEARTBEAT_INTERVAL_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private async ping(): Promise<void> {
    if (!this._connected || !this.transport) return
    // A busy server (long-running tool call) shouldn't be flagged dead —
    // only probe while no request is in flight.
    if (this.pending.size > 0) return
    try {
      await this.request('ping', {}, undefined, HEARTBEAT_TIMEOUT_MS)
    } catch (err) {
      console.log(`[MCP:${this.config.name}] ping failed, marking disconnected:`, (err as Error).message)
      this.handleDisconnect()
    }
  }

  // ── Tool operations ─────────────────────────────────────────────────

  async callTool(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    this.ensureConnected()
    return this.request('tools/call', { name, arguments: args }, signal)
  }

  // ── Internal MCP protocol ────────────────────────────────────────────

  private async initialize(): Promise<void> {
    const result = (await this.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'pulsemind', version: '1.0' },
    })) as {
      protocolVersion: string
      capabilities: MCPServerCapabilities
      serverInfo: { name: string; version: string }
    }

    this._serverInfo = result.serverInfo
    this.sendNotification('notifications/initialized')
  }

  private async discoverTools(): Promise<void> {
    try {
      const result = (await this.request('tools/list', {})) as { tools: MCPToolDefinition[] }
      this._tools = result.tools || []
      console.log(`[MCP:${this.config.name}] Discovered ${this._tools.length} tools`)
    } catch (err) {
      console.log(`[MCP:${this.config.name}] tools/list failed:`, err)
      this._tools = []
    }
  }

  private async request(method: string, params: unknown = {}, signal?: AbortSignal, timeoutMs = 60_000): Promise<unknown> {
    const id = ++this.msgId
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params })

    if (signal?.aborted) {
      throw new Error('Request aborted')
    }

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.send(msg)

      const timeoutHandle = setTimeout(() => {
        const p = this.pending.get(id)
        if (p) {
          p.cleanup?.()
          this.pending.delete(id)
          reject(new Error(`MCP request timed out: ${method}`))
        }
      }, timeoutMs)
      const existing = this.pending.get(id)
      if (existing) existing.timeoutHandle = timeoutHandle

      if (signal) {
        const onAbort = () => {
          const p = this.pending.get(id)
          if (p) {
            clearTimeout(p.timeoutHandle)
            this.pending.delete(id)
            reject(new Error('Request aborted'))
          }
        }
        signal.addEventListener('abort', onAbort, { once: true })
        // Clean up the listener if the promise settles normally
        const cleanup = () => signal.removeEventListener('abort', onAbort)
        this.pending.get(id)!.cleanup = cleanup
      }
    })
  }

  private sendNotification(method: string, params: unknown = {}): void {
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params })
    this.send(msg)
  }

  private send(raw: string): void {
    if (!this.transport) throw new Error('MCP server not running')
    this.transport.send(raw)
  }

  private handleMessage(msg: Record<string, unknown>): void {
    if (typeof msg.id === 'number' && ('result' in msg || 'error' in msg)) {
      const pending = this.pending.get(msg.id)
      if (pending) {
        clearTimeout(pending.timeoutHandle)
        pending.cleanup?.()
        this.pending.delete(msg.id)
        if (msg.error) {
          const err = msg.error as { message?: string; code?: number }
          pending.reject(new Error(err.message || `MCP error (code ${err.code})`))
        } else {
          pending.resolve(msg.result)
        }
      }
      return
    }

    if (typeof msg.id === 'undefined' && msg.method) {
      console.log(`[MCP:${this.config.name}] Notification:`, msg.method, JSON.stringify(msg.params).slice(0, 300))
    }
  }

  private ensureConnected(): void {
    if (!this._connected || !this.transport) {
      throw new Error('MCP server is not connected')
    }
  }
}
