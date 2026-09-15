/** WsClient handshake/backoff behaviour (PLAN-browser-extension M0.5 + fix).
 *
 * The client is Chrome-free by design (WebSocket is injectable), so these run
 * under plain vitest with a fake socket. The first case is the regression that
 * shipped: request()'s "handshake done" gate also covered the hello request
 * itself, so hello was rejected forever and the extension could never connect. */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CloseCodes } from '../src/shared/agent-protocol/methods'
import { WsClient, type WsClientConfig } from '../src/extension/background/ws-client'

interface FakeFrame {
  jsonrpc: string
  id?: number
  method?: string
  params?: Record<string, unknown>
}

const CFG: WsClientConfig = {
  wsUrl: 'ws://127.0.0.1:8765',
  token: 'tok',
  clientId: 'pulsemind-extension',
  clientVersion: '0.4.0',
  protocolVersion: 1,
  reconnectBaseMs: 10,
}

/** Minimal WebSocket stand-in: the test drives open/message/close by hand. */
class FakeSocket {
  static OPEN = 1
  static instances: FakeSocket[] = []
  /** Reply for every outbound request; null = stay silent (timeout path). */
  static autoReply: ((frame: FakeFrame) => Record<string, unknown>) | null = () => ({
    result: { protocolVersion: 1, serviceVersion: '0.3.5' },
  })

  readyState = 0
  sent: FakeFrame[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null

  constructor(public url: string) {
    FakeSocket.instances.push(this)
  }

  send(data: string): void {
    const frame = JSON.parse(data) as FakeFrame
    this.sent.push(frame)
    const reply = FakeSocket.autoReply?.(frame)
    if (frame.method && frame.id !== undefined && reply) {
      queueMicrotask(() => this.receive({ jsonrpc: '2.0', id: frame.id, ...reply }))
    }
  }

  close(): void {
    this.readyState = 3
  }

  open(): void {
    this.readyState = FakeSocket.OPEN
    this.onopen?.()
  }

  receive(msg: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }

  serverClose(code: number, reason = ''): void {
    this.readyState = 3
    this.onclose?.({ code, reason })
  }
}

function makeClient(handlers = {}): WsClient {
  return new WsClient(CFG, handlers, FakeSocket as unknown as typeof WebSocket)
}

const lastFrame = (socket: FakeSocket): FakeFrame => socket.sent[socket.sent.length - 1]

describe('extension WsClient', () => {
  beforeEach(() => {
    FakeSocket.instances = []
    FakeSocket.autoReply = () => ({ result: { protocolVersion: 1, serviceVersion: '0.3.5' } })
  })

  it('completes the hello handshake (regression: the gate must not reject hello itself)', async () => {
    const states: string[] = []
    const client = makeClient({ onStateChange: (s: 'connecting' | 'open' | 'closed') => states.push(s) })

    const ready = client.connect()
    const socket = FakeSocket.instances[0]
    expect(socket.url).toBe('ws://127.0.0.1:8765/?token=tok')

    socket.open()
    await ready

    expect(client.connected).toBe(true)
    expect(client.state).toBe('open')
    expect(client.lastError).toBe('')
    expect(socket.sent[0].method).toBe('hello')
    expect(socket.sent[0].params).toMatchObject({ clientId: 'pulsemind-extension', protocolVersion: 1 })
    expect(states).toEqual(['connecting', 'open'])

    client.close()
  })

  it('refuses business requests before the handshake, then services them after', async () => {
    const client = makeClient()
    const ready = client.connect()
    const socket = FakeSocket.instances[0]
    socket.open()

    // hello is still in flight here — the gate must hold everything but `hello`.
    await expect(client.request('agent.ask', { sessionId: 's1' })).rejects.toThrow('not connected')

    await ready
    const ask = client.request('agent.ask', { sessionId: 's1' })
    const frame = lastFrame(socket)
    expect(frame.method).toBe('agent.ask')
    socket.receive({ jsonrpc: '2.0', id: frame.id, result: { accepted: true } })
    await expect(ask).resolves.toEqual({ accepted: true })

    client.close()
  })

  it('settles the ready promise and records the reason when hello is refused', async () => {
    FakeSocket.autoReply = () => ({ error: { code: -32002, message: 'protocol version mismatch' } })
    const client = makeClient()

    const ready = client.connect()
    FakeSocket.instances[0].open()

    await expect(ready).rejects.toThrow('protocol version mismatch')
    expect(client.connected).toBe(false)
    expect(client.state).toBe('closed')
    expect(client.lastError).toContain('hello 失败')

    client.close()
  })

  it('records the server close code so the SW can re-pair on 4401', async () => {
    const client = makeClient()
    const ready = client.connect()
    const socket = FakeSocket.instances[0]
    socket.open()
    await ready

    socket.serverClose(CloseCodes.unauthorized, 'unauthorized')

    expect(client.lastCloseCode).toBe(CloseCodes.unauthorized)
    expect(client.lastError).toContain('4401')
    expect(client.connected).toBe(false)

    client.close()
  })

  it('a manual close suppresses reconnection and drops in-flight requests', async () => {
    vi.useFakeTimers()
    try {
      const client = makeClient()
      const ready = client.connect()
      const socket = FakeSocket.instances[0]
      socket.open()
      await ready

      FakeSocket.autoReply = () => null // stay silent: the request must be rejected by teardown
      const inFlight = client.request('agent.ask')
      client.close()

      await expect(inFlight).rejects.toThrow('closed by client')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(FakeSocket.instances).toHaveLength(1)
      expect(client.state).toBe('closed')
    } finally {
      vi.useRealTimers()
    }
  })
})
