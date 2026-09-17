import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The session-manager import chain touches real stores (it creates MEMORY.md on
// first touch), so point HOME at a temp dir BEFORE importing it — a test must
// never write into the user's live ~/.pulsemind.
process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-terminal-sweep-'))

const { AgentSessionManagerImpl } = await import('../src/main/agent/session-manager')
const { AgentEngine } = await import('../src/renderer/src/agent/AgentEngine')
const { setHost } = await import('../src/renderer/src/agent/host')
const { applySessionEvent, freshSessionState } = await import('../src/shared/agent-session/mirror')

import type { AgentMessage, ContentBlock, ToolUseBlock } from '../src/renderer/src/types/agent'
import type { AgentEventData } from '../src/shared/agent-protocol'
import type { SessionState } from '../src/shared/agent-session/mirror'

setHost(new Proxy({}, { get: (_t, key) => () => Promise.resolve(key === 'getConversationPlan' ? null : []) }) as never)

const CONV = 'conv_sweep'

/** Type-only view of the private bits of the real transport. */
type Transport = {
  emitMessages(sessionId: string, messages: AgentMessage[]): void
  hydrate(sessionId: string, messages: AgentMessage[], summary?: unknown): Promise<void>
  onEvent(sink: (sessionId: string, data: AgentEventData) => void): () => void
}
const transport = new AgentSessionManagerImpl() as unknown as Transport

const engine = new AgentEngine({ conversationId: CONV, hooks: {} }, {
  onMessagesChanged: (messages: AgentMessage[]) => transport.emitMessages(CONV, messages),
})
// The tests below never create a real session; ensureEntry is pointed at the
// engine built above and the session table is given the matching entry, like
// tests/turn-duration.test.ts stubbing ensureEntry.
;(transport as unknown as { ensureEntry: unknown }).ensureEntry = async () => ({ engine })
;(transport as unknown as { sessions: Map<string, unknown> }).sessions = new Map([[CONV, { engine }]])

const spawnBlock = (id: string): ToolUseBlock =>
  ({ type: 'tool_use', id, name: 'spawn_agent', input: { task: 'x' }, status: 'running' })

/** Attach a folding sink that records what arrived; returns its detach. */
function attach(state: SessionState): { events: AgentEventData[]; detach: () => void } {
  const events: AgentEventData[] = []
  const sink = (_sessionId: string, data: AgentEventData) => {
    events.push(data)
    applySessionEvent(state, structuredClone(data))
  }
  const off = transport.onEvent(sink)
  return { events, detach: off }
}

function seedTurn(blocks: ToolUseBlock[], msgId: string): void {
  engine.messages = [{ id: msgId, role: 'assistant', createdAt: '2026-09-17T00:00:00Z', contentBlocks: blocks }]
  engine.toolUseBlocks = blocks as ContentBlock[]
  engine.agentStatus = { status: 'executing' }
  engine.notify()
}

describe('terminal-status sweep — the diff channels reconcile when a turn ends', () => {
  it('a tool_status patch lost mid-turn is re-shipped by the terminal notify (completed)', () => {
    const state = freshSessionState()
    const { detach } = attach(state)

    seedTurn([spawnBlock('call_A'), spawnBlock('call_B')], 'a1')
    expect(state.messages).toHaveLength(1)

    // The client goes away (renderer reload / dropped event) BEFORE A finishes.
    detach()
    const blockA = (engine.messages[0].contentBlocks as ToolUseBlock[]).find(b => b.id === 'call_A')!
    blockA.status = 'completed'
    blockA.exitCode = 0
    engine.notify() // registry records the patch; nobody is listening

    // The client comes back with its STALE mirror (it never saw A's patch) and
    // the turn ends. The terminal notify must re-diff from scratch so the stale
    // mirror converges instead of showing 执行状态未知 forever.
    const state2 = structuredClone(state)
    const { events: tail } = attach(state2)
    engine.agentStatus = { status: 'completed' }
    engine.notify()

    const shippedA = (tail.filter(e => e.type === 'tool_status') as Array<{ updates: Array<{ toolUseId: string; status?: string; exitCode?: number }> }>)
      .flatMap(e => e.updates).find(u => u.toolUseId === 'call_A')
    expect(shippedA?.status).toBe('completed')
    expect(shippedA?.exitCode).toBe(0)
    const liveA = state2.messages[0].contentBlocks.find(b => b.id === 'call_A') as ToolUseBlock
    expect(liveA.status).toBe('completed')
    expect(liveA.exitCode).toBe(0)
  })

  it('the idle status after 停止 sweeps too, so aborted spawn envelopes reach the mirror', () => {
    const state = freshSessionState()
    const { detach } = attach(state)
    seedTurn([spawnBlock('call_C')], 'a2')

    detach()
    const blockC = (engine.messages[0].contentBlocks as ToolUseBlock[]).find(b => b.id === 'call_C')!
    blockC.status = 'completed'
    blockC.exitCode = 1 // aborted envelope
    engine.notify()

    const state2 = structuredClone(state)
    const { events: tail } = attach(state2)
    engine.agentStatus = { status: 'idle' } // stopExecution's final status
    engine.notify()

    const shipped = (tail.filter(e => e.type === 'tool_status') as Array<{ updates: Array<{ toolUseId: string; exitCode?: number }> }>)
      .flatMap(e => e.updates).find(u => u.toolUseId === 'call_C')
    expect(shipped?.exitCode).toBe(1)
    expect((state2.messages[0].contentBlocks.find(b => b.id === 'call_C') as ToolUseBlock).exitCode).toBe(1)
  })

  it('after a reopen-from-DB, a re-stamped field still ships — the notify-driven re-diff re-bases the registry', async () => {
    const state = freshSessionState()
    const { detach } = attach(state)
    seedTurn([spawnBlock('call_D')], 'a3')

    // The event carrying D's completion is lost (stop-time burst, reload…).
    detach()
    const blockD = (engine.messages[0].contentBlocks as ToolUseBlock[]).find(b => b.id === 'call_D')!
    blockD.status = 'completed'
    blockD.exitCode = 1
    engine.notify()

    // The user re-opens the conversation: the mirror is rebuilt from DB rows
    // (derived status, NO exitCode) and pushed into the engine via hydrate.
    const hydrated: AgentMessage[] = [{
      id: 'a3', role: 'assistant', createdAt: '2026-09-17T00:00:00Z',
      contentBlocks: [{ type: 'tool_use', id: 'call_D', name: 'spawn_agent', input: { task: 'x' }, status: 'completed' } as ToolUseBlock],
    }]
    const state2 = structuredClone(state)
    const { events: duringHydrate } = attach(state2)
    await transport.hydrate(CONV, structuredClone(hydrated))
    // loadConversation's own notify re-diffs every block against the registry,
    // so the fresh mirror learns the hydrated runtime state right away.
    expect(duringHydrate.some(e => e.type === 'tool_status')).toBe(true)

    // The engine re-stamps the field the DB row lacked (the retry envelope's
    // exitCode). With a stale registry this signature matches what was "already
    // sent" and the patch is skipped; with the reset it ships and converges.
    const reloaded = (engine.messages[0].contentBlocks as ToolUseBlock[]).find(b => b.id === 'call_D')!
    reloaded.exitCode = 1
    engine.notify()
    expect((state2.messages[0].contentBlocks.find(b => b.id === 'call_D') as ToolUseBlock).exitCode).toBe(1)
  })
})
