import { describe, expect, it } from 'vitest'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import WebSocket from 'ws'
import { startAgentService, type AgentServiceHandle, type AgentServiceConversations } from '../src/main/agent/ws-server'
import { agentClientRegistry } from '../src/main/agent/client-registry'
import { hostedToolProxy } from '../src/main/agent/hosted/proxy'
import { hostedPromptRouter } from '../src/main/agent/hosted/prompts'
import { ErrorCodes, PROTOCOL_VERSION, type AgentEventData } from '../src/shared/agent-protocol'
import type { AgentServiceSessions } from '../src/main/agent/service-sessions'
import type { SandboxApprovalMode } from '../src/shared/sandbox/policy'

// ── Test harness ─────────────────────────────────────────────────────

interface Frame {
  jsonrpc: '2.0'
  id?: number | string | null
  method?: string
  params?: any
  result?: any
  error?: { code: number; message: string }
}

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
      if (resolve) {
        this.pending.delete(frame.id as number)
        resolve(frame)
      }
    })
  }

  open(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return Promise.resolve()
    return new Promise((resolve) => {
      this.openResolve = resolve
    })
  }

  closed(): Promise<number> {
    return new Promise((resolve) => this.ws.on('close', (code) => resolve(code)))
  }

  request(method: string, params?: unknown, timeoutMs = 5_000): Promise<Frame> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`request timeout: ${method}`)), timeoutMs)
      this.pending.set(id, (frame) => {
        clearTimeout(timer)
        resolve(frame)
      })
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  notify(method: string, params?: unknown): void {
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }))
  }

  async hello(clientId: string, instanceId?: string): Promise<Frame> {
    return this.request('hello', {
      clientId,
      // Omitted, not empty: an empty suffix must be indistinguishable from a
      // legacy client (see HelloParams.instanceId).
      ...(instanceId ? { instanceId } : {}),
      clientVersion: 'test',
      protocolVersion: PROTOCOL_VERSION,
    })
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
          if (item.method === method) {
            clearTimeout(timer)
            resolve(item)
          }
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
  /** Per-session 模型 writes that reached the manager (remote 模型下拉). */
  sessionModels: Array<{ sessionId: string; profileId: string | null }>
  /** Session ids the model.list was asked for (undefined = global default). */
  modelStateCalls: Array<string | undefined>
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
    sessionModels: [] as Array<{ sessionId: string; profileId: string | null }>,
    modelStateCalls: [] as Array<string | undefined>,
    /** The live transcript a snapshot() would answer with (the persistence
     *  tests seed it before emitting a turn end). */
    messages: [] as unknown[],
    /** snapshot() 的状态面（handoff 守卫测试拨它）：真实 manager 的 snapshot
     *  恒带 status，fake 缺省 idle。 */
    snapshotStatus: 'idle' as string,
  }
  const live = new Set<string>()
  return {
    get created() {
      return state.created
    },
    get asks() {
      return state.asks
    },
    get engineCalls() {
      return state.engineCalls
    },
    get model() {
      return state.model
    },
    get switched() {
      return state.switched
    },
    get approvalModes() {
      return state.approvalModes
    },
    get sessionModels() {
      return state.sessionModels
    },
    get modelStateCalls() {
      return state.modelStateCalls
    },
    get state() {
      return state
    },
    get live() {
      return live
    },
    // The real manager writes the conversation column and re-resolves the live
    // engine; the fake records the write and echoes the level back, which is
    // what the caller reconciles against.
    setApprovalMode: async (sessionId: string, mode: SandboxApprovalMode) => {
      state.approvalModes.push({ sessionId, mode })
      return mode
    },
    // The real manager validates against settings.profiles; the fake refuses an
    // unknown id the same way, so the error path is exercised end to end.
    modelState: async (sessionId?: string) => {
      state.modelStateCalls.push(sessionId)
      const activeId = sessionId
        ? // Mirror the real scoping: the session's own pin when it has one,
          // the global default otherwise.
          (state.sessionModels.find((m) => m.sessionId === sessionId && m.profileId)?.profileId ?? state.model.activeId)
        : state.model.activeId
      return { profiles: state.model.profiles, activeId }
    },
    setActiveProfile: async (profileId: string) => {
      if (!state.model.profiles.some((p) => p.id === profileId)) throw new Error(`unknown profile: ${profileId}`)
      state.model.activeId = profileId
      state.switched.push(profileId)
      return { profiles: state.model.profiles, activeId: state.model.activeId }
    },
    // The real manager writes conversations.profile_id and answers with the
    // model in force for THAT session; the fake records the write and scopes
    // the answer to the session, which is what the panel reconciles against.
    setSessionProfile: async (sessionId: string, profileId: string | null) => {
      if (profileId && !state.model.profiles.some((p) => p.id === profileId)) throw new Error(`unknown profile: ${profileId}`)
      state.sessionModels.push({ sessionId, profileId })
      const activeId = profileId ?? state.model.activeId
      return { profiles: state.model.profiles, activeId }
    },
    emit: (sessionId, data) => {
      for (const s of sinks) s(sessionId, data)
    },
    setAskHandler: (fn) => {
      state.askHandler = fn
    },
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
    history: async () => ({ messages: state.messages, agentId: 'default' }),
    snapshot: async () => (live.size > 0 ? { messages: state.messages, status: { status: state.snapshotStatus } } : null),
    hasSession: (sessionId) => live.has(sessionId),
    hydrate: async () => {},
    engineCall: async (sessionId, method, args = []) => {
      state.engineCalls.push({ sessionId, method, args })
      return undefined
    },
    onEvent: (sink) => {
      sinks.push(sink)
      return () => {
        const i = sinks.indexOf(sink)
        if (i >= 0) sinks.splice(i, 1)
      }
    },
  }
}

/** In-memory conversations store (better-sqlite3 is Electron-ABI and cannot
 *  load under plain Node — the repo's known DB-layer test gap). */
type FakeRow = { title: string; origin: string | null; updatedAt: string; approvalMode?: SandboxApprovalMode; tabKey?: string | undefined }
function makeFakeStore(): AgentServiceConversations & { rows: Map<string, FakeRow>; savedConversations: Map<string, unknown> } {
  const rows = new Map<string, FakeRow>()
  const savedConversations = new Map<string, unknown>()
  return {
    rows,
    savedConversations,
    hydrate: (id) => {
      const row = rows.get(id)
      return row ? { title: row.title, messages: [], historySummary: undefined, historySummaryFrontier: undefined } : null
    },
    listByOrigin: (origin, limit, tabKey) => {
      const found = [...rows.entries()]
        .filter(([, r]) => r.origin === origin)
        // Same scope semantics as the SQL: a scoped call never sees an unscoped
        // row (the real store hands those to the first tab via adoptUnscoped).
        .filter(([, r]) => !tabKey || r.tabKey === tabKey)
        .sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt))
        .slice(0, limit)
        // approvalMode rides along (the real listConversationsByOrigin reads
        // `conversations.approval_mode`): the panel's snapshot prefers it over
        // its own tab-local carry-over, so losing it here would reopen the
        // "the panel and the desktop disagree" bug.
        .map(([id, r]) => ({ id, title: r.title, updatedAt: r.updatedAt, approvalMode: r.approvalMode }))
      return found
    },
    adoptUnscoped: (origin, tabKey) => {
      for (const [, r] of rows) {
        if (r.origin === origin && !r.tabKey) r.tabKey = tabKey
      }
    },
    releaseDeadScopes: (origin, liveScopes) => {
      for (const [, r] of rows) {
        if (r.origin === origin && r.tabKey && !liveScopes.includes(r.tabKey)) r.tabKey = undefined
      }
    },
    // Mirrors the real UPDATE's predicate: no scope (legacy shape) or a scope
    // THIS install holds live. Another install's live scopes stay put.
    claimLegacyScopes: (fromOrigin, toOrigin, liveScopes) => {
      if (fromOrigin === toOrigin) return
      for (const [, r] of rows) {
        if (r.origin !== fromOrigin) continue
        if (!r.tabKey || liveScopes.includes(r.tabKey)) r.origin = toOrigin
      }
    },
    origin: (id) => rows.get(id)?.origin ?? null,
    approvalMode: (id) => rows.get(id)?.approvalMode,
    title: (id) => rows.get(id)?.title ?? null,
    // The hosted-transcript writer records its saves so tests can assert the
    // turn-end write without a database.
    persist: (conversation) => {
      savedConversations.set(conversation.id, conversation)
    },
    remove: (id) => {
      rows.delete(id)
    },
    rename: (id, title) => {
      const r = rows.get(id)
      if (r) r.title = title
    },
    // session.handoff 的 origin 重戳（PLAN-extension-handoff）：与真实
    // updateConversationOrigin 的 UPSERT 同语义——行在则改 origin，行不在则建桩。
    stampOrigin: (id, origin) => {
      const existing = rows.get(id)
      if (existing) existing.origin = origin
      else rows.set(id, { title: '', origin, updatedAt: new Date().toISOString() })
    },
  }
}

async function start(
  token = 'test-token',
  sessions = makeFakeSessions(),
  store = makeFakeStore(),
): Promise<{ handle: AgentServiceHandle; sessions: FakeSessions; store: ReturnType<typeof makeFakeStore> }> {
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
async function openWithSession(
  handle: AgentServiceHandle,
  clientId = 'pulsemind-extension',
  instanceId?: string,
): Promise<{ client: TestClient; sessionId: string }> {
  const client = new TestClient(`ws://127.0.0.1:${handle.port}/?token=${handle.token}`)
  await client.open()
  await client.hello(clientId, instanceId)
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
            res.on('data', (d) => {
              body += d
            })
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

  // review_20261103 高3：doCreateSession 把「上次使用」档位种进新会话列，而
  // session.list 只列有消息的会话——面板在首条消息落库前没有别的渠道读到它。
  // session.create 必须把列值带回来（best-effort：行不存在/存储抛错 → undefined，
  // 不弄死 create 回答）。
  it('session.create echoes the stored 授权 level so a message-less session is still visible', async () => {
    const { handle, store } = await start()
    try {
      const client = new TestClient(`ws://127.0.0.1:${handle.port}/?token=${handle.token}`)
      await client.open()
      await client.hello('pulsemind-extension')

      const res = await client.request('session.create', {})
      expect(res.result.approvalMode).toBeUndefined() // 无行 → best-effort undefined

      store.rows.set(res.result.sessionId, { title: '', origin: 'pulsemind-extension', updatedAt: new Date().toISOString(), approvalMode: 'auto' })
      const seeded = await client.request('session.create', { sessionId: res.result.sessionId })
      expect(seeded.result.approvalMode).toBe('auto')

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

      const askPromise = client.request(
        'agent.ask',
        {
          sessionId,
          content: '总结这个页面',
          pageContext: { url: 'https://example.com/b', title: '页面 B' },
        },
        8_000,
      )

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
        await hostedToolProxy.call(agentClientRegistry.get(sid), sid, 'page_click', { index: 3 }, 200).catch((err: Error) => failures.push(err.message))
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

  it('registers EVERY ask of a parked batch — the panel answers them in order (2026-10-10: 第二题 unknown callId)', async () => {
    const { handle, sessions } = await start()
    try {
      const { client, sessionId } = await openWithSession(handle)

      sessions.setAskHandler((sid) => {
        sessions.emit(sid, {
          type: 'status',
          status: 'awaiting_user_input',
          tools: [
            { toolUseId: 'tu_q1', name: 'ask_user', detail: '{"prompt":"选城市"}', args: { prompt: '选城市', choices: ['甲', '乙'] } },
            { toolUseId: 'tu_q2', name: 'ask_user', detail: '{"prompt":"选日期"}', args: { prompt: '选日期', choices: ['今天', '明天'] } },
          ],
        })
      })

      const askRes = await client.request('agent.ask', { sessionId, content: '问吧' }, 8_000)
      expect(askRes.result).toMatchObject({ accepted: true })

      // Both questions prompt, each under its own callId. waitFor returns the
      // FIRST matching notification without consuming it — collect instead.
      await waitUntil(() => client.notifications.filter((n) => n.method === 'ask_user.request').length >= 2)
      const callIds = client.notifications
        .filter((n) => n.method === 'ask_user.request')
        .map((n) => n.params.callId)
        .sort()
      expect(callIds).toEqual(['tu_q1', 'tu_q2'])

      // The batch card answers in dispatch order — BOTH must reach the engine.
      client.notify('ask_user.response', { callId: 'tu_q1', response: '甲' })
      await waitUntil(() => sessions.engineCalls.some((c) => c.method === 'respondToTool' && c.args[0] === 'tu_q1'))
      client.notify('ask_user.response', { callId: 'tu_q2', response: '明天' })
      await waitUntil(() => sessions.engineCalls.some((c) => c.method === 'respondToTool' && c.args[0] === 'tu_q2' && c.args[1] === '明天'))

      // The consumed entries are gone; a replay errors instead of double-firing.
      const replay = await client.request('ask_user.response', { callId: 'tu_q1', response: '甲' }, 8_000)
      expect(replay.error?.code).toBe(ErrorCodes.invalidParams)

      client.close()
    } finally {
      await handle.close()
    }
  })

  it('answers request-shaped relays; an unknown callId and a dead session error back', async () => {
    const { handle, sessions } = await start()
    try {
      const { client, sessionId } = await openWithSession(handle)

      // Nothing parked under these callIds (server-side timeouts reject after
      // 2/5 minutes): the relay must say so, or the panel's buttons die
      // silently — the defect this reply path exists for.
      const staleApproval = await client.request('approval.response', { callId: 'tu_none', approved: true }, 8_000)
      expect(staleApproval.error?.code).toBe(ErrorCodes.invalidParams)
      const staleAsk = await client.request('ask_user.response', { callId: 'tu_none', response: 'x' }, 8_000)
      expect(staleAsk.error?.code).toBe(ErrorCodes.invalidParams)

      // A live prompt answers ok and settles into the engine.
      sessions.setAskHandler((sid) => {
        sessions.emit(sid, {
          type: 'status',
          status: 'awaiting_approval',
          tools: [{ toolUseId: 'tu_r', name: 'write', detail: '{}' }],
        })
      })
      await client.request('agent.ask', { sessionId, content: 'go' }, 8_000)
      await client.waitFor('approval.request')
      const settled = await client.request('approval.response', { callId: 'tu_r', approved: true }, 8_000)
      expect(settled.result).toMatchObject({ ok: true })
      await waitUntil(() => sessions.engineCalls.some((c) => c.method === 'approveTool' && c.args[0] === 'tu_r'))

      // The loop-limit decision has no callId — its failure mode is a dead
      // session, and the reply is what keeps the panel's card from sitting
      // there forever with a dead 继续/停止 pair.
      const dead = await client.request('iteration_limit.response', { sessionId: 'ws_never_created', approved: true }, 8_000)
      expect(dead.error?.code).toBe(ErrorCodes.sessionNotFound)
      const alive = await client.request('iteration_limit.response', { sessionId, approved: false }, 8_000)
      expect(alive.result).toMatchObject({ ok: true })
      await waitUntil(() => sessions.engineCalls.some((c) => c.method === 'stopExecution'))

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

  it('session.create binds hosted clients so page tools survive an SW restart (2026-10-10)', async () => {
    const { handle } = await start()
    try {
      // The SW-restart shape: a fresh socket resumes its session via
      // session.create — WITHOUT an intervening agent.ask. Before the
      // sessionCreate bind this left the registry empty (the dead socket's
      // drop() had unbound it) and page_* failed with
      // 「当前会话没有连接的浏览器客户端」 until the next message.
      const client = new TestClient(`ws://127.0.0.1:${handle.port}/?token=${handle.token}`)
      await client.open()
      await client.hello('pulsemind-extension')
      const res = await client.request('session.create', {})
      const sessionId = res.result.sessionId as string
      await waitUntil(() => agentClientRegistry.get(sessionId) !== undefined)
      expect(agentClientRegistry.isHostedCapable(sessionId)).toBe(true)

      // A non-hosted client's session.create must not open the page-tool gate:
      // the bind never happens, so give the reply a beat and assert directly.
      const plain = new TestClient(`ws://127.0.0.1:${handle.port}/?token=${handle.token}`)
      await plain.open()
      await plain.hello('some-cli-client')
      const plainRes = await plain.request('session.create', {})
      const plainSessionId = plainRes.result.sessionId as string
      await new Promise((r) => setTimeout(r, 50))
      expect(agentClientRegistry.get(plainSessionId)).toBeUndefined()
      expect(agentClientRegistry.isHostedCapable(plainSessionId)).toBe(false)

      client.close()
      plain.close()
      await waitUntil(() => agentClientRegistry.get(sessionId) === undefined && agentClientRegistry.get(plainSessionId) === undefined)
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
      // The protocol's list item is `sessionId` (like every other session.*
      // payload), NOT the conversation store's raw `id`: the panel resumes a row
      // with `session.create({ sessionId })`, so shipping `id` left every row
      // unresumable — the 历史会话 menu rendered titles, yet clicking one unbound
      // the tab instead of switching (2026-11-02).
      const rows = (list.result as { sessions: Array<{ sessionId: string; id?: string }> }).sessions
      const ids = rows.map((s) => s.sessionId)
      expect(ids).toContain('ws_a')
      expect(ids).not.toContain('ws_b')
      expect(rows.every((r) => r.id === undefined)).toBe(true)
      // The round trip the panel performs: a listed id must resume, not create.
      const resumed = await ext.request('session.create', { sessionId: 'ws_a' })
      expect(resumed.result).toMatchObject({ sessionId: 'ws_a', resumed: true })

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

  it('session.list is scoped per tabKey; unscoped rows are adopted by the first tab (2026-11-03)', async () => {
    const { handle, sessions, store } = await start()
    try {
      // A row written before per-tab history existed (the extension's whole
      // existing history, in practice): no tab_key.
      store.rows.set('ws_legacy', { title: '旧会话', origin: 'pulsemind-extension', updatedAt: '2026-11-01T00:00:00.000Z' })

      const ext = new TestClient(`ws://127.0.0.1:${handle.port}/?token=${handle.token}`)
      await ext.open()
      await ext.hello('pulsemind-extension')

      // Tab A's create carries its scope through to the session manager — that
      // is what stamps `conversations.tab_key` on the real store.
      const created = await ext.request('session.create', { tabKey: 'tab_a' })
      const createdId = (created.result as { sessionId: string }).sessionId
      expect(sessions.created.at(-1)?.opts?.tabKey).toBe('tab_a')
      store.rows.set(createdId, { title: 'A 的会话', origin: 'pulsemind-extension', updatedAt: new Date().toISOString(), tabKey: 'tab_a' })

      const listA = (await ext.request('session.list', { tabKey: 'tab_a' })).result as { sessions: Array<{ sessionId: string }> }
      const idsA = listA.sessions.map((s) => s.sessionId)
      // Its own conversation, plus the legacy row it adopted on first sight —
      // upgrading must not make a user's history disappear.
      expect(idsA).toContain(createdId)
      expect(idsA).toContain('ws_legacy')
      expect(store.rows.get('ws_legacy')?.tabKey).toBe('tab_a')

      // A sibling tab starts empty and stays empty: two tabs never share.
      const listB = (await ext.request('session.list', { tabKey: 'tab_b' })).result as { sessions: Array<{ sessionId: string }> }
      expect(listB.sessions).toHaveLength(0)

      // Unscoped callers (desktop tooling, tests) keep the old whole-origin view.
      const listAll = (await ext.request('session.list', {})).result as { sessions: Array<{ sessionId: string }> }
      expect(listAll.sessions.map((s) => s.sessionId)).toContain('ws_legacy')

      ext.close()
    } finally {
      await handle.close()
    }
  })

  // review_20261104 中3：chrome.storage.session 随浏览器退出清空——重启后所有
  // 带戳会话携带死 scope，scoped 列表查不到、收养只触 NULL 行、桌面端又排除
  // 托管 origin，历史在所有 UI 不可达且每回合继续落库。session.list 携带活
  // scope 集合，服务端先释放死戳再收养：历史整批归入重启后首个列表的页签。
  it('releases dead scopes then adopts them into the listing tab (review_20261104 中3)', async () => {
    const { handle, store } = await start()
    try {
      // 重启前的世界：tab_old 作用域的会话；重启后存储清空，liveScopes 只剩
      // 新铸的 tab_a。
      store.rows.set('ws_old1', { title: '旧一', origin: 'pulsemind-extension', updatedAt: '2026-11-03T10:00:00.000Z', tabKey: 'tab_old1' })
      store.rows.set('ws_old2', { title: '旧二', origin: 'pulsemind-extension', updatedAt: '2026-11-03T09:00:00.000Z', tabKey: 'tab_old2' })

      const ext = new TestClient(`ws://127.0.0.1:${handle.port}/?token=${handle.token}`)
      await ext.open()
      await ext.hello('pulsemind-extension')

      // 重启后首个列表：死戳释放 → 同一调用内的收养把它们交给 tab_a。
      const listA = (await ext.request('session.list', { tabKey: 'tab_a', liveScopes: ['tab_a'] })).result as {
        sessions: Array<{ sessionId: string }>
      }
      const idsA = listA.sessions.map((s) => s.sessionId)
      expect(idsA).toContain('ws_old1')
      expect(idsA).toContain('ws_old2')
      expect(store.rows.get('ws_old1')?.tabKey).toBe('tab_a')
      expect(store.rows.get('ws_old2')?.tabKey).toBe('tab_a')

      // 活 scope 永不释放：兄弟页签的行不动。
      store.rows.set('ws_live', { title: '兄弟页签', origin: 'pulsemind-extension', updatedAt: '2026-11-03T11:00:00.000Z', tabKey: 'tab_live' })
      await ext.request('session.list', { tabKey: 'tab_a', liveScopes: ['tab_a', 'tab_live'] })
      expect(store.rows.get('ws_live')?.tabKey).toBe('tab_live')

      // 无 liveScopes 的 scoped 调用（旧版扩展）：不释放，行为与从前一致。
      store.rows.set('ws_stale', { title: '另一死戳', origin: 'pulsemind-extension', updatedAt: '2026-11-03T08:00:00.000Z', tabKey: 'tab_dead' })
      await ext.request('session.list', { tabKey: 'tab_a' })
      expect(store.rows.get('ws_stale')?.tabKey).toBe('tab_dead')

      // 畸形项被逐条过滤（非字符串/空串丢弃），合法子集照常驱动释放+收养。
      await ext.request('session.list', { tabKey: 'tab_a', liveScopes: ['tab_a', 42, null, ''] })
      expect(store.rows.get('ws_stale')?.tabKey).toBe('tab_a')

      // 无人值守 origin（isHostedClientId 但非扩展常量）不受影响：释放按 origin 走。
      ext.close()
    } finally {
      await handle.close()
    }
  })
})

// ── per-install identity (2026-11-05): Chrome + 360 load the same binary ──
// The extension's clientId is the constant `pulsemind-extension` in every
// browser. Before this split, the same-clientId replacement rule (close 4409)
// made two installs kick each other in an endless reconnect loop, and both
// writes landed on one conversation origin (one browser's dead-scope release
// rolled up the other's live tabs). `instanceId` — minted once per browser
// profile, persisted in chrome.storage.local — splits BOTH: the identity key
// keeps connections apart, the origin keeps histories apart.

describe('per-install identity: two installs of one binary coexist', () => {
  const url = (handle: AgentServiceHandle): string => `ws://127.0.0.1:${handle.port}/?token=${handle.token}`

  it('different instanceIds do not kick each other; both are listed', async () => {
    const { handle } = await start()
    try {
      const chrome = new TestClient(url(handle))
      await chrome.open()
      await chrome.hello('pulsemind-extension', 'inst_chrome')

      const b360 = new TestClient(url(handle))
      await b360.open()
      await b360.hello('pulsemind-extension', 'inst_b360')

      // Neither connection was replaced: both still answer. (Pre-fix the
      // second hello closed the first with 4409 — the reported 互踢.)
      expect((await chrome.request('ping')).result).toMatchObject({ pong: true })
      expect((await b360.request('ping')).result).toMatchObject({ pong: true })

      // 已连接的客户端 distinguishes the installs by origin.
      expect(handle.clients()).toHaveLength(2)
      expect(handle.clients()).toEqual(
        expect.arrayContaining([
          { clientId: 'pulsemind-extension:inst_chrome', sessions: 0 },
          { clientId: 'pulsemind-extension:inst_b360', sessions: 0 },
        ]),
      )

      chrome.close()
      b360.close()
      await waitUntil(() => handle.clients().length === 0)
    } finally {
      await handle.close()
    }
  })

  it('reconnecting the SAME install still replaces its own ghost', async () => {
    const { handle } = await start()
    try {
      const first = new TestClient(url(handle))
      await first.open()
      await first.hello('pulsemind-extension', 'inst_same')
      const firstClosed = first.closed()

      const second = new TestClient(url(handle))
      await second.open()
      await second.hello('pulsemind-extension', 'inst_same')

      // The replacement rule survives — keyed by (clientId, instanceId), so an
      // SW wake-up race still leaves exactly one connection per install.
      expect(await firstClosed).toBe(4409)
      await waitUntil(() => handle.clients().length === 1)
      expect(handle.clients()).toEqual([{ clientId: 'pulsemind-extension:inst_same', sessions: 0 }])

      second.close()
      await waitUntil(() => handle.clients().length === 0)
    } finally {
      await handle.close()
    }
  })

  it('each install sees only its own history (origin is base:instanceId)', async () => {
    const { handle, sessions, store } = await start()
    try {
      const a = new TestClient(url(handle))
      await a.open()
      await a.hello('pulsemind-extension', 'inst_a')
      const created = await a.request('session.create', { tabKey: 'tab_a' })
      const idA = (created.result as { sessionId: string }).sessionId
      // The real manager stamps the row; the in-memory fake needs it seeded.
      expect(sessions.created.at(-1)?.opts?.clientId).toBe('pulsemind-extension:inst_a')
      store.rows.set(idA, { title: 'Chrome 的会话', origin: 'pulsemind-extension:inst_a', updatedAt: new Date().toISOString(), tabKey: 'tab_a' })

      const b = new TestClient(url(handle))
      await b.open()
      await b.hello('pulsemind-extension', 'inst_b')
      const listB = (await b.request('session.list', { tabKey: 'tab_a' })).result as { sessions: Array<{ sessionId: string }> }
      expect(listB.sessions).toHaveLength(0)

      const listA = (await a.request('session.list', { tabKey: 'tab_a' })).result as { sessions: Array<{ sessionId: string }> }
      expect(listA.sessions.map((s) => s.sessionId)).toEqual([idA])

      // Cross-install mutation is refused like any foreign origin.
      expect((await b.request('session.delete', { sessionId: idA })).error?.code).toBe(-32005)
      expect((await b.request('session.rename', { sessionId: idA, title: 'X' })).error?.code).toBe(-32005)
      expect(store.rows.get(idA)?.title).toBe('Chrome 的会话')

      a.close()
      b.close()
    } finally {
      await handle.close()
    }
  })

  it('a malformed instanceId degrades to the legacy identity', async () => {
    const { handle } = await start()
    try {
      const first = new TestClient(url(handle))
      await first.open()
      // Illegal charset: treated as absent, never as an origin nobody can name.
      await first.hello('pulsemind-extension', 'bad id!')
      const firstClosed = first.closed()

      const second = new TestClient(url(handle))
      await second.open()
      await second.hello('pulsemind-extension')

      // Both resolve to the bare legacy identity → ordinary replacement.
      expect(await firstClosed).toBe(4409)
      expect(handle.clients()).toEqual([{ clientId: 'pulsemind-extension', sessions: 0 }])

      second.close()
      await waitUntil(() => handle.clients().length === 0)
    } finally {
      await handle.close()
    }
  })

  it('claims pre-instance legacy history for the install that opens the panel', async () => {
    const { handle, store } = await start()
    try {
      // Pre-upgrade rows: one unscoped, one scoped to a tab this install holds
      // live, one scoped to ANOTHER install's live tab.
      store.rows.set('ws_legacy_unscoped', { title: '旧未带戳', origin: 'pulsemind-extension', updatedAt: '2026-11-01T00:00:00.000Z' })
      store.rows.set('ws_legacy_mine', { title: '本安装活页签', origin: 'pulsemind-extension', updatedAt: '2026-11-02T00:00:00.000Z', tabKey: 'tab_live' })
      store.rows.set('ws_legacy_other', { title: '另一安装活页签', origin: 'pulsemind-extension', updatedAt: '2026-11-03T00:00:00.000Z', tabKey: 'tab_other' })

      const ext = new TestClient(url(handle))
      await ext.open()
      await ext.hello('pulsemind-extension', 'inst_upgraded')

      const list = (await ext.request('session.list', { tabKey: 'tab_live', liveScopes: ['tab_live'] })).result as {
        sessions: Array<{ sessionId: string }>
      }
      const ids = list.sessions.map((s) => s.sessionId)
      expect(ids).toContain('ws_legacy_unscoped')
      expect(ids).toContain('ws_legacy_mine')
      expect(ids).not.toContain('ws_legacy_other')

      // Claimed rows move to this install's origin (the unscoped one is then
      // adopted by the listing tab); the other install's live scope stays put.
      expect(store.rows.get('ws_legacy_unscoped')?.origin).toBe('pulsemind-extension:inst_upgraded')
      expect(store.rows.get('ws_legacy_unscoped')?.tabKey).toBe('tab_live')
      expect(store.rows.get('ws_legacy_mine')?.origin).toBe('pulsemind-extension:inst_upgraded')
      expect(store.rows.get('ws_legacy_other')?.origin).toBe('pulsemind-extension')
      expect(store.rows.get('ws_legacy_other')?.tabKey).toBe('tab_other')

      // And a second install cannot take them now.
      const other = new TestClient(url(handle))
      await other.open()
      await other.hello('pulsemind-extension', 'inst_second')
      const otherList = (await other.request('session.list', { tabKey: 'tab_x', liveScopes: ['tab_x'] })).result as {
        sessions: Array<{ sessionId: string }>
      }
      expect(otherList.sessions).toHaveLength(0)
      expect(store.rows.get('ws_legacy_other')?.origin).toBe('pulsemind-extension')

      ext.close()
      other.close()
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

  it('model.setActive with a sessionId pins THAT conversation, not the default', async () => {
    const { handle, sessions } = await start()
    try {
      const client = new TestClient(`ws://127.0.0.1:${handle.port}/?token=${handle.token}`)
      await client.open()
      await client.hello('pulsemind-extension')

      const res = await client.request('model.setActive', { profileId: 'p2', sessionId: 'conv_per_session' })
      expect(res.result).toMatchObject({ ok: true, model: { activeId: 'p2' } })
      // The write reached the manager as a per-session pin and the GLOBAL
      // default stayed where it was — that is the whole point of the split.
      expect(sessions.sessionModels).toEqual([{ sessionId: 'conv_per_session', profileId: 'p2' }])
      expect(sessions.switched).toEqual([])
      expect((sessions.model as { activeId: string }).activeId).toBe('p1')

      client.close()
    } finally {
      await handle.close()
    }
  })

  it('model.list with a sessionId answers the session-scoped active model', async () => {
    const { handle, sessions } = await start()
    try {
      const client = new TestClient(`ws://127.0.0.1:${handle.port}/?token=${handle.token}`)
      await client.open()
      await client.hello('pulsemind-extension')

      // The session id must ride through to the manager — that is the routing
      // this file owns; the scoping itself is the manager's contract.
      await client.request('model.setActive', { profileId: 'p2', sessionId: 'conv_per_session' })
      const res = await client.request('model.list', { sessionId: 'conv_per_session' })
      expect(res.result).toMatchObject({ activeId: 'p2' })
      expect(sessions.modelStateCalls).toContain('conv_per_session')

      const global = await client.request('model.list', {})
      expect(global.result).toMatchObject({ activeId: 'p1' })

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
      expect(list.result).toMatchObject({ sessions: [{ sessionId, approvalMode: 'always-ask' }] })

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
  it('listConversations filters hosted origins in SQL — the per-install family too', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'main', 'storage', 'conversation.db.ts'), 'utf-8')
    // 2026-11-05: hosted rows carry `base:instanceId` (Chrome and 360 load the
    // same extension binary), so an exact base-id comparison would leak every
    // instance session into the desktop list. The shared helper must emit the
    // LIKE guards, and the list must call it.
    expect(src).toMatch(/const HOSTED_ORIGIN_PREFIXES = HOSTED_ORIGINS\.map/)
    expect(src).toMatch(/function hostedOriginExclusion\(alias\?: string\): string/)
    expect(src).toMatch(/NOT LIKE '\$\{p\}:?%'/)
    expect(src).toMatch(/AND \$\{hostedOriginExclusion\('c'\)\}/)
  })

  it('claimLegacyScopes migrates only unscoped or live-scoped legacy rows', () => {
    // The migration that hands pre-instance history to the upgraded install;
    // the DB layer cannot be loaded here, so the predicate is pinned by scan.
    const src = readFileSync(join(process.cwd(), 'src', 'main', 'storage', 'conversation.db.ts'), 'utf-8')
    const at = src.indexOf('export function claimLegacyScopeConversations')
    expect(at).toBeGreaterThan(-1)
    const fn = src.slice(at, src.indexOf('\n}', at))
    expect(fn).toMatch(/UPDATE conversations SET origin = \?/)
    expect(fn).toMatch(/WHERE origin = \? AND \(tab_key IS NULL/)
    // Another install's LIVE scope is not claimable: only the caller's list.
    expect(fn).toMatch(/tab_key IN/)
    // A message-less stub is not history and must not ride the migration.
    expect(fn).toMatch(/EXISTS \(SELECT 1 FROM messages/)
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
    expect(fn).toMatch(/ON CONFLICT\(id\) DO UPDATE SET\s+origin = excluded\.origin/)
    // A scope-less create/resume (a desktop caller) must not erase a stamp that
    // is already there — only a real tabKey overwrites.
    expect(fn).toMatch(/tab_key = COALESCE\(excluded\.tab_key, tab_key\)/)
  })
})

describe('hosted transcripts persist at turn end (2026-11-02)', () => {
  // Main-hosted sessions have no renderer to save for them: without this the
  // extension conversation stayed the origin stamp's message-less stub forever
  // (32 such rows on the dev machine), invisible to session.list's
  // EXISTS(messages) and lost to a desktop restart. The writer reads the LIVE
  // session through snapshot() — not history(), whose ensureEntry mints a
  // missing session back into existence; snapshot answers null and nothing is
  // written (the G84 double-writer/UPSERT trap).
  /** The row the real session-manager stamps at session.create — the fake
   *  sessions above do not touch the store, so each test seeds it itself. */
  const seedRow = (store: ReturnType<typeof makeFakeStore>, sessionId: string, title = '', origin = 'pulsemind-extension'): void => {
    store.rows.set(sessionId, { title, origin, updatedAt: new Date().toISOString() })
  }

  it('a hosted transcript lands on the idle status; the title follows the first text', async () => {
    const { handle, sessions, store } = await start()
    try {
      const { sessionId } = await openWithSession(handle)
      seedRow(store, sessionId)
      sessions.state.messages.push({
        id: 'm1',
        role: 'user',
        contentBlocks: [{ type: 'text', text: '总结这个页面' }],
        createdAt: '2026-11-02T00:00:00.000Z',
      })
      sessions.emit(sessionId, { type: 'status', status: 'streaming' } as AgentEventData)
      expect(store.savedConversations.size).toBe(0) // active — the turn is open
      sessions.emit(sessionId, { type: 'status', status: 'idle' } as AgentEventData)
      await waitUntil(() => store.savedConversations.size === 1)
      const saved = store.savedConversations.get(sessionId) as { title: string; messages: unknown[] }
      expect(saved.title).toBe('总结这个页面')
      expect(saved.messages).toHaveLength(1)
    } finally {
      await handle.close()
    }
  })

  // review_20261103 中2：upsert 的冲突子句无条件写 history_summary，落库不带
  // 摘要 = 每回合把列抹成 NULL，压缩过的会话重启后拿全量转写、首拍重新压一遍
  // （多一次 LLM 调用）。桌面写者保存前赋 engine.getHistorySummary()；托管
  // 写者走同一值经 engineCall，best-effort（读失败 → 无摘要照常落转写）。
  it('a per-install origin still counts as hosted and persists (2026-11-05)', async () => {
    // isHostedClientId reads the BASE id: the instance suffix changed the
    // conversation origin, not the client's capabilities. If this gate read the
    // exact origin, every upgraded install would silently stop saving history.
    const { handle, sessions, store } = await start()
    try {
      const { sessionId } = await openWithSession(handle, 'pulsemind-extension', 'inst_persist')
      seedRow(store, sessionId, '', 'pulsemind-extension:inst_persist')
      sessions.state.messages.push({
        id: 'm1',
        role: 'user',
        contentBlocks: [{ type: 'text', text: '页面总结' }],
        createdAt: '2026-11-05T00:00:00.000Z',
      })
      sessions.emit(sessionId, { type: 'status', status: 'idle' } as AgentEventData)
      await waitUntil(() => store.savedConversations.size === 1)
      expect(store.savedConversations.has(sessionId)).toBe(true)
    } finally {
      await handle.close()
    }
  })

  it('the history summary rides the turn-end save instead of being NULLed', async () => {
    const { handle, sessions, store } = await start()
    try {
      const { sessionId } = await openWithSession(handle)
      seedRow(store, sessionId)
      sessions.state.messages.push({
        id: 'm1',
        role: 'user',
        contentBlocks: [{ type: 'text', text: '长任务' }],
        createdAt: '2026-11-02T00:00:00.000Z',
      })
      sessions.engineCall = async (sid, method) => {
        expect(sid).toBe(sessionId)
        return method === 'getHistorySummary' ? { text: '早前轮次的摘要', firstKeptId: 'm_keep' } : undefined
      }
      sessions.emit(sessionId, { type: 'status', status: 'idle' } as AgentEventData)
      await waitUntil(() => store.savedConversations.size === 1)
      const saved = store.savedConversations.get(sessionId) as { historySummary?: string; historySummaryFrontier?: string }
      expect(saved.historySummary).toBe('早前轮次的摘要')
      expect(saved.historySummaryFrontier).toBe('m_keep')

      // 读失败（session gone / engine 关闭）：摘要为空但转写照常落。
      const { handle: h2, sessions: s2, store: store2 } = await start()
      try {
        const { sessionId: sid2 } = await openWithSession(h2)
        seedRow(store2, sid2)
        s2.state.messages.push({ id: 'm1', role: 'user', contentBlocks: [{ type: 'text', text: 'hi' }], createdAt: '2026-11-02T00:00:00.000Z' })
        s2.engineCall = async () => {
          throw new Error('session not found')
        }
        s2.emit(sid2, { type: 'status', status: 'idle' } as AgentEventData)
        await waitUntil(() => store2.savedConversations.size === 1)
        const saved2 = store2.savedConversations.get(sid2) as { historySummary?: string }
        expect(saved2.historySummary).toBeUndefined()
      } finally {
        await h2.close()
      }
    } finally {
      await handle.close()
    }
  })

  it('a non-hosted origin never persists (the desktop renderer writes its own)', async () => {
    const { handle, sessions, store } = await start()
    try {
      const { sessionId } = await openWithSession(handle, 'local-ui')
      store.rows.set(sessionId, { title: '', origin: 'local', updatedAt: new Date().toISOString() })
      sessions.state.messages.push({ id: 'm1', role: 'user', contentBlocks: [{ type: 'text', text: 'hi' }], createdAt: '2026-11-02T00:00:00.000Z' })
      sessions.emit(sessionId, { type: 'status', status: 'idle' } as AgentEventData)
      await new Promise((r) => setTimeout(r, 30))
      expect(store.savedConversations.size).toBe(0)
    } finally {
      await handle.close()
    }
  })

  it('an existing title survives; the placeholder is replaced; a deleted session writes nothing', async () => {
    const { handle, sessions, store } = await start()
    try {
      const { client, sessionId } = await openWithSession(handle)
      seedRow(store, sessionId)
      await client.request('session.rename', { sessionId, title: '我的会话' })
      sessions.state.messages.push({ id: 'm1', role: 'user', contentBlocks: [{ type: 'text', text: 'hi' }], createdAt: '2026-11-02T00:00:00.000Z' })
      sessions.emit(sessionId, { type: 'status', status: 'idle' } as AgentEventData)
      await waitUntil(() => store.savedConversations.has(sessionId))
      expect((store.savedConversations.get(sessionId) as { title: string }).title).toBe('我的会话')

      // Placeholder → the FIRST message's text (the desktop's rule, which
      // reads messages[0], not the newest) even on a later turn.
      store.rows.get(sessionId)!.title = '新对话'
      sessions.state.messages.push({ id: 'm2', role: 'assistant', contentBlocks: [{ type: 'text', text: '回答' }], createdAt: '2026-11-02T00:00:01.000Z' })
      sessions.emit(sessionId, { type: 'status', status: 'idle' } as AgentEventData)
      await waitUntil(() => (store.savedConversations.get(sessionId) as { title?: string })?.title === 'hi')

      // Deleted mid-turn: snapshot() answers null → no write, no resurrection.
      // (The fake keys "service holds the session" off `live` — the same thing
      // the real snapshot's hasSession/pendingCreates check stands for.)
      store.savedConversations.delete(sessionId)
      sessions.live.delete(sessionId)
      sessions.emit(sessionId, { type: 'status', status: 'idle' } as AgentEventData)
      await new Promise((r) => setTimeout(r, 30))
      expect(store.savedConversations.has(sessionId)).toBe(false)
    } finally {
      await handle.close()
    }
  })
})

// ── session.handoff（PLAN-extension-handoff）──────────────────────────

describe('session.handoff — 扩展会话移交桌面端', () => {
  const seedRow = (store: ReturnType<typeof makeFakeStore>, sessionId: string, origin = 'pulsemind-extension'): void => {
    store.rows.set(sessionId, { title: '移交的会话', origin, updatedAt: new Date().toISOString() })
  }

  it('三拒绝：会话不存在 / 已在桌面端 / 非 hosted origin', async () => {
    const { handle, store } = await start()
    try {
      seedRow(store, 'conv_hosted', 'pulsemind-extension')
      seedRow(store, 'conv_local', 'local')
      seedRow(store, 'conv_other', 'some-other-client')
      const ext = new TestClient(`ws://127.0.0.1:${handle.port}/?token=${handle.token}`)
      await ext.open()
      await ext.hello('pulsemind-extension')

      const missing = await ext.request('session.handoff', { sessionId: 'conv_missing', page: { url: 'https://x.test' } })
      expect(missing.error?.code).toBe(ErrorCodes.sessionNotFound)

      const local = await ext.request('session.handoff', { sessionId: 'conv_local', page: { url: 'https://x.test' } })
      expect(local.error?.code).toBe(ErrorCodes.invalidParams)
      expect(local.error?.message).toContain('已在桌面端')

      const other = await ext.request('session.handoff', { sessionId: 'conv_other', page: { url: 'https://x.test' } })
      expect(other.error?.code).toBe(ErrorCodes.forbidden)
      ext.close()
    } finally {
      await handle.close()
    }
  })

  it('第四拒绝：活跃回合（流式中 / 待审批）不得移交——审批卡孤儿化比等一拍更贵', async () => {
    const { handle, sessions, store } = await start()
    try {
      seedRow(store, 'conv_busy')
      sessions.live.add('conv_busy')
      const ext = new TestClient(`ws://127.0.0.1:${handle.port}/?token=${handle.token}`)
      await ext.open()
      await ext.hello('pulsemind-extension')

      for (const status of ['streaming', 'awaiting_approval', 'awaiting_user_input']) {
        sessions.state.snapshotStatus = status
        const res = await ext.request('session.handoff', { sessionId: 'conv_busy', page: { url: 'https://x.test' } })
        expect(res.error?.code).toBe(ErrorCodes.invalidParams)
        expect(res.error?.message).toContain('回合')
        // 拒绝路径不得动 origin / 解绑
        expect(store.rows.get('conv_busy')?.origin).toBe('pulsemind-extension')
      }
      ext.close()
    } finally {
      await handle.close()
    }
  })

  it('成功路径：origin 重戳 local + 双向解绑 + 广播 + 引擎已死也放行', async () => {
    const broadcasts: Array<{ sessionId: string; title: string; url: string }> = []
    const { sessions, store } = makeHandoffParts()
    const handle = await startAgentService({
      port: 0,
      token: 'test-token',
      sessions: sessions as unknown as AgentServiceSessions,
      store,
      broadcast: (p) => broadcasts.push(p),
    })
    try {
      seedRow(store, 'conv_go')
      // 引擎已死：live 不加该会话 → snapshot null → 守卫放行（转过去等于续聊静默会话）
      const ext = new TestClient(`ws://127.0.0.1:${handle.port}/?token=${handle.token}`)
      await ext.open()
      await ext.hello('pulsemind-extension')

      // 预置一个绑定：移交后必须解绑（registry 释放反向通道）
      const fakeTransport = { id: 't1', clientId: 'pulsemind-extension', sendToolCall: () => {}, sendApprovalRequest: () => {}, sendAskUserRequest: () => {} }
      agentClientRegistry.bind('conv_go', fakeTransport)

      const res = await ext.request('session.handoff', {
        sessionId: 'conv_go',
        page: { url: 'https://example.test/article', title: '文章' },
      })
      expect(res.result).toMatchObject({ ok: true })
      // ③ origin 重戳：桌面列表立即可见 + hosted-persistence 自动停写
      expect(store.rows.get('conv_go')?.origin).toBe('local')
      // ④ registry 解绑
      expect(agentClientRegistry.get('conv_go')).toBeUndefined()
      // ⑤ 广播
      await waitUntil(() => broadcasts.length > 0)
      expect(broadcasts[0]).toMatchObject({ sessionId: 'conv_go', url: 'https://example.test/article' })
      ext.close()
    } finally {
      await handle.close()
    }
  })

  it('零消息会话放行（无东西可续，转过去等于新会话，无害）', async () => {
    const { handle, store } = await start()
    try {
      seedRow(store, 'conv_empty')
      const ext = new TestClient(`ws://127.0.0.1:${handle.port}/?token=${handle.token}`)
      await ext.open()
      await ext.hello('pulsemind-extension')
      const res = await ext.request('session.handoff', { sessionId: 'conv_empty', page: { url: 'https://x.test' } })
      expect(res.result).toMatchObject({ ok: true })
      expect(store.rows.get('conv_empty')?.origin).toBe('local')
      ext.close()
    } finally {
      await handle.close()
    }
  })
})

/** 独立的 fake 组装：与 start() 相同，但把 sessions/store 暴露给需要注入
 *  broadcast 的用例（broadcast 是 startAgentService 的 opts，不走 start）。 */
function makeHandoffParts(): { sessions: FakeSessions; store: ReturnType<typeof makeFakeStore> } {
  return { sessions: makeFakeSessions(), store: makeFakeStore() }
}
