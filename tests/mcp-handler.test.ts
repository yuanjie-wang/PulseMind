// review 20260925 item 9 (second tier) — the MCP IPC surface. Two layers:
// validateMcpConfig (pure input gate for a channel that ultimately SPAWNS
// processes) and the handler wiring, driven through the electron stub's ipcMain
// registry exactly like terminal-gate.test.ts. The manager and the
// SQLite-backed store are mocked: better-sqlite3 is Electron-ABI, and what the
// handlers owe the protocol is orchestration (validate → mutate → persist →
// notify), not the manager's internals (covered by mcp-client.test.ts).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain, resetStubIpcHandlers } from './stubs/electron'

const managerMock = vi.hoisted(() => ({
  listServers: vi.fn(),
  getServer: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  restart: vi.fn(),
  callTool: vi.fn(),
  register: vi.fn(),
  unregister: vi.fn(),
  setSummary: vi.fn(),
  markAutoStart: vi.fn(),
  isAutoStart: vi.fn(),
  startAutoStartServers: vi.fn(),
}))
vi.mock('../src/main/mcp/MCPServerManager', () => ({ serverManager: managerMock }))

const storeMock = vi.hoisted(() => ({
  getAll: vi.fn(),
  save: vi.fn(),
}))
vi.mock('../src/main/storage/mcp-server-store', () => ({ mcpServerStore: storeMock }))

const { registerMcpHandlers, validateMcpConfig, persistCustomServers } = await import('../src/main/ipc/mcp.handler')
const { IPC_CHANNELS } = await import('../src/shared/ipc-channels')

type IpcHandler = (...args: unknown[]) => unknown

function handler(channel: string): IpcHandler {
  const h = ipcMain.handlers.get(channel)
  if (!h) throw new Error(`no handler registered for ${channel}`)
  return h
}

let sender: { send: ReturnType<typeof vi.fn> }
let event: { sender: typeof sender }

beforeEach(() => {
  resetStubIpcHandlers()
  vi.clearAllMocks()
  storeMock.getAll.mockResolvedValue([])
  storeMock.save.mockResolvedValue(undefined)
  managerMock.listServers.mockReturnValue([])
  registerMcpHandlers()
  sender = { send: vi.fn() }
  event = { sender }
})

// ── validateMcpConfig — the gate in front of process spawn / remote URL ──

describe('validateMcpConfig', () => {
  it.each([
    [null, /配置必须是对象/],
    ['nope', /配置必须是对象/],
    [{}, /服务器名称不能为空/],
    [{ name: '   ' }, /服务器名称不能为空/],
    [{ name: 'a', transportType: 'ftp' }, /transportType 必须是/],
    [{ name: 'a', transportType: 'sse' }, /url 不能为空/],
    [{ name: 'a', transportType: 'streamable-http' }, /url 不能为空/],
    [{ name: 'a', transportType: 'sse', url: 'not a url' }, /url 格式无效/],
    [{ name: 'a', transportType: 'sse', url: 'https://x.dev/sse', headers: [] }, /headers 必须是对象/],
    [{ name: 'a' }, /启动命令不能为空/],
    [{ name: 'a', command: '   ' }, /启动命令不能为空/],
    [{ name: 'a', command: 'node', args: [1] }, /args 必须是字符串数组/],
    [{ name: 'a', command: 'node', env: 'x' }, /env 必须是对象/],
  ])('rejects %o', (config, message) => {
    expect(() => validateMcpConfig(config)).toThrow(message)
  })

  it('accepts valid stdio / sse / streamable-http configs', () => {
    expect(validateMcpConfig({ name: 'local', command: 'node', args: ['srv.mjs'], env: { K: 'V' } })).toBe(true)
    expect(validateMcpConfig({ name: 'sse', transportType: 'sse', url: 'https://x.dev/sse', headers: { Authorization: 'Bearer k' } })).toBe(true)
    expect(validateMcpConfig({ name: 'http', transportType: 'streamable-http', url: 'https://x.dev/mcp' })).toBe(true)
  })
})

// ── handler wiring ──

describe('MCP IPC handlers', () => {
  it('list/get return copies, unknown id reads null', () => {
    managerMock.listServers.mockReturnValue([{ id: 's1', name: 'S1' }])
    expect(handler(IPC_CHANNELS.MCP_LIST_SERVERS)(event)).toEqual([{ id: 's1', name: 'S1' }])

    managerMock.getServer.mockReturnValue(null)
    expect(handler(IPC_CHANNELS.MCP_GET_SERVER)(event, 'nope')).toBeNull()

    const tools = [{ name: 'echo' }]
    const server = { id: 's1', tools }
    managerMock.getServer.mockReturnValue(server)
    const got = handler(IPC_CHANNELS.MCP_GET_SERVER)(event, 's1') as { tools: unknown[] }
    expect(got.tools).toEqual(tools)
    expect(got.tools).not.toBe(tools) // defensive copy — a renderer write can't mutate the manager
  })

  it('start: success persists and notifies; failure reports without side effects', async () => {
    managerMock.start.mockResolvedValue(undefined)
    const ok = await handler(IPC_CHANNELS.MCP_START_SERVER)(event, 's1')
    expect(ok).toEqual({ success: true })
    expect(managerMock.start).toHaveBeenCalledWith('s1')
    expect(managerMock.markAutoStart).toHaveBeenCalledWith('s1', true)
    expect(storeMock.save).toHaveBeenCalled()               // persistCustomServers
    expect(sender.send).toHaveBeenCalledWith(IPC_CHANNELS.MCP_SERVERS_CHANGED)

    vi.clearAllMocks()
    storeMock.save.mockResolvedValue(undefined)
    managerMock.start.mockRejectedValue(new Error('spawn failed'))
    const fail = await handler(IPC_CHANNELS.MCP_START_SERVER)(event, 's1')
    expect(fail).toEqual({ success: false, error: 'spawn failed' })
    expect(managerMock.markAutoStart).not.toHaveBeenCalled()
    expect(storeMock.save).not.toHaveBeenCalled()
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('stop failure reports the error and skips persist/notify', async () => {
    managerMock.stop.mockRejectedValue(new Error('already stopped'))
    const res = await handler(IPC_CHANNELS.MCP_STOP_SERVER)(event, 's1')
    expect(res).toEqual({ success: false, error: 'already stopped' })
    expect(managerMock.markAutoStart).not.toHaveBeenCalled()
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('call-tool forwards the exact server/tool/args triple', async () => {
    managerMock.callTool.mockResolvedValue({ ok: true, result: 42 })
    const res = await handler(IPC_CHANNELS.MCP_CALL_TOOL)(event, 's1', 'echo', { text: 'hi' })
    expect(managerMock.callTool).toHaveBeenCalledWith('s1', 'echo', { text: 'hi' })
    expect(res).toEqual({ ok: true, result: 42 })
  })

  it('register: invalid config never reaches the manager', async () => {
    const res = await handler(IPC_CHANNELS.MCP_REGISTER_SERVER)(event, { name: '' }) as { success: boolean; error: string }
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/服务器名称不能为空/)
    expect(managerMock.register).not.toHaveBeenCalled()
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('register: valid config persists, notifies, and strips the client field', async () => {
    const config = { name: 'local', command: 'node', args: [] }
    managerMock.register.mockReturnValue({
      id: 's9', name: 'local', config, status: 'stopped',
      tools: [], serverInfo: null, client: { secret: 'runtime-client' },
    })
    const res = await handler(IPC_CHANNELS.MCP_REGISTER_SERVER)(event, config) as {
      success: boolean
      server: Record<string, unknown>
    }
    expect(res.success).toBe(true)
    expect(res.server).toEqual({
      id: 's9', name: 'local', config, status: 'stopped', tools: [], serverInfo: null,
    })
    expect('client' in res.server).toBe(false)   // the runtime client must not cross IPC
    expect(storeMock.save).toHaveBeenCalled()
    expect(sender.send).toHaveBeenCalledWith(IPC_CHANNELS.MCP_SERVERS_CHANGED)
  })

  it('update-server-summary writes through the manager and persists', async () => {
    await handler(IPC_CHANNELS.MCP_UPDATE_SERVER_SUMMARY)(event, 's1', 'my summary')
    expect(managerMock.setSummary).toHaveBeenCalledWith('s1', 'my summary')
    expect(storeMock.save).toHaveBeenCalled()
  })

  it('persistCustomServers maps the manager snapshot onto store records', async () => {
    managerMock.isAutoStart.mockReturnValue(true)
    managerMock.listServers.mockReturnValue([
      { id: 's1', name: 'S1', config: { name: 'S1', command: 'node' }, summary: 'sum' },
    ])
    await persistCustomServers()
    expect(storeMock.save).toHaveBeenCalledWith([
      { id: 's1', config: { name: 'S1', command: 'node' }, autoStart: true, summary: 'sum' },
    ])
  })
})
