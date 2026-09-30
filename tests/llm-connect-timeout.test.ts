import { describe, expect, it, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'

// The main-process proxy's per-attempt connect cap. The 60s idle watchdog only
// arms AFTER fetch() resolves (response headers received) — before that line a
// black-holed connection awaited forever with no socket-level timeout
// (conv_20260930091135: two plan sub-agents parked mid-plan on exactly such an
// await, no error, no done, for hours). The cap aborts the attempt with a
// distinguishable error while keeping the outer cancel semantics intact.

const { fetchWithAttemptTimeout } = await import('../src/main/ipc/api-proxy.handler')

const servers: Server[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.close()
})

const listen = (handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<string> =>
  new Promise((resolve) => {
    const s = createServer(handler)
    servers.push(s)
    s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}/v1/chat/completions`))
  })

describe('fetchWithAttemptTimeout (per-attempt connect cap)', () => {
  it('a server that accepts but never answers is cut at the cap with a named error', async () => {
    const url = await listen(() => { /* hold the connection open, send nothing */ })
    const t0 = Date.now()
    await expect(fetchWithAttemptTimeout(url, { method: 'POST', headers: {}, body: '{}' }, undefined, 400))
      .rejects.toThrow(/Connect timeout/)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(380)
    expect(Date.now() - t0).toBeLessThan(5_000)
  })

  it('a fast response passes through untouched', async () => {
    const url = await listen((_req, res) => { res.end('ok') })
    const res = await fetchWithAttemptTimeout(url, { method: 'POST', headers: {}, body: '{}' }, undefined, 5_000)
    expect(res.ok).toBe(true)
    expect(await res.text()).toBe('ok')
  })

  it('an outer abort wins over the cap — cancel semantics unchanged', async () => {
    const url = await listen(() => { /* hold open */ })
    const outer = new AbortController()
    const pending = fetchWithAttemptTimeout(url, { method: 'POST', headers: {}, body: '{}' }, outer.signal, 60_000)
    setTimeout(() => outer.abort(new Error('user cancelled')), 100)
    await expect(pending).rejects.toThrow('user cancelled')
  })

  it('an already-aborted outer signal fails fast without touching the network', async () => {
    const outer = new AbortController()
    outer.abort(new Error('pre-cancelled'))
    await expect(fetchWithAttemptTimeout('http://127.0.0.1:1/x', { method: 'POST' }, outer.signal, 5_000))
      .rejects.toThrow('pre-cancelled')
  })

  it('an outer abort during the BODY stream still kills the read — the link survives the headers', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.write('chunk1') // headers + one chunk, then hold the body open
    })
    const outer = new AbortController()
    const res = await fetchWithAttemptTimeout(url, { method: 'POST' }, outer.signal, 60_000)
    const reader = res.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe('chunk1')
    const pending = reader.read() // holds until abort or EOF
    setTimeout(() => outer.abort(new Error('Stream idle timeout')), 100)
    await expect(pending).rejects.toThrow('Stream idle timeout')
  })
})
