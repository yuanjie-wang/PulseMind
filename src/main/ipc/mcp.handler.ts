import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { serverManager, type MCPManagedServer } from '../mcp/MCPServerManager'
import { createChromeDevToolsConfig } from '../mcp/servers/chrome-devtools'
import { mcpServerStore } from '../storage/mcp-server-store'
import type { MCPClientConfig } from '../mcp/MCPClient'

// Public-facing server type (no client field)
type McpServerInfo = Omit<MCPManagedServer, 'client'>

export function validateMcpConfig(config: unknown): config is MCPClientConfig {
  if (!config || typeof config !== 'object') throw new Error('配置必须是对象')
  const c = config as Record<string, unknown>
  if (typeof c.name !== 'string' || !c.name.trim()) throw new Error('服务器名称不能为空')

  const transportType = c.transportType
  if (transportType !== undefined && transportType !== 'stdio' && transportType !== 'sse' && transportType !== 'streamable-http') {
    throw new Error('transportType 必须是 "stdio"、"sse" 或 "streamable-http"')
  }

  if (transportType === 'sse' || transportType === 'streamable-http') {
    // Remote SSE server
    if (typeof c.url !== 'string' || !c.url.trim()) throw new Error('SSE/Streamable HTTP 模式下 url 不能为空')
    try { new URL(c.url as string) } catch { throw new Error('url 格式无效') }
    if (c.headers !== undefined && (typeof c.headers !== 'object' || c.headers === null || Array.isArray(c.headers))) {
      throw new Error('headers 必须是对象')
    }
  } else {
    // Local stdio server
    if (typeof c.command !== 'string' || !c.command.trim()) throw new Error('启动命令不能为空')
    if (c.args !== undefined && (!Array.isArray(c.args) || !c.args.every(a => typeof a === 'string'))) {
      throw new Error('args 必须是字符串数组')
    }
    if (c.env !== undefined && (typeof c.env !== 'object' || c.env === null)) {
      throw new Error('env 必须是对象')
    }
  }
  return true
}

// Register default + persisted custom servers on startup
async function registerServers(): Promise<void> {
  // Chrome DevTools (built-in)
  try {
    const server = serverManager.register(createChromeDevToolsConfig())
    // Windows: Chrome auto-connect can be slow on first launch
    const startTimeout = process.platform === 'win32' ? 120_000 : 60_000
    serverManager.start(server.id, 2, startTimeout).catch((err) =>
      console.warn(`[MCP] Chrome DevTools auto-start deferred:`, err)
    )
    console.log('[MCP] Chrome DevTools server registered')
  } catch (err) {
    console.log('[MCP] Failed to register Chrome DevTools:', err)
  }

  // Custom servers from store
  try {
    const records = await mcpServerStore.getAll()
    for (const record of records) {
      if (serverManager.getServer(record.id)) continue
      try {
        serverManager.register(record.config, record.id)
        if (record.summary) serverManager.setSummary(record.id, record.summary)
        if (record.autoStart) {
          serverManager.markAutoStart(record.id, true)
        }
        console.log(`[MCP] Custom server "${record.config.name}" registered from store`)
      } catch (err) {
        console.log(`[MCP] Failed to register custom server "${record.config.name}":`, err)
      }
    }
    // Auto-start servers that were connected before restart
    serverManager.startAutoStartServers()
  } catch (err) {
    console.log('[MCP] Failed to load custom servers:', err)
  }
}

// Persist current custom servers to store
export async function persistCustomServers(): Promise<void> {
  const allServers = serverManager.listServers()
  // Only persist non-built-in servers (Chrome DevTools is the only built-in)
  const customServers = allServers.filter((s) => s.id !== 'chrome-devtools')
  await mcpServerStore.save(
    customServers.map((s) => ({ id: s.id, config: s.config, autoStart: serverManager.isAutoStart(s.id), summary: s.summary }))
  )
}

export function registerMcpHandlers(): void {
  // Register servers async (don't block IPC registration)
  registerServers().catch((err) => console.log('[MCP] registerServers error:', err))

  // ── List all registered servers ──
  ipcMain.handle(IPC_CHANNELS.MCP_LIST_SERVERS, () => {
    const servers = serverManager.listServers()
    return servers.map((s) => ({ ...s }))
  })

  // ── Get a specific server ──
  ipcMain.handle(IPC_CHANNELS.MCP_GET_SERVER, (_event, id: string) => {
    const server = serverManager.getServer(id)
    if (!server) return null
    return { ...server, tools: [...server.tools] }
  })

  // ── Start a server ──
  ipcMain.handle(IPC_CHANNELS.MCP_START_SERVER, async (event, id: string): Promise<{ success: boolean; error?: string }> => {
    try {
      await serverManager.start(id)
      serverManager.markAutoStart(id, true)
      await persistCustomServers()
      event.sender.send(IPC_CHANNELS.MCP_SERVERS_CHANGED)
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // ── Stop a server ──
  ipcMain.handle(IPC_CHANNELS.MCP_STOP_SERVER, async (event, id: string): Promise<{ success: boolean; error?: string }> => {
    try {
      await serverManager.stop(id)
      serverManager.markAutoStart(id, false)
      await persistCustomServers()
      event.sender.send(IPC_CHANNELS.MCP_SERVERS_CHANGED)
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // ── Restart a server ──
  ipcMain.handle(IPC_CHANNELS.MCP_RESTART_SERVER, async (event, id: string): Promise<{ success: boolean; error?: string }> => {
    try {
      await serverManager.restart(id)
      event.sender.send(IPC_CHANNELS.MCP_SERVERS_CHANGED)
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // ── Call a tool on a server ──
  ipcMain.handle(
    IPC_CHANNELS.MCP_CALL_TOOL,
    async (
      _event,
      serverId: string,
      toolName: string,
      args: Record<string, unknown>
    ): Promise<{ success: boolean; result?: unknown; error?: string }> => {
      return serverManager.callTool(serverId, toolName, args)
    }
  )

  // ── Reload all servers from disk config ──
  ipcMain.handle(IPC_CHANNELS.MCP_RELOAD_SERVERS, async (event) => {
    try {
      const records = await mcpServerStore.getAll()
      const currentIds = new Set(serverManager.listServers().map((s) => s.id))

      // Unregister servers that are no longer in config (except chrome-devtools)
      for (const id of currentIds) {
        if (id === 'chrome-devtools') continue
        if (!records.find((r) => r.id === id)) {
          serverManager.unregister(id)
        }
      }

      // Register or update servers from config
      for (const record of records) {
        const existing = serverManager.getServer(record.id)
        if (existing) {
          // Re-register if config changed
          const sameConfig = JSON.stringify(existing.config) === JSON.stringify(record.config)
          if (!sameConfig) {
            const wasConnected = existing.status === 'connected'
            serverManager.unregister(record.id)
            serverManager.register(record.config, record.id)
            if (wasConnected) serverManager.start(record.id).catch(() => {})
          }
        } else {
          serverManager.register(record.config, record.id)
          if (record.autoStart) {
            serverManager.markAutoStart(record.id, true)
            serverManager.start(record.id).catch(() => {})
          }
        }
      }

      event.sender.send(IPC_CHANNELS.MCP_SERVERS_CHANGED)
      return { success: true, servers: serverManager.listServers().map((s) => ({ ...s })) }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // ── Register a new custom server ──
  ipcMain.handle(IPC_CHANNELS.MCP_REGISTER_SERVER, async (event, config: MCPClientConfig): Promise<{ success: boolean; server?: McpServerInfo; error?: string }> => {
    try {
      validateMcpConfig(config)
      const server = serverManager.register(config)
      await persistCustomServers()
      event.sender.send(IPC_CHANNELS.MCP_SERVERS_CHANGED)
      const { client, ...info } = server
      return { success: true, server: info }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // ── Unregister a custom server ──
  ipcMain.handle(IPC_CHANNELS.MCP_UNREGISTER_SERVER, async (event, id: string): Promise<{ success: boolean; error?: string }> => {
    try {
      serverManager.unregister(id)
      await persistCustomServers()
      event.sender.send(IPC_CHANNELS.MCP_SERVERS_CHANGED)
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // ── Update a custom server config ──
  ipcMain.handle(IPC_CHANNELS.MCP_UPDATE_SERVER, async (event, id: string, config: MCPClientConfig): Promise<{ success: boolean; error?: string }> => {
    try {
      validateMcpConfig(config)
      // Re-register: unregister then register with same id
      const needRestart = serverManager.getServer(id)?.status === 'connected'
      serverManager.unregister(id)
      serverManager.register(config, id)
      if (needRestart) {
        await serverManager.start(id).catch(() => {})
      }
      await persistCustomServers()
      event.sender.send(IPC_CHANNELS.MCP_SERVERS_CHANGED)
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // ── Update a server's summary ──
  ipcMain.handle(IPC_CHANNELS.MCP_UPDATE_SERVER_SUMMARY, async (_event, id: string, summary: string) => {
    serverManager.setSummary(id, summary)
    await persistCustomServers()
  })
}
