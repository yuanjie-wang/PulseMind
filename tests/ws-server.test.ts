import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { startAgentService } from '../src/main/agent/ws-server'
import { PROTOCOL_VERSION } from '../src/shared/agent-protocol'

process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-ws-'))

describe('agent service WebSocket (M2.1)', () => {
  it('authenticates via ?token=, answers hello and ping', async () => {
    const service = await startAgentService({ port: 0 })
    expect(service.port).toBeGreaterThan(0)
    expect(service.token).toBeTruthy()

    const ws = new WebSocket(`ws://127.0.0.1:${service.port}?token=${service.token}`)

    // Sequential request/reply over the shared message stream.
    const inbox: any[] = []
    const pending = new Map<number, (res: any) => void>()
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      inbox.push(msg)
      const resolve = pending.get(msg.id)
      if (resolve) { pending.delete(msg.id); resolve(msg) }
    })
    const request = (id: number, method: string, params?: object): Promise<any> => new Promise((resolve) => {
      pending.set(id, resolve)
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })

    await new Promise<void>((r) => ws.on('open', r))

    const hello = await request(1, 'hello', { clientId: 'vitest', clientVersion: '0', protocolVersion: PROTOCOL_VERSION })
    expect(hello.result.protocolVersion).toBe(PROTOCOL_VERSION)
    expect(hello.result.serviceVersion).toBe('0.3.5')

    const ping = await request(2, 'ping')
    expect(ping.result.pong).toBe(true)

    const unknown = await request(3, 'nope')
    expect(unknown.error.code).toBe(-32601)

    ws.close()
    await service.close()
  })

  it('rejects connections with a wrong token', async () => {
    const service = await startAgentService({ port: 0 })
    const ws = new WebSocket(`ws://127.0.0.1:${service.port}?token=wrong`)

    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)))
    const code = await closed
    expect(code).toBe(4401)

    await service.close()
  })
})
