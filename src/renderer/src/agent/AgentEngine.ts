import { getHost } from './host'
import { IncrementalJsonTracker } from './json-stream'
import type {
  AgentMessage,
  AgentStatus,
  ContentBlock,
  ToolUseBlock,
  ToolResultBlock,
  Plan
} from '../types/agent'
import type { ToolManager } from '../tools/ToolManager'
import type { SkillManager } from '../skills/SkillManager'
import type { HooksConfig } from '../types/hooks'
import type { MemoryManager } from '../memory/MemoryManager'
import type { KnowledgeManager } from '../knowledge/KnowledgeManager'
import type { PlatformInfo } from '../types/electron'
import type { LlmAdapter } from '../llm/adapter'
import { SkillKeywordAgent, SkillSelectionAgent, HistorySummaryAgent } from './one-shot-agent'
import { safeInvoke, safeInvokeObserver, MAX_LOOP_ITERATIONS, generateMsgId, type SubAgentResult, type SpawnSubAgentConfig, type SubAgentHandle } from './agent-utils'
import { buildSystemPrompt } from './system-prompt-builder'
import type { ExpertRuntimeContext } from '../../../shared/types/expert'
import { normalizeSummonedExperts, type SummonState, type SummonedExpert } from '../../../shared/expert-context'
import type { SandboxApprovalMode } from '../../../shared/sandbox/policy'
import type { PageContext } from '../../../shared/agent-protocol'
import { PlanManager } from './plan-manager'
import { migrateLinearPlan } from '../../../shared/plan/graph'
import { ensureCache } from './mcp-cache'
import { ToolExecutor, UI_PREVIEW_MAX } from './tool-executors'
import { SpawnManager } from './engine/spawn-manager'
import { collectEnabledTools, buildToolProtocols } from './engine/tool-collection'
import { scheduleMemoryExtraction, persistUnsavedToolResults } from './engine/memory-extraction'
import { ExecutionFlow } from './engine/execution-flow'
import { StreamRunner } from './engine/stream-runner'
import { TurnClock, isWaitingOnUserStatus } from './engine/turn-clock'
import { releaseQueuedSubAgents, subAgentBudgetKey } from './engine/subagent-limiter'
import { ContextCompactor } from './engine/context-compactor'
import type { EngineCore } from './engine/engine-core'
import { stripImageData } from './image-utils'

// ── Tool-result guardrail ─────────────────────────────────────────────
// Every tool result funnels through addToolResult; executors do NOT truncate
// on their own. This single cap is the one backstop: results over the token
// budget are head+tail truncated for context, and the full text is offloaded
// to ~/.pulsemind/tmp/trunc/ so the model can `read` it back. The budget is in
// estimated tokens because the context window is counted in tokens — a fixed
// char cap would be far too generous for CJK-heavy output (30K chars ≈ 7.5K
// tokens in English but ≈ 30K tokens in Chinese). The DB persists whatever
// lives in this.messages, so this also keeps oversized results out of the
// tool_results table. The read tool is exempt (passes Infinity as maxTokens):
// reading a file IS the task, so read results always land in full.
const MAX_TOOL_RESULT_TOKENS = 4_000

/** Rough token estimate: CJK chars ≈ 1 token, everything else ≈ 1 token per 4 chars. */
function estimateTokens(text: string): number {
  const cjk = text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g)?.length ?? 0
  return cjk + Math.ceil((text.length - cjk) / 4)
}

/**
 * Fingerprint of the cached prefix (system prompt + tool schemas). DeepSeek
 * renders `system → tools → messages`, so this hash covers everything that sits
 * in front of the conversation: the same hash on consecutive requests means the
 * history stayed reusable, a different one means it was re-billed from the top.
 * Diagnostics only — logged, never sent.
 */
function prefixFingerprint(systemPrompt: string, tools: unknown): string {
  const s = systemPrompt + '\u0000' + JSON.stringify(tools)
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

// ── AgentEngine Options ───────────────────────────────────────────────

export interface AgentEngineOptions {
  apiKey: string | null
  baseURL: string
  model: string
  maxTokens: number
  contextLength?: number
  profileId?: string
  myName: string
  soul: string
  yourName: string
  adapter: LlmAdapter
  toolManager: ToolManager
  skillManager: SkillManager
  workspaceDir?: string
  skillsDir?: string
  platformInfo?: PlatformInfo
  memoryManager?: MemoryManager
  knowledgeManager?: KnowledgeManager
  /** PLAN-knowledge-groups G5: the @知识库 scope of the CURRENT turn (null =
   *  unscoped = search everything). Written by prepareTurn from the staged
   *  value — never set directly; domain-tools reads it via ex.opts. */
  knowledgeBaseScope?: { id: string; name: string } | null
  experienceManager?: import('../experiences/ExperienceManager').ExperienceManager
  hooks?: HooksConfig
  onSkillStateChange?: () => void
  /** How tool calls are gated for this engine (shared ladder; a project's
   *  sandbox policy is what the session manager resolves onto it). Absent means
   *  the engine-level fallback 'auto': every engine with a user in front of it
   *  is given an explicit level by the session manager (whose own fallback, for
   *  a conversation that never chose one, is DEFAULT_APPROVAL_MODE), so this
   *  case is either a sub-agent inheriting an unset parent or a derived engine
   *  (tool studio, canvas) that pins its own — nothing here can answer a hold,
   *  so it must not hold. */
  approvalMode?: SandboxApprovalMode
  locale?: 'zh' | 'en'
  conversationId?: string
  /** The session this engine's expert budget belongs to. A sub-agent is its own
   *  conversation (`conversationId: sub_…`) but must spend the SAME slots
   *  as its parent, so spawn-manager copies the root id here — nested spawns
   *  count against it too (see engine/subagent-limiter.ts). Absent on a normal
   *  engine, where the conversation id is the session. */
  sessionRootId?: string

  // Spawn sub-agent options
  allowedTools?: string[]
  /** Connector whitelist (MCP server ids). `undefined` = no restriction, an
   *  EMPTY ARRAY = no connector may be used. An expert pack's 可用连接器 lands
   *  here via applyExpertContext. */
  allowedMcpServers?: string[]
  /** Skill whitelist (SkillDefinition.name). `undefined` = no restriction, an
   *  EMPTY ARRAY = no skill may be used. An expert pack's 可用技能 lands here
   *  via applyExpertContext. */
  allowedSkills?: string[]
  /** @-summoned expert config pack: composed instructions + allowed capability.
   *  Replaces the basic persona section in the system prompt (see
   *  system-prompt-builder) and narrows tools/skills/connectors. */
  expert?: ExpertRuntimeContext
  systemPromptAppendix?: string
  /** Replace the built system prompt wholesale (derived sessions such as the
   *  tool studio, whose prompt is a builder contract rather than the assistant
   *  persona). Same code path as a spawned agent's prompt — see
   *  buildSystemPrompt's spawnSystemPrompt branch. */
  systemPromptOverride?: string
  /** The browser extension's current tab (per-turn state, set by the session
   *  manager before each ask). Rendered in the prompt's dynamic Current Page
   *  section — never enters the cached prefix. */
  pageContext?: PageContext
  /** True while a browser-extension client is driving this session. The page
   *  tools exist only then (PLAN-browser-extension §3.4.4): with no client
   *  bound there is nothing to execute them, so they must not appear in the
   *  tool list at all rather than fail one call at a time. */
  hostedAvailable?: boolean
}

// ── AgentEngine Callbacks ───────────────────────────────────────────

export interface AgentEngineCallbacks {
  onMessagesChanged?: (messages: AgentMessage[]) => void
  onStatusChanged?: (status: AgentStatus) => void
  onStreamingBlocksChanged?: (blocks: ContentBlock[]) => void
  onPlanChanged?: (plan: Plan | null) => void
}

// ── AgentEngine ───────────────────────────────────────────────────────

// `implements EngineCore` keeps the class honest against the strategy
// modules' declared dependency surface (engine/engine-core.ts).
export class AgentEngine implements EngineCore {
  // ── Observable state (read by React wrapper) ────────────────────
  messages: AgentMessage[] = []
  agentStatus: AgentStatus = { status: 'idle' }
  streamingBlocks: ContentBlock[] = []

  // ── Internal state (was useRef) ─────────────────────────────────
  /** @internal */
  opts: AgentEngineOptions
  private callbacks!: AgentEngineCallbacks
  /** @internal - reachable from collaborators (SpawnManager / ExecutionFlow) */
  getHost() {
    return getHost()
  }

  /** @internal - reachable from SpawnManager collaborators */
  notify = (): void => {
    if (this.notifyTimer !== null) {
      clearTimeout(this.notifyTimer)
      this.notifyTimer = null
    }
    // Every status change funnels through here, so the turn clock follows the
    // same signal the user sees: parked on a decision → stop counting, working
    // again → count. One choke point instead of a pause()/resume() pair at each
    // of the sites that set a waiting status.
    this.turnClock.sync(isWaitingOnUserStatus(this.agentStatus.status))
    this.callbacks.onMessagesChanged?.(this.messages)
    this.callbacks.onStatusChanged?.(this.agentStatus)
    this.callbacks.onStreamingBlocksChanged?.(this.streamingBlocks)
  }

  // SSE deltas and terminal output chunks arrive far faster than the render
  // framerate; each uncoalesced notify fans out into setMessages/setStreamingBlocks
  // state updates that re-render the whole chat view. Coalesce them to ~12fps.
  private static readonly NOTIFY_COALESCE_MS = 80
  private notifyTimer: ReturnType<typeof setTimeout> | null = null

  /** Trailing-edge coalesced full notify — for in-place block mutations driven by
   *  high-frequency events (e.g. terminal output streaming into tool_use.output). */
  /** @internal */
  notifyCoalesced = (): void => {
    if (this.notifyTimer !== null) return
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null
      this.notify()
    }, AgentEngine.NOTIFY_COALESCE_MS)
  }

  /** Coalesced streaming-only notify for the SSE delta path: messages and status
   *  don't change per delta, so re-emitting them would only churn React identity. */
  /** @internal */
  notifyStreamingCoalesced = (): void => {
    if (this.notifyTimer !== null) return
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null
      this.callbacks.onStreamingBlocksChanged?.(this.streamingBlocks)
    }, AgentEngine.NOTIFY_COALESCE_MS)
  }

  /** @internal */
  abortController: AbortController | null = null
  /** @internal */
  currentAssistantBlocks: (ContentBlock | undefined)[] = []
  /** @internal */
  toolUseBlocks: ToolUseBlock[] = []
  /** @internal */
  jsonAccumulators: Map<number, IncrementalJsonTracker> = new Map()
  /** @internal */
  loopCount = 0
  /** @internal */
  maxLoopCount = MAX_LOOP_ITERATIONS
  /** @internal */
  terminalCleanups: (() => void)[] = []
  /** @internal */
  executingProcessId: string | null = null
  /** @internal */
  isCancelled = false
  /** @internal */
  requestStartTime = 0
  /** @internal — the turn's duration accumulator: user send → last output
   *  character, excluding time parked on the user (held approval / ask_user /
   *  loop-limit prompt / manual pause). See engine/turn-clock.ts. */
  turnClock = new TurnClock()
  /** Consecutive idle-timeout retries for the current stream. Reset on success. */
  /** @internal */
  streamIdleRetries = 0
  /** @internal */
  pendingToolIds = new Set<string>()
  /** @internal */
  isAutoExecuting = false
  /** @internal */
  currentRequestId: string | null = null
  /** Maps MCP tool name → MCP server ID for routing */
  /** @internal */
  mcpToolOwner = new Map<string, string>()
  /** MCP tool names selected via pick_tool — empty = none selected */
  public selectedMcpTools: string[] = []
  /** Gated built-in tool names activated via pick_tool or keyword trigger — empty = all hidden */
  public selectedBuiltinTools: string[] = []
  /** Cached history summary for the currently-dropped leading region. Keyed by the
   *  id of the first kept message after hardTruncate; reused until the frontier advances. */
  private historySummary: { firstKeptId: string; text: string } | null = null
  // Sub-agents for background LLM tasks (stateless singletons)
  private skillKeywordAgent = new SkillKeywordAgent()
  private skillSelectionAgent = new SkillSelectionAgent()
  // Spawn sub-agent state (set by startSpawnLoop)
  /** @internal */
  resolveCompletion?: (result: SubAgentResult) => void
  /** @internal */
  completionPromise?: Promise<SubAgentResult>
  /** @internal */
  spawnSystemPrompt?: string
  /** @internal Conversation-list title of a spawned sub-agent. */
  spawnTitle?: string
  private spawnSystemPromptAppendix?: string
  /** @internal */
  onSpawnProgress?: (summary: string) => void
  /** Last time onSpawnProgress fired — heartbeat updates are throttled to 800ms. */
  private _lastSpawnProgressAt = 0
  /** @internal */
  allowedToolsSet?: Set<string>
  /** @internal */
  allowedMcpServersSet?: Set<string>
  /** Active spawned sub-agents, keyed by sub-agent id */
  /** @internal */
  activeSubAgents = new Map<string, AgentEngine>()
  /** @internal Tool-use id of the spawn_agent call the last startDelegatedLoop
   *  minted. It is the ONLY call whose expert result may be delivered verbatim
   *  (the @-summon's whole point); a model-emitted spawn_agent never matches, so
   *  its result keeps going through the envelope → summarize path. Cleared at
   *  the start of every turn. */
  private delegatedToolUseId: string | null = null
  /** @internal The summoned expert's conclusion, waiting for continueLoop to
   *  append it as this turn's own assistant message. */
  private pendingVerbatimReply: string | null = null
  /** @internal Multi-expert @-summon state (plan mode). Null outside such a
   *  turn — see startPlanningLoop / buildSummonNudge. */
  summon: SummonState | null = null
  /** G5: the caller (renderer send or hosted ask) stages the @知识库 scope
   *  here BEFORE startLoop; prepareTurn consumes it into
   *  opts.knowledgeBaseScope for exactly one turn, so a later send without an
   *  @mention runs unscoped — mirrors the summon's per-turn recast. */
  stagedKnowledgeBaseScope: { id: string; name: string } | null = null
  setKnowledgeBaseScope = (scope: { id: string; name: string } | null): void => {
    this.stagedKnowledgeBaseScope = scope
  }
  // Public access to plan (delegated to PlanManager)
  get plan(): Plan | null { return this.planManager.plan }
  // Managers for extracted concerns
  /** @internal */
  planManager: PlanManager
  /** @internal */
  toolExecutor: ToolExecutor
  private spawnManager = new SpawnManager(this)
  private streamRunner = new StreamRunner(this)
  private runLlmStream = (opts: AgentEngineOptions, req: { apiUrl: string; headers: Record<string, string>; resolvedBody: unknown }): Promise<void> => this.streamRunner.run(opts, req)
  reportSpawnProgress = (msg: string, force = false): void => { this.spawnManager.reportProgress(msg, force) }
  /** @internal */
  compactor = new ContextCompactor({
    runHistorySummary: (regionText) => this.runHistorySummary(regionText),
    getMessages: () => this.messages,
  })

  /** Current history-summary cache (persisted with the conversation). */
  getHistorySummary(): { firstKeptId: string; text: string } | null {
    return this.compactor.getHistorySummary()
  }

  /** Restore the persisted history summary after rehydration. */
  seedHistorySummary(text?: string, frontierId?: string): void {
    this.compactor.seedHistorySummary(text, frontierId)
  }

  constructor(opts: AgentEngineOptions, callbacks?: AgentEngineCallbacks) {
    this.opts = opts
    this.callbacks = callbacks || {}
    if (opts.allowedTools) this.allowedToolsSet = new Set(opts.allowedTools)
    if (opts.systemPromptAppendix) this.spawnSystemPromptAppendix = opts.systemPromptAppendix
    if (opts.systemPromptOverride) this.spawnSystemPrompt = opts.systemPromptOverride
    if (opts.allowedMcpServers) this.allowedMcpServersSet = new Set(opts.allowedMcpServers)

    // Initialise the shared cache (safe to call multiple times — no-op after first).
    // Fires initial IPC calls in the background and subscribes to
    // onMcpServersChanged / onSkillsChanged for reactive updates,
    // so collectEnabledTools and system-prompt-builder never need IPC.
    ensureCache().catch(() => {})

    this.planManager = new PlanManager(
      (id, content, isError) => this.addToolResult(id, content, isError),
      () => this.notify(),
      () => this.messages,
      (plan) => {
        this.savePlan(plan)
        this.callbacks.onPlanChanged?.(plan)
      },
      // 多专家 @召唤的覆盖检查：create_plan 必须把每位被召唤的专家都派到节点上。
      // A getter (not a snapshot) because the summons belongs to the CURRENT turn.
      () => this.summon?.experts ?? [],
    )
    // "The plan tooling has been used" is only true once a plan EXISTS: an
    // advance_plan that errors with "No active plan" still reaches
    // notifyPlanChange (updates persist and notify unconditionally), and
    // letting that retire the nudge would leave a multi-expert summons with no
    // plan at all — the very turn the nudge exists to correct.
    // M3 (review 2026-09-18): `engaged` means "a plan was created FOR THIS
    // summons" — not "some plan exists". planManager.plan survives across
    // turns, so an advance_plan erroring against the PREVIOUS turn's plan
    // (notifyPlanChange fires even from the catch) or a spawn mapped onto it
    // used to retire the nudge while the summoned experts never got a node.
    // Only a plan that is not the one this turn started with may engage.
    this.planManager.onMutated = () => {
      if (!this.summon || !this.planManager.plan) return
      if (this.planManager.plan !== (this.summon.planAtStart ?? null)) this.summon.engaged = true
    }

    this.toolExecutor = new ToolExecutor(
      opts,
      this.mcpToolOwner,
      this.skillKeywordAgent,
      this.skillSelectionAgent,
      (id, content, isError, imageData) => this.addToolResult(id, content, isError, imageData),
      () => this.notify(),
      (pid) => { this.executingProcessId = pid },
      (config) => this.spawnSubAgent(config),
      () => this.planManager.plan,
      (ref, subConvId) => this.planManager.linkNodeSession(ref, subConvId),
      (toolUseId, text) => this.deliverExpertConclusion(toolUseId, text),
      (ref, attemptId) => this.planManager.beginNodeExecution(ref, attemptId),
      (ref, attemptId, status, subConvId) => this.planManager.updateNodeExecution(ref, attemptId, status, subConvId),
    )
  }

  /** Persist plan changes to DB whenever PlanManager mutates the plan. */
  private savePlan = async (plan: Plan | null): Promise<void> => {
    if (!this.opts.conversationId) return
    try {
      await getHost().saveConversationPlan(this.opts.conversationId, plan ? JSON.stringify(plan) : null)
    } catch (err) {
      console.warn('[AgentEngine] Failed to save plan:', err)
    }
  }

  /** Load a persisted plan from DB for an existing conversation. Plans written
   *  before the DAG refactor carry no `version` — migrate them on the way in. */
  async loadPlan(conversationId: string): Promise<void> {
    try {
      const json = await getHost().getConversationPlan(conversationId)
      if (json) {
        const parsed = JSON.parse(json) as Plan | null
        this.planManager.plan = parsed?.version === 2 ? parsed : migrateLinearPlan(parsed)
        if (this.planManager.plan) this.callbacks.onPlanChanged?.(this.planManager.plan)
      }
    } catch (err) {
      console.warn('[AgentEngine] Failed to load plan:', err)
    }
  }

  /** Update options (called from React when deps change) */
  updateOptions(opts: AgentEngineOptions): void {
    const oldModel = this.opts.model
    const newModel = opts.model
    console.log(`[AgentEngine] updateOptions: ${oldModel} -> ${newModel}`, {
      apiKey: opts.apiKey ? `${opts.apiKey.slice(0, 8)}...` : null,
      baseURL: opts.baseURL,
      model: opts.model,
      provider: opts.adapter.constructor.name
    })
    this.opts = opts
    this.toolExecutor.updateOptions(opts)
  }

  /** Swap the @-summoned expert config pack at runtime. Expert state lives on
   *  opts (single source of truth for the prompt builder and for the tool
   *  collection, which reads the allowed* whitelists); the pack's 可用技能 /
   *  可用连接器 narrow the session's skill and connector sets while it is
   *  bound, and unbinding restores the unrestricted session. There is no prompt
   *  cache to invalidate: the prompt is rebuilt on every request and the expert
   *  is part of its invariant core, so the next loop picks up the new role by
   *  construction. Called by session-manager before each ask — cheap no-op when
   *  nothing moved. */
  applyExpertContext(next: ExpertRuntimeContext | null): void {
    const expertChanged = JSON.stringify(this.opts.expert ?? null) !== JSON.stringify(next ?? null)
    if (!expertChanged) return

    this.opts.expert = next ?? undefined
    // 白名单原样透传：数组（含空数组）= 只允许这些，undefined = 不限制。
    // 空数组绝不能塌成 undefined——那会把「一个都不许用」退化成「全都可用」。
    this.opts.allowedSkills = next?.allowedSkills
    this.opts.allowedMcpServers = next?.allowedMcpServers
    this.allowedMcpServersSet = this.opts.allowedMcpServers ? new Set(this.opts.allowedMcpServers) : undefined
    console.log(`[AgentEngine] expert context ${next ? `→ ${next.id}` : 'cleared'}`)
  }

  /** Dispose — cleanup all listeners and sub-agents */
  dispose(): void {
    this.isCancelled = true
    this.abortController?.abort()
    this.cleanupTerminalListeners()
    if (this.currentRequestId) {
      getHost().apiAbortStream(this.currentRequestId)
      this.currentRequestId = null
    }
    this.executionFlow.settleSubAgentTree(this)
    releaseQueuedSubAgents(subAgentBudgetKey(this.opts))
    this.resolveCompletionIfSpawned('aborted')
    this.planManager.plan = null
  }

  // ── Core methods ──────────────────────────────────────────────────

  /** Shared turn preamble (startLoop / startDelegatedLoop): gate on the key,
   *  run the beforeSession hook (it may rewrite or cancel the text), cancel any
   *  in-flight request, append the user message and start the clock. Returns
   *  the text to run — the hook may have rewritten it — or null when the turn
   *  was cancelled before anything was appended. */
  private prepareTurn = async (userMessage: string): Promise<string | null> => {
    if (!userMessage.trim()) return null
    const opts = this.opts
    if (!opts.apiKey) {
      console.warn('[AgentEngine] startLoop blocked: no API key')
      this.agentStatus = { status: 'error', error: 'API key not configured' }
      this.notify()
      return null
    }

    const beforeSessionCtx = await safeInvoke(opts.hooks?.beforeSession, { userMessage, messages: this.messages }, 'beforeSession')
    userMessage = beforeSessionCtx.userMessage
    if (!userMessage.trim()) return null

    this.loopCount = 0
    this.maxLoopCount = MAX_LOOP_ITERATIONS
    this.isCancelled = false
    this.pendingToolIds = new Set()
    // Per-turn @-summon state belongs to the turn that opened it: a new send
    // starts with no delegated call to close verbatim and no summons to honor.
    this.delegatedToolUseId = null
    this.pendingVerbatimReply = null
    this.summon = null
    // The staged @知识库 scope belongs to the turn the caller is about to
    // open; an explicit null (no mention this send) unscopes too.
    this.opts.knowledgeBaseScope = this.stagedKnowledgeBaseScope
    this.stagedKnowledgeBaseScope = null
    // Cancel any in-flight request so two don't write to this.messages concurrently
    this.abortController?.abort()
    if (this.currentRequestId) {
      getHost().apiAbortStream(this.currentRequestId)
      this.currentRequestId = null
    }
    this.cleanupTerminalListeners()

    const userMsg: AgentMessage = {
      id: generateMsgId(),
      role: 'user',
      contentBlocks: [{ type: 'text', text: userMessage }],
      createdAt: new Date().toISOString()
    }
    this.messages = [...this.messages, userMsg]
    this.agentStatus = { status: 'streaming' }
    this.notify()

    this.turnClock.start()
    opts.adapter.reconcileMessages?.(this.messages)
    return userMessage
  }

  startLoop = async (userMessage: string): Promise<void> => {
    const text = await this.prepareTurn(userMessage)
    if (text === null) return
    console.log(`[AgentEngine] startLoop: model=${this.opts.model}`)
    await this.continueLoop()
  }

  /**
   * @-summon delegation (召唤专家 → spawn_agent): the mentioned expert runs the
   * task as a sub-agent instead of the conversation re-binding its identity.
   * The user's message is followed by a deterministic spawn_agent tool_use
   * block — byte-for-byte the shape a model-emitted delegation carries — and
   * dispatched through handleToolUseResponse, so every piece of the spawn
   * machinery applies unchanged: the parallel-slot limiter, live progress
   * lines, the sub-conversation link on the card, and stop/pause handling.
   * The expert's conclusion is NOT re-summarized: `delegatedToolUseId` names
   * this call, so execSpawnAgent's delivery reaches continueLoop's verbatim
   * close and the expert's own text becomes the assistant message
   * (用户裁定 2026-09-17:「能不能在主对话中直接输出专家的结论」). On failure the
   * normal envelope → parent path still applies, because a failure report is
   * what the user needs there, not raw partial output.
   */
  startDelegatedLoop = async (userMessage: string, subAgentId: string): Promise<void> => {
    // Guard BEFORE prepareTurn: a delegation without an expert id is a caller
    // bug, and aborting after it would strand an appended user message.
    if (!subAgentId.trim()) return
    const text = await this.prepareTurn(userMessage)
    if (text === null) return
    console.log(`[AgentEngine] startDelegatedLoop: model=${this.opts.model} → spawn_agent ${subAgentId}`)
    const spawnCall: ToolUseBlock = {
      id: `toolu_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      type: 'tool_use',
      name: 'spawn_agent',
      input: { subAgentId, task: text },
      status: 'pending'
    }
    this.delegatedToolUseId = spawnCall.id
    this.messages = [...this.messages, {
      id: generateMsgId(),
      role: 'assistant',
      contentBlocks: [spawnCall],
      createdAt: new Date().toISOString()
    }]
    this.agentStatus = { status: 'executing', toolUseId: spawnCall.id }
    this.notify()
    await this.handleToolUseResponse([spawnCall])
  }

  /**
   * 多专家 @召唤 → 计划模式（用户裁定 2026-09-17:「当@多个专家，能不能进入plan模式，
   * 为多个专家分配任务」）。The turn opens like any other (the mentions are already
   * stripped, the user's own assignment words survive), and the summons rides
   * the per-turn state block as a brief that makes the plan the turn's shape:
   * create_plan with every summoned expert assigned, dispatch the READY set in
   * one parallel batch, settle with advance_plan, synthesize at the end.
   * Two mechanisms make it binding rather than advisory: create_plan refuses a
   * plan that leaves a summoned expert unassigned, and a turn that ends without
   * a plan is re-issued once (execution-flow's nudge). The engine still plans
   * with the model's own rounds — it never writes the DAG itself — because the
   * split into nodes is exactly the judgement the experts' tasks depend on.
   */
  startPlanningLoop = async (userMessage: string, experts: readonly SummonedExpert[]): Promise<void> => {
    const roster = normalizeSummonedExperts(experts)
    // Guard BEFORE prepareTurn, like startDelegatedLoop: a summons with no
    // expert is a caller bug, and bailing after it would strand the message.
    if (roster.length === 0) return
    // One expert is the delegation path — routed here rather than left to the
    // caller so the two entry points cannot disagree about a one-name roster.
    if (roster.length === 1) return this.startDelegatedLoop(userMessage, roster[0].id)
    const text = await this.prepareTurn(userMessage)
    if (text === null) return
    this.summon = { experts: roster, nudged: false, engaged: false, planAtStart: this.planManager.plan }
    console.log(`[AgentEngine] startPlanningLoop: model=${this.opts.model} → plan mode for ${roster.map((e) => e.id).join(', ')}`)
    await this.continueLoop()
  }

  /**
   * @internal 单专家 @召唤的结论原文交付 — called by execSpawnAgent with the
   * finished expert's text. Accepted only when the id is the delegation THIS
   * engine dispatched: a model-emitted spawn_agent (or any other turn) gets a
   * `false` back and keeps the ordinary result envelope. Accepted text is
   * appended by continueLoop as the turn's own assistant message, so no second
   * LLM round touches it — that round is precisely the information loss the
   * user reported.
   */
  private deliverExpertConclusion = (toolUseId: string, text: string): boolean => {
    if (!this.delegatedToolUseId || toolUseId !== this.delegatedToolUseId) return false
    if (!text.trim()) return false
    this.pendingVerbatimReply = text
    return true
  }

  /**
   * @internal One corrective re-issue for a multi-expert @召唤 whose turn ended
   * without a plan (the model answered in its own words instead of planning).
   * Returns true when the caller must NOT close the turn: an engine-held turn
   * that is about to be re-issued. Bounded to a single nudge — `nudged` is set
   * here, so the second turn end closes normally even if the model ignores
   * both the brief and the correction. Fired from ExecutionFlow's turn end, so
   * the turn's own bookkeeping (clock, status) stays with the one place that
   * owns it.
   */
  nudgeSummonIfUnplanned = (): boolean => {
    const summon = this.summon
    if (!summon || summon.nudged || summon.engaged || this.isCancelled) return false
    summon.nudged = true
    console.log(`[AgentEngine] summons unanswered — re-issuing the turn once (${summon.experts.map((e) => e.id).join(', ')})`)
    setTimeout(() => { void this.continueLoop() }, 0)
    return true
  }

  // stopReason dispatch delegation (ExecutionFlow, split 8)
  async handleToolUseResponse(toolUses: ToolUseBlock[]): Promise<void> { return this.executionFlow.handleToolUseResponse(toolUses) }
  async handleMaxTokensResponse(toolUses: ToolUseBlock[]): Promise<void> { return this.executionFlow.handleMaxTokensResponse(toolUses) }
  handleEndTurnResponse(stopReason: string | null): void { this.executionFlow.handleEndTurnResponse(stopReason) }

  /** @internal - driven by SpawnManager for spawned engines */
  continueLoop = async (): Promise<void> => {
    const opts = this.opts
    // A cancelled engine must not be revived by a LATE tool result (a slow MCP
    // call or shell exit landing after stopExecution/pauseExecution):
    // addToolResult calls back into here when its pending set empties, and
    // without this guard one straggler re-issues an LLM request after the user
    // pressed stop. Explicit resumes (resumeExecution / retryLastTurn) reset
    // isCancelled first, so they pass.
    if (this.isCancelled) return
    if (!opts.apiKey) {
      this.agentStatus = { status: 'error', error: 'API key not configured' }
      this.notify()
      return
    }

    // 单专家 @召唤的收尾：专家自己的结论就是这一轮的答复。Appending it as the
    // assistant message and ending the turn IS the summon — one more LLM round
    // could only re-summarize it, which is the information loss the user
    // reported. It runs before the loop-count check on purpose: no request is
    // issued, so nothing is consumed from the loop budget.
    if (this.pendingVerbatimReply !== null) {
      const text = this.pendingVerbatimReply
      this.pendingVerbatimReply = null
      this.messages = [...this.messages, {
        id: generateMsgId(),
        role: 'assistant',
        contentBlocks: [{ type: 'text', text }],
        createdAt: new Date().toISOString()
      }]
      this.notify()
      this.handleEndTurnResponse(null)
      return
    }

    // Reconcile orphaned tool_use blocks (interrupted tool executions) before
    // EVERY request. resumeExecution / stream-idle retry / sub-agent loops jump
    // straight here, bypassing startLoop's reconciliation. Without this, a
    // sleep/resume interrupt leaves an unpaired assistant tool_calls message
    // that OpenAI rejects with "insufficient tool messages following tool_calls".
    opts.adapter.reconcileMessages?.(this.messages)

    this.loopCount += 1
    if (this.loopCount > this.maxLoopCount) {
      if (this.spawnSystemPrompt) {
        // A spawned expert that reaches its own loop limit errors out and
        // SETTLES its completion (PLAN-parallel-experts T8, L12). The silent
        // `+50` renewal was the main agent's self-extend semantics; on an
        // unattended expert it means a stuck one burns tokens forever, the
        // parent's `await spawnBatch` never returns, and — with the FIFO slot
        // queue — one never-ending expert wedges the whole session's queue.
        this.agentStatus = { status: 'error', error: `Sub-agent reached its loop limit (${this.maxLoopCount} rounds) without completing the task.` }
        this.notify()
        this.resolveCompletionIfSpawned('error')
        return
      }
      this.agentStatus = { status: 'awaiting_extension', currentCount: this.loopCount - 1, limit: this.maxLoopCount }
      this.notify()
      return
    }

    this.requestStartTime = performance.now()
    try {
      const req = await this.prepareLoopRequest(opts)
      await this.runLlmStream(opts, req)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      console.error('[AgentEngine] loop request failed:', message)
      this.agentStatus = { status: 'error', error: message }
      this.notify()
      safeInvokeObserver(opts.hooks?.afterLlmCall, { messages: this.messages, stopReason: null, status: { status: 'error', error: message } }, 'afterLlmCall')
      safeInvokeObserver(opts.hooks?.afterSession, { messages: this.messages, status: { status: 'error', error: message } }, 'afterSession')
      this.resolveCompletionIfSpawned('error')
    }
  }

  /**
   * Build the loop's LLM request: system prompt, tool schemas, compaction
   * pipeline and hook processing. Returns transport-ready request parts.
   */
  private prepareLoopRequest = async (opts: AgentEngineOptions): Promise<{
    apiUrl: string
    headers: Record<string, string>
    resolvedBody: unknown
  }> => {
    const toolManager = opts.toolManager

    // ── Tools (before the prompt: the protocols section is built from the SAME
    // final toolset that ships as schemas, so the prompt never describes a tool
    // the request does not carry) ──────────────────────────────────────────
    const enabledTools = await collectEnabledTools(this, toolManager)
    const toolProtocols = buildToolProtocols(enabledTools)

    // ── Build the prompt: invariant core + per-turn state ─────────
    // The split is a prefix-cache contract, not a formatting choice. DeepSeek
    // matches a prompt prefix from token 0 and renders `system → tools →
    // messages`, so the system prompt sits in front of the tool schemas AND the
    // whole conversation: one volatile byte there (a timestamp, a memory, git
    // status) re-bills everything behind it. The core therefore carries only
    // invariants, and every value that moves per turn rides `stateBlock`, which
    // is sent as the FINAL message — the one position where a change costs only
    // itself. Measured on deepseek-flash: marking a tool description drops the
    // hit from 1280 to 384; marking the system message drops it to 0.
    const spResult = await buildSystemPrompt({
      opts,
      spawnSystemPrompt: this.spawnSystemPrompt,
      spawnSystemPromptAppendix: this.spawnSystemPromptAppendix,
      messages: this.messages,
      plan: this.planManager.plan,
      summon: this.summon,
      toolProtocols,
    })
    const systemPrompt = spResult.systemPrompt
    // The state block is rebuilt per request (never persisted, never rendered) so
    // memory saved this turn is visible on the next call instead of waiting for a
    // cache TTL — and, because it is not part of `messages`, the append-only
    // history keeps its bytes.
    const stateBlock: AgentMessage | null = spResult.stateBlock
      ? {
          id: generateMsgId(),
          role: 'user',
          contentBlocks: [{ type: 'text', text: spResult.stateBlock }],
          createdAt: new Date().toISOString(),
        }
      : null

    // ── Persist tool_results for tool_result_search ──────────────
    if (this.opts.conversationId) {
      await persistUnsavedToolResults(this)
    }

    // ── Background memory extraction (fire-and-forget, doesn't block request) ──
    scheduleMemoryExtraction(this)

    // Strip image data from tool_results before sending to LLM (keep originals for UI)
    const stripToolResultImages = (msg: AgentMessage): AgentMessage => {
      if (msg.role !== 'user') return msg
      const blocks = msg.contentBlocks
      if (!blocks || !blocks.some(b => b.type === 'tool_result')) return msg
      const newBlocks = blocks.map(b => {
        if (b.type !== 'tool_result') return b
        const tb = b as ToolResultBlock
        let content = tb.content || ''
        try {
          const parsed = JSON.parse(content)
          content = JSON.stringify(stripImageData(parsed))
        } catch {
          content = stripImageData(content) as string
        }
        return { ...tb, content }
      })
      return { ...msg, contentBlocks: newBlocks }
    }

    const apiMessages = this.messages.map(stripToolResultImages)

    // ── Compaction pipeline (operates on API copy; this.messages untouched) ──
    // Fixed overhead the char heuristic never sees: system prompt + tool schemas.
    // Injected into the fallback estimate so compaction still fires at the right
    // pressure point before the first API token report arrives.
    const fixedOverhead = estimateTokens(systemPrompt) + estimateTokens(JSON.stringify(enabledTools)) + (spResult.stateBlock ? estimateTokens(spResult.stateBlock) : 0)
    const nanoCompacted = this.compactor.nanoCompact(apiMessages)
    const lightCompacted = this.compactor.lightCompact(nanoCompacted, opts.contextLength || 128000, fixedOverhead)
    const truncatedMessages = this.compactor.hardTruncate(lightCompacted, opts.contextLength || 128000, fixedOverhead)
    // After truncation, inject an LLM summary of the dropped region into the API
    // copy so the model keeps the gist. Synthetic message never leaves this scope.
    // Pass the PRE-compaction copy as the summarizer source: nanoCompact has
    // already replaced old tool_results with [tool_result_id:] placeholders, so
    // summarizing lightCompacted would hide what the tools actually returned
    // (incl. failures) and let the summary fabricate outcomes.
    const finalMessages = await this.compactor.injectHistorySummary(apiMessages, lightCompacted, truncatedMessages)

    // The state block is appended AFTER compaction: it is per-turn context, not
    // history — it must never be summarized, truncated or moved off the end.
    const requestMessages: AgentMessage[] = stateBlock ? [...finalMessages, stateBlock] : finalMessages

    const { url: apiUrl, headers, body } = opts.adapter.buildRequest(opts.baseURL, opts.apiKey ?? '', {
      model: opts.model,
      maxTokens: Math.floor(opts.maxTokens * 1.5),
      messages: requestMessages,
      tools: enabledTools,
      systemPrompt,
      stream: true
    })

    // Log request payload for debugging (full detail for spawned/canvas agents)
    if (this.spawnSystemPrompt) {
      console.log('=== [CanvasEngine] FULL SYSTEM PROMPT ===')
      console.log(systemPrompt)
      console.log('=== [CanvasEngine] API MESSAGES ===')
      console.log(JSON.stringify(apiMessages, null, 2))
      console.log('=== [CanvasEngine] TOOLS ===')
      console.log(enabledTools.map(t => t.name))
    }
    // Summary only — the full payload is dumped from the main process (see
    // `main/llm/request-dump.ts`), which has the post-hook bytes and a disk to
    // write them to. `prefix` is the fingerprint of what precedes the
    // conversation: two turns with the same one share a cacheable prefix.
    console.log('[LLM Request] model:', opts.model, 'messages:', requestMessages.length, 'tools:', enabledTools?.length ?? 0, 'sysPromptLen:', systemPrompt?.length ?? 0, 'prefix:', prefixFingerprint(systemPrompt, enabledTools), 'stateLen:', spResult.stateBlock?.length ?? 0, 'bodyLen:', JSON.stringify(body).length)

    const controller = new AbortController()
    this.abortController = controller
    this.isCancelled = false

    this.currentAssistantBlocks = []
    this.streamingBlocks = []
    this.toolUseBlocks = []
    this.jsonAccumulators = new Map()
    this.agentStatus = { status: 'streaming' }
    this.notify()

//    console.log('[AgentEngine] POST', apiUrl, { model: opts.model, max_tokens: opts.maxTokens, msgCount: this.messages.length, tools: enabledTools.map(t => t.name), provider: opts.adapter.provider })

    // beforeLlmCall hook (skip for spawned agents)
    let resolvedBody = body
    if (!this.spawnSystemPrompt) {
      const beforeLlmCallCtx = await safeInvoke(opts.hooks?.beforeLlmCall, { body, messages: this.messages }, 'beforeLlmCall')
      resolvedBody = beforeLlmCallCtx.body
    }

    return { apiUrl, headers, resolvedBody }
  }

  // ── Tool building ────────────────────────────────────────────────────

  // ── Public methods ──────────────────────────────────────────────────

  cancelLoop = (): void => {
    this.isCancelled = true
    this.abortController?.abort()
    if (this.currentRequestId) { getHost().apiAbortStream(this.currentRequestId); this.currentRequestId = null }
    this.cleanupTerminalListeners()
    if (this.executingProcessId) { getHost().killCommand(this.executingProcessId); this.executingProcessId = null }

    // Pause all active sub-agents (stop streams but keep data + unresolved promises)
    for (const subEngine of this.activeSubAgents.values()) {
      subEngine.pauseExecution()
    }

    // Enter pause state — user decides whether to resume or fully stop
    this.agentStatus = {
      status: 'awaiting_continue',
      ...(this.activeSubAgents.size > 0 ? { subAgentCount: this.activeSubAgents.size } : {})
    }
    this.streamingBlocks = []
    this.pendingToolIds = new Set()
    this.notify()
  }

  clearError = (): void => {
    this.agentStatus = { status: 'idle' }
    this.notify()
  }

  // ── Tool execution lifecycle delegation (ExecutionFlow, split 4/5) ──
  private executionFlow = new ExecutionFlow(this)
  approveTool = async (toolUseId: string): Promise<void> => this.executionFlow.approveTool(toolUseId)
  rejectTool = (toolUseId: string): void => this.executionFlow.rejectTool(toolUseId)
  killTool = (toolUseId: string): void => this.executionFlow.killTool(toolUseId)
  pauseExecution = (): void => this.executionFlow.pauseExecution()
  resumeExecution = (): void => this.executionFlow.resumeExecution()
  stopExecution = (): void => this.executionFlow.stopExecution()

  // Sub-agent delegation (SpawnManager, split 3/5)
  // NOTE: the parallel-expert slot is held by the DISPATCHER (executors/spawn-tool.ts
  // takes one and holds it across `waitForCompletion`), not here — calling this
  // directly would spawn an expert outside the session's three-slot budget.
  // `spawn-tool` is currently the only production caller.
  spawnSubAgent = (config: SpawnSubAgentConfig): SubAgentHandle => this.spawnManager.spawnSubAgent(config)
  startSpawnLoop = (config: SpawnSubAgentConfig): void => this.spawnManager.startSpawnLoop(config)
  resolveCompletionIfSpawned = (status: SubAgentResult['status']): void => this.spawnManager.resolveCompletionIfSpawned(status)

  /** Re-run the current turn after an error. this.messages already ends with the
   *  triggering user message (no assistant message was committed on failure), so a
   *  fresh continueLoop() re-issues the request without duplicating input. */
  retryLastTurn = async (): Promise<void> => {
    const opts = this.opts
    if (!opts.apiKey || this.messages.length === 0) return

    this.isCancelled = false
    this.pendingToolIds = new Set()
    this.streamIdleRetries = 0
    this.abortController?.abort()
    if (this.currentRequestId) {
      getHost().apiAbortStream(this.currentRequestId)
      this.currentRequestId = null
    }
    this.currentAssistantBlocks = []
    this.streamingBlocks = []
    this.jsonAccumulators = new Map()
    this.toolUseBlocks = []
    this.agentStatus = { status: 'streaming' }
    this.notify()
    // The retried turn gets its own clock: the failed attempt's time is not part
    // of the answer the user ends up reading.
    this.turnClock.start()
    opts.adapter.reconcileMessages?.(this.messages)
    await this.continueLoop()
  }

  reset = (): void => {
    this.cancelLoop()
    this.stopExecution()
    this.messages = []
    this.loopCount = 0
    this.maxLoopCount = MAX_LOOP_ITERATIONS
    this.isCancelled = false
    this.pendingToolIds = new Set()
    this.historySummary = null
    this.notify()
  }

  loadConversation = (msgs: AgentMessage[]): void => {
    this.cancelLoop()
    this.stopExecution()
    this.messages = msgs
    this.loopCount = 0
    this.maxLoopCount = MAX_LOOP_ITERATIONS
    this.streamingBlocks = []
    this.notify()
  }

  extendLoop = (): void => {
    this.maxLoopCount += MAX_LOOP_ITERATIONS
    this.loopCount = 0
    this.agentStatus = { status: 'idle' }
    this.notify()
    setTimeout(() => this.continueLoop(), 0)
  }

  /** The user responded to an ask_user prompt */
  respondToTool = (toolUseId: string, response: string): void => {
    this.messages = this.messages.map(msg => {
      const idx = msg.contentBlocks.findIndex(b => b.type === 'tool_use' && b.id === toolUseId)
      if (idx === -1) return msg
      const block = msg.contentBlocks[idx] as ToolUseBlock
      const updatedBlock: ToolUseBlock = {
        ...block,
        status: 'completed',
        exitCode: response === 'CANCELLED' ? 1 : 0,
        output: response
      }
      const newBlocks = [...msg.contentBlocks]
      newBlocks[idx] = updatedBlock
      return { ...msg, contentBlocks: newBlocks } as AgentMessage
    })
    this.notify()
    this.addToolResult(toolUseId, response, response === 'CANCELLED')
  }

  // ── Spawn sub-agent ──────────────────────────────────────────────────

  // ── Private helpers ──────────────────────────────────────────────────

  /** @internal */
  addToolResult = (toolUseId: string, content: string, isError: boolean, imageData?: string, maxTokens?: number): void => {
    // Global guardrail (see MAX_TOOL_RESULT_TOKENS above): errors are kept whole,
    // anything else over the token budget is head+tail truncated and the full text
    // is offloaded to ~/.pulsemind/tmp/trunc/ for the model to `read` back. The length
    // short-circuit skips estimation when even worst-case (all CJK) fits the budget.
    // `maxTokens` overrides the default — the read tool passes Infinity to bypass
    // the guardrail entirely (reading a file IS the task, so results always land
    // in full; nothing is offloaded for it).
    const budget = maxTokens ?? MAX_TOOL_RESULT_TOKENS
    let text = content
    if (!isError && text.length > budget) {
      const estTokens = estimateTokens(text)
      if (estTokens > budget) {
        const perChar = estTokens / text.length
        const head = Math.floor((budget * 0.75) / perChar)
        const tail = Math.floor((budget * 0.25) / perChar)
        const hidden = text.length - head - tail
        const dest = `~/.pulsemind/tmp/trunc/trunc_${toolUseId.slice(0, 8)}_${Date.now()}.txt`
        getHost().writeFile({ filePath: dest, content: text }).catch(() => {})
        text = `${text.slice(0, head)}\n\n… [Tool result truncated: ~${estTokens.toLocaleString()} tokens, ${hidden.toLocaleString()} chars omitted — full text saved at ${dest}, use \`read\` to page through it] …\n\n${text.slice(-tail)}`
      }
    }

    // Guard against duplicate
    for (const msg of this.messages) {
      if (msg.role !== 'user') continue
      if (msg.contentBlocks.some(b => b.type === 'tool_result' && b.tool_use_id === toolUseId)) {
        console.warn(`[AgentEngine] Duplicate tool_result skipped for ${toolUseId}`)
        this.pendingToolIds.delete(toolUseId)
        if (this.pendingToolIds.size === 0 && !this.isAutoExecuting) this.continueLoop()
        return
      }
    }

    // Auto-mark tool_use as completed — ensures React.memo re-renders ExecutionSegment
    // with the correct status, since addToolResult creates a new messages reference
    // that includes the updated block status.
    for (const msg1 of this.messages) {
      for (const block1 of msg1.contentBlocks) {
        if (block1.type === 'tool_use' && block1.id === toolUseId && block1.status === 'running') {
          block1.status = 'completed'
        }
      }
    }

    const msgs = this.messages
    const lastMsg = msgs[msgs.length - 1]
    const secondLast = msgs.length >= 2 ? msgs[msgs.length - 2] : null
    const isToolResultCollector = secondLast?.role === 'assistant' && secondLast.contentBlocks.some(b => b.type === 'tool_use') && lastMsg?.role === 'user'

    const resultBlock: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: text,
      is_error: isError,
      tool_result_id: crypto.randomUUID(),
      ...(imageData ? { imageData } as { imageData: string } : {})
    }

    if (isToolResultCollector) {
      (lastMsg as AgentMessage).contentBlocks = [...lastMsg.contentBlocks, resultBlock]
      this.messages = [...msgs]
    } else {
      const resultMsg: AgentMessage = {
        id: generateMsgId(),
        role: 'user',
        contentBlocks: [resultBlock],
        createdAt: new Date().toISOString()
      }
      this.messages = [...msgs, resultMsg]
    }
    this.notify()

    // Auto-set tool_use block output for CommandCard display (skip exec — already has terminal output)
    const afterToolName = (() => {
      for (const msg of this.messages) { for (const b of msg.contentBlocks) { if (b.type === 'tool_use' && b.id === toolUseId) return b.name } }
      return 'unknown'
    })()
    safeInvokeObserver(this.opts.hooks?.afterTool, { toolUseId, toolName: afterToolName, content: text, isError }, 'afterTool')

    // Auto-set tool_use block output for CommandCard display (skip exec — already has terminal output from IPC)
    if (afterToolName !== 'exec') {
      for (const msg of this.messages) {
        for (const b of msg.contentBlocks) {
          if (b.type === 'tool_use' && b.id === toolUseId) {
            ;(b as ToolUseBlock).output = text.slice(0, UI_PREVIEW_MAX)
          }
        }
      }
    }

    this.pendingToolIds.delete(toolUseId)
    if (this.pendingToolIds.size === 0 && !this.isAutoExecuting) this.continueLoop()
    else if (this.pendingToolIds.size > 0) {
      const remaining = this.toolUseBlocks.filter(t => this.pendingToolIds.has(t.id))
      this.agentStatus = { status: 'awaiting_approval', tools: remaining }
      this.notify()
    }
  }

  // ── Compaction remaining-window floors ─────────────────────────────────
  // Compaction triggers on remaining window (contextLength - used). On small
  // model windows the percentage floor (10%/30%) collapses to tiny headroom,
  private static readonly LIGHT_COMPACT_MIN_REMAINING = 30_000

  // ── Tool result persistence (for tool_result_search) ──────────────────

  /**
   * Persist all unsaved tool_results to the tool_results table.
   * Saves original content before nanoCompact replaces it with placeholders in the API copy.

  // ── Compaction pipeline ──────────────────────────────────────────────
  //
  // Two-layer strategy (all operate on API copies; this.messages untouched):
  //
  //   Layer 1: nanoCompact — tiered tool_result content replacement (API copy)
  //   Layer 2: lightCompact — structured removal of complete tool cycles (API copy)
  //   Layer 3: hardTruncate — drop oldest messages (API copy, last resort)
  //
  // Background memory extraction replaces the old autoCompact mechanism —
  // saves memories from old tool pairs instead of modifying messages.

  /** @internal - also driven by ExecutionFlow */
  cleanupTerminalListeners(): void {
    for (const unsub of this.terminalCleanups) unsub()
    this.terminalCleanups = []
  }

  /** Run the HistorySummaryAgent non-streaming. Returns '' on LLM failure/empty. */
  private async runHistorySummary(regionText: string): Promise<string> {
    const summaryAgent = new HistorySummaryAgent()
    try {
      return await summaryAgent.execute(
        { regionText, locale: this.opts.locale },
        {
          llmConfig: {
            adapter: this.opts.adapter,
            apiKey: this.opts.apiKey || '',
            baseURL: this.opts.baseURL,
            model: this.opts.model
          },
          maxTokens: 500
        }
      )
    } catch (err) {
      console.warn('[AgentEngine] history summary failed, using plain truncation:', err)
      return ''
    }
  }


  // ── Background memory extraction (replaces old autoCompact) ──────────

  /** Prevents concurrent memory extraction runs */
  /** @internal */
  _memExtractionInProgress = false
  /** Cooldown timestamp for memory extraction */
  /** @internal */
  _lastMemExtractionTime = 0
}
