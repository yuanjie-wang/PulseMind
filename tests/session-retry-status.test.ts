import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The session-manager import chain touches real stores, so HOME must point at
// a throwaway dir BEFORE it loads — the same recipe (and dynamic imports) as
// tests/terminal-status-sweep.test.ts, so this file stands alone.
process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-retry-status-'))

const { AgentSessionManagerImpl } = await import('../src/main/agent/session-manager')
const { applySessionEvent, freshSessionState, seedSessionState } = await import('../src/shared/agent-session/mirror')

import type { AgentEventData } from '../src/shared/agent-protocol'
import type { AgentStatus } from '../src/renderer/src/types/agent'
import type { SessionState } from '../src/shared/agent-session/mirror'

const CONV = 'conv_retry'

/** Type-only view of the private bits of the real transport. `makeCallbacks`
 *  is private on the class; the runtime has no such concept, and the cast is
 *  how tests/terminal-status-sweep.test.ts reaches `ensureEntry` too. */
type Transport = {
  onEvent(sink: (sessionId: string, data: AgentEventData) => void): () => void
  makeCallbacks(sessionId: string): { onStatusChanged(status: AgentStatus): void }
  snapshot(sessionId: string): Promise<{
    messages: unknown[]
    status: { status: string; error?: string; attempt?: number; maxRetries?: number; delayMs?: number; message?: string }
    streamingBlocks: unknown[]
    plan: unknown
  } | null>
}
const transport = new AgentSessionManagerImpl() as unknown as Transport

/** Just enough engine for snapshot() to read — it projects four fields off it. */
const engine = {
  agentStatus: { status: 'idle' } as AgentStatus,
  messages: [],
  streamingBlocks: [],
  plan: null,
}
;(transport as unknown as { ensureEntry: unknown }).ensureEntry = async () => ({ engine })
;(transport as unknown as { sessions: Map<string, unknown> }).sessions = new Map([[CONV, { engine }]])

const RETRY: AgentStatus = { status: 'retrying', message: '网络波动，正在重试 (2/20)…', attempt: 2, maxRetries: 20, delay: 3000 }

/** Drive the real onStatusChanged and return the wire events it emitted. */
function emitStatus(status: AgentStatus): AgentEventData[] {
  const events: AgentEventData[] = []
  const off = transport.onEvent((sessionId, data) => {
    if (sessionId === CONV) events.push(data)
  })
  transport.makeCallbacks(CONV).onStatusChanged(status)
  off()
  return events
}

describe('onStatusChanged — a retry’s count rides the wire with its word', () => {
  it('ships attempt/maxRetries/delayMs/message on the status event', () => {
    // Main has ALWAYS had these fields (api-proxy's retry callback builds the
    // message with (n/max), stream-runner copies them onto the status) — the
    // emit had no retrying branch, so the wire carried the word alone and the
    // chat banner lost its count (user report 2026-09-24).
    const [ev] = emitStatus(RETRY)
    expect(ev).toBeDefined()
    expect(ev?.type).toBe('status')
    expect(ev).toMatchObject({
      status: 'retrying',
      attempt: 2,
      maxRetries: 20,
      delayMs: 3000,
      message: '网络波动，正在重试 (2/20)…',
    })
  })

  it('folds into the full mirrored status end to end', () => {
    // Two layers deep: even a rich wire used to be stripped by mirroredStatus.
    // Both must hold at once or the banner still shows no count.
    const state: SessionState = freshSessionState()
    const off = transport.onEvent((sessionId, data) => {
      if (sessionId === CONV) applySessionEvent(state, structuredClone(data))
    })
    transport.makeCallbacks(CONV).onStatusChanged(RETRY)
    off()
    expect(state.agentStatus).toEqual({
      status: 'retrying',
      attempt: 2,
      maxRetries: 20,
      delay: 3000,
      message: '网络波动，正在重试 (2/20)…',
    })
  })

  it('still ships the error reason (the contract that predates this)', () => {
    const [ev] = emitStatus({ status: 'error', error: 'API 请求失败 (400): model not found' })
    expect(ev).toMatchObject({ status: 'error', error: 'API 请求失败 (400): model not found' })
  })
})

describe('snapshot — a retry’s count survives a re-attach', () => {
  it('carries the retry fields in status and the seed folds them back', async () => {
    engine.agentStatus = RETRY
    const snap = await transport.snapshot(CONV)
    expect(snap).not.toBeNull()
    expect(snap!.status).toMatchObject({
      status: 'retrying',
      attempt: 2,
      maxRetries: 20,
      delayMs: 3000,
      message: '网络波动，正在重试 (2/20)…',
    })
    const state = freshSessionState()
    seedSessionState(state, snap!)
    expect(state.agentStatus).toEqual({
      status: 'retrying',
      attempt: 2,
      maxRetries: 20,
      delay: 3000,
      message: '网络波动，正在重试 (2/20)…',
    })
  })

  it('still carries the error reason', async () => {
    engine.agentStatus = { status: 'error', error: '连接中断' }
    const snap = await transport.snapshot(CONV)
    expect(snap!.status).toMatchObject({ status: 'error', error: '连接中断' })
  })
})

describe('wiring — the wire type and the banner guards', () => {
  const root = join(__dirname, '..')
  const payloads = readFileSync(join(root, 'src/shared/agent-protocol/payloads.ts'), 'utf8')
  const chatView = readFileSync(join(root, 'src/renderer/src/components/layout/ChatView.tsx'), 'utf8')

  it('the status event and the snapshot share one StatusSnapshot declaration', () => {
    // One definition, two carriers — an event that spells its own field list
    // and a snapshot that spells a second one is exactly how the two halves
    // drift apart (the emit already dropped fields the producer had set).
    const statusLine = payloads.split('\n').find(l => l.includes("type: 'status'"))
    expect(statusLine, 'payloads.ts should declare a status event').toBeDefined()
    expect(statusLine).toMatch(/StatusSnapshot/)
    const snapshotLine = payloads.split('\n').find(l => l.includes('type StatusSnapshot'))
    expect(snapshotLine, 'payloads.ts should declare StatusSnapshot').toBeDefined()
    expect(snapshotLine).toMatch(/maxRetries\?: number/)
    expect(snapshotLine).toMatch(/delayMs\?: number/)
    expect(snapshotLine).toMatch(/message\?: string/)
  })

  it('the banner renders (attempt/maxRetries) only behind the key-presence guard', () => {
    // The regression line, verbatim: unguarded parens straight off the status
    // object, which render `(/)` when a thin wire dropped the fields.
    expect(chatView).not.toMatch(/正在重试 \(\{agentStatus\.attempt\}\/\{agentStatus\.maxRetries\}\)/)
    expect(chatView).toMatch(/'attempt' in agentStatus && 'maxRetries' in agentStatus/)
    // And the countdown seed must not go NaN on a missing delay — NaN <= 1 is
    // false, so the interval would tick for the rest of the turn while the
    // seconds never render.
    expect(chatView).toMatch(/Number\.isFinite\(agentStatus\.delay\)/)
  })
})
