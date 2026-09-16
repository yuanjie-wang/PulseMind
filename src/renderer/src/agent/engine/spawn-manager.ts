/**
 * Sub-agent lifecycle (PLAN-0.3.5 refactor, split 3/5): spawning, progress
 * reporting and completion resolution, extracted from AgentEngine. Holds a
 * back-reference to the owning engine — one SpawnManager per engine; the
 * spawned engine's own manager drives its loop.
 */
import { AgentEngine, type AgentEngineOptions } from '../AgentEngine'
import type { SubAgentResult, SpawnSubAgentConfig, SubAgentHandle } from '../agent-utils'
import { agentMessagesToConversation } from '../../utils/message-utils'
import { getHost } from '../host'
import type { EngineCore } from './engine-core'

export class SpawnManager {
  private _lastSpawnProgressAt = 0

  // Needs the concrete class (not just EngineCore): this module is the engine
  // FACTORY — spawnSubAgent constructs full AgentEngine instances.
  constructor(private engine: EngineCore) {}

  /** Push a live progress line to the parent engine's UI (sub-agents only). Throttled to 800ms except forced transition updates. */
  reportProgress(msg: string, force = false): void {
    if (!this.engine.onSpawnProgress || !this.engine.spawnSystemPrompt) return
    const now = Date.now()
    if (!force && now - this._lastSpawnProgressAt < 800) return
    this._lastSpawnProgressAt = now
    this.engine.onSpawnProgress(msg)
  }


  spawnSubAgent(config: SpawnSubAgentConfig): SubAgentHandle {
    const id = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
    const subConvId = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`

    const subOpts: AgentEngineOptions = {
      ...this.engine.opts,
      conversationId: subConvId,
      // The expert budget belongs to the SESSION, not to the expert's own
      // sub-conversation: without this the child looks like a brand-new session
      // and gets three fresh slots (and a nested spawn starts another three)
      // instead of sharing the parent's three.
      sessionRootId: this.engine.opts.sessionRootId || this.engine.opts.conversationId,
      hooks: undefined,
      // 专家拿不到页面工具（PLAN-parallel-experts T9，第二轮裁定 ④：不给）：
      // 专家继承父会话的 hostedAvailable=true，但注册表只绑定被 ws 客户端 ask
      // 过的会话，专家的会话没人绑定——每次 page_* 调用都必然报「当前会话没有
      // 连接的浏览器客户端」，是纯噪声加一次白跑的 LLM 轮。关掉入口比留着
      // 必然失败的出口好。「专家驱动页面」要注册表支持子会话绑定，另立项。
      hostedAvailable: false,
      // The sub-agent runs its own prompt wholesale and must never inherit the
      // parent session's @-summoned expert pack (its prompt override AND its
      // capability whitelists) through the spread. The DELEGATED pack's own
      // 可用技能 / 可用连接器 travel explicitly via config instead — the spawned
      // engine enforces them exactly like a @-summoned expert.
      // 可用技能 / 可用连接器 travel explicitly via config instead — the spawned
      // engine enforces them exactly like a @-summoned expert. Passed through
      // as-is: an empty array means "none allowed", undefined means "no
      // restriction" (a general sub-agent with no expert pack).
      allowedTools: undefined,
      allowedMcpServers: config.allowedMcpServers,
      allowedSkills: config.allowedSkills,
      systemPromptOverride: undefined,
      expert: undefined,
    }

    const engine = new AgentEngine(subOpts)

    // Set spawn state (consumed by continueLoop)
    engine.spawnSystemPrompt = config.systemPrompt
    engine.spawnTitle = config.title
    engine.onSpawnProgress = config.onProgress
    engine.completionPromise = new Promise<SubAgentResult>((resolve) => {
      engine.resolveCompletion = resolve
    })

    // Inject initial messages
    engine.messages = [...config.initialMessages]

    // Set max loop iterations for sub-agent
    if (config.maxLoopIterations) {
      engine.maxLoopCount = config.maxLoopIterations
    }

    // Start loop (async but handle doesn't await it)
    engine.startSpawnLoop(config)

    // Periodic save during sub-agent execution so progress survives crashes.
    // Appends only messages newer than the last tick (plus a small re-saved tail
    // for in-place block updates like exitCode) — a full-conversation rewrite
    // every 5s stalls the main process once a sub-agent's history grows long.
    const SUB_SAVE_INTERVAL = 5000
    const SUB_SAVE_TAIL = 8
    let savedCount = 0
    const saveTimer = setInterval(() => {
      const msgs = engine.messages
      if (msgs.length <= savedCount) return
      const fromIdx = Math.max(0, savedCount - SUB_SAVE_TAIL)
      const conv = agentMessagesToConversation(msgs.slice(fromIdx), subConvId, 'Sub-agent')
      getHost().appendConversationMessages(subConvId, 'Sub-agent', conv.messages).catch(() => {})
      savedCount = msgs.length
    }, SUB_SAVE_INTERVAL)

    // Track for cancellation when the (parent) main agent is stopped
    const cleanup = (): void => {
      clearInterval(saveTimer)
      this.engine.activeSubAgents.delete(id)
    }
    engine.completionPromise!.then(cleanup, cleanup)

    const handle: SubAgentHandle = {
      id,
      subConvId,
      get messages() { return engine.messages },
      get agentStatus() { return engine.agentStatus },
      abort: () => engine.cancelLoop(),
      waitForCompletion: () => engine.completionPromise!,
    }

    this.engine.activeSubAgents.set(id, engine)
    return handle
  }

  /** Simplified loop entry for spawned agents — skips session/hooks/userMsg setup. */
  startSpawnLoop(config: SpawnSubAgentConfig): void {
    this.engine.loopCount = 0
    this.engine.maxLoopCount = config.maxLoopIterations ?? 10
    this.engine.isCancelled = false
    this.engine.pendingToolIds = new Set()
    this.engine.opts.adapter.reconcileMessages?.(this.engine.messages)
    if (this.engine.messages.length === 0) {
      this.engine.messages = [{
        id: `spawn_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        role: 'user',
        contentBlocks: [{ type: 'text', text: 'Please execute the task described in the system prompt.' }],
        createdAt: new Date().toISOString()
      }]
    }
    // A sub-agent turn is a task in its own right: its duration is stamped on
    // its final answer and read in the node's 子代理会话, so the clock starts
    // with the kick-off message exactly as it does for a user's send.
    this.engine.turnClock.start()
    this.engine.continueLoop()
  }

  /** Resolve the spawn completion promise if this is a spawned agent. */
  resolveCompletionIfSpawned(status: SubAgentResult['status']): void {
    if (!this.engine.resolveCompletion) return
    const outputTokens = this.engine.messages.reduce((sum, m) => sum + (m.outputTokens || 0), 0)

    // Save conversation for token usage statistics
    const convId = this.engine.opts.conversationId
    if (convId && this.engine.messages.length > 0) {
      const firstText = this.engine.messages[0]?.contentBlocks?.find(b => b.type === 'text')?.text || ''
      // The injected kick-off message is a fixed string — prefer the delegated
      // expert name + task so sub-agent sessions are distinguishable in the list.
      const title = this.engine.spawnTitle || firstText || 'Sub-agent'
      const conv = agentMessagesToConversation(this.engine.messages, convId, title)
      getHost().saveConversation(conv).catch(err =>
        console.warn('[AgentEngine] Failed to save sub-agent conversation:', err)
      )
    }

    this.engine.resolveCompletion({ messages: this.engine.messages, status, outputTokens, subConversationId: convId ?? undefined })
    this.engine.resolveCompletion = undefined
    // completionPromise deliberately stays: a settled promise is inert, and an
    // expert that settles while spawnSubAgent is still on its synchronous path
    // (loop limit crossed on round 1) must leave `waitForCompletion()` and the
    // `.then(cleanup)` below a real promise — nulling here crashed both (T8).
  }

}
