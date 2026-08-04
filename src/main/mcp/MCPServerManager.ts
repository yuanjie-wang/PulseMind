import { MCPClient, type MCPClientConfig, type MCPToolDefinition } from './MCPClient'

// ── Types ────────────────────────────────────────────────────────────

export interface MCPManagedServer {
  id: string
  name: string
  config: MCPClientConfig
  status: 'stopped' | 'connecting' | 'connected' | 'error'
  error?: string
  tools: MCPToolDefinition[]
  serverInfo: { name: string; version: string } | null
  summary?: string
  client: MCPClient
}

export interface MCPToolCallResult {
  success: boolean
  result?: unknown
  error?: string
}

// ── Manager ──────────────────────────────────────────────────────────

const MAX_MCP_SERVERS = 20

// Auto-reconnect backoff after an unexpected disconnect (capped, resets on a
// successful connect). A manual stop()/unregister() opts out via intentionalStops.
const RECONNECT_BASE_DELAY_MS = 1000
const RECONNECT_MAX_DELAY_MS = 15_000

class MCPServerManagerImpl {
  private servers = new Map<string, MCPManagedServer>()
  private autoStartIds = new Set<string>()
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private reconnectAttempts = new Map<string, number>()
  private intentionalStops = new Set<string>()

  markAutoStart(id: string, autoStart: boolean): void {
    if (autoStart) this.autoStartIds.add(id)
    else this.autoStartIds.delete(id)
  }

  isAutoStart(id: string): boolean {
    return this.autoStartIds.has(id)
  }

  getAutoStartIds(): string[] {
    return Array.from(this.autoStartIds)
  }

  async startAutoStartServers(): Promise<void> {
    for (const id of this.autoStartIds) {
      this.start(id).catch((err) =>
        console.log(`[MCP] Auto-start failed for "${id}":`, err)
      )
    }
  }

  // ── Registration ─────────────────────────────────────────────────────

  register(config: MCPClientConfig, id?: string): MCPManagedServer {
    if (this.servers.size >= MAX_MCP_SERVERS) {
      throw new Error(`MCP server limit reached (max ${MAX_MCP_SERVERS})`)
    }

    const serverId = id || config.name.toLowerCase().replace(/\s+/g, '-')
    if (this.servers.has(serverId)) {
      throw new Error(`MCP server "${serverId}" is already registered`)
    }

    // Clear any leftover reconnect state from a previous registration with this id
    this.clearReconnectTimer(serverId)
    this.reconnectAttempts.delete(serverId)
    this.intentionalStops.delete(serverId)

    const client = new MCPClient(config, serverId)
    client.onDisconnect = (sid) => {
      const s = this.servers.get(sid)
      if (!s) return
      s.status = 'stopped'
      s.tools = []
      s.serverInfo = null
      // Skip auto-reconnect when the disconnect was a manual stop/unregister
      if (this.intentionalStops.has(sid)) {
        this.intentionalStops.delete(sid)
        this.clearReconnectTimer(sid)
        return
      }
      this.scheduleReconnect(sid)
    }

    const server: MCPManagedServer = {
      id: serverId,
      name: config.name,
      config,
      status: 'stopped',
      tools: [],
      serverInfo: null,
      client
    }

    this.servers.set(serverId, server)
    return server
  }

  unregister(id: string): void {
    const server = this.servers.get(id)
    if (!server) return
    this.clearReconnectTimer(id)
    this.reconnectAttempts.delete(id)
    // Auto-stop if running
    if (server.status === 'connected' || server.status === 'connecting') {
      server.client.stop().catch(() => {})
    }
    this.servers.delete(id)
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  async start(id: string, retryCount = 2, startTimeoutMs?: number): Promise<void> {
    const server = this.servers.get(id)
    if (!server) throw new Error(`MCP server "${id}" not found`)
    if (server.status === 'connected') return
    if (server.status === 'connecting') throw new Error(`MCP server "${id}" is already connecting`)

    // A manual start supersedes any pending reconnect timer
    this.clearReconnectTimer(id)
    server.status = 'connecting'
    server.error = undefined

    for (let attempt = 1; attempt <= retryCount; attempt++) {
      try {
        await server.client.start(startTimeoutMs)
        server.status = 'connected'
        server.tools = server.client.tools
        server.serverInfo = server.client.serverInfo
        this.reconnectAttempts.delete(id)
        console.log(`[MCP] Server "${server.name}" connected (${server.tools.length} tools)`)
        return
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (attempt < retryCount) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000)
          console.log(`[MCP] Server "${server.name}" attempt ${attempt}/${retryCount} failed, retrying in ${delay}ms:`, message)
          await new Promise(r => setTimeout(r, delay))
        } else {
          server.status = 'error'
          server.error = message
          console.log(`[MCP] Server "${server.name}": all ${retryCount} attempts failed:`, message)
          throw err
        }
      }
    }
  }

  async stop(id: string): Promise<void> {
    const server = this.servers.get(id)
    if (!server) throw new Error(`MCP server "${id}" not found`)
    if (server.status === 'stopped') return

    this.clearReconnectTimer(id)
    this.reconnectAttempts.delete(id)
    // Opt out of auto-reconnect for this disconnect. SSE/streamable transports
    // fire onDisconnect on abort (consuming the marker); stdio never does, so
    // the finally below cleans up for that path.
    this.intentionalStops.add(id)
    try {
      await server.client.stop()
    } finally {
      this.intentionalStops.delete(id)
    }
    server.status = 'stopped'
    server.tools = []
    server.serverInfo = null
    server.error = undefined
  }

  async restart(id: string): Promise<void> {
    await this.stop(id)
    await this.start(id)
  }

  // ── Auto-reconnect ───────────────────────────────────────────────────

  private scheduleReconnect(id: string): void {
    const server = this.servers.get(id)
    if (!server) return
    const attempt = (this.reconnectAttempts.get(id) || 0) + 1
    this.reconnectAttempts.set(id, attempt)
    const delay = Math.min(RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt - 1), RECONNECT_MAX_DELAY_MS)
    console.log(`[MCP] Server "${server.name}" disconnected, reconnecting in ${delay}ms (attempt ${attempt})`)
    this.clearReconnectTimer(id)
    this.reconnectTimers.set(id, setTimeout(() => {
      this.reconnectTimers.delete(id)
      // Skip if it was manually stopped, unregistered, or reconnected meanwhile
      if (this.intentionalStops.has(id)) return
      const s = this.servers.get(id)
      if (!s || s.status === 'connected') return
      this.start(id).catch((err) => {
        console.log(`[MCP] Reconnect failed for "${server.name}":`, err)
        if (this.servers.has(id) && !this.intentionalStops.has(id)) {
          this.scheduleReconnect(id)
        }
      })
    }, delay))
  }

  private clearReconnectTimer(id: string): void {
    const timer = this.reconnectTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      this.reconnectTimers.delete(id)
    }
  }

  // ── Tool execution ───────────────────────────────────────────────────

  async callTool(serverId: string, toolName: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<MCPToolCallResult> {
    const server = this.servers.get(serverId)
    if (!server) return { success: false, error: `MCP server "${serverId}" not found` }
    if (server.status !== 'connected') return { success: false, error: `MCP server "${serverId}" is not connected (status: ${server.status})` }

    try {
      const result = await server.client.callTool(toolName, args, signal)
      const json = JSON.stringify(result)
      if (json.length > 10 * 1024 * 1024) {
        const msg = `MCP tool "${toolName}" returned ${(json.length / 1024 / 1024).toFixed(1)}MB result (max 10MB)`
        console.warn(`[MCP] ${msg}`)
        return { success: false, error: msg }
      }
      return { success: true, result }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────

  setSummary(id: string, summary: string): void {
    const s = this.servers.get(id)
    if (s) s.summary = summary
  }

  // ── Query ────────────────────────────────────────────────────────────

  listServers(): Array<Omit<MCPManagedServer, 'client'>> {
    return Array.from(this.servers.values()).map((s) => ({
      id: s.id,
      name: s.name,
      config: s.config,
      status: s.status,
      error: s.error,
      tools: s.tools,
      serverInfo: s.serverInfo,
      summary: s.summary
    }))
  }

  getServer(id: string): (Omit<MCPManagedServer, 'client'>) | undefined {
    const s = this.servers.get(id)
    if (!s) return undefined
    return {
      id: s.id,
      name: s.name,
      config: s.config,
      status: s.status,
      error: s.error,
      tools: s.tools,
      serverInfo: s.serverInfo,
      summary: s.summary
    }
  }

  /** Auto-start all registered servers */
  async startAll(): Promise<void> {
    const results: Array<{ id: string; success: boolean; error?: string }> = []
    for (const [id] of this.servers) {
      try {
        await this.start(id)
        results.push({ id, success: true })
      } catch (err) {
        results.push({ id, success: false, error: err instanceof Error ? err.message : String(err) })
      }
    }
    return results as unknown as void
  }
}

// Singleton
export const serverManager = new MCPServerManagerImpl()
