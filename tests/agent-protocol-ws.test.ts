import { describe, expect, it } from 'vitest'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import WebSocket from 'ws'
import { startAgentService, type AgentServiceHandle, type AgentServiceConversations } from '../src/main/agent/ws-server'
import { agentClientRegistry } from '../src/main/agent/client-registry'
import { hostedToolProxy } from '../src/main/agent/hosted/proxy'
import { hostedPromptRouter } from '../src/main/agent/hosted/prompts'
import { PROTOCOL_VERSION, type AgentEventData } from '../src/shared/agent-protocol'
import type { AgentServiceSessions } from '../src/main/agent/service-sessions'
import type { SandboxApprovalMode } from '../src/shared/sandbox/policy'

// ── Test harness ─────────────────────────────────────────────────────

interface Frame { jsonrpc: '2.0'; id?: number | string | null; method?: string; params?: any; result?: any; error?: { code: number; message: string } }

class TestClient {
  private ws: WebSocket
  private pending = new Map<number, (res: Frame) => void>()
  private nextId = 1
  notifications: Array<{ method: string; params: any }> = []
  private openResolve: (() => void) | null = null

  /** `extraHeaders` must be passed at construction — the ws library reads
   *  them when the handshake request is built. */
  constructor(url: string, extraHeaders: Record<string, string> = {}) {
    this.ws = new WebSocket(url, { headers: extraHeaders })
    this.ws.on('open', () => this.openResolve?.())
    this.ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as Frame
      if (frame.method) {
        this.notifications.push({ method: frame.method, params: frame.params })
        return
      }
      const resolve = this.pending.get(frame.id as number)
      if (resolve) { this.pending.delete(frame.id as number); resolve(frame) }
    })
  }

  open(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return Promise.resolve()
    return new Promise((resolve) => { this.openResolve = resolve })
  }

  closed(): Promise<number> {
    return new Promise((resolve) => this.ws.on('close', (code) => resolve(code)))
  }

  request(method: string, params?: unknown, timeoutMs = 5_000): Promise<Frame> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`request timeout: ${method}`)), timeoutMs)
      this.pending.set(id, (frame) => { clearTimeout(timer); resolve(frame) })
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  notify(method: string, params?: unknown): void {
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }))
  }

  async hello(clientId: string): Promise<Frame> {
    return this.request('hello', { clientId, clientVersion: 'test', protocolVersion: PROTOCOL_VERSION })
  }

  /** Wait for the first notification matching `method`. */
  waitFor(method: string, timeoutMs = 4_000): Promise<{ method: string; params: any }> {
    const found = this.notifications.find((n) => n.method === method)
    if (found) return Promise.resolve(found)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${method} within ${timeoutMs}ms`)), timeoutMs)
      const originalPush = this.notifications.push.bind(this.notifications)
      this.notifications.push = (...items: Array<{ method: string; params: any }>) => {
        const r = originalPush(...items)
        for (const item of items) {
          if (item.method === method) { clearTimeout(timer); resolve(item) }
        }
        return r
      }
    })
  }

  close(): void {
    this.ws.close()
  }
}

/** Minimal session-manager fake: records calls, exposes the event sink. */
interface FakeSessions extends AgentServiceSessions {
  created: Array<{ sessionId: string; opts: any }>
  asks: Array<{ sessionId: string; content: string; pageContext: any }>
  engineCalls: Array<{ sessionId: string; method: string; args: unknown[] }>
  /** Mutable model state + the switch log. 模型切换 is global, so what the tests
   *  assert is what the service forwarded, not a per-session field. */
  model: { profiles: Array<{ id: string; name?: string; provider?: string; model: string }>; activeId: string }
  switched: string[]
  /** 授权 writes that reached the manager (the remote 授权 button). */
  approvalModes: Array<{ sessionId: string; mode: SandboxApprovalMode }>
  emit: (sessionId: string, data: AgentEventData) => void
  setAskHandler: (fn: (sessionId: string, content: string, pageContext: any) => Promise<void>) => void
}

function makeFakeSessions(): FakeSessions {
  const sinks: Array<(sessionId: string, data: AgentEventData) => void> = []
  const state = {
    created: [] as Array<{ sessionId: string; opts: any }>,
    asks: [] as Array<{ sessionId: string; content: string; pageContext: any }>,
    engineCalls: [] as Array<{ sessionId: string; method: string; args: unknown[] }>,
    askHandler: null as null | ((sessionId: string, content: string, pageContext: any) => Promise<void>),
    model: {
      profiles: [
        { id: 'p1', name: 'GPT-4o', provider: 'openai', model: 'gpt-4o' },
        { id: 'p2', name: 'Claude', provider: 'anthropic', model: 'claude-sonnet-4-5' },
      ],
      activeId: 'p1',
    },
    switched: [] as string[],
    approvalModes: [] as Array<{ sessionId: string; mode: SandboxApprovalMode }>,
  }
  const live = new Set<string>()
  return {
    get created() { return state.created },
    get asks() { return state.asks },
    get engineCalls() { return state.engineCalls },
    get model() { return state.model },
    get switched() { return state.switched },
    get approvalModes() { return state.approvalModes },
    // The real manager writes the conversation column and re-resolves the live
    // engine; the fake records the write and echoes the level back, which is
    // what the caller reconciles against.
    setApprovalMode: async (sessionId: string, mode: SandboxApprovalMode) => {
      state.approvalModes.push({ sessionId, mode })
      return mode
    },
    // The real manager validates against settings.profiles; the fake refuses an
    // unknown id the same way, so the error path is exercised end to end.
    modelState: async () => ({ profiles: state.model.profiles, activeId: state.model.activeId }),
    setActiveProfile: async (profileId: string) => {
      if (!state.model.profiles.some((p) => p.id === profileId)) throw new Error(`unknown profile: ${profileId}`)
      state.model.activeId = profileId
      state.switched.push(profileId)
      return { profiles: state.model.profiles, activeId: state.model.activeId }
    },
    emit: (sessionId, data) => { for (const s of sinks) s(sessionId, data) },
    setAskHandler: (fn) => { state.askHandler = fn },
    createSession: async (sessionId, opts) => {
      state.created.push({ sessionId, opts })
      live.add(sessionId)
      return { sessionId, agentId: opts?.agentId ?? 'default' }
    },
    ask: async (sessionId, content, pageContext) => {
      state.asks.push({ sessionId, content, pageContext })
      // The real manager starts the loop and returns: it does NOT await the
      // turn. Reverse traffic (tool.call / approval.request / ask_user.request)
      // therefore lands after the ask RPC has already settled — which is
      // exactly the window an ask-scoped client binding fails in. Deferring
      // here keeps that window visible to these tests.
      const handler = state.askHandler
      if (handler) setTimeout(() => void handler(sessionId, content, pageContext), 0)
    },
    cancel: () => {},
    history: async () => ({ messages: [], agentId: 'default' }),
    hasSession: (sessionId) => live.has(sessionId),
    hydrate: async () => {},
    engineCall: async (sessionId, method, args = []) => {
      state.engineCalls.push({ sessionId, method, args })
      return undefined
    },
    onEvent: (sink) => {
      sinks.push(sink)
      return () => { const i = sinks.indexOf(sink); if (i >= 0) sinks.splice(i, 1) }
    },
  }
}

/** In-memory conversations store (better-sqlite3 is Electron-ABI and cannot
 *  load under plain Node — the repo's known DB-layer test gap). */
type FakeRow = { title: string; origin: string | null; updatedAt: string; approvalMode?: SandboxApprovalMode }
function makeFakeStore(): AgentServiceConversations & { rows: Map<string, FakeRow> } {
  const rows = new Map<string, FakeRow>()
  return {
    rows,
    hydrate: (id) => {
      const row = rows.get(id)
      return row ? { title: row.title, messages: [], historySummary: undefined, historySummaryFrontier: undefined } : null
    },
    listByOrigin: (origin, limit) => {
      const found = [...rows.entries()]
        .filter(([, r]) => r.origin === origin)
        .sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt))
        .slice(0, limit)
        // approvalMode rides along (the real listConversationsByOrigin reads
        // `conversations.approval_mode`): the panel's snapshot prefers it over
        // its own tab-local carry-over, so losing it here would reopen the
        // "the panel and the desktop disagree" bug.
        .map(([id, r]) => ({ id, title: r.title, updatedAt: r.updatedAt, approvalMode: r.approvalMode }))
      return found
    },
    origin: (id) => rows.get(id)?.origin ?? null,
    remove: (id) => { rows.delete(id) },
    rename: (id, title) => { const r = rows.get(id); if (r) r.title = title },
  }
}

async function start(token = 'test-token', sessions = makeFakeSessions(), store = makeFakeStore()): Promise<{ handle: AgentServiceHandle; sessions: FakeSessions; store: ReturnType<typeof makeFakeStore> }> {
  const handle = await startAgentService({ port: 0, token, sessions, store })
  return { handle, sessions: sessions as FakeSessions, store: store as ReturnType<typeof makeFakeStore> }
}

/** Poll until `predicate` holds — for state that settles across event ticks
 *  (socket close, a deferred reverse call) rather than one awaited promise. */
async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('waitUntil: condition not met in time')
}

/** Open, hello, create a session — the common preamble. */
async function openWithSession(handle: AgentServiceHandle, clientId = 'pulsemind-extension'): Promise<{ client: TestClient; sessionId: string }> {
  const client = new TestClient(`ws://127.0.0.1:${handle.port}/?token=${handle.token}`)
  await client.open()
  await client.hello(clientId)
  const created = await client.request('session.create', {})
  return { client, sessionId: (created.result as { sessionId: string }).sessionId }
}

// ── M0.3: origin policy + pairing ──────────────────────────────────────

describe('M0.3 origin policy + token pairing', () => {
  it('rejects web-page origins even with a valid token (close 4403)', async () => {
    const { handle } = await start()
    try {
      const client = new TestClient(`ws://127.0.0.1:${handle.port}/?token=${handle.token}`, { Origin: 'https://evil.example' })
      const code = await client.closed()
      expect(code).toBe(4403)
    } finally {
      await handle.close()
    }
  })

  it('accepts extension origins and bare (non-browser) clients', async () => {
    const { handle } = await start()
    try {
      const ext = new TestClient(`ws://127.0.0.1:${handle.port}/?token=${handle.token}`, { Origin: 'chrome-extension://abcdefg' })
      await ext.open()
      expect((await ext.hello('pulsemind-extension')).result).toMatchObject({ protocolVersion: PROTOCOL_VERSION })
      ext.close()

      const bare = new TestClient(`ws://127.0.0.1:${handle.port}/?token=${handle.token}`)
      await bare.open()
      expect((await bare.hello('cli-client')).result).toMatchObject({ protocolVersion: PROTOCOL_VERSION })
      bare.close()
    } finally {
      await handle.close()
    }
  })

  it('GET /token pairs for extension origins, 403 for web pages / foreign hosts', async () => {
    const { handle } = await start()
    try {
      const rawGet = (headers: Record<string, string>): Promise<{ status: number; body: string }> =>
        new Promise((resolve, reject) => {
          const req = httpRequest({ host: '127.0.0.1', port: handle.port, path: '/token', headers }, (res) => {
            let body = ''
            res.on('data', (d) => { body += d })
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
          })
          req.on('error', reject)
          req.end()
        })

      // node:http allows forging Host (undici's fetch silently ignores it),
      // which is exactly the DNS-rebinding shape the endpoint must refuse.
      const ext = await rawGet({ Origin: 'chrome-extension://abcdefg' })
      expect(ext.status).toBe(200)
      expect(JSON.parse(ext.body)).toMatchObject({ token: handle.token })

      const web = await rawGet({ Origin: 'https://evil.example' })
      expect(web.status).toBe(403)

      const rebinding = await rawGet({ Host: 'evil.example' })
      expect(rebinding.status).toBe(403)
    } finally {
      await handle.close()
    }
  })

  it('falls back deterministically when the requested port is taken', async () => {
    const occupier = createHttpServer((_q, res) => res.end())
    await new Promise<void>((resolve) => occupier.listen(0, '127.0.0.1', resolve))
    const takenPort = (occupier.address() as { port: number }).port
    let handle: AgentServiceHandle | null = null
    try {
      handle = await startAgentService({ port: takenPort, token: 't', sessions: makeFakeSessions(), store: makeFakeStore() })
      expect(handle.port).toBeGreaterThan(takenPort)
      expect(handle.port - takenPort).toBeLessThanOrEqual(14)
    } finally {
      await handle?.close()
      await new Promise<void>((resolve) => occupier.close(() => resolve()))
    }
  })
})

// ── handle.clients() — the settings panel's 已连接的客户端 ────────────────
// serviceGetStatus reads exactly this method, so a handle without it made
// every status fetch throw while the service ran: the toggle "never changed"
// and the client list stayed empty even with the extension connected.

describe('handle.clients() — the connected-client list', () => {
  it('lists helloed clients with their session count and hides pre-hello sockets', async () => {
    const { handle } = await start()
    try {
      // Connected but hello not sent: not a client worth listing.
      const silent = new TestClient(`ws://127.0.0.1:${handle.port}/?token=${handle.token}`)
      await silent.open()
      expect(handle.clients()).toEqual([])

      const { client } = await openWithSession(handle)
      expect(handle.clients()).toEqual([{ clientId: 'pulsemind-extension', sessions: 1 }])

      await client.request('session.create', {})
      expect(handle.clients()).toEqual([{ clientId: 'pulsemind-extension', sessions: 2 }])

      client.close()
      silent.close()
      await waitUntil(() => handle.clients().length === 0)
    } finally {
      await handle.close()
    }
  })

  it('a replaced connection (same clientId) is listed once', async () => {
    const { handle } = await start()
    try {
      const first = new TestClient(`ws://127.0.0.1:${handle.port}/?token=${handle.token}`)
      await first.open()
      await first.hello('pulsemind-extension')

      const second = new TestClient(`ws://127.0.0.1:${handle.port}/?token=${handle.token}`)
      await second.open()
      await second.hello('pulsemind-extension')

      await waitUntil(() => handle.clients().length === 1)
      expect(handle.clients()).toEqual([{ clientId: 'pulsemind-extension', sessions: 0 }])

      first.close()
      second.close()
      await waitUntil(() => handle.clients().length === 0)
    } finally {
      await handle.close()
    }
  })
})

// ── M0.4: session resume / list / delete / rename + pageContext ─────────

describe('M0.4 session surface', () => {
  it('session.create resumes a stored conversation (resumed=true) and hydrates', async () => {
    const { handle, sessions, store } = await start()
    try {
      store.rows.set('ws_resume_1', { title: '旧会话', origin: 'pulsemind-extension', updatedAt: new Date().toISOString() })

      const client = new TestClient(`ws://127.0.0.1:${handle.port}/?token=${handle.token}`)
      await client.open()
      await client.hello('pulsemind-extension')

      const res = await client.request('session.create', { sessionId: 'ws_resume_1' })
      expect(res.result).toMatchObject({ sessionId: 'ws_resume_1', resumed: true })
      expect(sessions.created.some((c) => c.sessionId === 'ws_resume_1' && c.opts.title === '旧会话')).toBe(true)

      // Second create for a live session → not a resume.
      const again = await client.request('session.create', { sessionId: 'ws_resume_1' })
      expect(again.result).toMatchObject({ sessionId: 'ws_resume_1', resumed: false })

      // Stale id → fresh session with a server-generated id.
      const stale = await client.request('session.create', { sessionId: 'ws_gone' })
      expect(stale.result.sessionId).not.toBe('ws_gone')

      client.close()
    } finally {
      await handle.close()
    }
  })

  it('agent.ask forwards pageContext and the loop completes via a tool.result', async () => {
    const { handle, sessions } = await start()
    try {
      const { client, sessionId } = await openWithSession(handle)

      // The fake ask drives a real hosted tool call through the bound transport.
      sessions.setAskHandler(async (sid) => {
        const transport = agentClientRegistry.get(sid)
        const result = await hostedToolProxy.call(transport, sid, 'page_get_content', { viewportExpansion: 0 })
        sessions.emit(sid, { type: 'token', blockType: 'text', text: String(result) })
      })

      const askPromise = client.request('agent.ask', {
        sessionId,
        content: '总结这个页面',
        pageContext: { url: 'https://example.com/b', title: '页面 B' },
      }, 8_000)

      const call = await client.waitFor('tool.call')
      expect(call.params.tool).toBe('page_get_content')
      expect(call.params.sessionId).toBe(sessionId)
      client.notify('tool.result', { callId: call.params.callId, ok: true, result: '[1]<input placeholder=搜索 />' })

      const askRes = await askPromise
      expect(askRes.result).toMatchObject({ accepted: true, status: 'completed' })

      const ask = sessions.asks.at(-1)
      expect(ask?.content).toBe('总结这个页面')
      expect(ask?.pageContext).toMatchObject({ url: 'https://example.com/b', title: '页面 B' })

      // The reverse traffic lands after the ask RPC settled (see the fake's
      // deferred handler), so the loop's continuation is awaited by arrival.
      await waitUntil(() =>
        client.notifications.some(
          (n) => n.method === 'agent.event' && n.params.sessionId === sessionId && n.params.data.type === 'token' && n.params.data.text.includes('[1]<input'),
        ),
      )

      client.close()
    } finally {
      await handle.close()
    }
  })

  it('tool.call timeout settles the reverse call (the loop never stalls)', async () => {
    const { handle, sessions } = await start()
    try {
      const { client, sessionId } = await openWithSession(handle)

      // A 200ms budget that is never answered → the proxy must settle the call
      // with an error instead of parking the loop (the engine turns it into an
      // is_error tool result).
      const failures: string[] = []
      sessions.setAskHandler(async (sid) => {
        await hostedToolProxy
          .call(agentClientRegistry.get(sid), sid, 'page_click', { index: 3 }, 200)
          .catch((err: Error) => failures.push(err.message))
      })

      const res = await client.request('agent.ask', { sessionId, content: '点它' }, 8_000)
      expect(res.result).toMatchObject({ accepted: true })
      await waitUntil(() => failures.length > 0)
      expect(failures[0]).toContain('超时')

      client.close()
    } finally {
      await handle.close()
    }
  })

  it('drops orphan tool.result without disturbing the connection', async () => {
    const { handle } = await start()
    try {
      const { client } = await openWithSession(handle)
      client.notify('tool.result', { callId: 'no-such-call', ok: true, result: 'x' })
      const ping = await client.request('ping')
      expect(ping.result).toMatchObject({ pong: true })
      client.close()
    } finally {
      await handle.close()
    }
  })

  it('routes approval.request to the asking client and approval.response back into the engine', async () => {
    const { handle, sessions } = await start()
    try {
      const { client, sessionId } = await openWithSession(handle)

      // The fold the engine performs when it parks on a held tool call.
      sessions.setAskHandler((sid) => {
        sessions.emit(sid, {
          type: 'status',
          status: 'awaiting_approval',
          tools: [{ toolUseId: 'tu_1', name: 'page_click', detail: '{"index":3}' }],
        })
      })

      // The ask settles long before the prompt exists — the binding has to
      // outlive it for the card to reach anyone (the deferred fake ask emits
      // the status only after this RPC is done).
      const askRes = await client.request('agent.ask', { sessionId, content: '点它' }, 8_000)
      expect(askRes.result).toMatchObject({ accepted: true })
      expect(agentClientRegistry.get(sessionId)).toBeDefined()

      const req = await client.waitFor('approval.request')
      expect(req.params).toMatchObject({ sessionId, callId: 'tu_1', kind: 'browser_write' })
      expect(req.params.summary).toContain('page_click')

      client.notify('approval.response', { callId: 'tu_1', approved: true })
      await waitUntil(() => sessions.engineCalls.some((c) => c.method === 'approveTool' && c.args[0] === 'tu_1'))

      client.close()
    } finally {
      await handle.close()
    }
  })

  it('routes ask_user and iteration_limit responses into the engine', async () => {
    const { handle, sessions } = await start()
    try {
      const { client, sessionId } = await openWithSession(handle)

      sessions.setAskHandler((sid) => {
        sessions.emit(sid, {
          type: 'status',
          status: 'awaiting_user_input',
          tools: [{ toolUseId: 'tu_q', name: 'ask_user', detail: '{"prompt":"选一个"}', args: { prompt: '选一个', choices: ['甲', '乙'] } }],
        })
      })

      const askRes = await client.request('agent.ask', { sessionId, content: '问吧' }, 8_000)
      expect(askRes.result).toMatchObject({ accepted: true })

      const req = await client.waitFor('ask_user.request')
      expect(req.params).toMatchObject({ sessionId, callId: 'tu_q', question: '选一个' })

      client.notify('ask_user.response', { callId: 'tu_q', response: '甲' })
      client.notify('iteration_limit.response', { sessionId, approved: true })
      await waitUntil(() => sessions.engineCalls.some((c) => c.method === 'respondToTool' && c.args[0] === 'tu_q' && c.args[1] === '甲'))
      await waitUntil(() => sessions.engineCalls.some((c) => c.method === 'extendLoop'))

      client.close()
    } finally {
      await handle.close()
    }
  })

  it('releases the session binding when the connection drops', async () => {
    const { handle, sessions } = await start()
    try {
      const { client, sessionId } = await openWithSession(handle)

      sessions.setAskHandler((sid) => {
        sessions.emit(sid, {
          type: 'status',
          status: 'awaiting_user_input',
          tools: [{ toolUseId: 'tu_q', name: 'ask_user', detail: '{"prompt":"选一个"}', args: { prompt: '选一个', choices: ['甲'] } }],
        })
      })
      await client.request('agent.ask', { sessionId, content: '问吧' }, 8_000)
      await client.waitFor('ask_user.request')
      const pending = hostedPromptRouter.pendingCounts()

      // A dead connection can no longer serve this session: the binding goes,
      // and the parked question is settled so the loop is not left waiting.
      client.close()
      await waitUntil(() => agentClientRegistry.get(sessionId) === undefined)
      expect(agentClientRegistry.isHostedCapable(sessionId)).toBe(false)
      expect(hostedPromptRouter.pendingCounts().asks).toBeLessThan(pending.asks)
      expect(sessions.engineCalls.some((c) => c.method === 'respondToTool' && c.args[0] === 'tu_q')).toBe(true)
    } finally {
      await handle.close()
    }
  })

  it('session.list / rename / delete scope to the calling client origin', async () => {
    const { handle, store } = await start()
    try {
      store.rows.set('ws_a', { title: 'A', origin: 'pulsemind-extension', updatedAt: new Date().toISOString() })
      store.rows.set('ws_b', { title: 'B', origin: 'some-other-client', updatedAt: new Date().toISOString() })

      const ext = new TestClient(`ws://127.0.0.1:${handle.port}/?token=${handle.token}`)
      await ext.open()
      await ext.hello('pulsemind-extension')

      const list = await ext.request('session.list', {})
      const ids = (list.result as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id)
      expect(ids).toContain('ws_a')
      expect(ids).not.toContain('ws_b')

      const renamed = await ext.request('session.rename', { sessionId: 'ws_a', title: 'A2' })
      expect(renamed.result).toMatchObject({ ok: true })
      expect(store.rows.get('ws_a')?.title).toBe('A2')

      // Cross-client rename is forbidden.
      const foreign = new TestClient(`ws://127.0.0.1:${handle.port}/?token=${handle.token}`)
      await foreign.open()
      await foreign.hello('some-other-client')
      const denied = await foreign.request('session.rename', { sessionId: 'ws_a', title: 'X' })
      expect(denied.error?.code).toBe(-32005)

      const del = await ext.request('session.delete', { sessionId: 'ws_a' })
      expect(del.result).toMatchObject({ ok: true })
      expect(store.rows.has('ws_a')).toBe(false)

      ext.close()
      foreign.close()
    } finally {
      await handle.close()
    }
  })
})

// ── M4.5: 模型切换 (global, mirrors the desktop's own picker) ────────────

describe('M4.5 模型切换', () => {
  it('session.list carries the model state (one round trip for the panel)', async () => {
    const { handle } = await start()
    try {
      const client = new TestClient(`ws://127.0.0.1:${handle.port}/?token=${handle.token}`)
      await client.open()
      await client.hello('pulsemind-extension')

      const list = await client.request('session.list', {})
      expect(list.result).toMatchObject({ model: { activeId: 'p1' } })
      expect((list.result as { model: { profiles: unknown[] } }).model.profiles).toHaveLength(2)
      // Never on the wire: the profile's credentials and endpoint.
      expect(JSON.stringify(list.result)).not.toContain('apiKey')
      expect(JSON.stringify(list.result)).not.toContain('baseURL')

      client.close()
    } finally {
      await handle.close()
    }
  })

  it('model.list answers the picker inventory', async () => {
    const { handle } = await start()
    try {
      const client = new TestClient(`ws://127.0.0.1:${handle.port}/?token=${handle.token}`)
      await client.open()
      await client.hello('pulsemind-extension')

      const res = await client.request('model.list', {})
      expect(res.result).toMatchObject({
        activeId: 'p1',
        profiles: [
          { id: 'p1', name: 'GPT-4o', provider: 'openai', model: 'gpt-4o' },
          { id: 'p2', name: 'Claude', provider: 'anthropic', model: 'claude-sonnet-4-5' },
        ],
      })

      client.close()
    } finally {
      await handle.close()
    }
  })

  it('model.setActive writes the active profile and answers the new state', async () => {
    const { handle, sessions } = await start()
    try {
      const client = new TestClient(`ws://127.0.0.1:${handle.port}/?token=${handle.token}`)
      await client.open()
      await client.hello('pulsemind-extension')

      const res = await client.request('model.setActive', { profileId: 'p2' })
      expect(res.result).toMatchObject({ ok: true, model: { activeId: 'p2' } })
      expect(sessions.switched).toEqual(['p2'])

      client.close()
    } finally {
      await handle.close()
    }
  })

  it('model.setActive rejects an empty or unknown profileId', async () => {
    const { handle, sessions } = await start()
    try {
      const client = new TestClient(`ws://127.0.0.1:${handle.port}/?token=${handle.token}`)
      await client.open()
      await client.hello('pulsemind-extension')

      const empty = await client.request('model.setActive', {})
      expect(empty.error?.code).toBe(-32602)
      const unknown = await client.request('model.setActive', { profileId: 'nope' })
      expect(unknown.error?.code).toBe(-32602)
      expect(unknown.error?.message).toContain('unknown profile')
      // Neither reached the manager, so the active profile never moved.
      expect(sessions.switched).toEqual([])
      expect((sessions.model as { activeId: string }).activeId).toBe('p1')

      client.close()
    } finally {
      await handle.close()
    }
  })

  it('session.setApprovalMode writes through and answers the level in force', async () => {
    const { handle, sessions } = await start()
    try {
      const { client, sessionId } = await openWithSession(handle)

      const res = await client.request('session.setApprovalMode', { sessionId, mode: 'always-ask' })
      expect(res.result).toMatchObject({ ok: true, mode: 'always-ask' })
      expect(sessions.approvalModes).toEqual([{ sessionId, mode: 'always-ask' }])

      // Back again: the panel is a toggle, not a one-way widening.
      const back = await client.request('session.setApprovalMode', { sessionId, mode: 'auto' })
      expect(back.result).toMatchObject({ ok: true, mode: 'auto' })
      expect(sessions.approvalModes.at(-1)).toEqual({ sessionId, mode: 'auto' })

      client.close()
    } finally {
      await handle.close()
    }
  })

  it('session.setApprovalMode answers what the service settled on, not what it was asked for', async () => {
    // A pinned, unattended run keeps its own level however the column is
    // written. The reply is what the panel echoes, so it must be the service's
    // answer — otherwise a click on 全部允许 would look applied while the run
    // still held its calls.
    const sessions = makeFakeSessions()
    sessions.setApprovalMode = async () => 'outside-ask'
    const { handle } = await start('test-token', sessions)
    try {
      const { client, sessionId } = await openWithSession(handle)
      const res = await client.request('session.setApprovalMode', { sessionId, mode: 'auto' })
      expect(res.result).toMatchObject({ ok: true, mode: 'outside-ask' })
      client.close()
    } finally {
      await handle.close()
    }
  })

  it('session.setApprovalMode refuses a missing sessionId or an unknown level', async () => {
    const { handle, sessions } = await start()
    try {
      const client = new TestClient(`ws://127.0.0.1:${handle.port}/?token=${handle.token}`)
      await client.open()
      await client.hello('pulsemind-extension')

      const noSession = await client.request('session.setApprovalMode', { mode: 'auto' })
      expect(noSession.error?.code).toBe(-32602)
      const badMode = await client.request('session.setApprovalMode', { sessionId: 'ws_1', mode: 'yolo' })
      expect(badMode.error?.code).toBe(-32602)
      // Neither reached the manager, so nothing was written onto a conversation.
      expect(sessions.approvalModes).toEqual([])

      client.close()
    } finally {
      await handle.close()
    }
  })

  it('session.list carries the stored 授权 level to the client', async () => {
    const { handle, store } = await start()
    try {
      const { client, sessionId } = await openWithSession(handle)
      store.rows.set(sessionId, {
        title: '标签页会话',
        origin: 'pulsemind-extension',
        updatedAt: new Date().toISOString(),
        approvalMode: 'always-ask',
      })

      const list = await client.request('session.list', {})
      expect(list.result).toMatchObject({ sessions: [{ id: sessionId, approvalMode: 'always-ask' }] })

      client.close()
    } finally {
      await handle.close()
    }
  })

  it('session.list still answers when the model read fails', async () => {
    const sessions = makeFakeSessions()
    sessions.modelState = async () => {
      throw new Error('settings unavailable')
    }
    const { handle } = await start('test-token', sessions)
    try {
      const client = new TestClient(`ws://127.0.0.1:${handle.port}/?token=${handle.token}`)
      await client.open()
      await client.hello('pulsemind-extension')

      // The inventory is a side dish: its failure must not cost the caller the
      // session list it actually asked for.
      const list = await client.request('session.list', {})
      expect(list.result).toMatchObject({ sessions: [] })

      client.close()
    } finally {
      await handle.close()
    }
  })
})

// ── M0.4: pageContext in the system prompt ──────────────────────────────
// Moved to the per-turn state block: the page is per-turn state (the user
// navigates), and the system prompt is now the frozen cache prefix — a page URL
// in it would re-bill the tool schemas and the whole conversation on every
// navigation.

describe('M0.4 Current Page prompt section', () => {
  it('carries the page in the per-turn state block, never in the cached prefix', async () => {
    const { buildSystemPrompt } = await import('../src/renderer/src/agent/system-prompt-builder')
    const result = await buildSystemPrompt({
      opts: { pageContext: { url: 'https://example.com/a', title: '示例页' } } as never,
      messages: [],
      plan: null,
    })
    expect(result.stateBlock).toContain('## Current Page')
    expect(result.stateBlock).toContain('https://example.com/a')
    expect(result.stateBlock).toContain('示例页')
    expect(result.systemPrompt).not.toContain('## Current Page')
  })

  it('omits the section when no pageContext is set', async () => {
    const { buildSystemPrompt } = await import('../src/renderer/src/agent/system-prompt-builder')
    const result = await buildSystemPrompt({
      opts: {} as never,
      messages: [],
      plan: null,
    })
    expect(result.stateBlock).not.toContain('## Current Page')
  })
})

// ── M0.4: desktop list exclusion (裁定 3) — static check, the SQL lives in a
// native module we cannot load under plain Node ──

describe('M0.4 desktop list excludes hosted sessions', () => {
  it('listConversations filters hosted origins in SQL', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'main', 'storage', 'conversation.db.ts'), 'utf-8')
    expect(src).toMatch(/c\.origin IS NULL OR c\.origin NOT IN/)
  })

  // The stamp must create the row: a session exists before its first message is
  // persisted, so an UPDATE-only stamp silently does nothing — the row later
  // created by persistence carries no origin, which both leaks the session into
  // the desktop chat list and hides it from the panel's own session list
  // (found while wiring M1.4 against the live service).
  it('updateConversationOrigin upserts so a pre-persist session is stamped', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'main', 'storage', 'conversation.db.ts'), 'utf-8')
    const body = src.slice(src.indexOf('export function updateConversationOrigin'))
    const fn = body.slice(0, body.indexOf('\n}'))
    expect(fn).toMatch(/INSERT INTO conversations/)
    expect(fn).toMatch(/ON CONFLICT\(id\) DO UPDATE SET origin = excluded\.origin/)
  })
})
