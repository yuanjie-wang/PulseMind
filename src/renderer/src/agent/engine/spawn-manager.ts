/**
 * Sub-agent lifecycle (PLAN-0.3.5 refactor, split 3/5): spawning, progress
 * reporting and completion resolution, extracted from AgentEngine. Holds a
 * back-reference to the owning engine — one SpawnManager per engine; the
 * spawned engine's own manager drives its loop.
 */
import { AgentEngine, type AgentEngineOptions } from '../AgentEngine'
import type { SubAgentResult, SpawnSubAgentConfig, SubAgentHandle } from '../agent-utils'
import { agentMessagesToConversation } from '../../utils/message-utils'
import { getLoopIterationLimit } from '../agent-utils'
import { getHost } from '../host'
import type { EngineCore } from './engine-core'

/** 续聊注册表的 LRU 帽（2026-10-28 续聊原语）：每条目是一个完整子引擎（含
 *  全部消息历史）——帽必须小，5 个已是「最近几轮专家」的合理驻留面。进程
 *  重启清空（引擎不入库；跨重启续聊=重水化，前瞻未做）。 */
export const SUB_AGENT_FOLLOWUP_KEEP = 5

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
      // undefined = no restriction (a general sub-agent with no expert pack);
      // the explore 预设 (spawn-tool.ts) passes its read-only whitelist here —
      // subOpts.allowedTools → the engine's allowedToolsSet → tool-collection's
      // whitelist filter, which also turns that sub-engine's MCP discovery off.
      allowedTools: config.allowedTools,
      allowedMcpServers: config.allowedMcpServers,
      allowedSkills: config.allowedSkills,
      systemPromptOverride: undefined,
      expert: undefined,
      // Sub-agent tool boundary (PLAN-plan-split v2 R2): the toolset drops
      // SUB_AGENT_DENY_TOOLS (create_plan / advance_plan / spawn_agent).
      // Every spawn gets this — the ruling covers the general sub-agent,
      // expert packs and plan-node spawns alike.
      spawnedToolset: true,
      // v2 R6/R7: ONLY a splittable plan-node spawn arms create_sub_plan —
      // the opt is both the toolset gate and the bridge constants' carrier.
      ...(config.planSplit ? { spawnPlanSplit: { nodeRef: config.planSplit.nodeRef, attemptId: config.planSplit.attemptId } } : {}),
    }

    const engine = new AgentEngine(subOpts)

    // 会话文件变更台账共享（2026-10-28 工作区树着色）：子引擎的 executor 直接持有
    // 父引擎的那一份——树着色的是「本会话改了什么」，子代理写的文件也算。引用
    // 共享让嵌套派发自然上卷到根引擎，completedSubAgents 的 LRU 淘汰也不丢记录；
    // onChange 只挂在根引擎那份上（AgentEngine 构造器接的是自己新建的台账，被
    // 这里换掉后成了孤儿），所以 file_changes 事件只从托管会话发出一次。
    engine.toolExecutor.fileChanges = this.engine.toolExecutor.fileChanges

    // The narrow parent-plan bridge (v2 R6): the executor is built before the
    // sub-engine knows its parent, so spawn-manager — the one module that sees
    // both — wires the merge callback here. S2 discipline holds: the sub-agent
    // gains exactly this one mouth to the parent plan, nothing else.
    // createdIds feeds the parent's spawn envelope ("this node split its
    // remainder into …") after waitForCompletion.
    if (config.planSplit) {
      const split = config.planSplit
      engine.toolExecutor.parentPlanMerge = (children, reason) => {
        const result = this.engine.planManager.mergeSplitProposal(split.nodeRef, split.attemptId, children, reason)
        if (result.ok) split.createdIds.push(...result.nodeIds)
        return result
      }
    }

    // Set spawn state (consumed by continueLoop)
    engine.spawnSystemPrompt = config.systemPrompt
    // The one true spawn discriminator (see the field's comment on AgentEngine):
    // the assistants share spawnSystemPrompt via their pinned override, but only
    // a spawned agent lacks a user channel for ask_user to park on.
    engine.isSpawnedSubAgent = true
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
    const detachSaver = attachSubConversationSaver(engine, subConvId)
    // Liveness watchdog: a wedged sub-engine must settle loudly instead of
    // parking the parent's spawn batch (and the whole plan wave) forever.
    const detachWatchdog = attachSubAgentWatchdog(engine, subConvId)

    // Track for cancellation when the (parent) main agent is stopped
    const cleanup = (): void => {
      detachSaver()
      detachWatchdog()
      this.engine.activeSubAgents.delete(id)
    }
    // 续聊注册表（2026-10-28）：settle 不再等于丢弃——结算把引擎保留进
    // completedSubAgents（LRU 帽），spawn_agent 的 agentId 从这里唤醒同一个
    // 引擎带全部上下文继续；重新派发从零开始的老二选一之外多了第三条路。
    engine.completionPromise!.then(() => {
      this.retainCompleted(subConvId, engine, config.title)
      cleanup()
    }, cleanup)

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
    // Same base the engine constructor already read (getLoopIterationLimit()):
    // an omitted config used to silently cap a spawned agent at 10 rounds,
    // clobbering that value here.
    this.engine.maxLoopCount = config.maxLoopIterations ?? getLoopIterationLimit()
    this.engine.isCancelled = false
    this.engine.pendingToolIds = new Set()
    this.engine.opts.adapter.reconcileMessages?.(this.engine.messages)
    if (this.engine.messages.length === 0) {
      // Defensive only: spawn_agent now supplies the task AS the first user
      // message (visible in the sub-agent transcript), so this fixed line is
      // unreachable from that path — it exists so an empty-message spawn can
      // never send a request with no user turn at all.
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
  /** 续聊注册表的 LRU 写入：同 id 重置（follow-up 完成后再次保留），帽外按
   *  Map 插入序淘汰最老。只在本引擎（父）的注册表上操作。 */
  retainCompleted(subConvId: string, engine: AgentEngine, title?: string): void {
    const registry = this.engine.completedSubAgents
    registry.delete(subConvId)
    registry.set(subConvId, { engine, title: title || 'Sub-agent' })
    while (registry.size > SUB_AGENT_FOLLOWUP_KEEP) {
      const oldest = registry.keys().next().value
      if (oldest === undefined) break
      registry.delete(oldest)
    }
  }

  /** agentId 续聊（2026-10-28）：从注册表取出已结算的子引擎，重绑保存器/
   *  看门狗/父会话 activeSubAgents（stop/cancel 面必须重新覆盖它），换新
   *  completionPromise，以 userText 追问同一个引擎——全上下文在场，发现成本
   *  只付一次。注册表未命中（LRU 淘汰/进程重启/双续聊竞态）返回 null，调用
   *  方给出「全新派发」的恢复话术。注意本方法运行在父引擎的 spawn-manager
   *  上（注册表在父引擎字段），对子引擎的唤醒经 engine.followUpRun。 */
  followUpCompleted(subConvId: string, userText: string): SubAgentHandle | null {
    const reg = this.engine.completedSubAgents.get(subConvId)
    if (!reg) return null
    this.engine.completedSubAgents.delete(subConvId)
    const engine = reg.engine
    // 防御在飞：注册表只收 settled 引擎（pop 即离开注册表，双续聊竞态落到
    // null），但一个便宜的真值检查好过论证每一条交错路径。
    if (engine.pendingToolIds.size > 0 || engine.currentRequestId) return null
    const id = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
    this.engine.activeSubAgents.set(id, engine)
    const detachSaver = attachSubConversationSaver(engine, subConvId)
    const detachWatchdog = attachSubAgentWatchdog(engine, subConvId)
    const cleanup = (): void => {
      detachSaver()
      detachWatchdog()
      this.engine.activeSubAgents.delete(id)
    }
    engine.completionPromise = new Promise<SubAgentResult>((resolve) => {
      engine.resolveCompletion = resolve
    })
    engine.completionPromise.then(() => {
      this.retainCompleted(subConvId, engine, reg.title)
      cleanup()
    }, cleanup)
    engine.followUpRun(userText)
    const handle: SubAgentHandle = {
      id,
      subConvId,
      get messages() { return engine.messages },
      get agentStatus() { return engine.agentStatus },
      abort: () => engine.cancelLoop(),
      waitForCompletion: () => engine.completionPromise!,
    }
    return handle
  }

  /** Resolve the spawn completion promise if this is a spawned agent. */
  resolveCompletionIfSpawned(status: SubAgentResult['status']): void {
    if (!this.engine.resolveCompletion) return
    const outputTokens = this.engine.messages.reduce((sum, m) => sum + (m.outputTokens || 0), 0)

    // Save conversation for token usage statistics
    const convId = this.engine.opts.conversationId
    if (convId && this.engine.messages.length > 0) {
      const firstText = this.engine.messages[0]?.contentBlocks?.find(b => b.type === 'text')?.text || ''
      // Prefer the explicit spawn title: the kick-off message is now the whole
      // task paragraph, which makes a poor (multi-line) list label — firstText
      // only covers a config that supplied no title at all.
      const title = this.engine.spawnTitle || firstText || 'Sub-agent'
      const conv = agentMessagesToConversation(this.engine.messages, convId, title)
      getHost().saveConversation(conv).catch(err =>
        console.warn('[AgentEngine] Failed to save sub-agent conversation:', err)
      )
    }

    // The failure reason rides the result: every 'error' settle site writes
    // agentStatus immediately before calling this, so reading it back is the
    // message the turn actually closed with. 'aborted' has nothing to carry —
    // the user stopped it.
    const error = status === 'error' && this.engine.agentStatus.status === 'error'
      ? this.engine.agentStatus.error
      : undefined
    this.engine.resolveCompletion({ messages: this.engine.messages, status, outputTokens, subConversationId: convId ?? undefined, error })
    this.engine.resolveCompletion = undefined
    // completionPromise deliberately stays: a settled promise is inert, and an
    // expert that settles while spawnSubAgent is still on its synchronous path
    // (loop limit crossed on round 1) must leave `waitForCompletion()` and the
    // `.then(cleanup)` below a real promise — nulling here crashed both (T8).
  }

}

// ── Sub-agent lifecycle timers (extracted for testability) ──────────────

export const SUB_SAVE_INTERVAL = 5000
export const SUB_SAVE_TAIL = 8
export const SUB_WATCHDOG_INTERVAL = 30_000
export const SUB_WATCHDOG_STALL = 10 * 60_000

/** Periodic save during sub-agent execution so progress survives crashes.
 *  Appends only messages newer than the last tick (plus a small re-saved tail
 *  for in-place block updates like exitCode) — a full-conversation rewrite
 *  every 5s stalls the main process once a sub-agent's history grows long.
 *  savedCount advances ONLY on success: the append is an upsert (idempotent
 *  over the re-saved tail), so a failed tick is simply retried next tick.
 *  Advancing unconditionally (the old shape) made ONE transient failure
 *  permanently drop that window — conv_20260930091135 lost both stuck
 *  sub-agents' final rounds this way, silently, via the swallowed rejection. */
export function attachSubConversationSaver(
  engine: EngineCore,
  subConvId: string,
  host: Pick<ReturnType<typeof getHost>, 'appendConversationMessages'> = getHost(),
): () => void {
  let savedCount = 0
  let saveInFlight = false
  const saveTimer = setInterval(() => {
    const msgs = engine.messages
    if (saveInFlight || msgs.length <= savedCount) return
    const fromIdx = Math.max(0, savedCount - SUB_SAVE_TAIL)
    const conv = agentMessagesToConversation(msgs.slice(fromIdx), subConvId, 'Sub-agent')
    saveInFlight = true
    host.appendConversationMessages(subConvId, 'Sub-agent', conv.messages)
      .then(() => { savedCount = Math.max(savedCount, msgs.length) })
      .catch((err: unknown) => {
        console.warn(`[SpawnManager] sub-agent save failed for ${subConvId} (will retry):`, err instanceof Error ? err.message : err)
      })
      .finally(() => { saveInFlight = false })
  }, SUB_SAVE_INTERVAL)
  return () => clearInterval(saveTimer)
}

/** Liveness watchdog (conv_20260930091135): a spawned engine that wedges on a
 *  dropped-resolver await below the request path parks forever — no in-flight
 *  request, no pending tool, no progress — and the parent's
 *  `await waitForCompletion()` plus the whole plan wave freeze with it. The
 *  settle signature cannot fire on legitimate work: a long tool run holds
 *  pendingToolIds, a long request holds currentRequestId (main-side retry
 *  sleeps included), and every other phase reports progress or grows
 *  messages. In-flight phases count as ALIVE, not merely exempt — the clock
 *  refreshes while they run, so a >stallMs stretch of legitimate work (retry
 *  stacking, a slow round) leaves no accrued debt behind when it ends and one
 *  tick can no longer land in the post-work gap to settle a healthy engine
 *  (the review_20261001 中1 shape, generalized off the frozen case).
 *  prepareLoopInProgress covers the build phase, where the compaction
 *  summary call awaits the same retrying transport with no currentRequestId
 *  armed. After SUB_WATCHDOG_STALL of neither, settle the spawn as an
 *  error so the envelope reaches the parent, the slots free up and the
 *  scheduler moves on; the zombie engine is frozen so a late-resolving await
 *  cannot revive it invisibly. A frozen engine (pauseExecution's
 *  awaiting_continue) accrues no stall debt — it is under human supervision,
 *  and a long pause must not pre-charge the clock for the post-resume gap. */
export function attachSubAgentWatchdog(
  engine: EngineCore,
  subConvId: string,
  opts?: { intervalMs?: number; stallMs?: number },
): () => void {
  const intervalMs = opts?.intervalMs ?? SUB_WATCHDOG_INTERVAL
  const stallMs = opts?.stallMs ?? SUB_WATCHDOG_STALL
  let lastLiveness = Date.now()
  let lastMsgCount = engine.messages.length
  const prevProgress = engine.onSpawnProgress
  engine.onSpawnProgress = (msg: string) => {
    lastLiveness = Date.now()
    prevProgress?.(msg)
  }
  const watchdogTimer = setInterval(() => {
    if (engine.messages.length !== lastMsgCount) {
      lastMsgCount = engine.messages.length
      lastLiveness = Date.now()
      return
    }
    if (engine.isCancelled) {
      // 冻结期（pauseExecution 的 awaiting_continue）= 人为监护中，停摆债不
      // 累积：钟随 tick 刷新。否则冻结 ≥ stallMs 后旧债满额，解冻到新请求挂上
      // 之间的异步间隙被一个 tick 命中就会把健康专家误结算
      // 为卡死（review_20261001 中1）。结算路径里的 isCancelled 卫兵语义不变。
      lastLiveness = Date.now()
      return
    }
    // 在途（请求 / 工具 / 请求构建期）计活而非仅豁免：钟随 tick 刷新，一段
    // 超过 stallMs 的合法在途（主侧重试堆叠、慢请求、构建期的压缩摘要调用）
    // 结束后不留旧债，收尾间隙不再有 tick 能命中满额钟把健康专家误结算。
    if (engine.pendingToolIds.size > 0 || engine.currentRequestId || engine.prepareLoopInProgress) {
      lastLiveness = Date.now()
      return
    }
    if (Date.now() - lastLiveness < stallMs) return
    console.error(`[SpawnManager] sub-agent ${subConvId} stalled ${Math.round(stallMs / 60_000)}min with no in-flight request, no pending tools and no progress — settling as error`)
    engine.isCancelled = true
    engine.abortController?.abort()
    engine.agentStatus = { status: 'error', error: `子代理超过 ${Math.round(stallMs / 60_000)} 分钟无任何产出且无在途请求/工具，疑似内部卡死，已自动结算（可基于子会话已有进度重试）。` }
    engine.notify()
    engine.resolveCompletionIfSpawned('error')
  }, intervalMs)
  return () => clearInterval(watchdogTimer)
}
