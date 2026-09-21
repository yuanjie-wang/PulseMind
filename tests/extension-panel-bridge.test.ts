/** Panel ↔ worker routing (PLAN-browser-extension M1.3/M1.4).
 *
 * The bridge is where tab↔session binding, session resume and event delivery
 * meet, and it is the part the desktop service cannot cover with its own tests,
 * so it runs against a stub chrome API and a fake WS client here. */

import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentEventData } from '../src/shared/agent-protocol'
import { PanelBridge } from '../src/extension/background/panel-bridge'
import type { WsClient } from '../src/extension/background/ws-client'
import type { ConnectionState } from '../src/extension/bridge'

const TAB = 7
const OTHER_TAB = 9

interface SentMessage {
  tabId: number
  msg: Record<string, unknown>
}

/** Minimal chrome surface the bridge touches (storage.session + tabs). */
function installChromeStub(): { sent: SentMessage[]; tabs: unknown[] } {
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
  return { sent, tabs }
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
  let tabs: unknown[]
  /** One settings store behind both RPCs, the way the real service has one: the
   *  switch is written to it, and the next read reports the new active profile. */
  let modelStore: ReturnType<typeof makeModelStore>

  beforeEach(() => {
    const stub = installChromeStub()
    sent = stub.sent
    tabs = stub.tabs
    modelStore = makeModelStore()
    client = new FakeClient()
    client.handlers['session.create'] = () => ({ sessionId: 'ws_1', agentId: 'default', resumed: false })
    client.handlers['session.list'] = () => ({ sessions: [{ sessionId: 'ws_1', title: 'X' }], model: modelStore })
    client.handlers['model.setActive'] = (params) => {
      const id = String(params.profileId)
      if (!modelStore.profiles.some((p) => p.id === id)) throw new Error(`unknown profile: ${id}`)
      modelStore = { ...modelStore, activeId: id }
      return { ok: true, model: modelStore }
    }
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

  it('relays an approval decision and an ask_user answer as one-way notifications', async () => {
    const bridge = makeBridge(client)
    await bridge.handleRequest({ type: 'panel/ask', content: 'hi' }, TAB)

    const approval = await bridge.handleRequest({ type: 'panel/approval-response', callId: 'toolu_1', approved: true }, TAB)
    expect(approval.ok).toBe(true)
    expect(client.notificationsTo('approval.response')).toEqual([{ callId: 'toolu_1', approved: true }])

    await bridge.handleRequest({ type: 'panel/answer', callId: 'toolu_2', response: '北京' }, TAB)
    expect(client.notificationsTo('ask_user.response')).toEqual([{ callId: 'toolu_2', response: '北京' }])
  })

  it('refuses to relay an answer while the service is disconnected', async () => {
    client.connected = false
    const bridge = makeBridge(client, { state: 'closed', connected: false, reason: '未发现桌面端服务' })

    const res = await bridge.handleRequest({ type: 'panel/approval-response', callId: 'toolu_1', approved: true }, TAB)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('未连接')
    expect(client.notifications).toHaveLength(0)
  })

  // ── 模型 (global, unlike 授权) ──────────────────────────────────────

  it('switches the model through the service and broadcasts it to every open panel', async () => {
    const bridge = makeBridge(client)
    await bridge.handleRequest({ type: 'panel/ask', content: 'hi' }, TAB)
    tabs.push({ id: TAB })
    await bridge.handleRequest({ type: 'panel/set-open', open: true }, TAB)

    const res = await bridge.handleRequest({ type: 'panel/set-model', profileId: 'p2' }, TAB)
    expect(res.ok).toBe(true)
    // Nothing is written tab-locally: the service owns the setting (it is the
    // same one the desktop's picker writes) and answers with the state after it.
    expect(client.callsTo('model.setActive')).toEqual([{ profileId: 'p2' }])
    expect(res.snapshot?.model).toMatchObject({ activeId: 'p2' })

    // The switch is global, so the panels that did not click have to hear about
    // it — otherwise every other tab keeps showing the previous model.
    await settle()
    const pushed = sent.filter((s) => s.msg.type === 'panel/model')
    expect(pushed).toHaveLength(1)
    expect(pushed[0].msg.payload).toMatchObject({ activeId: 'p2' })
  })

  it('reports a refused model switch and pushes nothing', async () => {
    const bridge = makeBridge(client)
    tabs.push({ id: TAB })
    await bridge.handleRequest({ type: 'panel/set-open', open: true }, TAB)

    const res = await bridge.handleRequest({ type: 'panel/set-model', profileId: 'nope' }, TAB)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('unknown profile')
    expect(modelStore.activeId).toBe('p1')

    await settle()
    expect(sent.filter((s) => s.msg.type === 'panel/model')).toHaveLength(0)
  })

  it('refuses a model switch while the service is disconnected', async () => {
    client.connected = false
    const bridge = makeBridge(client, { state: 'closed', connected: false, reason: '未发现桌面端服务' })

    const res = await bridge.handleRequest({ type: 'panel/set-model', profileId: 'p2' }, TAB)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('未连接')
    expect(client.calls).toHaveLength(0)
  })
})
