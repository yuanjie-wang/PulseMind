/** review_20260923 M1 — a stop landing on an ask parked in the loop queue.
 *
 * MAX_CONCURRENT_LOOPS (2) is smaller than the batch default concurrency (3),
 * so from the third row on, every routine ask parks in session-manager's
 * waitingLoops. A stop during that window settles the ROW (the engine parks at
 * idle and the unattended gates tear down), but the parked ask is still
 * holding a queue entry: when a slot frees, the woken ask used to startTurn
 * anyway — prepareTurn resets isCancelled, the whole task ran with nobody
 * watching, tokens burned, nothing persisted.
 *
 * vitest here is node-env and the sessions live in the real
 * AgentSessionManagerImpl, driven like tests/terminal-status-sweep.test.ts:
 * real engines, ensureEntry pointed at the test's own table, and startLoop
 * replaced by a gate the test controls (the stand-in for a turn in flight).
 * The mint-window half of the fix lives in batch-runner (better-sqlite3 at
 * import time) and is pinned by source scan in tests/routine-batch-wiring.test.ts.
 */

import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The session-manager import chain touches real stores (it creates MEMORY.md on
// first touch), so point HOME at a temp dir BEFORE importing it — a test must
// never write into the user's live ~/.pulsemind.
process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-queue-stop-'))

const { AgentSessionManagerImpl } = await import('../src/main/agent/session-manager')
const { AgentEngine } = await import('../src/renderer/src/agent/AgentEngine')
const { setHost } = await import('../src/renderer/src/agent/host')

import type { AgentEventData } from '../src/shared/agent-protocol'

/** Construction-time cache warming pokes the host; nothing in this file needs
 *  it to answer, so every method is a generic async no-op. */
setHost(new Proxy({}, { get: () => () => Promise.resolve([] as unknown[]) }) as never)

type Entry = { engine: AgentEngine; agentId: string; pinned: Record<string, unknown> }

interface ManagerView {
  sessions: Map<string, Entry>
  runningLoops: number
  waitingLoops: Array<{ sessionId: string; parked: { stopped: boolean }; resolve: () => void }>
  ask(sessionId: string, content: string): Promise<void>
  engineCall(sessionId: string, method: string, args: unknown[]): Promise<unknown>
  onEvent(sink: (sessionId: string, data: AgentEventData) => void): () => void
}

/** A real engine whose startLoop parks on a gate this test controls — the
 *  stand-in for an LLM turn in flight. */
function makeGatedEngine(id: string) {
  const engine = new AgentEngine({ conversationId: id, hooks: {} })
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const startLoop = vi.fn(() => gate)
  ;(engine as unknown as { startLoop: unknown }).startLoop = startLoop
  return { engine, startLoop, release }
}

/** A fresh manager per test: the queue state under test must never leak
 *  between cases. ensureEntry is pointed at the test's own table and ask()'s
 *  per-turn refreshes are no-oped (they read the conversation DB, and
 *  better-sqlite3 is Electron-ABI — it cannot load under plain node). */
function makeTransport() {
  const transport = new AgentSessionManagerImpl() as unknown as ManagerView
  const sessions = new Map<string, Entry>()
  ;(transport as unknown as { sessions: Map<string, Entry> }).sessions = sessions
  ;(transport as unknown as Record<string, unknown>).refreshConversationApproval = () => {}
  ;(transport as unknown as Record<string, unknown>).refreshExpertContext = async () => {}
  ;(transport as unknown as Record<string, unknown>).ensureEntry = async (id: string) => {
    const entry = sessions.get(id)
    if (!entry) throw new Error(`session not found: ${id}`)
    return entry
  }
  const register = (id: string, engine: AgentEngine): void => {
    sessions.set(id, { engine, agentId: 'default', pinned: {} })
  }
  return { transport, register }
}

/** Let every pending microtask chain (ask dispatch, wake, decline) settle. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('stop landing on a loop-queue-parked ask (review_20260923 M1)', () => {
  it('the parked ask declines its wake: no startTurn, the slot is handed to the next waiter', async () => {
    const { transport, register } = makeTransport()
    const a = makeGatedEngine('conv_q_a')
    const b = makeGatedEngine('conv_q_b')
    const victim = makeGatedEngine('conv_q_victim')
    const next = makeGatedEngine('conv_q_next')
    register('conv_q_a', a.engine)
    register('conv_q_b', b.engine)
    register('conv_q_victim', victim.engine)
    register('conv_q_next', next.engine)

    const events: Array<{ sessionId: string; data: AgentEventData }> = []
    transport.onEvent((sessionId, data) => events.push({ sessionId, data }))

    // Fill both global slots, then let two more asks queue up — the batch
    // shape (default concurrency 3 > MAX_CONCURRENT_LOOPS 2).
    void transport.ask('conv_q_a', 'a')
    void transport.ask('conv_q_b', 'b')
    const victimAsk = transport.ask('conv_q_victim', 'victim')
    const nextAsk = transport.ask('conv_q_next', 'next')
    await flush()
    expect(a.startLoop).toHaveBeenCalledTimes(1)
    expect(b.startLoop).toHaveBeenCalledTimes(1)
    expect(victim.startLoop).not.toHaveBeenCalled()
    expect(events.some((e) => e.sessionId === 'conv_q_victim' && e.data.type === 'status' && e.data.status === 'queued')).toBe(true)

    // 停止 lands while the victim's ask sits parked — exactly what the routine
    // row's stop does. The engine parks at idle; that is what the row settles on.
    await transport.engineCall('conv_q_victim', 'stopExecution', [])
    expect(victim.engine.agentStatus.status).toBe('idle')

    // A running loop settles: the freed slot wakes the queue in FIFO order.
    a.release()
    await flush()
    await flush()

    // THE regression: the victim must not revive into a full unobserved turn.
    expect(victim.startLoop).not.toHaveBeenCalled()
    // The wake it declined is handed on, not dropped: the next waiter starts.
    expect(next.startLoop).toHaveBeenCalledTimes(1)
    // Slot accounting: B and NEXT hold the two slots — never three, never zero.
    expect(transport.runningLoops).toBe(2)
    // The victim's ask resolved (declined), it did not hang on the queue.
    await victimAsk
    void nextAsk
  })

  it('a declined sole waiter leaves the slot correct and the session usable', async () => {
    const { transport, register } = makeTransport()
    const a = makeGatedEngine('conv_s_a')
    const b = makeGatedEngine('conv_s_b')
    const victim = makeGatedEngine('conv_s_victim')
    register('conv_s_a', a.engine)
    register('conv_s_b', b.engine)
    register('conv_s_victim', victim.engine)

    void transport.ask('conv_s_a', 'a')
    void transport.ask('conv_s_b', 'b')
    const victimAsk = transport.ask('conv_s_victim', 'victim')
    await flush()
    expect(victim.startLoop).not.toHaveBeenCalled()

    await transport.engineCall('conv_s_victim', 'stopExecution', [])
    a.release()
    await flush()
    await flush()

    expect(victim.startLoop).not.toHaveBeenCalled()
    expect(transport.runningLoops).toBe(1) // b only — the decline took no slot
    await victimAsk

    // The decline is one-shot and left nothing behind: a later ask for the
    // same conversation runs normally (停止后再发新消息 keeps working).
    await transport.ask('conv_s_victim', 'after')
    expect(victim.startLoop).toHaveBeenCalledTimes(1)
  })

  it('a stop for a turn that was NOT parked must not poison the next ask', async () => {
    const { transport, register } = makeTransport()
    const a = makeGatedEngine('conv_p_a')
    const s = makeGatedEngine('conv_p_s')
    register('conv_p_a', a.engine)
    register('conv_p_s', s.engine)

    void transport.ask('conv_p_a', 'a')
    await transport.ask('conv_p_s', 'first')
    await flush()
    // One slot is free, so this ask started immediately — it was never parked.
    expect(s.startLoop).toHaveBeenCalledTimes(1)

    // The user stops the RUNNING turn, then sends a new message: the new turn
    // must start (the stop mark is scoped to parked asks, never a session-wide
    // kill switch).
    await transport.engineCall('conv_p_s', 'stopExecution', [])
    s.release()
    await flush()
    await transport.ask('conv_p_s', 'second')
    await flush()
    expect(s.startLoop).toHaveBeenCalledTimes(2)
  })
})
