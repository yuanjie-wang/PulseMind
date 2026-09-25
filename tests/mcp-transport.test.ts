// review 20260925 item 9 (second tier) — MCP transport seams. The SSE/Streamable
// HTTP transports are driven through a stubbed global fetch + a fake stream
// reader, so the real parseSSEBuffer state machine runs (endpoint handshake,
// CRLF, multi-line data, frames split mid-line) without touching the network.
// StdioTransport is covered by its no-process guards here and end-to-end with a
// real subprocess in mcp-client.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SSETransport, StreamableHTTPTransport, StdioTransport } from '../src/main/mcp/transport'

interface FetchCall { url: string; init?: RequestInit }

let fetchCalls: FetchCall[] = []
let fetchImpl: (url: string, init?: RequestInit) => Promise<unknown>

beforeEach(() => {
  fetchCalls = []
  fetchImpl = async () => { throw new Error('fetch not stubbed for this test') }
  vi.stubGlobal('fetch', (url: unknown, init?: RequestInit) => {
    const u = String(url)
    fetchCalls.push({ url: u, init })
    return fetchImpl(u, init)
  })
})

afterEach(() => { vi.unstubAllGlobals() })

/** A reader over pre-baked chunks — done after the last one. */
function readerOf(...chunks: string[]) {
  const encoder = new TextEncoder()
  let i = 0
  return {
    read: async (): Promise<{ done: boolean; value?: Uint8Array }> =>
      i < chunks.length
        ? { done: false, value: encoder.encode(chunks[i++]) }
        : { done: true, value: undefined },
  }
}

const sseResponse = (...chunks: string[]) => ({ ok: true, body: { getReader: () => readerOf(...chunks) } })

/** Poll until cond holds — the transports' read loops are async fire-and-forget. */
async function until(cond: () => boolean, label: string): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > 3000) throw new Error(`timed out waiting for: ${label}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('SSETransport', () => {
  it('endpoint handshake, then message dispatch across split/CRLF/multi-line frames', async () => {
    fetchImpl = async (url) =>
      url.endsWith('/sse')
        ? sseResponse(
            // phase 1: a ping frame before the endpoint must not resolve us early
            'event: ping\r\ndata: {}\r\n\r\nevent: endpoint\r\ndata: {"url":"https://rpc.example/s1/messages","sessionId":"s1"}\r\n\r\n',
            // phase 2: a frame split mid-data-line, then multi-line data
            'event: message\r\nda',
            'ta: {"jsonrpc":"2.0","id":1}\r\ndata: {"extra":true}\r\n\r\n',
          )
        : { ok: true }

    const messages: string[] = []
    let closed = false
    const t = new SSETransport('https://rpc.example/sse')
    t.onMessage = (d) => { messages.push(d) }
    t.onClose = () => { closed = true }

    await t.connect()
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].init?.headers).toMatchObject({ Accept: 'text/event-stream' })

    await until(() => messages.length === 1 && closed, 'message + close')
    // multi-line data joined with \n, \r stripped, trailing newline trimmed
    expect(messages[0]).toBe('{"jsonrpc":"2.0","id":1}\n{"extra":true}')

    // the session was negotiated from the endpoint event: send() POSTs there
    t.send('{"jsonrpc":"2.0","id":2}')
    expect(fetchCalls[1].url).toBe('https://rpc.example/s1/messages')
    expect(fetchCalls[1].init?.method).toBe('POST')
    expect(fetchCalls[1].init?.body).toBe('{"jsonrpc":"2.0","id":2}')
    await t.disconnect()
  })

  it('a non-JSON endpoint payload is used verbatim as the message URL', async () => {
    fetchImpl = async () => sseResponse('event: endpoint\r\ndata: https://mcp.example/messages/raw-42\r\n\r\n')
    const t = new SSETransport('https://mcp.example/sse')
    await t.connect()
    t.send('payload')
    expect(fetchCalls[1].url).toBe('https://mcp.example/messages/raw-42')
    await t.disconnect()
  })

  it('rejects when the stream ends before an endpoint event', async () => {
    fetchImpl = async () => sseResponse('event: ping\r\ndata: {}\r\n\r\n')
    const t = new SSETransport('https://rpc.example/sse')
    await expect(t.connect()).rejects.toThrow(/SSE 连接已关闭/)
  })

  it('send() before connect() throws', () => {
    const t = new SSETransport('https://rpc.example/sse')
    expect(() => t.send('x')).toThrow(/尚未连接完毕/)
  })
})

describe('StreamableHTTPTransport', () => {
  const PING = '{"jsonrpc":"2.0","id":"ping","result":{}}'

  it('connect() pings once, then send() correlates JSON responses', async () => {
    let call = 0
    fetchImpl = async () => {
      call += 1
      return call === 1
        ? { ok: true, text: async () => PING }
        : { ok: true, headers: { get: () => 'application/json' }, text: async () => '{"id":7,"result":"pong"}' }
    }
    const messages: string[] = []
    const t = new StreamableHTTPTransport('https://mcp.example/mcp')
    t.onMessage = (d) => { messages.push(d) }
    await t.connect()
    expect(messages).toEqual([PING])

    t.send('{"jsonrpc":"2.0","id":7,"method":"tools/list"}')
    await until(() => messages.length === 2, 'json response')
    expect(messages[1]).toBe('{"id":7,"result":"pong"}')
    await t.disconnect()
  })

  it('a failed connect reports through onError and leaves send() unusable', async () => {
    fetchImpl = async () => ({ ok: false, status: 503, statusText: 'Service Unavailable' })
    const errors: string[] = []
    const t = new StreamableHTTPTransport('https://mcp.example/mcp')
    t.onError = (e) => { errors.push(e.message) }
    await t.connect()                       // errors are swallowed into onError, not thrown
    expect(errors[0]).toMatch(/HTTP 503/)
    expect(() => t.send('x')).toThrow(/尚未连接/)
    await t.disconnect()
  })

  it('a non-OK send reports through onError', async () => {
    let call = 0
    fetchImpl = async () => {
      call += 1
      return call === 1
        ? { ok: true, text: async () => PING }
        : { ok: false, status: 500, statusText: 'Internal Server Error' }
    }
    const errors: string[] = []
    const t = new StreamableHTTPTransport('https://mcp.example/mcp')
    t.onError = (e) => { errors.push(e.message) }
    await t.connect()
    t.send('x')
    await until(() => errors.length === 1, 'send error')
    expect(errors[0]).toMatch(/HTTP 500/)
    await t.disconnect()
  })

  it('a streaming response dispatches EVERY event (no type filter, unlike SSETransport)', async () => {
    let call = 0
    fetchImpl = async () => {
      call += 1
      return call === 1
        ? { ok: true, text: async () => PING }
        : {
            ok: true,
            headers: { get: () => 'text/event-stream' },
            body: { getReader: () => readerOf(
              'event: message\ndata: {"id":8}\n\n',
              'data: {"id":9}\n\n',   // data-only frame still counts as a message
              'event: ping\ndata: {}\n\n',
            ) },
          }
    }
    const messages: string[] = []
    const t = new StreamableHTTPTransport('https://mcp.example/mcp')
    t.onMessage = (d) => { messages.push(d) }
    await t.connect()
    t.send('x')
    await until(() => messages.length === 4, 'streamed events')
    // messages[0] is connect()'s ping answer; then every streamed event, whatever its type
    expect(messages).toEqual([PING, '{"id":8}', '{"id":9}', '{}'])
    await t.disconnect()
  })
})

describe('StdioTransport guards', () => {
  it('send() without a live process throws; disconnect() is a no-op', async () => {
    const t = new StdioTransport('definitely-not-spawned', [], {})
    expect(() => t.send('x')).toThrow(/MCP server not running/)
    await expect(t.disconnect()).resolves.toBeUndefined()
  })
})
