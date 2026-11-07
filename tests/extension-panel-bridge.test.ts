/** Panel ↔ worker routing (PLAN-browser-extension M1.3/M1.4).
 *
 * The bridge is where tab↔session binding, session resume and event delivery
 * meet, and it is the part the desktop service cannot cover with its own tests,
 * so it runs against a stub chrome API and a fake WS client here. */

import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentEventData } from '../src/shared/agent-protocol'
import { PanelBridge } from '../src/extension/background/panel-bridge'
import { getSessionForTab, getTabForSession, getTabScope } from '../src/extension/background/state'
import type { WsClient } from '../src/extension/background/ws-client'
import type { ConnectionState } from '../src/extension/bridge'

const TAB = 7
const OTHER_TAB = 9

interface SentMessage {
  tabId: number
  msg: Record<string, unknown>
}

/** Minimal chrome surface the bridge touches (storage.session + tabs). */
function installChromeStub(): { sent: SentMessage[]; tabs: unknown[]; sessionBag: Record<string, unknown> } {
  const sessionBag: Record<string, unknown> = {}
  const sent: SentMessage[] = []
  const tabs: unknown[] = []
  const area = (bag: Record<string, unknown>): unknown => ({
    get: async (key: string) => ({ [key]: bag[key] }),
    set: async (obj: Record<string, unknown>) => {
      Object.assign(bag, obj)
    },
  })
  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { session: area(sessionBag), local: area({}) },
    tabs: {
      sendMessage: async (tabId: number, msg: Record<string, unknown>) => {
        sent.push({ tabId, msg })
      },
      query: async () => tabs,
    },
    runtime: { getManifest: () => ({ version: '0.1.0' }) },
  }
  return { sent, tabs, sessionBag }
}

class FakeClient {
  connected = true
  calls: Array<{ method: string; params: Record<string, unknown> }> = []
  /** One-way service-bound messages (approval/ask_user answers). */
  notifications: Array<{ method: string; params: Record<string, unknown> }> = []
  handlers: Record<string, (params: Record<string, unknown>) => unknown> = {}

  async request(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({ method, params: (params ?? {}) as Record<string, unknown> })
    const handler = this.handlers[method]
    if (handler) return handler((params ?? {}) as Record<string, unknown>)
    return {}
  }

  notify(method: string, params?: unknown): void {
    this.notifications.push({ method, params: (params ?? {}) as Record<string, unknown> })
  }

  callsTo(method: string): Array<Record<string, unknown>> {
    return this.calls.filter((c) => c.method === method).map((c) => c.params)
  }

  notificationsTo(method: string): Array<Record<string, unknown>> {
    return this.notifications.filter((n) => n.method === method).map((n) => n.params)
  }
}

const CONNECTION: ConnectionState = { state: 'open', connected: true, serviceUrl: 'ws://127.0.0.1:8765' }

/** `session.list` answers with the model state riding along (one round trip for
 *  a mounting panel), so the stub carries it too. */
function makeModelStore(): { profiles: Array<{ id: string; name: string; provider: string; model: string }>; activeId: string } {
  return {
    profiles: [
      { id: 'p1', name: 'GPT-4o', provider: 'openai', model: 'gpt-4o' },
      { id: 'p2', name: 'Claude', provider: 'anthropic', model: 'claude-sonnet-4-5' },
    ],
    activeId: 'p1',
  }
}

function makeBridge(client: FakeClient, connection: ConnectionState = CONNECTION): PanelBridge {
  return new PanelBridge({
    getClient: () => client as unknown as WsClient,
    getConnection: () => connection,
  })
}

/** Delivery is fire-and-forget; let the promise chain drain. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const userMessage = (id: string, text: string): unknown => ({
  id,
  role: 'user',
  contentBlocks: [{ type: 'text', text }],
  createdAt: '2026-09-15T00:00:00.000Z',
})

describe('extension panel bridge', () => {
  let client: FakeClient
  let sent: SentMessage[]
  /** The raw chrome.storage.session bag — binding-symmetry assertions read the
   *  maps directly instead of going through bridge behaviour. */
  let sessionBag: Record<string, unknown>
  /** One settings store behind both RPCs, the way the real service has one: the
   *  DEFAULT switch is written to it, and the next read reports the new value. */
  let modelStore: ReturnType<typeof makeModelStore>
  /** Per-session pins behind model.setActive/model.list, the way the real
   *  service keeps conversations.profile_id. */
  let sessionModels: Map<string, string>

  beforeEach(() => {
    const stub = installChromeStub()
    sent = stub.sent
    sessionBag = stub.sessionBag
    modelStore = makeModelStore()
    sessionModels = new Map()
    client = new FakeClient()
    client.handlers['session.create'] = () => ({ sessionId: 'ws_1', agentId: 'default', resumed: false })
    client.handlers['session.list'] = () => ({ sessions: [{ sessionId: 'ws_1', title: 'X' }], model: modelStore })
    client.handlers['model.setActive'] = (params) => {
      const id = String(params.profileId)
      if (!modelStore.profiles.some((p) => p.id === id)) throw new Error(`unknown profile: ${id}`)
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined
      if (sessionId) sessionModels.set(sessionId, id)
      else modelStore = { ...modelStore, activeId: id }
      return { ok: true, model: modelStateFor(sessionId) }
    }
    client.handlers['model.list'] = (params) => modelStateFor(typeof params.sessionId === 'string' ? params.sessionId : undefined)
  })

  /** The service's scoping contract: a session's own pin when it has one, the
   *  global default otherwise. */
  const modelStateFor = (sessionId?: string) => ({
    profiles: modelStore.profiles,
    activeId: (sessionId ? sessionModels.get(sessionId) : undefined) ?? modelStore.activeId,
  })

  const panelEvents = (): SentMessage[] => sent.filter((s) => s.msg.type === 'panel/event')

  it('creates and binds a session on the first ask, carrying the page context', async () => {
    const bridge = makeBridge(client)
    const res = await bridge.handleRequest(
      { type: 'panel/ask', content: '总结这个页面', pageContext: { url: 'https://example.com/a', title: 'Example' } },
      TAB,
    )

    expect(res.ok).toBe(true)
    expect(res.snapshot?.sessionId).toBe('ws_1')
    // The page context seeds the title, so the session list is readable later.
    expect(client.callsTo('session.create')[0]).toMatchObject({
      title: 'Example',
      pageContext: { url: 'https://example.com/a', title: 'Example' },
    })
    expect(client.callsTo('agent.ask')[0]).toMatchObject({
      sessionId: 'ws_1',
      content: '总结这个页面',
      pageContext: { url: 'https://example.com/a', title: 'Example' },
    })
    // Second ask reuses the binding instead of creating another session.
    await bridge.handleRequest({ type: 'panel/ask', content: '再来' }, TAB)
    expect(client.callsTo('session.create')).toHaveLength(2) // resume with the existing id
    expect(client.callsTo('session.create')[1]).toMatchObject({ sessionId: 'ws_1' })
  })

  it('refuses to ask while the service is disconnected', async () => {
    client.connected = false
    const bridge = makeBridge(client, { state: 'closed', connected: false, reason: '未发现桌面端服务' })
    const res = await bridge.handleRequest({ type: 'panel/ask', content: 'hi' }, TAB)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('未连接')
    expect(client.calls).toHaveLength(0)
  })

  it('folds events into the mirror and delivers them only to the owning tab', async () => {
    const bridge = makeBridge(client)
    await bridge.handleRequest({ type: 'panel/ask', content: 'hi' }, TAB)
    await bridge.handleRequest({ type: 'panel/set-open', open: true }, TAB)

    bridge.onAgentEvent('ws_1', { type: 'messages_append', fromIndex: 0, items: [userMessage('m1', 'hi')] })
    bridge.onAgentEvent('ws_1', { type: 'status', status: 'streaming' })
    bridge.onAgentEvent('ws_other', { type: 'status', status: 'streaming' })
    await settle()

    expect(panelEvents()).toHaveLength(2)
    expect(panelEvents().every((s) => s.tabId === TAB)).toBe(true)
    expect(bridge.isBusy('ws_1')).toBe(true)

    // The fold is observable to a panel that attaches later.
    const res = await bridge.handleRequest({ type: 'panel/attach' }, TAB)
    expect(res.snapshot?.messages).toHaveLength(1)
    expect(res.snapshot?.status).toBe('streaming')
  })

  it('carries the failure reason into a snapshot, not just the status word', async () => {
    // A panel that attaches AFTER the failure (panel re-opened, worker restart)
    // never saw the `status` event, so the snapshot is its only carrier — without
    // `statusError` it renders its own 未知错误 instead of what main said.
    const bridge = makeBridge(client)
    await bridge.handleRequest({ type: 'panel/ask', content: 'hi' }, TAB)
    bridge.onAgentEvent('ws_1', { type: 'status', status: 'error', error: 'API 请求失败 (400)' })
    await settle()

    const res = await bridge.handleRequest({ type: 'panel/attach' }, TAB)
    expect(res.snapshot?.status).toBe('error')
    expect(res.snapshot?.statusError).toBe('API 请求失败 (400)')
  })

  it('leaves statusError unset on a healthy snapshot', async () => {
    const bridge = makeBridge(client)
    await bridge.handleRequest({ type: 'panel/ask', content: 'hi' }, TAB)
    bridge.onAgentEvent('ws_1', { type: 'status', status: 'streaming' })
    await settle()

    const res = await bridge.handleRequest({ type: 'panel/attach' }, TAB)
    expect(res.snapshot?.status).toBe('streaming')
    expect(res.snapshot?.statusError).toBeUndefined()
  })

  it('does not push to a tab whose panel is closed', async () => {
    const bridge = makeBridge(client)
    await bridge.handleRequest({ type: 'panel/ask', content: 'hi' }, TAB)
    bridge.onAgentEvent('ws_1', { type: 'status', status: 'streaming' })
    await settle()
    expect(panelEvents()).toHaveLength(0)
  })

  it('resumes a stored session and seeds the mirror from history (worker wake / desktop restart)', async () => {
    const bridge = makeBridge(client)
    await bridge.handleRequest({ type: 'panel/ask', content: 'hi' }, TAB)

    // A restarted worker loses its mirrors but not the tab binding.
    client.handlers['session.create'] = () => ({ sessionId: 'ws_1', agentId: 'default', resumed: true })
    client.handlers['agent.history'] = () => ({ messages: [userMessage('m1', 'hi')], agentId: 'default' })
    const revived = makeBridge(client)

    const res = await revived.handleRequest({ type: 'panel/attach' }, TAB)
    expect(client.callsTo('session.create').at(-1)).toMatchObject({ sessionId: 'ws_1' })
    expect(res.snapshot?.messages).toHaveLength(1)
  })

  it('follows the id the service actually used when the stored one is gone', async () => {
    const bridge = makeBridge(client)
    await bridge.handleRequest({ type: 'panel/ask', content: 'hi' }, TAB)

    // The conversation was deleted service-side: resume falls back to a new id.
    client.handlers['session.create'] = () => ({ sessionId: 'ws_new', agentId: 'default', resumed: false })
    const revived = makeBridge(client)

    const first = await revived.handleRequest({ type: 'panel/attach' }, TAB)
    expect(first.snapshot?.sessionId).toBe('ws_new')

    // The rebinding sticks: the next attach asks to resume the new id.
    const second = await revived.handleRequest({ type: 'panel/attach' }, TAB)
    expect(second.snapshot?.sessionId).toBe('ws_new')
    expect(client.callsTo('session.create').filter((p) => p.sessionId === 'ws_1')).toHaveLength(1)
  })

  it('cancels, renames and lists through the service, isolating a foreign session', async () => {
    const bridge = makeBridge(client)
    await bridge.handleRequest({ type: 'panel/ask', content: 'hi' }, TAB)

    await bridge.handleRequest({ type: 'panel/cancel' }, TAB)
    expect(client.callsTo('agent.cancel')[0]).toMatchObject({ sessionId: 'ws_1' })

    await bridge.handleRequest({ type: 'panel/rename-session', sessionId: 'ws_1', title: '新名字' }, TAB)
    expect(client.callsTo('session.rename')[0]).toMatchObject({ sessionId: 'ws_1', title: '新名字' })

    const list = await bridge.handleRequest({ type: 'panel/list-sessions' }, TAB)
    expect((list.data as Array<{ sessionId: string }>)[0].sessionId).toBe('ws_1')

    // The service owns authorization; its refusal must reach the panel as-is.
    client.handlers['session.rename'] = () => {
      throw new Error('not your session (code -32005)')
    }
    const forbidden = await bridge.handleRequest({ type: 'panel/rename-session', sessionId: 'ws_x', title: 't' }, TAB)
    expect(forbidden.ok).toBe(false)
    expect(forbidden.error).toContain('not your session')
  })

  it('unbinds the tab on delete and starts a fresh session on request', async () => {
    const bridge = makeBridge(client)
    await bridge.handleRequest({ type: 'panel/ask', content: 'hi' }, TAB)

    await bridge.handleRequest({ type: 'panel/delete-session', sessionId: 'ws_1' }, TAB)
    const afterDelete = await bridge.handleRequest({ type: 'panel/attach' }, TAB)
    expect(afterDelete.snapshot?.sessionId).toBeNull()

    client.handlers['session.create'] = () => ({ sessionId: 'ws_2', agentId: 'default', resumed: false })
    const created = await bridge.handleRequest({ type: 'panel/new-session' }, TAB)
    expect(created.snapshot?.sessionId).toBe('ws_2')
  })

  it('keeps per-tab bindings apart', async () => {
    let next = 0
    client.handlers['session.create'] = (params) =>
      params.sessionId
        ? { sessionId: params.sessionId, agentId: 'default', resumed: true }
        : { sessionId: `ws_${++next}`, agentId: 'default' }
    const bridge = makeBridge(client)
    await bridge.handleRequest({ type: 'panel/ask', content: 'a' }, TAB)
    await bridge.handleRequest({ type: 'panel/ask', content: 'b' }, OTHER_TAB)

    // Each tab holds its own session; a tab never adopts the other's.
    const first = await bridge.handleRequest({ type: 'panel/attach' }, TAB)
    const second = await bridge.handleRequest({ type: 'panel/attach' }, OTHER_TAB)
    expect(first.snapshot?.sessionId).toBe('ws_1')
    expect(second.snapshot?.sessionId).toBe('ws_2')
    expect(client.callsTo('agent.ask').map((p) => p.sessionId)).toEqual(['ws_1', 'ws_2'])
  })

  // ── 历史会话 scope per tab (2026-11-03) ─────────────────────────────
  // One Chrome tab shares ONE 历史会话 list across refresh/navigation; two tabs
  // must never see each other's conversations. The scope is a token minted per
  // tab in session storage and stamped on the conversation row, so both the
  // create and the list have to carry it.

  it('gives each tab its own 历史会话 scope and keeps it stable across re-attaches', async () => {
    const bridge = makeBridge(client)

    await bridge.handleRequest({ type: 'panel/attach' }, TAB)
    const scopeA = client.callsTo('session.list')[0]?.tabKey
    expect(typeof scopeA).toBe('string')
    expect(scopeA).toBeTruthy()

    // Refresh / navigation keep the tab id, so the same tab keeps its scope —
    // that is what makes its list survive a reload.
    await bridge.handleRequest({ type: 'panel/attach' }, TAB)
    expect(client.callsTo('session.list')[1]?.tabKey).toBe(scopeA)

    // A sibling tab is a different scope: its list can never show this tab's rows.
    await bridge.handleRequest({ type: 'panel/attach' }, OTHER_TAB)
    const scopeB = client.callsTo('session.list')[2]?.tabKey
    expect(typeof scopeB).toBe('string')
    expect(scopeB).not.toBe(scopeA)

    // The live scope set rides along (review_20261104 中3): the service
    // releases dead stamps (previous browser sessions) so the rows re-adopt
    // into this tab instead of stranding after a Chrome restart.
    const scopesSeen = client.callsTo('session.list').at(-1)?.liveScopes
    expect(Array.isArray(scopesSeen)).toBe(true)
    expect(scopesSeen).toContain(scopeA)
    expect(scopesSeen).toContain(scopeB)

    // The create stamps the same scope, so the service can list the new
    // conversation back to this tab (and only to it).
    await bridge.handleRequest({ type: 'panel/ask', content: 'hi' }, TAB)
    expect(client.callsTo('session.create')[0].tabKey).toBe(scopeA)
    // A resume carries it too — a service whose row lost the stamp must not be
    // able to strand this conversation outside the tab's list.
    await bridge.handleRequest({ type: 'panel/ask', content: '再来' }, TAB)
    expect(client.callsTo('session.create')[1]).toMatchObject({ sessionId: 'ws_1', tabKey: scopeA })

    // The scope is persisted, not minted per call: a worker restart rebuilds
    // the bridge from an empty module and must read the same token back.
    const revived = makeBridge(client)
    await revived.handleRequest({ type: 'panel/attach' }, TAB)
    expect(client.callsTo('session.list').at(-1)?.tabKey).toBe(scopeA)
  })

  // review_20261104 高1：会话列表是 tab 作用域数据，刷新点只允许回请求页签。
  // 旧实现 broadcast 给所有打开面板——B 的历史菜单被 A 的列表整表顶掉，B 还能
  // resume A 的行（把会话绑定搬走、COALESCE 把 tab_key 永久改写进 B 作用域）。
  it('routes the session-list refresh only to the requesting tab (review_20261104 高1)', async () => {
    const bridge = makeBridge(client)
    // Both panels open: a leaked broadcast lands in `sent` addressed to both.
    // The attach mints each tab's scope (session.list carries it).
    await bridge.handleRequest({ type: 'panel/attach' }, TAB)
    await bridge.handleRequest({ type: 'panel/attach' }, OTHER_TAB)
    await bridge.handleRequest({ type: 'panel/set-open', open: true }, TAB)
    await bridge.handleRequest({ type: 'panel/set-open', open: true }, OTHER_TAB)
    const scopes = sessionBag.tabScopes as Record<string, string>
    const scopeA = scopes[String(TAB)]
    const scopeB = scopes[String(OTHER_TAB)]
    expect(scopeA).toBeTruthy()
    expect(scopeB).toBeTruthy()
    // The fake service answers each scoped list with a row naming that scope,
    // so a leaked list is identifiable by payload alone.
    client.handlers['session.list'] = (params) => ({
      sessions: [{ sessionId: 'ws_1', title: `rows-of-${params.tabKey}` }],
      model: modelStore,
    })
    sent.length = 0

    // All four refresh points, each triggered by TAB only.
    await bridge.handleRequest({ type: 'panel/rename-session', sessionId: 'ws_1', title: '改名' }, TAB)
    await bridge.handleRequest({ type: 'panel/new-session' }, TAB)
    await bridge.handleRequest({ type: 'panel/delete-session', sessionId: 'ws_1' }, TAB)
    await bridge.handleRequest({ type: 'panel/ask', content: 'hi' }, TAB) // ensureSession 铸新会话
    await settle()

    const listMessages = sent.filter((s) => s.msg.type === 'panel/sessions')
    expect(listMessages.length).toBeGreaterThan(0)
    expect(listMessages.every((s) => s.tabId === TAB)).toBe(true)
    for (const m of listMessages) {
      for (const row of m.msg.payload as Array<{ title: string }>) {
        expect(row.title).toBe(`rows-of-${scopeA}`)
      }
    }
  })

  // review_20261104 中4：getTabScope 是整表读改写，两次并发首铸（attach 的
  // inventory 与首条消息的 createSession）各从旧 map 铸 token、后写覆盖先写——
  // 败者的 token 已盖在会话上、存储里却活着另一个，该会话在自己的页签列表里
  // 永久隐形。铸造串行化后并发调用必须拿到同一个 token。
  it('concurrent first mints of one tab agree on a single scope (review_20261104 中4)', async () => {
    const [a, b] = await Promise.all([getTabScope(101), getTabScope(101)])
    expect(a).toBe(b)
    // 落盘的是双方共用的那一个，不是被覆盖的孤儿。
    const stored = (sessionBag.tabScopes as Record<string, string>)[String(101)]
    expect(stored).toBe(a)
  })

  it('drops a closed tab binding so events stop being routed to it', async () => {
    const bridge = makeBridge(client)
    await bridge.handleRequest({ type: 'panel/ask', content: 'hi' }, TAB)
    await bridge.handleRequest({ type: 'panel/set-open', open: true }, TAB)

    await bridge.onTabClosed(TAB)
    bridge.onAgentEvent('ws_1', { type: 'status', status: 'streaming' } as AgentEventData)
    await settle()

    expect(panelEvents()).toHaveLength(0)
    const res = await bridge.handleRequest({ type: 'panel/attach' }, TAB)
    expect(res.snapshot?.sessionId).toBeNull()
  })

  // ── 授权 (approval mode) ───────────────────────────────────────────

  it('keeps a pre-session approval choice on the tab and replays it onto the session', async () => {
    const bridge = makeBridge(client)
    // No session yet: there is no conversation row to store the mode on, so the
    // choice has to survive in the tab binding.
    const set = await bridge.handleRequest({ type: 'panel/set-approval', mode: 'always-ask' }, TAB)
    expect(set.ok).toBe(true)
    expect(set.snapshot?.approvalMode).toBe('always-ask')
    expect(client.callsTo('session.setApprovalMode')).toHaveLength(0)

    // The session appears with the first ask — the choice rides along.
    await bridge.handleRequest({ type: 'panel/ask', content: 'hi' }, TAB)
    expect(client.callsTo('session.setApprovalMode')[0]).toMatchObject({ sessionId: 'ws_1', mode: 'always-ask' })
  })

  it('sends the mode straight through once a session exists, and prefers the stored one', async () => {
    const bridge = makeBridge(client)
    await bridge.handleRequest({ type: 'panel/ask', content: 'hi' }, TAB)

    await bridge.handleRequest({ type: 'panel/set-approval', mode: 'auto' }, TAB)
    expect(client.callsTo('session.setApprovalMode').at(-1)).toMatchObject({ sessionId: 'ws_1', mode: 'auto' })

    // The desktop's column is the authority: a session list carrying a different
    // mode wins over the tab's local carry-over.
    client.handlers['session.list'] = () => ({ sessions: [{ sessionId: 'ws_1', title: 'X', approvalMode: 'outside-ask' }] })
    const attached = await bridge.handleRequest({ type: 'panel/attach' }, TAB)
    expect(attached.snapshot?.approvalMode).toBe('outside-ask')
  })

  // ── 授权 for a session the list does not carry (2026-11-02) ─────────
  // `session.list` lists only conversations WITH messages now (the 历史会话
  // menu was full of 未命名会话 stubs — every session.create upserts a row).
  // The snapshot used to read the current session's 授权 off that list, so a
  // fresh session (新会话, 授权 picked, nothing sent yet) would have shown the
  // default right after the click and after every reload.

  it('keeps the 授权 of a message-less session that session.list no longer carries', async () => {
    const bridge = makeBridge(client)
    // 新会话 → an empty conversation: the real list omits it from here on.
    client.handlers['session.list'] = () => ({ sessions: [], model: modelStore })
    await bridge.handleRequest({ type: 'panel/new-session' }, TAB)

    const set = await bridge.handleRequest({ type: 'panel/set-approval', mode: 'auto' }, TAB)
    expect(client.callsTo('session.setApprovalMode').at(-1)).toMatchObject({ sessionId: 'ws_1', mode: 'auto' })
    // The answer's snapshot and a later re-attach both show the choice, with
    // no list row and no tab carry-over (the carry is consumed on write).
    expect(set.snapshot?.approvalMode).toBe('auto')
    const attached = await bridge.handleRequest({ type: 'panel/attach' }, TAB)
    expect(attached.snapshot?.approvalMode).toBe('auto')
    expect(sessionBag.approvalModes ?? {}).toEqual({})
  })

  it('a cold attach seeds the 授权 from agent.snapshot when the list has no row for it', async () => {
    const bridge = makeBridge(client)
    await bridge.handleRequest({ type: 'panel/new-session' }, TAB)

    // Worker restart: mirrors (and the cache) are gone, the tab binding stays.
    // The service's still-life carries the stored column; the list is empty.
    client.handlers['session.create'] = () => ({ sessionId: 'ws_1', agentId: 'default', resumed: true })
    client.handlers['session.list'] = () => ({ sessions: [], model: modelStore })
    client.handlers['agent.snapshot'] = () => ({
      messages: [],
      status: { status: 'idle' },
      streamingBlocks: [],
      plan: null,
      fileChanges: [],
      lastCompaction: null,
      approvalMode: 'always-ask',
    })
    const revived = makeBridge(client)
    const res = await revived.handleRequest({ type: 'panel/attach' }, TAB)
    expect(res.snapshot?.approvalMode).toBe('always-ask')
  })

  // review_20261103 高3：doCreateSession 把「上次使用」档位播种进每个无配置的
  // 新会话列，而该会话既进不了 session.list（EXISTS(messages)）也等不到冷快照
  // （bridge 已持 mirror，snapshot 路径被跳过）——面板显示「按需确认」、引擎
  // 实际按 auto 放行。session.create 现在把列值带回来，createSession 播种缓存，
  // 一处覆盖两个铸造点。
  it('session.create 的 approvalMode 播种缓存：新会话快照显示服务端真实档位', async () => {
    const bridge = makeBridge(client)
    // 服务端按「上次使用」播种了 auto；该会话无消息，list 永远不携带它。
    client.handlers['session.create'] = () => ({ sessionId: 'ws_1', agentId: 'default', approvalMode: 'auto' })
    client.handlers['session.list'] = () => ({ sessions: [], model: modelStore })
    const res = await bridge.handleRequest({ type: 'panel/new-session' }, TAB)
    expect(res.snapshot?.approvalMode).toBe('auto')

    // 重挂（worker 不重启，mirror 已在）：缓存仍在，快照继续显示真实档位。
    const attached = await bridge.handleRequest({ type: 'panel/attach' }, TAB)
    expect(attached.snapshot?.approvalMode).toBe('auto')

    // 预会话 carry 仍然赢过播种值：干净页签先摆 carry，再开新会话，快照显示 carry。
    const second = makeBridge(client)
    client.handlers['session.create'] = () => ({ sessionId: 'ws_2', agentId: 'default', approvalMode: 'auto' })
    await second.handleRequest({ type: 'panel/set-approval', mode: 'always-ask' }, OTHER_TAB)
    const carried = await second.handleRequest({ type: 'panel/new-session' }, OTHER_TAB)
    expect(carried.snapshot?.approvalMode).toBe('always-ask')
    expect(client.callsTo('session.setApprovalMode').at(-1)).toMatchObject({ sessionId: 'ws_2', mode: 'always-ask' })
  })

  it('a list row (the freshest read of the column) still outranks the cached 授权', async () => {
    const bridge = makeBridge(client)
    await bridge.handleRequest({ type: 'panel/ask', content: 'hi' }, TAB)
    await bridge.handleRequest({ type: 'panel/set-approval', mode: 'auto' }, TAB)
    client.handlers['session.list'] = () => ({ sessions: [{ sessionId: 'ws_1', title: 'X', approvalMode: 'outside-ask' }], model: modelStore })
    const attached = await bridge.handleRequest({ type: 'panel/attach' }, TAB)
    expect(attached.snapshot?.approvalMode).toBe('outside-ask')
  })

  it('relays an approval decision and an ask_user answer as requests (unknown callId must be visible)', async () => {
    const bridge = makeBridge(client)
    await bridge.handleRequest({ type: 'panel/ask', content: 'hi' }, TAB)

    // Requests, not notifications: the service answers whether the callId was
    // still parked, so a stale button (server-side timeout already rejected)
    // reaches the panel as a failed answer instead of a silent no-op.
    const approval = await bridge.handleRequest({ type: 'panel/approval-response', callId: 'toolu_1', approved: true }, TAB)
    expect(approval.ok).toBe(true)
    expect(client.callsTo('approval.response')).toEqual([{ callId: 'toolu_1', approved: true }])

    await bridge.handleRequest({ type: 'panel/answer', callId: 'toolu_2', response: '北京' }, TAB)
    expect(client.callsTo('ask_user.response')).toEqual([{ callId: 'toolu_2', response: '北京' }])

    // And the failure path: the service's unknown-callId error propagates.
    client.handlers['approval.response'] = () => {
      throw new Error('unknown callId: toolu_x')
    }
    const stale = await bridge.handleRequest({ type: 'panel/approval-response', callId: 'toolu_x', approved: true }, TAB)
    expect(stale.ok).toBe(false)
    expect(stale.error).toContain('unknown callId')
  })

  it('refuses to relay an answer while the service is disconnected', async () => {
    client.connected = false
    const bridge = makeBridge(client, { state: 'closed', connected: false, reason: '未发现桌面端服务' })

    const res = await bridge.handleRequest({ type: 'panel/approval-response', callId: 'toolu_1', approved: true }, TAB)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('未连接')
    expect(client.calls).toHaveLength(0)
  })

  it('relays the loop-limit decision with the tab session id (iteration_limit.response)', async () => {
    const bridge = makeBridge(client)
    await bridge.handleRequest({ type: 'panel/ask', content: 'hi' }, TAB)

    const res = await bridge.handleRequest({ type: 'panel/iteration-response', approved: true }, TAB)
    expect(res.ok).toBe(true)
    expect(client.callsTo('iteration_limit.response')).toEqual([{ sessionId: 'ws_1', approved: true }])

    await bridge.handleRequest({ type: 'panel/iteration-response', approved: false }, TAB)
    expect(client.callsTo('iteration_limit.response')).toEqual([
      { sessionId: 'ws_1', approved: true },
      { sessionId: 'ws_1', approved: false },
    ])
  })

  it('refuses the loop-limit decision without a bound session', async () => {
    const bridge = makeBridge(client)
    const res = await bridge.handleRequest({ type: 'panel/iteration-response', approved: true }, TAB)
    expect(res.ok).toBe(false)
    expect(client.calls).toHaveLength(0)
  })

  // ── 模型 (per conversation, like 授权) ──────────────────────────────

  it('keeps a pre-session model choice on the tab and replays it onto the session', async () => {
    const bridge = makeBridge(client)
    // No session yet: there is no conversation row to store the model on, so
    // the choice has to survive in the tab binding.
    const set = await bridge.handleRequest({ type: 'panel/set-model', profileId: 'p2' }, TAB)
    expect(set.ok).toBe(true)
    expect(set.snapshot?.model).toMatchObject({ activeId: 'p2' })
    expect(client.callsTo('model.setActive')).toHaveLength(0)

    // The session appears with the first ask — the choice rides along, and
    // the picker then reads the session-scoped state back.
    const asked = await bridge.handleRequest({ type: 'panel/ask', content: 'hi' }, TAB)
    expect(client.callsTo('model.setActive')[0]).toMatchObject({ sessionId: 'ws_1', profileId: 'p2' })
    expect(asked.snapshot?.model).toMatchObject({ activeId: 'p2' })
    // The DEFAULT never moved: only this conversation pinned itself.
    expect(modelStore.activeId).toBe('p1')
  })

  it('sends the model straight through once a session exists, without touching the default', async () => {
    const bridge = makeBridge(client)
    await bridge.handleRequest({ type: 'panel/ask', content: 'hi' }, TAB)

    const res = await bridge.handleRequest({ type: 'panel/set-model', profileId: 'p2' }, TAB)
    expect(res.ok).toBe(true)
    expect(client.callsTo('model.setActive')).toEqual([{ profileId: 'p2', sessionId: 'ws_1' }])
    expect(res.snapshot?.model).toMatchObject({ activeId: 'p2' })
    expect(modelStore.activeId).toBe('p1')

    // Per conversation now: no cross-tab broadcast — other tabs'
    // conversations did not move.
    await settle()
    expect(sent.filter((s) => s.msg.type === 'panel/model')).toHaveLength(0)
  })

  it('reports a refused model switch and answers with the unchanged state', async () => {
    const bridge = makeBridge(client)
    await bridge.handleRequest({ type: 'panel/ask', content: 'hi' }, TAB)

    const res = await bridge.handleRequest({ type: 'panel/set-model', profileId: 'nope' }, TAB)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('unknown profile')
    expect(modelStore.activeId).toBe('p1')
  })

  it('refuses a session-scoped model switch while the service is disconnected', async () => {
    const bridge = makeBridge(client)
    await bridge.handleRequest({ type: 'panel/ask', content: 'hi' }, TAB)
    expect(client.callsTo('session.create')).toHaveLength(1)

    // The session exists, so the click must reach the service — a disconnect
    // refuses it instead of silently holding it (unlike the pre-session case,
    // which never touches the service and is kept on the tab).
    client.connected = false
    const down = makeBridge(client, { state: 'closed', connected: false, reason: '未发现桌面端服务' })
    const res = await down.handleRequest({ type: 'panel/set-model', profileId: 'p2' }, TAB)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('未连接')
    expect(client.callsTo('model.setActive')).toHaveLength(0)
  })

  // ── 绑定对称性 + 预会话选择的生命周期 ──────────────────────────────

  it('rebinding a session from a second tab releases the first tab\'s stale claim', async () => {
    const bridge = makeBridge(client)
    await bridge.handleRequest({ type: 'panel/ask', content: 'hi' }, TAB)
    expect(await getSessionForTab(TAB)).toBe('ws_1')

    // The same session resumed from another tab: the session routes there now,
    // so tab 7 must not keep believing it owns it (its asks would otherwise
    // vanish into a transcript it never receives).
    await bridge.handleRequest({ type: 'panel/resume-session', sessionId: 'ws_1' }, OTHER_TAB)

    expect(await getTabForSession('ws_1')).toBe(OTHER_TAB)
    expect(await getSessionForTab(TAB)).toBeNull()
    expect(await getSessionForTab(OTHER_TAB)).toBe('ws_1')
  })

  it('resume-session switches the tab to that conversation\'s transcript', async () => {
    const bridge = makeBridge(client)
    await bridge.handleRequest({ type: 'panel/ask', content: '第一个' }, TAB)
    expect(await getSessionForTab(TAB)).toBe('ws_1')

    // The 历史会话 row for another conversation: the id must survive the wire
    // (2026-11-02 — `session.list` shipped the store's raw `id`, so the panel
    // called this with `undefined` and the click did nothing).
    client.handlers['session.create'] = (params) => ({ sessionId: String(params.sessionId ?? 'ws_x'), agentId: 'default', resumed: true })
    // Full still-life shape: seedSessionState reads status/streamingBlocks/plan,
    // and a partial snapshot throws into the agent.history fallback instead.
    client.handlers['agent.snapshot'] = () => ({
      messages: [userMessage('m2', '第二个会话')],
      status: { status: 'idle' },
      streamingBlocks: [],
      plan: null,
    })

    const res = await bridge.handleRequest({ type: 'panel/resume-session', sessionId: 'ws_2' }, TAB)
    expect(res.ok).toBe(true)
    expect(res.snapshot?.sessionId).toBe('ws_2')
    expect(res.snapshot?.messages).toHaveLength(1)
    expect(await getSessionForTab(TAB)).toBe('ws_2')
    expect(client.callsTo('agent.snapshot').at(-1)).toMatchObject({ sessionId: 'ws_2' })
  })

  it('refuses a resume without an id and keeps the tab\'s current binding', async () => {
    const bridge = makeBridge(client)
    await bridge.handleRequest({ type: 'panel/ask', content: 'hi' }, TAB)

    // A malformed row must fail loudly BEFORE clearTab: unbinding first turned
    // the broken click into "this panel now has no conversation at all". No
    // service round trip may happen on the way out (the first ask's
    // session.create is the only one on record).
    const createdBefore = client.callsTo('session.create').length
    const res = await bridge.handleRequest(
      { type: 'panel/resume-session', sessionId: undefined as unknown as string },
      TAB,
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain('会话 id')
    expect(await getSessionForTab(TAB)).toBe('ws_1')
    expect(client.callsTo('session.create')).toHaveLength(createdBefore)
  })

  it('consumes a pre-session choice after carrying it — it never resurfaces', async () => {
    const bridge = makeBridge(client)
    await bridge.handleRequest({ type: 'panel/set-model', profileId: 'p2' }, TAB)
    await bridge.handleRequest({ type: 'panel/set-approval', mode: 'always-ask' }, TAB)

    // First ask carries both onto the session…
    await bridge.handleRequest({ type: 'panel/ask', content: 'hi' }, TAB)
    expect(client.callsTo('model.setActive')).toHaveLength(1)
    expect(client.callsTo('session.setApprovalMode')).toHaveLength(1)

    // …and consumes the tab values: after the session is deleted, the next
    // fresh session must NOT be pinned to picks from the previous one.
    await bridge.handleRequest({ type: 'panel/delete-session', sessionId: 'ws_1' }, TAB)
    await bridge.handleRequest({ type: 'panel/ask', content: 'again' }, TAB)
    expect(client.callsTo('model.setActive')).toHaveLength(1)
    expect(client.callsTo('session.setApprovalMode')).toHaveLength(1)
    expect(sessionBag.approvalModes).toEqual({})
    expect(sessionBag.modelIds).toEqual({})
  })

  it('a FAILED carry still consumes the tab value — no dormant pin for the next session (review 20261009 中5)', async () => {
    const bridge = makeBridge(client)
    // A pick the desktop cannot honor (profile deleted since): model.setActive
    // throws deterministically for the unknown id.
    await bridge.handleRequest({ type: 'panel/set-model', profileId: 'gone' }, TAB)

    // The first ask delivers the carry best-effort: the RPC failed but the tab
    // value is consumed anyway, and the ask itself still went out (a failed
    // carry must not fail the message that triggered it).
    await bridge.handleRequest({ type: 'panel/ask', content: 'hi' }, TAB)
    expect(client.callsTo('model.setActive')).toHaveLength(1)
    expect(sessionBag.modelIds).toEqual({})
    expect(client.callsTo('agent.ask')).toHaveLength(1)

    // The old "kept for a retry" contract never retried — the carry runs only
    // while the session id moves — so the value slept until the next fresh
    // session and pinned THAT one, the exact shape the carry exists to prevent.
    await bridge.handleRequest({ type: 'panel/delete-session', sessionId: 'ws_1' }, TAB)
    await bridge.handleRequest({ type: 'panel/ask', content: 'again' }, TAB)
    expect(client.callsTo('model.setActive')).toHaveLength(1)
  })

  it('set-approval with a live session writes only the column, not the tab carry-over', async () => {
    const bridge = makeBridge(client)
    await bridge.handleRequest({ type: 'panel/ask', content: 'hi' }, TAB)

    await bridge.handleRequest({ type: 'panel/set-approval', mode: 'auto' }, TAB)
    expect(client.callsTo('session.setApprovalMode').at(-1)).toMatchObject({ sessionId: 'ws_1', mode: 'auto' })
    // Tab-scoped choices are strictly pre-session: a live-session click must
    // not leave a stale duplicate that resurrects on the next fresh session.
    expect(sessionBag.approvalModes ?? {}).toEqual({})
  })

  it('新会话 carries the pre-session 授权/模型 choices too (same as the first ask)', async () => {
    const bridge = makeBridge(client)
    await bridge.handleRequest({ type: 'panel/set-model', profileId: 'p2' }, TAB)
    await bridge.handleRequest({ type: 'panel/set-approval', mode: 'always-ask' }, TAB)

    // The carry must not depend on what the user does next: 新会话 lands the
    // same choices the first ask would have.
    const res = await bridge.handleRequest({ type: 'panel/new-session' }, TAB)
    expect(res.ok).toBe(true)
    expect(client.callsTo('model.setActive')[0]).toMatchObject({ sessionId: 'ws_1', profileId: 'p2' })
    expect(client.callsTo('session.setApprovalMode')[0]).toMatchObject({ sessionId: 'ws_1', mode: 'always-ask' })
    expect(sessionBag.approvalModes).toEqual({})
    expect(sessionBag.modelIds).toEqual({})
  })
})
