import { expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The session-manager import chain touches real stores (it creates MEMORY.md on
// first touch), so point HOME at a temp dir BEFORE importing it — a test must
// never write into the user's live ~/.pulsemind.
process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-content-roundtrip-'))

const { AgentSessionManagerImpl } = await import('../src/main/agent/session-manager')
const { AgentEngine } = await import('../src/renderer/src/agent/AgentEngine')
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
const assistant = (id: string): AgentMessage =>
  ({ id, role: 'assistant', contentBlocks: [block(id)], createdAt: NOW })

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


const { agentMessagesToConversation, storedMessagesToAgentMessages } = await import('../src/renderer/src/utils/message-utils')
it('sends same-ID content updates and preserves both successful results on reload', () => {
  const manager = new AgentSessionManagerImpl()
  const state = freshSessionState()
  const events: AgentEventData[] = []
  manager.onEvent((_id, data) => { events.push(structuredClone(data)); applySessionEvent(state, structuredClone(data)) })
  const engine = makeEngine()
  engine.isAutoExecuting = true
  const tools = ['one', 'two'].map(id => ({ type: 'tool_use' as const, id, name: 'read', input: {}, status: 'running' as const, exitCode: 0 }))
  engine.messages = [{ id: 'a', role: 'assistant', contentBlocks: tools, createdAt: NOW }]
  engine.toolUseBlocks = tools
  engine.pendingToolIds = new Set(['one', 'two'])
  const send = () => (manager as unknown as TransportInternals).emitMessages('test', engine.messages)
  send()
  engine.addToolResult('one', 'first result', false)
  send()
  engine.addToolResult('two', 'second result', false)
  send()
  expect(events.some(e => e.type === 'messages_update')).toBe(true)
  const saved = agentMessagesToConversation(state.messages, 'test', 'test')
  const loaded = storedMessagesToAgentMessages(structuredClone(saved.messages))
  expect(loaded.flatMap(m => m.contentBlocks).filter(b => b.type === 'tool_result')).toHaveLength(2)
  expect(loaded[0].contentBlocks.map(b => (b as {status?: string}).status)).toEqual(['completed', 'completed'])
})

it('keeps consecutive appends and updates only the touched message identity', () => {
  const manager = new AgentSessionManagerImpl()
  const state = freshSessionState()
  const events: AgentEventData[] = []
  manager.onEvent((_id, event) => { events.push(structuredClone(event)); applySessionEvent(state, structuredClone(event)) })
  const send = (messages: AgentMessage[]) => (manager as unknown as TransportInternals).emitMessages('test', messages)
  const first = assistant('first'), second = assistant('second')
  send([first]); send([first, second])
  expect(state.messages.map(m => m.id)).toEqual(['first', 'second'])
  const oldFirst = state.messages[0], oldSecond = state.messages[1]
  second.contentBlocks = [block('changed')]
  send([first, second])
  expect(state.messages[0]).toBe(oldFirst)
  expect(state.messages[1]).not.toBe(oldSecond)
  expect(state.messages[1].contentBlocks).toEqual([block('changed')])
  events.length = 0
  send([first, second])
  expect(events).toEqual([])
  send([assistant('replacement'), second])
  expect(state.messages.map(m => m.id)).toEqual(['replacement', 'second'])
  expect(events.some(e => e.type === 'messages')).toBe(true)
  send([second])
  expect(state.messages.map(m => m.id)).toEqual(['second'])
})
