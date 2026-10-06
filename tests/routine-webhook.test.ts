// PLAN-routine-triggers M1 — the outbound half and the trigger normalizer.
//
//  1. postSettlementEvent / signPayload: the settlement webhook — signature
//     is verifiable HMAC, payload is ids-not-content, sends are gated by
//     settings and retried only on retryable failures. settings-store is
//     mocked (the holder below); fetch is stubbed per case.
//  2. routineStore trigger normalization (REAL store over a mock DB — the
//     better-sqlite3/ABI discipline from experience-script-store.test.ts):
//     the store is where webhook tokens are minted and file lists clamped.

import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHmac } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-routine-webhook-'))
mkdirSync(join(process.env.HOME, '.pulsemind'), { recursive: true })

/** settingsStore.get() reads from here per call. */
const settingsHolder: { notifications: unknown } = { notifications: undefined }
vi.mock('../src/main/storage/settings-store', () => ({
  settingsStore: { get: async () => ({ notifications: settingsHolder.notifications }) },
}))
vi.mock('../src/main/storage/database', () => ({
  getDb: () => fakeDb,
  initializeDatabase: async () => {},
  ensureDbHealthy: async () => {},
}))

const fakeDb = {
  prepare(_sql: string) {
    return { get: () => undefined, all: () => [], run: () => ({ changes: 0 }) }
  },
}

const PAYLOAD = {
  event: 'routine.settled' as const,
  routineId: 'routine_1',
  runId: 'run_1',
  conversationId: 'routine_c1',
  status: 'failed' as const,
  error: 'x'.repeat(900),
  skipped: { approvals: 2, questions: 1 },
  finishedAt: '2026-10-06T10:00:00.000Z',
}

describe('settlement webhook', () => {
  let postSettlementEvent: typeof import('../src/main/routine/webhook-out')['postSettlementEvent']
  let signPayload: typeof import('../src/main/routine/webhook-out')['signPayload']
  let fetchMock: ReturnType<typeof vi.fn>

  beforeAll(async () => {
    ;({ postSettlementEvent, signPayload } = await import('../src/main/routine/webhook-out'))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    settingsHolder.notifications = undefined
  })

  it('signPayload is HMAC-SHA256 over `${t}.${body}`', () => {
    const body = '{"a":1}'
    const t = 1_700_000_000
    expect(signPayload('sec', t, body)).toBe(createHmac('sha256', 'sec').update(`${t}.${body}`).digest('hex'))
  })

  it('no url or onSettled=false → fetch is never called', async () => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    settingsHolder.notifications = undefined
    await postSettlementEvent(PAYLOAD)
    settingsHolder.notifications = { webhookUrl: 'https://example.com/hook', onSettled: false }
    await postSettlementEvent(PAYLOAD)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a configured url gets ids-not-content JSON with a verifiable signature', async () => {
    const bodies: Array<{ body: string; headers: Record<string, string> }> = []
    fetchMock = vi.fn(async (_url: string, init: { body: string; headers: Record<string, string> }) => {
      bodies.push(init)
      return { ok: true, status: 204 }
    })
    vi.stubGlobal('fetch', fetchMock)
    settingsHolder.notifications = { webhookUrl: 'https://example.com/hook', webhookSecret: 'sec' }
    await postSettlementEvent(PAYLOAD)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const { body, headers } = bodies[0]
    const parsed = JSON.parse(body)
    expect(parsed).toMatchObject({
      event: 'routine.settled', routineId: 'routine_1', runId: 'run_1',
      status: 'failed', skipped: { approvals: 2, questions: 1 },
    })
    // error clipped to 500 — the wire must not carry a 900-char error body
    expect(parsed.error).toHaveLength(500)
    // ids only: no transcript, no prompt
    expect(body).not.toContain('messages')
    // signature: t=<unix>,v1=<hmac> and verifiable
    const m = (headers['x-pulsemind-signature'] as string).match(/^t=(\d+),v1=([0-9a-f]{64})$/)
    expect(m).toBeTruthy()
    expect(m![2]).toBe(signPayload('sec', Number(m![1]), body))
  })

  it('500s retry with backoff (3 attempts); 4xx (non-429) does not retry', async () => {
    settingsHolder.notifications = { webhookUrl: 'https://example.com/hook' }
    // retryable: two 500s then success — 3 attempts inside the fake clock
    fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, status: 204 })
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    const run = postSettlementEvent(PAYLOAD)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(2_000)
    await run
    expect(fetchMock).toHaveBeenCalledTimes(3)
    vi.useRealTimers()

    // misconfig: 401 is terminal on the first attempt
    fetchMock = vi.fn(async () => ({ ok: false, status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    await postSettlementEvent(PAYLOAD)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

// ── store normalization (real store, mock DB) ──
describe('routineStore trigger normalization', () => {
  let routineStore: typeof import('../src/main/storage/routine-store')['routineStore']
  const ROUTINES_DIR = join(process.env.HOME!, '.pulsemind', 'routines')

  beforeAll(async () => {
    ;({ routineStore } = await import('../src/main/storage/routine-store'))
    mkdirSync(ROUTINES_DIR, { recursive: true })
  })

  afterAll(() => {
    for (const r of routineStore.list()) routineStore.remove(r.id)
  })

  const base = () => ({ name: '任务', description: '', prompt: 'p', enabled: true })

  it('a webhook trigger always leaves with a token — minted when blank, kept when present', () => {
    const a = routineStore.create({ ...base(), triggers: [{ type: 'webhook', token: '' }] } as never)
    const b = routineStore.create({ ...base(), triggers: [{ type: 'webhook', token: 'given' }] } as never)
    const ta = routineStore.get(a.id)!.triggers!.find((t) => t.type === 'webhook') as { token: string }
    const tb = routineStore.get(b.id)!.triggers!.find((t) => t.type === 'webhook') as { token: string }
    expect(ta.token).toMatch(/^[0-9a-f]{32}$/)
    expect(tb.token).toBe('given')
    routineStore.remove(a.id)
    routineStore.remove(b.id)
  })

  it('file paths are trimmed, empty entries dropped, debounce clamped to [1000, 60000]', () => {
    const r = routineStore.create({
      ...base(),
      triggers: [{ type: 'file', paths: ['  /tmp/a  ', '', '   '], debounceMs: 100 }, { type: 'file', paths: [] }],
    } as never)
    const t = routineStore.get(r.id)!.triggers!
    expect(t).toHaveLength(1)
    expect(t[0]).toEqual({ type: 'file', paths: ['/tmp/a'], debounceMs: 1000 })
    routineStore.remove(r.id)
  })

  it('an all-invalid list normalizes away; update([]) clears', () => {
    const r = routineStore.create({ ...base(), triggers: [{ type: 'file', paths: ['   '], }] } as never)
    expect(routineStore.get(r.id)!.triggers).toBeUndefined()
    const r2 = routineStore.create({ ...base(), triggers: [{ type: 'webhook', token: 'keep-me' }] } as never)
    routineStore.update(r2.id, { triggers: [] })
    expect(routineStore.get(r2.id)!.triggers).toBeUndefined()
    routineStore.remove(r.id)
    routineStore.remove(r2.id)
  })

  it('update preserves a webhook token when the patch omits triggers', () => {
    const r = routineStore.create({ ...base(), triggers: [{ type: 'webhook', token: 'stable' }] } as never)
    routineStore.update(r.id, { description: '碰了别的字段' })
    const t = routineStore.get(r.id)!.triggers!.find((x) => x.type === 'webhook') as { token: string }
    expect(t.token).toBe('stable')
    routineStore.remove(r.id)
  })
})
