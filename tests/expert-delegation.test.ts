import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

// The engine import chain touches real stores (MEMORY.md creation on first
// touch), so point HOME at a temp dir BEFORE importing — a test must never
// write into the user's live ~/.pulsemind.
process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-expert-delegation-'))

const { AgentEngine } = await import('../src/renderer/src/agent/AgentEngine')
const { setHost } = await import('../src/renderer/src/agent/host')
const { ToolManager } = await import('../src/renderer/src/tools/ToolManager')
const { SkillManager } = await import('../src/renderer/src/skills/SkillManager')

import type { AgentEngineOptions } from '../src/renderer/src/agent/AgentEngine'
import type { ToolUseBlock } from '../src/renderer/src/types/agent'

/** Construction-time cache warming pokes the host; nothing here needs it to
 *  answer, so every method is a generic async no-op. */
setHost(new Proxy({}, { get: () => () => Promise.resolve([] as unknown[]) }) as never)

function makeEngine(): InstanceType<typeof AgentEngine> {
  return new AgentEngine({
    apiKey: 'test-key', baseURL: 'https://example.invalid', model: 'test-model', maxTokens: 1024,
    myName: 'tester', soul: '', yourName: 'user',
    adapter: {} as never, // never exercised: no request is issued here
    toolManager: new ToolManager() as never, skillManager: new SkillManager() as never,
    conversationId: 'conv_expert_delegation',
  } as unknown as AgentEngineOptions)
}

/**
 * 召唤专家改走 spawn_agent（2026-09-16）：@提及不再是「把会话身份切换成专家」
 * （conversations.expert_id 绑定），而是主会话把任务通过 spawn_agent 委托给该
 * 专家以子代理执行，结果回到当前对话。引擎侧的落点是 startDelegatedLoop：
 * 用户消息之后必须跟一个**确定性的** spawn_agent tool_use 块——与模型自己发出
 * 的委托调用逐字段同形——并走 handleToolUseResponse 派发，这样并行槽位、实时
 * 进度、子会话链接、停止处理全部原样生效。
 */
describe('expert delegation: @-summon routes through spawn_agent', () => {
  it('appends the user message then a deterministic spawn_agent tool call and dispatches it', async () => {
    const engine = makeEngine()
    const dispatch = vi.spyOn(engine, 'handleToolUseResponse').mockResolvedValue(undefined)
    try {
      await engine.startDelegatedLoop('帮我写一篇周报', 'expert-writer')

      expect(engine.messages).toHaveLength(2)
      const [userMsg, assistantMsg] = engine.messages
      expect(userMsg.role).toBe('user')
      expect(userMsg.contentBlocks[0]).toMatchObject({ type: 'text', text: '帮我写一篇周报' })

      expect(assistantMsg.role).toBe('assistant')
      expect(assistantMsg.contentBlocks).toHaveLength(1)
      const call = assistantMsg.contentBlocks[0] as ToolUseBlock
      expect(call.type).toBe('tool_use')
      expect(call.name).toBe('spawn_agent')
      expect(call.input).toEqual({ subAgentId: 'expert-writer', task: '帮我写一篇周报' })
      expect(call.status).toBe('pending')

      // The exact block object goes down the normal tool dispatch path — that
      // is the whole point: limiter, progress, subConvId link and stop
      // handling are the model-emitted path's, not a fork.
      expect(dispatch).toHaveBeenCalledTimes(1)
      expect(dispatch).toHaveBeenCalledWith([call])
      // The turn is visibly in progress on the spawned call (the card shows
      // running; the composer sees an active turn), and the clock runs.
      expect(engine.agentStatus).toEqual({ status: 'executing', toolUseId: call.id })
      expect(engine.turnClock.isActive()).toBe(true)
    } finally {
      dispatch.mockRestore()
    }
  })

  it('gives the delegation the beforeSession-rewritten text, not the raw input', async () => {
    const engine = makeEngine()
    engine.opts.hooks = {
      beforeSession: async (ctx) => ({ ...ctx, userMessage: `${ctx.userMessage}（已由钩子改写）` }),
    } as never
    const dispatch = vi.spyOn(engine, 'handleToolUseResponse').mockResolvedValue(undefined)
    try {
      await engine.startDelegatedLoop('审一下这段话', 'expert-reviewer')
      const call = engine.messages[1].contentBlocks[0] as ToolUseBlock
      expect(engine.messages[0].contentBlocks[0]).toMatchObject({ type: 'text', text: '审一下这段话（已由钩子改写）' })
      expect(call.input).toEqual({ subAgentId: 'expert-reviewer', task: '审一下这段话（已由钩子改写）' })
    } finally {
      dispatch.mockRestore()
    }
  })

  it('refuses an empty task or a hook-cancelled message without appending anything', async () => {
    const engine = makeEngine()
    const dispatch = vi.spyOn(engine, 'handleToolUseResponse').mockResolvedValue(undefined)
    try {
      await engine.startDelegatedLoop('   ', 'expert-writer')
      await engine.startDelegatedLoop('你好', '') // no expert id: not a delegation
      expect(engine.messages).toHaveLength(0)
      expect(dispatch).not.toHaveBeenCalled()

      engine.opts.hooks = {
        beforeSession: async (ctx) => ({ ...ctx, userMessage: '' }),
      } as never
      await engine.startDelegatedLoop('被钩子取消', 'expert-writer')
      expect(engine.messages).toHaveLength(0)
      expect(dispatch).not.toHaveBeenCalled()
    } finally {
      dispatch.mockRestore()
    }
  })

  it('startLoop still drives the normal loop (the non-summon path is unchanged)', async () => {
    const engine = makeEngine()
    const continueLoop = vi.spyOn(engine as unknown as { continueLoop: () => Promise<void> }, 'continueLoop')
      .mockResolvedValue(undefined)
    try {
      await engine.startLoop('普通消息')
      expect(engine.messages).toHaveLength(1)
      expect(engine.messages[0].role).toBe('user')
      expect(continueLoop).toHaveBeenCalledTimes(1)
    } finally {
      continueLoop.mockRestore()
    }
  })
})

/**
 * The renderer half cannot be mounted (vitest is node-env: no React, no
 * electronAPI), so the wiring is pinned as source, the same way
 * tests/pending-approval.test.ts pins the materialization ordering.
 */
describe('expert delegation: renderer wiring (source-scanned)', () => {
  const controllerSrc = readFileSync('src/renderer/src/hooks/useChatController.ts', 'utf8')

  it('routes a resolved mention to startDelegatedLoop and everything else to startLoop', () => {
    // Non-vacuity: the branch this invariant talks about exists.
    expect(controllerSrc).toContain('parseExpertMention(content, experts)')
    expect(controllerSrc).toContain('if (mention.expert) engineHandle.startDelegatedLoop(content, mention.expert.id)')
    expect(controllerSrc).toContain('else engineHandle.startLoop(content)')
  })

  it('no longer binds the expert to the conversation from the summon path', () => {
    // The binding write was the old implementation; the chip's 解除专家 still
    // uses persistence.updateConversationExpert for legacy rows, so only the
    // summon-issued writes must be gone.
    expect(controllerSrc).not.toContain('updateConversationExpert(convId, mention.expert.id)')
    // An empty mention must refuse instead of silently switching.
    expect(controllerSrc).toContain('chatView.expert.needTaskWithSummon')
  })
})
