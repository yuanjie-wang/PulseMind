import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// spawn-manager's two lifecycle timers, extracted for testability. The watchdog
// exists because conv_20260930091135 parked two plan sub-agents for hours on a
// dropped-resolver await below the request path: no in-flight request, no
// pending tool, no progress — and nothing in the system noticed. The saver
// exists because one swallowed append failure permanently dropped the tail
// (savedCount advanced past rows the DB never received).

const {
  attachSubAgentWatchdog,
  attachSubConversationSaver,
  SUB_WATCHDOG_STALL,
  SUB_WATCHDOG_INTERVAL,
  SUB_SAVE_TAIL,
} = await import('../src/renderer/src/agent/engine/spawn-manager')
type EngineCore = import('../src/renderer/src/agent/engine/engine-core').EngineCore
type AgentMessage = import('../src/renderer/src/types/agent').AgentMessage

const msg = (id: string): AgentMessage => ({
  id, role: 'assistant', contentBlocks: [{ type: 'text', text: `body ${id}` }], createdAt: new Date().toISOString(),
})

/** A minimal stand-in with exactly the fields the two attachers read. */
function makeFakeEngine(overrides: Partial<Record<string, unknown>> = {}) {
  const engine = {
    messages: [msg('m1'), msg('m2')] as AgentMessage[],
    pendingToolIds: new Set<string>(),
    currentRequestId: null as string | null,
    isCancelled: false,
    abortController: null as AbortController | null,
    agentStatus: { status: 'executing' } as { status: string; error?: string },
    onSpawnProgress: undefined as ((msg: string, force?: boolean) => void) | undefined,
    notify: vi.fn(),
    resolveCompletionIfSpawned: vi.fn(),
    ...overrides,
  }
  return engine as unknown as EngineCore & Record<string, ReturnType<typeof vi.fn>>
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('sub-agent stall watchdog', () => {
  it('defaults: 10min stall checked every 30s', () => {
    expect(SUB_WATCHDOG_STALL).toBe(10 * 60_000)
    expect(SUB_WATCHDOG_INTERVAL).toBe(30_000)
  })

  it('settles a wedged engine as error (no request, no tools, no liveness)', async () => {
    const engine = makeFakeEngine()
    const abort = new AbortController()
    ;(engine as unknown as { abortController: AbortController | null }).abortController = abort
    attachSubAgentWatchdog(engine, 'sub_x', { intervalMs: 1_000, stallMs: 5_000 })
    await vi.advanceTimersByTimeAsync(6_000)
    expect(engine.resolveCompletionIfSpawned).toHaveBeenCalledWith('error')
    expect(engine.isCancelled).toBe(true)
    expect(abort.signal.aborted).toBe(true)
    expect(engine.agentStatus.status).toBe('error')
    expect(engine.agentStatus.error).toContain('疑似内部卡死')
    expect(engine.notify).toHaveBeenCalled()
  })

  it('does not settle while a tool call is pending (long exec is legitimate)', async () => {
    const engine = makeFakeEngine({ pendingToolIds: new Set(['call_1']) })
    attachSubAgentWatchdog(engine, 'sub_x', { intervalMs: 1_000, stallMs: 5_000 })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(engine.resolveCompletionIfSpawned).not.toHaveBeenCalled()
  })

  it('does not settle while a request is in flight (long round / proxy retry sleeps)', async () => {
    const engine = makeFakeEngine({ currentRequestId: 'api_1' })
    attachSubAgentWatchdog(engine, 'sub_x', { intervalMs: 1_000, stallMs: 5_000 })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(engine.resolveCompletionIfSpawned).not.toHaveBeenCalled()
  })

  it('does not settle while progress keeps reporting', async () => {
    const engine = makeFakeEngine()
    attachSubAgentWatchdog(engine, 'sub_x', { intervalMs: 1_000, stallMs: 5_000 })
    // liveness every 3s < 5s stall — the wrapped onSpawnProgress resets the clock
    const beat = setInterval(() => engine.onSpawnProgress?.('思考中', false), 3_000)
    await vi.advanceTimersByTimeAsync(20_000)
    clearInterval(beat)
    expect(engine.resolveCompletionIfSpawned).not.toHaveBeenCalled()
  })

  it('does not settle while messages keep growing', async () => {
    const engine = makeFakeEngine()
    attachSubAgentWatchdog(engine, 'sub_x', { intervalMs: 1_000, stallMs: 5_000 })
    const beat = setInterval(() => { engine.messages.push(msg(`m${engine.messages.length + 1}`)) }, 3_000)
    await vi.advanceTimersByTimeAsync(20_000)
    clearInterval(beat)
    expect(engine.resolveCompletionIfSpawned).not.toHaveBeenCalled()
  })

  it('detach stops the sweep', async () => {
    const engine = makeFakeEngine()
    const detach = attachSubAgentWatchdog(engine, 'sub_x', { intervalMs: 1_000, stallMs: 5_000 })
    detach()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(engine.resolveCompletionIfSpawned).not.toHaveBeenCalled()
  })
})

describe('sub-conversation saver', () => {
  const mkMsgs = (n: number, base: AgentMessage[]): AgentMessage[] => [
    ...base,
    ...Array.from({ length: n }, (_, i) => msg(`extra_${base.length + i}`)),
  ]

  it('a failed append does NOT advance savedCount — the same window is retried and lands', async () => {
    const engine = makeFakeEngine()
    const append = vi.fn()
      .mockRejectedValueOnce(new Error('SQLITE_BUSY (simulated)'))
      .mockResolvedValue(undefined)
    const host = { appendConversationMessages: append } as never
    attachSubConversationSaver(engine, 'sub_x', host)
    await vi.advanceTimersByTimeAsync(5_500)
    expect(append).toHaveBeenCalledTimes(1)
    // window retried on the next tick, still covering ALL unsaved messages
    await vi.advanceTimersByTimeAsync(5_500)
    expect(append).toHaveBeenCalledTimes(2)
    const retried = append.mock.calls[1][2] as { id: string }[]
    expect(retried.map((m) => m.id)).toEqual(['m1', 'm2'])
    // after success, a quiet engine sends nothing more
    await vi.advanceTimersByTimeAsync(11_000)
    expect(append).toHaveBeenCalledTimes(2)
  })

  it('re-saves the 8-message tail on every send (in-place block updates survive)', async () => {
    const base = [msg('m1'), msg('m2')]
    const engine = makeFakeEngine()
    const append = vi.fn().mockResolvedValue(undefined)
    const host = { appendConversationMessages: append } as never
    attachSubConversationSaver(engine, 'sub_x', host)
    engine.messages = mkMsgs(3, base) // m1 m2 + 3 extras = 5
    await vi.advanceTimersByTimeAsync(5_500)
    expect(append).toHaveBeenCalledTimes(1)
    const sent = append.mock.calls[0][2] as { id: string }[]
    expect(sent.map((m) => m.id)).toEqual(['m1', 'm2', 'extra_2', 'extra_3', 'extra_4'])
    expect(SUB_SAVE_TAIL).toBe(8)
  })

  it('an in-flight append blocks the next tick (no double-send)', async () => {
    const engine = makeFakeEngine()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const append = vi.fn().mockReturnValue(gate)
    const host = { appendConversationMessages: append } as never
    attachSubConversationSaver(engine, 'sub_x', host)
    await vi.advanceTimersByTimeAsync(5_500)
    expect(append).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(15_000) // several ticks while still in flight
    expect(append).toHaveBeenCalledTimes(1)
    release()
    await vi.advanceTimersByTimeAsync(0) // flush the .then → savedCount advances
    await vi.advanceTimersByTimeAsync(5_500) // next tick: window already saved
    expect(append).toHaveBeenCalledTimes(1)
  })
})

