// review 20260925 item 9 (second tier) — MCPClient against a REAL stdio
// subprocess. The fake server speaks just enough JSON-RPC (initialize /
// tools/list / tools/call / ping) to drive the client's whole lifecycle:
// handshake, id-correlated calls, error mapping, and the in-flight rejection on
// stop(). The env report in serverInfo.name is how sanitizeEnv is observed from
// outside — the child sees exactly the env the client handed it.
//
// Cost note: StdioTransport.disconnect() always waits out its 3s SIGTERM grace
// period, so only TWO full start→stop cycles are used in this file (~6s).

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MCPClient } from '../src/main/mcp/MCPClient'

const SERVER = join(mkdtempSync(join(tmpdir(), 'pm-mcp-fake-')), 'fake-server.mjs')

writeFileSync(SERVER, `
import readline from 'node:readline'
const rl = readline.createInterface({ input: process.stdin })
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
// The client's env sanitization, observed from inside the child.
// region is covered ONLY by the /^AWS_/ pattern (SECRET_ACCESS_KEY also ends
// in _KEY, so a broken AWS rule alone would still strip it) — this is the var
// that makes the sanitizer's first rule observable in isolation.
const envReport = 'fake|aws=' + (process.env.AWS_SECRET_ACCESS_KEY ? 'yes' : 'no')
  + '|region=' + (process.env.AWS_REGION ? 'yes' : 'no')
  + '|token=' + (process.env.CI_JOB_TOKEN ? 'yes' : 'no')
  + '|custom=' + (process.env.CUSTOM_MARKER || 'none')
rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.id === undefined) return // notifications/initialized, shutdown
  switch (msg.method) {
    case 'initialize':
      out({ jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: envReport, version: '1.0' },
      } })
      break
    case 'tools/list':
      out({ jsonrpc: '2.0', id: msg.id, result: { tools: [{
        name: 'echo', description: 'Echo back',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      }] } })
      break
    case 'tools/call':
      if (msg.params.name === 'hang') return        // never answers — drives the stop() rejection
      if (msg.params.name === 'fail') {
        out({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'boom from server' } })
        break
      }
      out({ jsonrpc: '2.0', id: msg.id, result: { content: [
        { type: 'text', text: 'echo:' + (msg.params.arguments?.text ?? '') },
      ] } })
      break
    case 'ping':
      out({ jsonrpc: '2.0', id: msg.id, result: {} })
      break
    default: break
  }
})
`)

function newClient(env?: Record<string, string>): MCPClient {
  return new MCPClient(
    { command: process.execPath, args: [SERVER], name: 'fake', env },
    `test-${Math.random().toString(36).slice(2, 8)}`
  )
}

describe('MCPClient over a real stdio server', () => {
  let client: MCPClient

  beforeAll(async () => {
    client = newClient()
    await client.start(20_000)   // first start also pays for the login-shell PATH probe
  }, 30_000)

  afterAll(async () => {
    // no-op if the stop() test already ran; real teardown if an earlier test failed
    await client.stop()
  }, 15_000)

  it('completes the handshake and discovers tools', () => {
    expect(client.connected).toBe(true)
    expect(client.serverInfo?.version).toBe('1.0')
    expect(client.tools).toHaveLength(1)
    expect(client.tools[0]).toMatchObject({ name: 'echo' })
  })

  it('correlates callTool results by request id', async () => {
    const result = await client.callTool('echo', { text: 'hi' })
    expect(result).toEqual({ content: [{ type: 'text', text: 'echo:hi' }] })
    // a second call proves ids don't collide across sequential requests
    expect(await client.callTool('echo', { text: 'again' }))
      .toEqual({ content: [{ type: 'text', text: 'echo:again' }] })
  })

  it('maps a JSON-RPC error response to a rejection with the server message', async () => {
    await expect(client.callTool('fail')).rejects.toThrow('boom from server')
  })

  it('stop() rejects the in-flight call and clears tools/serverInfo', async () => {
    const inflight = client.callTool('hang').catch((e: Error) => e) // attach before rejection
    const stopped = client.stop()
    const err = await inflight
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('MCP client stopped')
    await stopped
    expect(client.connected).toBe(false)
    expect(client.tools).toEqual([])
    expect(client.serverInfo).toBeNull()
  })
})

describe('guards without a connection', () => {
  it('callTool throws, stop() resolves, and start() without url refuses', async () => {
    const c = newClient()
    await expect(c.callTool('echo')).rejects.toThrow(/MCP server is not connected/)
    await expect(c.stop()).resolves.toBeUndefined()

    const noUrl = new MCPClient({ command: '', args: [], name: 'sse-no-url', transportType: 'sse' })
    await expect(noUrl.start()).rejects.toThrow(/SSE transport requires url/)
    expect(noUrl.connected).toBe(false)
  })
})

describe('env sanitization (security behavior)', () => {
  it('strips secret-looking parent env vars, overlays hook env and user env', async () => {
    // Simulate a polluted parent environment — the child must not inherit these.
    process.env.AWS_SECRET_ACCESS_KEY = 'leak-me'
    process.env.AWS_REGION = 'leak-region'
    process.env.CI_JOB_TOKEN = 'leak-token'
    delete process.env.CUSTOM_MARKER
    const c = newClient({ CUSTOM_MARKER: 'kept' })
    try {
      await c.start(20_000)
      // serverInfo.name is the child's own view of its environment
      expect(c.serverInfo?.name).toContain('aws=no')
      expect(c.serverInfo?.name).toContain('region=no')
      expect(c.serverInfo?.name).toContain('token=no')
      expect(c.serverInfo?.name).toContain('custom=kept')
      // …while the parent still has them (the strip happens at spawn, not here)
      expect(process.env.AWS_SECRET_ACCESS_KEY).toBe('leak-me')
      expect(process.env.AWS_REGION).toBe('leak-region')
      expect(process.env.CI_JOB_TOKEN).toBe('leak-token')
    } finally {
      delete process.env.AWS_SECRET_ACCESS_KEY
      delete process.env.AWS_REGION
      delete process.env.CI_JOB_TOKEN
      delete process.env.CUSTOM_MARKER
      await c.stop()
    }
  }, 30_000)
})
