import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The session-manager import chain touches real stores (it creates MEMORY.md on
// first touch), so point HOME at a temp dir BEFORE importing it — a test must
// never write into the user's live ~/.pulsemind.
process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-turn-duration-'))

const { AgentSessionManagerImpl } = await import('../src/main/agent/session-manager')
const { AgentEngine } = await import('../src/renderer/src/agent/AgentEngine')
const { TurnClock } = await import('../src/renderer/src/agent/engine/turn-clock')
const { setHost } = await import('../src/renderer/src/agent/host')
const { applySessionEvent, freshSessionState } = await import('../src/shared/agent-session/mirror')
const { ToolManager } = await import('../src/renderer/src/tools/ToolManager')
const { SkillManager } = await import('../src/renderer/src/skills/SkillManager')

import type { AgentEngineOptions } from '../src/renderer/src/agent/AgentEngine'
import type { AgentMessage, ContentBlock } from '../src/renderer/src/types/agent'
import type { AgentEventData } from '../src/shared/agent-protocol'

/** Construction-time cache warming pokes the host; nothing in this file needs
 *  it to answer, so every method is a generic async no-op. */
setHost(new Proxy({}, { get: () => () => Promise.resolve([] as unknown[]) }) as never)

const NOW = '2026-09-16T10:00:00.000Z'

const block = (text: string): ContentBlock => ({ type: 'text', text })
const assistant = (id: string, processingMs: number): AgentMessage =>
  ({ id, role: 'assistant', contentBlocks: [block(id)], createdAt: NOW, processingMs })
const user = (): AgentMessage =>
  ({ id: 'u1', role: 'user', contentBlocks: [block('跑一下这个任务')], createdAt: NOW })

function makeEngine(): InstanceType<typeof AgentEngine> {
  return new AgentEngine({
    apiKey: 'test-key', baseURL: 'https://example.invalid', model: 'test-model', maxTokens: 1024,
    myName: 'tester', soul: '', yourName: 'user',
    adapter: {} as never, // never exercised: no request is issued here
    toolManager: new ToolManager() as never, skillManager: new SkillManager() as never,
    conversationId: 'conv_turn_duration',
  } as unknown as AgentEngineOptions)
}

/** Type-only view of the private transport so the test can drive the real one. */
type TransportInternals = { emitMessages(sessionId: string, messages: AgentMessage[]): void }

/**
 * 用户反馈 2026-09-16：「任务执行的时长展示不正确，明显小于实际执行时长，期望是从
 * 用户发送消息开始计算，到完成最后一个字符的输出，包括中间多次的 thinking 和 tool use」。
 *
 * Three things had to be true for the user to ever SEE it, and this file pins
 * all three. The engine's `TurnClock` numbers the whole turn rather than its
 * last round (started at the send, stopped at the last output character, and
 * stopped again while parked on the user — a held approval, an ask_user
 * question, the loop-limit prompt, a manual 暂停); `handleEndTurnResponse`
 * stamps that total on the final assistant message; and the transport carries
 * that in-place write to the clients, because the mirror only ever learns about
 * a message when it is appended — and it is appended at the END of its stream,
 * i.e. before the total exists.
 */
describe('turn duration: user send → last output character', () => {
  it('stamps the whole turn on the final message, replacing that round’s own time', () => {
    // A turn of 83s of wall clock, driven by moving the clock rather than by
    // arithmetic on performance.now() — in a fresh process that reading is
    // *smaller* than 83s, and a clock that was never started is idle, so the
    // engine would skip the stamp entirely.
    const engine = makeEngine()
    const first = assistant('a1', 9_000) // round 1: thinking + tool_use
    const second = assistant('a2', 21_000) // round 2: another tool round
    const final = assistant('a3', 15_000) // round 3: the answer, its own stream only
    engine.messages = [user(), first, second, final]

    let clock = 1_000
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => clock)
    try {
      engine.turnClock.start() // the user hits send at t=1s
      clock = 84_000 // …and the last character lands at t=84s
      engine.handleEndTurnResponse('end_turn')
    } finally {
      spy.mockRestore()
    }

    expect(engine.messages[3].processingMs).toBe(83_000)
    // Earlier rounds keep their own round time — they are per-round cards inside
    // the collapsed execution segment, not summaries of the turn.
    expect(engine.messages[1].processingMs).toBe(9_000)
    expect(engine.turnClock.isActive()).toBe(false) // consumed, so the next turn starts fresh
  })

  it('does not count the wait for a held approval', () => {
    const engine = makeEngine()
    const final = assistant('a2', 20_000)
    engine.messages = [user(), assistant('a1', 30_000), final]

    let clock = 0
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => clock)
    try {
      engine.turnClock.start() // send
      clock = 30_000 // round 1 ran 30s, then the model asked to write a file…
      engine.agentStatus = { status: 'awaiting_approval', tools: [] }
      engine.notify() // …and the engine parks. The user is away for 5 minutes.
      clock = 330_000
      // Still parked: nothing about being parked may advance the total.
      expect(engine.turnClock.elapsed()).toBe(30_000)

      engine.agentStatus = { status: 'executing' }
      engine.notify() // approval landed — counting again
      clock = 350_000 // round 2 runs 20s
      engine.handleEndTurnResponse('end_turn')
    } finally {
      spy.mockRestore()
    }

    expect(final.processingMs).toBe(50_000)
  })

  it('does not count a manual pause (which has no status of its own)', () => {
    const engine = makeEngine()
    const final = assistant('a2', 10_000)
    engine.messages = [user(), assistant('a1', 15_000), final]

    let clock = 0
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => clock)
    try {
      engine.turnClock.start()
      clock = 15_000
      engine.pauseExecution()
      clock = 315_000 // five minutes of not running
      expect(engine.turnClock.elapsed()).toBe(15_000)
      engine.resumeExecution()
      clock = 325_000
      engine.handleEndTurnResponse('end_turn')
    } finally {
      spy.mockRestore()
    }

    expect(final.processingMs).toBe(25_000)
  })

  it('the clock itself banks running segments and ignores the gaps', () => {
    let clock = 100
    const turnClock = new TurnClock(() => clock)
    expect(turnClock.elapsed()).toBe(0)
    turnClock.start()
    clock = 1_100 // 1s of work
    turnClock.sync(true) // parked on the user
    clock = 61_100 // a minute of thumb-twiddling
    expect(turnClock.elapsed()).toBe(1_000)
    turnClock.sync(false) // answered
    clock = 62_100 // 1s more
    expect(turnClock.stop()).toBe(2_000)
    expect(turnClock.isActive()).toBe(false)
    // A finished turn cannot be restarted by the 'completed' status that
    // follows it, or the next stamp would include the idle gap.
    turnClock.sync(false)
    clock = 999_999
    expect(turnClock.elapsed()).toBe(0)
  })

  it('a sub-agent turn is clocked from its kick-off message', () => {
    const engine = makeEngine()
    const round = assistant('a1', 4_000)
    engine.messages = [round]

    let clock = 0
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => clock)
    try {
      engine.startSpawnLoop({ task: 'x' } as never)
      clock = 47_000
      engine.handleEndTurnResponse('end_turn')
    } finally {
      spy.mockRestore()
    }

    expect(round.processingMs).toBe(47_000)
  })

  it('the wire carries the in-place write to the client mirror', () => {
    const manager = new AgentSessionManagerImpl()
    const events: AgentEventData[] = []
    manager.onEvent((_sessionId, data) => events.push(data))
    const t = manager as unknown as TransportInternals

    const messages = [assistant('a1', 9_000), assistant('a2', 21_000), assistant('a3', 15_000)]
    t.emitMessages('s1', messages)
    // The append is what the mirror has: per-round values, the last one 15s.
    expect(events.filter((e) => e.type === 'messages_append')).toHaveLength(1)

    // End of turn — the engine writes the total IN PLACE (no new message, no
    // length change), which is precisely what a length-diffed transport drops.
    messages[2].processingMs = 83_000
    t.emitMessages('s1', messages)

    const state = freshSessionState()
    for (const e of events) applySessionEvent(state, e)
    expect(state.messages[2].processingMs).toBe(83_000)
    expect(state.messages[0].processingMs).toBe(9_000)
  })

  it('ships nothing while the stats are unchanged (notify fires per streamed chunk)', () => {
    const manager = new AgentSessionManagerImpl()
    const events: AgentEventData[] = []
    manager.onEvent((_sessionId, data) => events.push(data))
    const t = manager as unknown as TransportInternals

    const messages = [assistant('a1', 9_000)]
    t.emitMessages('s2', messages)
    t.emitMessages('s2', messages)
    t.emitMessages('s2', messages)
    expect(events.filter((e) => e.type === 'message_stats')).toHaveLength(0)

    messages[0].processingMs = 12_000
    t.emitMessages('s2', messages)
    expect(events.filter((e) => e.type === 'message_stats')).toHaveLength(1)
  })
})
