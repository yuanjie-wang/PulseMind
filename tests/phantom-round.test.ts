import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The session-manager import chain touches real stores (it creates MEMORY.md on
// first touch), so point HOME at a temp dir BEFORE importing it — a test must
// never write into the user's live ~/.pulsemind.
process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-phantom-round-'))

const { AgentEngine } = await import('../src/renderer/src/agent/AgentEngine')
const { ToolManager } = await import('../src/renderer/src/tools/ToolManager')
const { SkillManager } = await import('../src/renderer/src/skills/SkillManager')

import type { AgentEngineOptions } from '../src/renderer/src/agent/AgentEngine'
import type { AgentMessage, ContentBlock, ToolResultBlock, ToolUseBlock } from '../src/renderer/src/types/agent'

/** Construction-time cache warming pokes the host; nothing in this file needs
 *  it to answer, so every method is a generic async no-op. */
const { setHost } = await import('../src/renderer/src/agent/host')
setHost(new Proxy({}, { get: () => () => Promise.resolve([] as unknown[]) }) as never)

const NOW = '2026-09-20T04:00:00.000Z'

const text = (s: string): ContentBlock => ({ type: 'text', text: s })

const askUserUse = (): ToolUseBlock => ({
  type: 'tool_use', id: 'tu_ask_1', name: 'ask_user', status: 'running',
  input: { prompt: '接下来做哪一件？', choices: '1. 做对比表, 5. 先不做' },
})

function makeEngine(messages: AgentMessage[]): InstanceType<typeof AgentEngine> {
  const engine = new AgentEngine({
    apiKey: 'test-key', baseURL: 'https://example.invalid', model: 'test-model', maxTokens: 1024,
    myName: 'tester', soul: '', yourName: 'user',
    adapter: {} as never, // never exercised: continueLoop is spied out below
    toolManager: new ToolManager() as never, skillManager: new SkillManager() as never,
    conversationId: 'conv_phantom_round',
  } as unknown as AgentEngineOptions)
  engine.messages = messages
  return engine
}

/**
 * 用户报告 2026-09-20（插件会话 ws_1789878852687）：「过程中我并没有发送任何消息」，
 * 但助手连发十余轮「你这条是空消息」的回复，其中一条乱码文本重复两遍。wire 上
 * （llm-requests 落盘）从未出现过空用户消息 —— 是引擎在无新增内容时把自己反复
 * 唤醒，模型面对「上一条是自己、用户那边什么都没有」的请求即兴脑补出空消息。
 *
 * Two unguarded continuations produced every phantom round, and this file pins
 * both. (1) `handleMaxTokensResponse` continued the loop even with ZERO tool
 * uses: a reasoning model (deepseek-flash) burns its hidden thinking budget,
 * the gateway answers finish_reason=length, the visible reply is short — and
 * the engine re-issued itself a content-less round each time. (2) a duplicate
 * `addToolResult` (the ask_user chip answered twice; the panel gives no
 * answered feedback) hit the duplicate guard and STILL called continueLoop —
 * mid-stream, so the second round raced the first on the engine's shared
 * stream state and produced the doubled garbled message (two requests, equal
 * message counts, on the wire).
 */
describe('no phantom rounds: a turn must not continue without new content', () => {
  it('ends the turn when max_tokens cuts a reply that has no tool calls', () => {
    const engine = makeEngine([
      { id: 'u1', role: 'user', contentBlocks: [text('现在哪个模型最厉害')], createdAt: NOW },
      { id: 'a1', role: 'assistant', contentBlocks: [text('部分回答…')], createdAt: NOW },
    ] as AgentMessage[])
    const continueLoop = vi.spyOn(engine, 'continueLoop').mockImplementation(async () => {})

    engine.handleMaxTokensResponse([])

    // The turn CLOSES (the user got a truncated answer, not a new silent round),
    // and no LLM request is re-issued with nothing new on the wire.
    expect(continueLoop).not.toHaveBeenCalled()
    expect(engine.agentStatus.status).toBe('completed')
  })

  it('still continues when max_tokens cut tool_use params — those need their error results', () => {
    const engine = makeEngine([
      { id: 'u1', role: 'user', contentBlocks: [text('跑一下')], createdAt: NOW },
      { id: 'a1', role: 'assistant', contentBlocks: [
        text('我来调用工具'),
        { type: 'tool_use', id: 'tu_1', name: 'write', status: 'pending', input: {}, _jsonTruncated: true },
      ], createdAt: NOW },
    ] as AgentMessage[])
    const continueLoop = vi.spyOn(engine, 'continueLoop').mockImplementation(async () => {})

    engine.handleMaxTokensResponse(engine.messages[1].contentBlocks.filter(b => b.type === 'tool_use') as ToolUseBlock[])

    // Truncated tool params get synthetic error results and the loop turns once
    // more so the model can retry — that half of the old behavior is the point.
    expect(continueLoop).toHaveBeenCalledTimes(1)
    // …and the synthetic error result must actually LAND in engine.messages.
    // The pre-fix addTruncatedResults returned void and rebuilt a dead local
    // array, so the wire carried the assistant tool_use with no paired
    // tool_result (review_20261005 P1-01); the adapters' reconcile skips the
    // LAST message — exactly where that orphan sat — so nothing repaired it.
    expect(engine.messages).toHaveLength(3)
    const synthetic = engine.messages[2]
    expect(synthetic.role).toBe('user')
    const block = synthetic.contentBlocks.find(b => b.type === 'tool_result') as ToolResultBlock
    expect(block.tool_use_id).toBe('tu_1')
    expect(block.is_error).toBe(true)
    expect(block.content).toMatch(/max_tokens/)
  })

  it('the tool_use truncated branch (handleToolUseResponse) lands its synthetic results too', async () => {
    const engine = makeEngine([
      { id: 'u1', role: 'user', contentBlocks: [text('跑一下')], createdAt: NOW },
      { id: 'a1', role: 'assistant', contentBlocks: [
        { type: 'tool_use', id: 'tu_trunc', name: 'write', status: 'pending', input: {}, _jsonTruncated: true },
      ], createdAt: NOW },
    ] as AgentMessage[])
    const continueLoop = vi.spyOn(engine, 'continueLoop').mockImplementation(async () => {})

    await engine.handleToolUseResponse(engine.messages[1].contentBlocks.filter(b => b.type === 'tool_use') as ToolUseBlock[])

    expect(continueLoop).toHaveBeenCalledTimes(1)
    expect(engine.messages).toHaveLength(3)
    const synthetic = engine.messages[2]
    expect(synthetic.role).toBe('user')
    const block = synthetic.contentBlocks.find(b => b.type === 'tool_result') as ToolResultBlock
    expect(block.tool_use_id).toBe('tu_trunc')
    expect(block.is_error).toBe(true)
    // The truncated calls were marked completed in place so the UI cards settle.
    const use = engine.messages[1].contentBlocks.find(b => b.type === 'tool_use') as ToolUseBlock
    expect(use.status).toBe('completed')
  })

  it('a duplicate tool_result (ask_user answered twice) never re-drives the loop', () => {
    const engine = makeEngine([
      { id: 'u1', role: 'user', contentBlocks: [text('问题')], createdAt: NOW },
      { id: 'a1', role: 'assistant', contentBlocks: [askUserUse()], createdAt: NOW },
    ] as AgentMessage[])
    engine.toolUseBlocks = [engine.messages[1].contentBlocks[0] as ToolUseBlock]
    engine.pendingToolIds = new Set(['tu_ask_1'])
    const continueLoop = vi.spyOn(engine, 'continueLoop').mockImplementation(async () => {})

    // The user double-clicks the chip: the first answer settles the call and
    // continues the loop (as it must); the duplicate must be swallowed.
    engine.respondToTool('tu_ask_1', '5. 先不做，随便聊')
    expect(continueLoop).toHaveBeenCalledTimes(1)
    engine.respondToTool('tu_ask_1', '5. 先不做，随便聊')
    expect(continueLoop).toHaveBeenCalledTimes(1) // ← the old code fired a second round here
    expect(engine.agentStatus.status).not.toBe('streaming')
  })

  it('a duplicate of a tool_result that is STILL pending may close the batch', () => {
    const engine = makeEngine([
      { id: 'u1', role: 'user', contentBlocks: [text('问题')], createdAt: NOW },
      { id: 'a1', role: 'assistant', contentBlocks: [askUserUse()], createdAt: NOW },
      { id: 'r1', role: 'user', contentBlocks: [
        { type: 'tool_result', tool_use_id: 'tu_ask_1', content: '5. 先不做，随便聊', is_error: false, tool_result_id: 'tr_1' },
      ], createdAt: NOW },
    ] as AgentMessage[])
    // The result landed but the batch is still waiting on it (a settle path
    // that appended the result without clearing pending) — the duplicate IS
    // the batch's last pending call, so closing the loop is correct here.
    engine.pendingToolIds = new Set(['tu_ask_1'])
    const continueLoop = vi.spyOn(engine, 'continueLoop').mockImplementation(async () => {})

    engine.addToolResult('tu_ask_1', '5. 先不做，随便聊', false)

    expect(continueLoop).toHaveBeenCalledTimes(1)
  })
})
