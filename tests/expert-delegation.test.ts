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
 * 多专家 @召唤 → 计划模式（用户裁定 2026-09-17：「当@多个专家，能不能进入plan模式，
 * 为多个专家分配任务」）。The engine owns the routing: one name IS the delegation
 * path above, so the two entry points cannot disagree about a one-name roster.
 * A multi-name roster opens an ordinary loop with `summon` set — the plan is the
 * model's own work, guided by the state block's brief and enforced in
 * create_plan (see tests/expert-summon-plan-mode.test.ts).
 */
describe('expert delegation: multi-expert @-summon opens plan mode', () => {
  it('opens a normal loop with the roster recorded and no pre-baked spawn call', async () => {
    const engine = makeEngine()
    const continueLoop = vi.spyOn(engine as unknown as { continueLoop: () => Promise<void> }, 'continueLoop')
      .mockResolvedValue(undefined)
    try {
      await engine.startPlanningLoop('把这个方案做出来', [
        { id: 'expert-writer', name: '写作专家' },
        { id: 'expert-reviewer', name: '代码审查专家' },
      ])

      // The user's own message, once — the plan itself is the model's next move.
      expect(engine.messages).toHaveLength(1)
      expect(engine.messages[0].contentBlocks).toHaveLength(1)
      expect(engine.messages[0].contentBlocks[0]).toMatchObject({ type: 'text', text: '把这个方案做出来' })
      expect(engine.summon).toEqual({
        experts: [{ id: 'expert-writer', name: '写作专家' }, { id: 'expert-reviewer', name: '代码审查专家' }],
        nudged: false,
        engaged: false,
        // M3 (review 2026-09-18): a fresh engine has no plan, so the turn
        // starts with planAtStart = null — only a NEWER plan may engage.
        planAtStart: null,
      })
      expect(continueLoop).toHaveBeenCalledTimes(1)
      // The clock runs for a plan-mode turn like any other.
      expect(engine.turnClock.isActive()).toBe(true)
    } finally {
      continueLoop.mockRestore()
    }
  })

  it('collapses a one-name roster onto the delegation path and an empty one onto nothing', async () => {
    const engine = makeEngine()
    const dispatch = vi.spyOn(engine, 'handleToolUseResponse').mockResolvedValue(undefined)
    const continueLoop = vi.spyOn(engine as unknown as { continueLoop: () => Promise<void> }, 'continueLoop')
      .mockResolvedValue(undefined)
    try {
      await engine.startPlanningLoop('写一篇周报', [{ id: 'expert-writer', name: '写作专家' }])
      const call = engine.messages[1].contentBlocks[0] as ToolUseBlock
      expect(call.name).toBe('spawn_agent')
      expect(call.input).toEqual({ subAgentId: 'expert-writer', task: '写一篇周报' })
      // One expert never enters plan mode: `summon` exists only for a roster
      // that has to be split across nodes.
      expect(engine.summon).toBeNull()
      expect(continueLoop).not.toHaveBeenCalled()

      await engine.startPlanningLoop('没有专家', [])
      await engine.startPlanningLoop('   ', [{ id: 'expert-writer', name: '写作专家' }])
      expect(engine.messages).toHaveLength(2)
      expect(continueLoop).not.toHaveBeenCalled()
    } finally {
      dispatch.mockRestore()
      continueLoop.mockRestore()
    }
  })

  it('clears the summons when the NEXT turn opens (per-turn state, not a mode)', async () => {
    const engine = makeEngine()
    const continueLoop = vi.spyOn(engine as unknown as { continueLoop: () => Promise<void> }, 'continueLoop')
      .mockResolvedValue(undefined)
    try {
      await engine.startPlanningLoop('第一轮', [
        { id: 'a', name: '甲' },
        { id: 'b', name: '乙' },
      ])
      expect(engine.summon).not.toBeNull()

      // A plain follow-up message must not inherit the previous turn's roster —
      // which covers the NEXT loop too: an ordinary send goes through startLoop,
      // i.e. through prepareTurn, which is where the reset lives.
      await engine.startLoop('再改一下')
      expect(engine.summon).toBeNull()
      expect(engine.messages).toHaveLength(2)
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
  const bridgeSrc = readFileSync('src/shared/types/electron-bridge.ts', 'utf8')
  const sessionMgrSrc = readFileSync('src/main/agent/session-manager.ts', 'utf8')

  it('routes a resolved roster through startSummonedLoop and everything else to startLoop', () => {
    // Non-vacuity: the branch this invariant talks about exists.
    expect(controllerSrc).toContain('parseExpertMentions(content, experts)')
    expect(controllerSrc).toContain('if (mentioned.length > 0) engineHandle.startSummonedLoop(content, mentioned, knowledgeBase, forcedSkills)')
    expect(controllerSrc).toContain('else engineHandle.startLoop(content, knowledgeBase, forcedSkills)')
  })

  it('the @ tokens ride the outgoing message; the guard reads the words beside them', () => {
    // 用户 2026-10-09: the mention's words are message content too — the
    // controller must not rewrite `content` with the stripped remainder.
    expect(controllerSrc).not.toContain('content = mentions.text')
    expect(controllerSrc).toContain('!mentions.task.trim()')
  })

  it('no longer binds the expert to the conversation from the summon path', () => {
    // The binding write was the old implementation; the chip's 解除专家 still
    // uses persistence.updateConversationExpert for legacy rows, so only the
    // summon-issued writes must be gone.
    expect(controllerSrc).not.toContain('updateConversationExpert(convId, mention.expert.id)')
    // An empty mention must refuse instead of silently switching.
    expect(controllerSrc).toContain('chatView.expert.needTaskWithSummon')
  })

  it('carries the roster over the wire as a list and routes it in ONE place', () => {
    // The old scalar param would silently drop a second expert — the whole
    // point of the plural path — so the field itself is pinned.
    expect(bridgeSrc).toContain('agentSessionAsk: (sessionId: string, content: string, summon?: SummonedExpert[], knowledgeBase?: { id: string; name: string } | null, forcedSkills?: string[] | null)')
    expect(bridgeSrc).not.toContain('delegateExpertId')
    // Main's only routing rule (the engine collapses 1 → delegation itself).
    expect(sessionMgrSrc).toContain('const roster = normalizeSummonedExperts(summon)')
    expect(sessionMgrSrc).toContain('? entry.engine.startPlanningLoop(content, roster)')
    expect(sessionMgrSrc).toContain(': entry.engine.startLoop(content)')
    expect(sessionMgrSrc).not.toContain('delegateExpertId')
  })

  it('forwards the roster at every hop between renderer and engine', () => {
    // Three pass-throughs, each of which can drop the third argument without a
    // symptom: the renderer would send it, main would receive a normal turn, and
    // the expert would simply be mentioned into the void — the class of failure
    // this file exists for.
    const handlerSrc = readFileSync('src/main/ipc/agent-session.handler.ts', 'utf8')
    const preloadSrc = readFileSync('src/preload/index.ts', 'utf8')
    const clientSrc = readFileSync('src/renderer/src/hooks/useConversationEngine.ts', 'utf8')
    // Preload: the invoke must carry it (a 2-arg invoke textually drops it).
    expect(preloadSrc).toContain('ipcRenderer.invoke(IPC_CHANNELS.AGENT_SESSION_ASK, sessionId, content, summon, knowledgeBase, forcedSkills)')
    // Handler: main's ask signature is (sessionId, content, pageContext, summon),
    // so the summon must ride the FOURTH slot — a 3-arg forward binds it to
    // pageContext and every summon becomes an ordinary turn.
    expect(handlerSrc).toContain('agentSessionManager.ask(sessionId, content, undefined, summon, knowledgeBase, forcedSkills)')
    // The client handle: the roster reaches the IPC call, not just its signature.
    expect(clientSrc).toContain('agentSessionAsk(convId, content, summon, knowledgeBase, forcedSkills)')
    expect(clientSrc).toContain('return ask(userMessage, experts, knowledgeBase, forcedSkills)')
  })
})
