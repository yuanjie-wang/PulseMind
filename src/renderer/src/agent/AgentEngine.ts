import { getHost } from './host'
import { IncrementalJsonTracker } from './json-stream'
import type {
  AgentMessage,
  AgentStatus,
  ContentBlock,
  SteerOutcome,
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
import { safeInvoke, safeInvokeObserver, getLoopIterationLimit, generateMsgId, type SubAgentResult, type SpawnSubAgentConfig, type SubAgentHandle } from './agent-utils'
import { buildSystemPrompt } from './system-prompt-builder'
import type { ExpertRuntimeContext } from '../../../shared/types/expert'
import { normalizeSummonedExperts, type SummonState, type SummonedExpert } from '../../../shared/expert-context'
import type { SandboxApprovalMode } from '../../../shared/sandbox/policy'
import type { PageContext } from '../../../shared/agent-protocol'
import { PlanManager } from './plan-manager'
import { migrateLinearPlan } from '../../../shared/plan/graph'
import { ensureCache } from './mcp-cache'
import { ToolExecutor, UI_PREVIEW_MAX } from './tool-executors'
import type { CompactToolRequest, CompactToolOutcome } from './executors/context'
import { SpawnManager } from './engine/spawn-manager'
import { collectEnabledTools, buildToolProtocols } from './engine/tool-collection'
import { runTurnEndMemoryExtraction, persistUnsavedToolResults } from './engine/memory-extraction'
import { ExecutionFlow } from './engine/execution-flow'
import { PlanScheduler } from './engine/plan-scheduler'
import { StreamRunner } from './engine/stream-runner'
import { TurnClock, isWaitingOnUserStatus } from './engine/turn-clock'
import { releaseQueuedSubAgents, subAgentBudgetKey } from './engine/subagent-limiter'
import { ContextCompactor, POST_TURN_COMPACT_USED_RATIO, evaluateRefillBreaker, makeCompactTracking, REFILL_TOOL_TURN_THRESHOLD, NANO_TIER3_NAMES, NANO_PROTECTION_WINDOW, type CompactTracking } from './engine/context-compactor'
import { MAX_TOOL_RESULT_TOKENS, MAX_USER_INPUT_CHARS } from './engine/engine-constants'
import { estimateTextTokens as estimateTokens, contextTokensOf } from './engine/context-estimate'
import { applyToolResultBudget } from './engine/result-ingestion'
import type { CompactionEvent } from '../../../shared/agent-protocol/payloads'
import type { EngineCore } from './engine/engine-core'
import { stripToolResultImages } from './strip-tool-results'
import { regroupToolResults } from '../llm/regroup-tool-results'

// ── Tool-result guardrail ─────────────────────────────────────────────
// Every tool result funnels through addToolResult; executors do NOT truncate
// on their own. This single cap is the one backstop: results over the token
// budget are head+tail truncated for context, and the full text is offloaded
// to ~/.pulsemind/tmp/trunc/ so the model can `read` it back. The budget is in
// estimated tokens because the context window is counted in tokens — a fixed
// char cap would be far too generous for CJK-heavy output (30K chars ≈ 7.5K
// tokens in English but ≈ 30K tokens in Chinese). The DB persists whatever
// lives in this.messages, so this also keeps oversized results out of the
// tool_results table. The read tool rides a dedicated higher budget
// (MAX_READ_RESULT_TOKENS, 30K) instead of the 4K default: reading a file IS
// the task, so a normal page lands in full — but a pathological long-line page
// (500 lines of minified code, single-line JSON) is head+tail truncated and
// offloaded like any other result instead of exceeding the whole window in one
// call.
// MAX_TOOL_RESULT_TOKENS lives in engine/engine-constants.ts — spawn-tool
// sizes the batch-split envelope budget from it and must not import this
// module (cycle: AgentEngine → tool-executors → executors/spawn-tool).
// The token estimator is the shared CJK-aware one (engine/context-estimate.ts):
// the compactor's trigger chain and the UI ring must read the same numbers.

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
  /** The bound project's identity (2026-09-18 项目概述). The session manager
   *  reads it fresh at create AND at every refreshOptions, so an overview
   *  edited mid-conversation lands on the very next request. Rendered into
   *  the stateBlock's `## Project` section — per-turn state, never the
   *  invariant core. Absent for unbound/default-project conversations, where
   *  the whole section stays out. */
  projectName?: string
  projectOverview?: string
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
   *  (tool studio) that pins its own — nothing here can answer a hold,
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
  /** Set by spawn-manager on every spawned sub-engine's opts (PLAN-plan-split
   *  v2 R2): the toolset drops SUB_AGENT_DENY_TOOLS (create_plan /
   *  advance_plan / spawn_agent) — a sub-agent plans nothing, settles nothing
   *  and delegates nothing; its only growth channel is create_sub_plan (when
   *  `spawnPlanSplit` is also set). Execution keeps matching early-return
   *  guards: collection hides the schema, the guard catches an out-of-schema
   *  hallucinated call (dispatch is by NAME). */
  spawnedToolset?: boolean
  /** Set for spawns of SPLITTABLE plan nodes (v2 R6/R7): arms
   *  create_sub_plan in the toolset and carries the parent-plan bridge
   *  constants — nodeRef + the parent-minted attemptId the merge CASes on. */
  spawnPlanSplit?: { nodeRef: string; attemptId: string }
}

// ── AgentEngine Callbacks ───────────────────────────────────────────

export interface AgentEngineCallbacks {
  onMessagesChanged?: (messages: AgentMessage[]) => void
  onStatusChanged?: (status: AgentStatus) => void
  onStreamingBlocksChanged?: (blocks: ContentBlock[]) => void
  onPlanChanged?: (plan: Plan | null) => void
  /** A compaction pass ran (request-time drop, post-turn prewarm or explicit
   *  /compact). Transport maps it onto the `compaction` session event so the
   *  UI can show what happened instead of leaving the user to infer it from a
   *  sudden quality drop. */
  onCompaction?: (event: CompactionEvent) => void
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
  maxLoopCount = getLoopIterationLimit()
  /** @internal */
  terminalCleanups: (() => void)[] = []
  /** @internal */
  executingProcessId: string | null = null
  /** @internal */
  isCancelled = false
  /** @internal — request ids aborted while freezing/stopping (see the field's
   *  comment on EngineCore for why the stream-runner consults this set instead
   *  of the mutable isCancelled). */
  cancelledRequestIds = new Set<string>()
  /** @internal */
  requestStartTime = 0
  /** @internal — the turn's duration accumulator: user send → last output
   *  character, excluding time parked on the user (held approval / ask_user /
   *  loop-limit prompt / manual pause). See engine/turn-clock.ts. */
  turnClock = new TurnClock()
  /** Consecutive idle-timeout retries for the current stream. Reset on success. */
  /** @internal */
  streamIdleRetries = 0
  /** Consecutive thinking-only rounds this turn (engine/thinking-only retry):
   *  stream-runner re-issues once, then errors the turn explicitly. Reset by
   *  prepareTurn and by any round that produced text or tool calls. */
  /** @internal */
  thinkingOnlyRetries = 0
  /** Provider context-overflow state (0.4.1 fix). The limit is parsed off the
   *  provider's own rejection — the one ground truth the estimates answer to —
   *  and prepareLoopRequest answers it with compactor.emergencyTruncate on the
   *  API copy. Cleared when a request is accepted again; the companion counter
   *  allows exactly one automatic truncated retry per failure streak (reset by
   *  a successful request and by prepareTurn). */
  contextOverflowLimit: number | null = null
  /** @internal */
  contextOverflowRetries = 0
  /** Number of spawn_agent calls in the round's dispatching assistant message —
   *  the denominator of the shared envelope budget (see executors/spawn-tool.ts
   *  spawnEnvelopeBudget). Stable across the batch: every dispatch of the round
   *  reads the same message. */
  countRoundSpawnCalls = (): number => {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i]
      if (msg.role !== 'assistant') continue
      return msg.contentBlocks.filter(b => b.type === 'tool_use' && b.name === 'spawn_agent').length
    }
    return 1
  }
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
  /** Cached history summary for the currently-dropped region. The id is the
   *  COVERAGE FRONTIER — the newest message the summary text covers (the last
   *  dropped one), not a kept-tail start: light drops holes (whole tool
   *  cycles), so a kept-tail key pinned itself to the first surviving
   *  non-cycle message and the cache never extended (conv_20260927170026:
   *  one 683-char summary for 29h). Serialized/persisted under the historical
   *  `firstKeptId` name; consumers treat it as opaque. */
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
  /** True ONLY for engines running inside a spawn dispatch (spawn-manager sets
   *  it alongside spawnSystemPrompt). spawnSystemPrompt itself is NOT a spawn
   *  discriminator: every derived/pinned session — the three assistants —
   *  stores its override there too, and a spawned agent is exactly the one
   *  runtime with no user channel (respondToTool can never reach it), which is
   *  what the ask_user park gate must actually test. */
  isSpawnedSubAgent = false
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
   *  append it as this turn's own assistant message. Public on EngineCore so
   *  the plan scheduler can yield to it (that verbatim close owns the turn). */
  pendingVerbatimReply: string | null = null
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
  /** Delegated-plan auto-scheduler (PLAN-plan-scheduler): kick() takes first
   *  refusal at drains, turn end and resume — see engine/plan-scheduler.ts.
   *  The annotation is load-bearing: without it the initializer infers through
   *  EngineCore (which names this very field) and TS reports a circular any. */
  planScheduler: PlanScheduler = new PlanScheduler(this)
  private runLlmStream = (opts: AgentEngineOptions, req: { apiUrl: string; headers: Record<string, string>; resolvedBody: unknown }): Promise<void> => this.streamRunner.run(opts, req)
  reportSpawnProgress = (msg: string, force = false): void => { this.spawnManager.reportProgress(msg, force) }
  /** @internal */
  compactor = new ContextCompactor({
    runHistorySummary: (regionText, instruction) => this.runHistorySummary(regionText, instruction),
    getMessages: () => this.messages,
    // Live view of the refill breaker (PLAN-context-zcode-benchmarks P1): the
    // compactor consumes the flag per pass; the state itself lives here, next
    // to the other request-loop knobs.
    isSummarySuspended: () => this.compactTracking.summarySuspended,
  })

  /** Refill-breaker state (PLAN-context-zcode-benchmarks P1): tool rounds
   *  since the last compaction drop, consecutive fast refills, and whether
   *  the breaker has suspended summary absorption. See
   *  engine/context-compactor.ts `evaluateRefillBreaker`. */
  compactTracking: CompactTracking = makeCompactTracking()

  /** @internal — execution-flow counts one completed tool batch per model
   *  round whose tool results landed; the refill breaker reads the pace.
   *  Tick sites (all of them, review_20260930 中2): dispatchToolExecution's
   *  tail (auto/sync batches — and held batches, whose results land after the
   *  user clicks; the only reader, evaluateRefillBreaker, runs at the NEXT
   *  request build, by which time they have), the truncated-param synthetic
   *  batch, the max_tokens synthetic batch, and the all-oversized synthetic
   *  batch. An ask_user answer / rejection / approval release lands through
   *  addToolResult and is covered by its round's dispatch tick — do NOT add
   *  another tick inside addToolResult, that would double-count the round. */
  recordToolBatchComplete(): void {
    this.compactTracking.toolRoundsSinceDrop++
  }

  /** Current history-summary cache (persisted with the conversation). */
  getHistorySummary(): { firstKeptId: string; text: string } | null {
    return this.compactor.getHistorySummary()
  }

  /** Restore the persisted history summary after rehydration. */
  seedHistorySummary(text?: string, frontierId?: string): void {
    this.compactor.seedHistorySummary(text, frontierId)
  }

  // ── Explicit compaction (PLAN context-management P0) ────────────────

  /** Sticks after an explicit /compact until reset(): the trigger chain is
   *  stateless per request — it re-reads the LIVE history every time — so a
   *  one-request force would re-inflate the very next copy to the same
   *  estimate. While set, lightCompact/hardTruncate bypass their thresholds
   *  (hard targets 0.6× instead of 0.9×). Post-turn prewarm does NOT set it:
   *  above the post-turn ratio the natural thresholds fire on their own. */
  private manualCompactActive = false
  private postTurnPrewarmInFlight = false

  /** Explicit /compact [指示词]: force-compact from the next request on, and
   *  prewarm the summary now (one LLM call at idle instead of blocking the
   *  next turn). Resolves with the compaction event for UI feedback, or null
   *  when there was nothing to drop (conversation below the keep-window
   *  floor) or a turn is in flight — compacting mid-turn would race the loop
   *  on the shared summary cache. No isCancelled gate on purpose: that flag
   *  means "late tool results must not revive the loop", while compaction
   *  sends no request and touches only the API copy — and a stopped (idle)
   *  or paused (awaiting_continue) conversation is exactly when the user
   *  reaches for /compact. The gate made the command a silent no-op that
   *  reported the opposite of what happened (review0924 M1). */
  compactNow = async (instruction?: string): Promise<CompactionEvent | null> => {
    const status = this.agentStatus.status
    if (status === 'streaming' || status === 'executing' || status === 'retrying') return null
    this.manualCompactActive = true
    const event = await this.compactor.prewarm({
      contextLength: this.opts.contextLength || 128_000,
      source: 'manual',
      instruction: instruction || undefined,
    })
    if (event) this.callbacks.onCompaction?.(event)
    return event
  }

  /** Post-turn prewarm (Codex's PostTurn phase, adapted to the API-copy
   *  design): at turn end, with usage at/above the ratio, warm the history
   *  summary while the engine is idle so the next turn's first request hits
   *  the cache instead of blocking on an LLM summarization call. Fire-and-
   *  forget by contract — the turn is already closed when this runs, and a
   *  failure costs nothing (the request path falls back to its own summary).
   *  Spawned sub-agents are skipped: their engines die with the task, so the
   *  warmed cache would never be read. */
  schedulePostTurnCompaction = (): void => {
    if (this.isSpawnedSubAgent || this.isCancelled) return
    if (this.postTurnPrewarmInFlight || this.manualCompactActive) return
    const contextLength = this.opts.contextLength
    if (!contextLength) return
    if (this.compactor.contextTokens() < contextLength * POST_TURN_COMPACT_USED_RATIO) return
    this.postTurnPrewarmInFlight = true
    void this.compactor.prewarm({ contextLength, source: 'post-turn' })
      .then((event) => { if (event) this.callbacks.onCompaction?.(event) })
      .catch((err) => console.warn('[AgentEngine] post-turn compaction prewarm failed:', err))
      .finally(() => { this.postTurnPrewarmInFlight = false })
  }

  // ── Model-initiated compaction (PLAN-context-compact-tool) ──────────

  /** context_compact's one-shot force: the NEXT request build's lightCompact
   *  bypasses its threshold (0.6× target) so the drop the tool's prewarm
   *  promised actually materializes in that copy. Consumed by
   *  prepareLoopRequest right after the build and deliberately separate from
   *  manualCompactActive (which sticks until reset) — the model asked for ONE
   *  slimming, then the passive fit-based rhythm takes over. NOT cleared by
   *  prepareTurn: the drop must land on the next built copy whenever it comes.
   *  @internal */
  pendingToolCompactForce = false
  /** Per-turn cap on the main compaction action (user ruling 2026-10-01):
   *  a compacted copy whose live-history estimate did not change invites an
   *  identical retry — one call per turn is the bound. prepareTurn clears it;
   *  the free_results light action is exempt (idempotent, zero-LLM). @internal */
  toolCompactUsedThisTurn = false

  /** The `context_compact` tool's engine side (D2/D3/D3b/D4): guards return
   *  structured outcomes and never throw; the main action (bare/instruction/
   *  notes) runs the prewarm pipeline with source 'tool' and arms the one-shot
   *  light force; free_results resolves ids against the same nano rules the
   *  compressor applies (TIER3 / protection window / existence) and mandates
   *  the rest. Guards ②③ bind the main action only. */
  compactForTool = async (call: CompactToolRequest): Promise<CompactToolOutcome> => {
    const instruction = call.instruction?.trim() || undefined
    const notes = call.notes?.trim() || undefined
    const freeResults = (call.freeResults ?? []).map((s) => String(s).trim()).filter(Boolean)

    // ① A request actually in flight stays un-raceable: the prewarm mutates the
    // shared summary cache. Tool execution happens BETWEEN requests (status
    // 'executing' with none in flight) and is exactly the sanctioned moment —
    // compactNow's blanket guard was the over-conservative one (D4).
    const status = this.agentStatus.status
    if (status === 'streaming' || status === 'retrying') {
      return { ok: false, reason: 'request_in_flight' }
    }

    // ── free_results: the orthogonal light action (D3b). Exempt from ②③ —
    // idempotent, zero-LLM, bounded only by the nano rules themselves. ──
    const freedResults: string[] = []
    const skippedIds: Array<{ id: string; reason: string }> = []
    if (freeResults.length > 0) {
      // Same walk nanoCompact runs: the newest N result-bearing user messages
      // are protected even from a mandated pick.
      const protectedMsgIds = new Set<string>()
      let found = 0
      for (let i = this.messages.length - 1; i >= 0 && found < NANO_PROTECTION_WINDOW; i--) {
        const msg = this.messages[i]
        if (msg.role !== 'user') continue
        if (msg.contentBlocks.some(b => b.type === 'tool_result')) {
          protectedMsgIds.add(msg.id)
          found++
        }
      }
      const ownerOf = new Map<string, { name: string; resultMsgId: string | null }>()
      for (const msg of this.messages) {
        for (const block of msg.contentBlocks) {
          if (block.type !== 'tool_use') continue
          ownerOf.set(block.id, { name: block.name, resultMsgId: null })
        }
      }
      for (const msg of this.messages) {
        if (msg.role !== 'user') continue
        for (const block of msg.contentBlocks) {
          if (block.type !== 'tool_result') continue
          const owner = ownerOf.get(block.tool_use_id)
          if (owner) owner.resultMsgId = msg.id
        }
      }
      for (const id of freeResults) {
        const owner = ownerOf.get(id)
        if (!owner) { skippedIds.push({ id, reason: 'unknown_id' }); continue }
        if (NANO_TIER3_NAMES.has(owner.name)) { skippedIds.push({ id, reason: 'tier3_protected' }); continue }
        if (owner.resultMsgId && protectedMsgIds.has(owner.resultMsgId)) {
          skippedIds.push({ id, reason: 'recent_protected' }); continue
        }
        freedResults.push(id)
      }
      this.compactor.mandateToolResultIds(freedResults)
    }

    // The main action is a bare call or one carrying instruction/notes;
    // free_results-only is the light action alone.
    const mainAction = Boolean(instruction || notes) || freeResults.length === 0
    if (!mainAction) {
      return { ok: true, freedResults, skippedIds, summaryLanded: false, notesKept: false }
    }

    // ② once per turn
    if (this.toolCompactUsedThisTurn) {
      return { ok: false, reason: 'already_this_turn', freedResults, skippedIds }
    }
    // ③ cheap pre-check: the force target is 0.6× the window — below 0.55×
    // there is provably nothing to drop and the pipeline would idle.
    const contextLength = this.opts.contextLength || 128_000
    const tokens = this.compactor.contextTokens()
    if (tokens < contextLength * 0.55) {
      return { ok: false, reason: 'not_worthwhile', tokens, window: contextLength, freedResults, skippedIds }
    }
    const event = await this.compactor.prewarm({
      contextLength,
      source: 'tool',
      instruction,
      notes,
      hardForce: false, // D3 two-powers split: the model's force bypasses ONLY light
    })
    // ④ nothing droppable (light-only semantics: what remains is text the
    // automatic layers only cut under real pressure)
    if (!event) {
      return { ok: false, reason: 'nothing_to_drop', freedResults, skippedIds }
    }
    this.pendingToolCompactForce = true
    this.toolCompactUsedThisTurn = true
    this.callbacks.onCompaction?.(event)
    return {
      ok: true,
      freedResults,
      skippedIds,
      droppedMessages: event.droppedMessages,
      tokensBefore: event.tokensBefore,
      tokensAfter: event.tokensAfter,
      summaryLanded: this.getHistorySummary() != null,
      notesKept: notes ? this.compactor.lastNotesLanded : false,
    }
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
      () => this.countRoundSpawnCalls(),
      (ref, attemptId, text) => this.planManager.recordNodeHandoff(ref, attemptId, text),
      // Read at call time, never snapshotted: the flag flips AFTER this
      // constructor on a spawned engine (spawn-manager), and the nested
      // dispatch branch in execSpawnAgent must see the live value.
      () => this.isSpawnedSubAgent,
      (ref, attemptId, children, reason) => this.planManager.mergeSplitProposal(ref, attemptId, children, reason),
      (ref, attemptId, path, status) => this.planManager.recordNodeReport(ref, attemptId, path, status),
      // context_compact's channel into the engine (PLAN-context-compact-tool):
      // guards + prewarm + mandate all live here; the executor only formats.
      (call) => this.compactForTool(call),
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
    // The expert pack rides the bag wholesale (refreshOptions re-attaches it
    // WITH its mirror fields), so the one derived piece living outside opts
    // must be re-derived here when the key is present — the same rule
    // applyExpertContext applies, minus its change-detection no-op.
    if (opts.allowedMcpServers !== undefined) {
      this.allowedMcpServersSet = new Set(opts.allowedMcpServers)
    }
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
      this.cancelledRequestIds.add(this.currentRequestId)
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
    // 4K input cap backstop (2026-09-30 「给输入框一个4k的上限」): the desktop
    // composer clamps in its onChange, but EVERY client funnels through
    // prepareTurn — a staged row restored from an old draft, the extension
    // panel, a hosted session — and the hook's rewrite is clamped here too.
    // Clip, warn, keep going: the transcript is the one place oversize text
    // never becomes permanent.
    if (userMessage.length > MAX_USER_INPUT_CHARS) {
      console.warn(`[AgentEngine] user message clipped to ${MAX_USER_INPUT_CHARS} chars (was ${userMessage.length})`)
      userMessage = userMessage.slice(0, MAX_USER_INPUT_CHARS)
    }

    this.loopCount = 0
    this.maxLoopCount = getLoopIterationLimit()
    // 输入了新消息 = 旧回合终止（user ruling 2026-09-29）：停在 awaiting_continue
    // 的旧回合里可能还冻着一棵专家树（用户没点确认条的 停止任务，而是直接发送
    // 了新消息），新回合开始前把整棵树真实结算——completion 落 'aborted'、并行
    // 槽位归还、排队者判 null（「子代理未启动」）。这是引擎侧权威的收口：桌面 /
    // 插件面板 / 托管会话 / 例行任务的新回合全部经过 prepareTurn，树为空时两者
    // 都是 no-op。
    this.executionFlow.settleSubAgentTree(this)
    releaseQueuedSubAgents(subAgentBudgetKey(this.opts))
    // 排空结算续延：completion 的 resolve、排队者的拒绝都是微任务，它们经
    // addToolResult 回调 continueLoop，而唯一的闸门是 isCancelled——必须趁它
    // 还关着让这些续延跑完（一个宏任务保证所有微任务排空），否则它们会与下面的
    // 新回合并发各开一条循环（两条循环写同一份转写，sendStagedNow 注释里那口锅）。
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    this.isCancelled = false
    this.pendingToolIds = new Set()
    // A new send gets a fresh overflow rescue: if a PREVIOUS turn ended in the
    // overflow error, this one's first oversized request is auto-retried too.
    // The forced cut itself is still armed via contextOverflowLimit (cleared
    // only by an accepted request).
    this.contextOverflowRetries = 0
    // A new send gets a fresh thinking-only rescue too: even if the previous
    // turn exhausted its re-issue, the model gets one more sampling chance.
    this.thinkingOnlyRetries = 0
    // Same for the stream idle-timeout budget. The cancel path already resets
    // it in the runner's catch (stream-runner, unconditional before the
    // isCancel return), so this is DEFENSE, not a bug fix: the "a new turn
    // starts with a fresh retry budget" invariant now holds no matter which
    // exit a previous turn took (review_20261005 P2-08 claimed a skipped reset
    // that the current control flow does not have).
    this.streamIdleRetries = 0
    // Same for context_compact's per-turn cap: every turn gets one main
    // compaction back. (pendingToolCompactForce is deliberately NOT touched —
    // the drop it arms belongs to the next built copy, whenever that comes.)
    this.toolCompactUsedThisTurn = false
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
      this.cancelledRequestIds.add(this.currentRequestId)
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
      // Turn-end memory salvage (error path — the pairs are still in memory).
      runTurnEndMemoryExtraction(this)
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

    // Strip image data from tool_results before sending to LLM (keep originals
    // for UI). The transform itself lives in `./strip-tool-results` — extracted
    // verbatim so this per-iteration O(tool_result bytes) cost is measurable on
    // the real function (scripts/probe-loop-iteration-perf.mjs).
    // Then repair adjacency for the wire (2026-09-30): chained plan dispatch
    // interleaves assistant messages with a live batch's results, and both
    // providers require each tool_result next to its own tool_use message.
    // Identity on legal histories, so sessions that never chain are
    // byte-identical and the compaction pipeline below sees a legal shape.
    const apiMessages = regroupToolResults(this.messages.map(stripToolResultImages))

    // ── Compaction pipeline (operates on API copy; this.messages untouched) ──
    // Fixed overhead the char heuristic never sees: system prompt + tool schemas.
    // Injected into the fallback estimate so compaction still fires at the right
    // pressure point before the first API token report arrives.
    const fixedOverhead = estimateTokens(systemPrompt) + estimateTokens(JSON.stringify(enabledTools)) + (spResult.stateBlock ? estimateTokens(spResult.stateBlock) : 0)
    // A provider just rejected this conversation as context-overflow: the
    // estimates missed it once (that is why the oversized request went out),
    // so ignore their thresholds and force the API copy under the limit the
    // provider named. Cleared when a request is accepted again (stream-runner).
    let pipelineMessages = apiMessages
    let emergencyChanged = false
    if (this.contextOverflowLimit != null) {
      const before = pipelineMessages
      pipelineMessages = this.compactor.emergencyTruncate(pipelineMessages, this.contextOverflowLimit, fixedOverhead)
      emergencyChanged = pipelineMessages.length !== before.length ||
        pipelineMessages.some((m, i) => m !== before[i])
      if (emergencyChanged) {
        console.log(`[AgentEngine] emergencyTruncate (provider limit ${this.contextOverflowLimit}): ${before.length} → ${pipelineMessages.length} messages`)
      }
    }
    const nanoCompacted = this.compactor.nanoCompact(pipelineMessages)
    // Two force sources, two scopes (keep them separate — see the field
    // comments): manualCompactActive (/compact) sticks until reset and drives
    // BOTH layers; pendingToolCompactForce (context_compact) is one-shot for
    // THIS copy and bypasses ONLY light — hard's passive 0.9× trigger stays
    // armed against the model's own misjudgement (D3 two-powers split).
    const lightForce = this.manualCompactActive || this.pendingToolCompactForce
    const lightCompacted = this.compactor.lightCompact(nanoCompacted, opts.contextLength || 128000, fixedOverhead, lightForce)
    const truncatedMessages = this.compactor.hardTruncate(lightCompacted, opts.contextLength || 128000, fixedOverhead, this.manualCompactActive)
    // The tool force armed the drop this copy just materialized — consume it
    // here, after the build, so exactly one request runs slimmed.
    this.pendingToolCompactForce = false
    // After truncation, inject an LLM summary of the dropped region into the API
    // copy so the model keeps the gist. Synthetic message never leaves this scope.
    // The summarizer source is the PRE-PIPELINE copy (before emergency/nano):
    // nanoCompact has already replaced old tool_results with [tool_result_id:]
    // placeholders, so summarizing lightCompacted would hide what the tools
    // actually returned (incl. failures) and let the summary fabricate outcomes;
    // and the dropped-region arithmetic inside (original.length - truncated.length)
    // must span emergency's drops too when the overflow flag is parked.
    const summaryBefore = this.compactor.getHistorySummary()
    const finalMessages = await this.compactor.injectHistorySummary(apiMessages, lightCompacted, truncatedMessages)

    // ── Compaction event: the pass is otherwise invisible ──
    // Detect per layer by reference/length (nano is 1:1, so reference identity
    // is its only footprint). The summary ships only when the cache changed,
    // so the mirror's persisted copy stays fresh without re-sending the text
    // on every request.
    const compactStrategies: string[] = []
    if (emergencyChanged) compactStrategies.push('emergency')
    if (nanoCompacted.some((m, i) => m !== pipelineMessages[i])) compactStrategies.push('nano')
    if (lightCompacted.length !== nanoCompacted.length) compactStrategies.push('light')
    if (truncatedMessages.length !== lightCompacted.length) compactStrategies.push('hard')
    // The reminder's own synthetic message would read as a summary landed —
    // exclude it so 'summary' keeps meaning "a summary message is in the copy".
    const reminderInjected = this.compactor.lastReminderCount > 0
    if (finalMessages.length > truncatedMessages.length + (reminderInjected ? 1 : 0)) compactStrategies.push('summary')
    if (reminderInjected) compactStrategies.push('read_reminder')

    // ── Refill breaker (PLAN-context-zcode-benchmarks P1) ──
    // Runs on EVERY request build (the un-trip path needs it even when nothing
    // was dropped): a fit-based drop landing within REFILL_TOOL_TURN_THRESHOLD
    // tool rounds of the previous one is a refill; REFILL_BREAKER_LIMIT in a
    // row suspends summary absorption until the rhythm normalizes. nano is 1:1
    // and emergency is the reactive backstop — neither is a refill signal.
    const roundsAtEntry = this.compactTracking.toolRoundsSinceDrop
    const refill = evaluateRefillBreaker(
      this.compactTracking,
      roundsAtEntry,
      compactStrategies.includes('light') || compactStrategies.includes('hard'),
      // An emergency-only pass isn't a refill signal, but its drops still
      // re-base the round clock (see evaluateRefillBreaker).
      compactStrategies.includes('emergency') ||
        compactStrategies.includes('light') || compactStrategies.includes('hard'),
    )
    if (refill.transitionedToSuspended) {
      console.warn(
        `[AgentEngine] refill breaker tripped (${this.compactTracking.consecutiveRefills} consecutive refills): the copy refilled within ` +
        `<${REFILL_TOOL_TURN_THRESHOLD} tool rounds of each compaction — a file or tool output is likely too large. ` +
        `Summary absorption suspended until the rhythm normalizes; nano/light/hard/emergency keep running.`
      )
      this.callbacks.onCompaction?.({
        ts: Date.now(),
        source: 'request',
        strategies: ['refill_breaker'],
        droppedMessages: 0,
        replayedUserMessages: 0,
        tokensBefore: contextTokensOf(apiMessages),
        tokensAfter: contextTokensOf(finalMessages),
      })
    }
    if (compactStrategies.length > 0) {
      const summaryAfter = this.compactor.getHistorySummary()
      const summaryChanged =
        !!summaryAfter && (!summaryBefore ||
          summaryAfter.firstKeptId !== summaryBefore.firstKeptId ||
          summaryAfter.text !== summaryBefore.text)
      const event: CompactionEvent = {
        ts: Date.now(),
        source: 'request',
        strategies: compactStrategies,
        droppedMessages: apiMessages.length - finalMessages.length,
        replayedUserMessages: this.compactor.lastInjectReplayCount,
        tokensBefore: contextTokensOf(apiMessages),
        tokensAfter: contextTokensOf(finalMessages),
        summary: summaryChanged ? summaryAfter : undefined,
      }
      this.callbacks.onCompaction?.(event)
    }

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

    // Log request payload for debugging (full detail for spawned sub-agents)
    if (this.spawnSystemPrompt) {
      console.log('=== [SpawnedAgent] FULL SYSTEM PROMPT ===')
      console.log(systemPrompt)
      console.log('=== [SpawnedAgent] API MESSAGES ===')
      console.log(JSON.stringify(apiMessages, null, 2))
      console.log('=== [SpawnedAgent] TOOLS ===')
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
    // The stop button (agentSessionCancel 落点：composer 的 ⏹、工具台/托管会话/
    // 插件侧的停止，以及 reset/loadConversation 的内部调用)——**冻结，不是结算**
    // （user ruling 2026-09-29 体验回滚：回到单停止钮；用户分不清暂停和终止该
    // 何时按）。中止在飞的请求/进程、整棵专家树一起冻结（递归 pauseExecution），
    // 回合停进 awaiting_continue，确认条的 继续执行/停止任务 接手。completion
    // 一律不结算、槽位仍被持有、排队者不排空——真正结算的是确认条的「停止任务」
    // （stopExecution）和「输入了新消息」（prepareTurn，引擎侧权威：桌面/插件/
    // 托管会话的新回合全部经过它）。
    this.executionFlow.pauseExecution()
  }

  /**
   * Mid-stream steering (PLAN-mid-stream-steer M1, B7 方案 A): redirect the
   * LIVE LLM stream with a new user instruction instead of stopping or
   * queueing. The abort seam is prepareTurn's own request-level one —
   * cancelledRequestIds + apiAbortStream — NOT pauseExecution: the stream-runner
   * catch walks its isCancel arm and returns without awaiting_continue, without
   * freezing the sub-agent tree, without settling spawn completions, without
   * touching the retry counters. What the round already said rides into the
   * transcript as an ordinary assistant message ("the model was halfway
   * through, the user cut in"); thinking blocks only with a COMPLETE signature
   * (an unsigned one would 400 the next Anthropic request); tool_use is dropped
   * wholesale — the steer re-asks, the aborted call never executes. The steer
   * CONSUMES a loop (continueLoop's loopCount++), so the 200 cap governs it
   * like any other round — steering is not a free renewal.
   *
   * Guard → abort → solidify → append are one synchronous block: no await, so
   * no IPC event (stream-done → onStreamComplete) can interleave and
   * double-append the round.
   */
  steer = async (text: string): Promise<SteerOutcome> => {
    const trimmed = (text ?? '').trim()
    // Phase guard: only a live LLM stream can be steered. Every other status
    // keeps today's semantics — executing tools are committed, awaiting_* has
    // the composer disabled anyway, and a settled turn is a normal send.
    if (this.agentStatus.status !== 'streaming') {
      return { ok: false, reason: 'not_streaming', status: this.agentStatus.status }
    }
    if (!trimmed) return { ok: false, reason: 'empty' }
    const requestId = this.currentRequestId
    if (!requestId) return { ok: false, reason: 'no_active_stream' }

    // 4K input cap backstop — the same clip prepareTurn applies to every
    // client's input; the steer text is a user message like any other.
    const clipped = trimmed.length > MAX_USER_INPUT_CHARS
      ? trimmed.slice(0, MAX_USER_INPUT_CHARS)
      : trimmed

    const solidBlocks: ContentBlock[] = []
    for (const b of this.currentAssistantBlocks) {
      if (!b) continue
      if (b.type === 'text' && b.text.trim()) solidBlocks.push(b)
      else if (b.type === 'thinking' && (b as { signature?: string }).signature) solidBlocks.push(b)
      else if (b.type === 'redacted_thinking') solidBlocks.push(b)
    }
    if (solidBlocks.length > 0) {
      this.messages = [...this.messages, {
        id: generateMsgId(),
        role: 'assistant',
        contentBlocks: solidBlocks,
        createdAt: new Date().toISOString()
      } satisfies AgentMessage]
    }

    this.cancelledRequestIds.add(requestId)
    try { this.abortController?.abort() } catch { /* already aborted */ }
    getHost().apiAbortStream(requestId)
    this.currentRequestId = null
    // Drop the in-flight canvas — the same reset shape the stream-runner's
    // idle-retry and overflow paths use before re-issuing.
    this.currentAssistantBlocks = []
    this.streamingBlocks = []
    this.jsonAccumulators = new Map()
    this.toolUseBlocks = []

    this.messages = [...this.messages, {
      id: generateMsgId(),
      role: 'user',
      contentBlocks: [{ type: 'text', text: clipped }],
      createdAt: new Date().toISOString()
    } satisfies AgentMessage]
    // The steer opens a fresh sampling window (the same reset a new turn gets).
    this.thinkingOnlyRetries = 0
    this.agentStatus = { status: 'streaming' }
    this.notify()
    // continueLoop is not awaited: the IPC response is the outcome, the next
    // request is the turn's business. Its own catch settles failures.
    void this.continueLoop().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[AgentEngine] steer re-dispatch failed:', message)
      this.agentStatus = { status: 'error', error: message }
      this.notify()
    })
    return { ok: true }
  }

  clearError = (): void => {
    this.agentStatus = { status: 'idle' }
    this.notify()
  }

  // ── Tool execution lifecycle delegation (ExecutionFlow, split 4/5) ──
  private executionFlow = new ExecutionFlow(this)
  approveTool = async (toolUseId: string, alwaysAllow?: boolean): Promise<void> => this.executionFlow.approveTool(toolUseId, alwaysAllow)
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
    // The thinking-only error's hint says 「可直接重试」 — the retry must buy a
    // fresh sampling chance: the counter survives the error close (it is what
    // ended the turn) and continueLoop() bypasses prepareTurn's reset, so
    // without this the button re-errored on the first degenerate round
    // (review_20260929 中4).
    this.thinkingOnlyRetries = 0
    // Same shape for the overflow rescue: a manual retry earns one more
    // automatic truncation + re-issue. The forced cut itself stays armed via
    // contextOverflowLimit (cleared only by an accepted request).
    this.contextOverflowRetries = 0
    this.abortController?.abort()
    if (this.currentRequestId) {
      this.cancelledRequestIds.add(this.currentRequestId)
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
    this.maxLoopCount = getLoopIterationLimit()
    this.isCancelled = false
    this.pendingToolIds = new Set()
    this.historySummary = null
    // A fresh conversation also clears an explicit /compact: the force sticks
    // until reset precisely so a live session stays slim, but it must not
    // outlive the history it was compacting. The compactor's summary cache is
    // cleared with it — a reset leaves nothing for the next conversation's
    // inject to re-key against.
    this.manualCompactActive = false
    this.compactor.seedHistorySummary(undefined, undefined)
    // context_compact's state dies with the conversation too: the one-shot
    // force has no next copy to slim, the per-turn cap has no turn, and the
    // mandated ids named messages this history no longer holds.
    this.pendingToolCompactForce = false
    this.toolCompactUsedThisTurn = false
    this.compactor.clearMandatedToolResultIds()
    this.notify()
  }

  loadConversation = (msgs: AgentMessage[]): void => {
    this.cancelLoop()
    this.stopExecution()
    this.messages = msgs
    this.loopCount = 0
    this.maxLoopCount = getLoopIterationLimit()
    this.streamingBlocks = []
    // 恢复不是冻结：上面清场把 isCancelled 关上（防御性，恢复时刻并没有活回合），
    // 但恢复后的第一个用户决定——回答 ask_user 卡片 / 审批放行——经 addToolResult
    // → continueLoop 续跑，而那是唯一不经过 prepareTurn 复位闸门的入口（新消息 /
    // 重试 / 继续执行都各自复位）。不复位 = 回答静默落空：卡片翻成已选择，任务
    // 永远不再继续（应用在 ask_user 挂起时退出、重进后点击卡片，2026-09-30）。
    this.isCancelled = false
    this.notify()
  }

  extendLoop = (): void => {
    // 续期一次加的是配置的 base（默认 200），不是写死的常量——用户改了上限后，
    // 「继续」给出的增量与第一次配额一致。
    this.maxLoopCount += getLoopIterationLimit()
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
    // is offloaded to ~/.pulsemind/tmp/trunc/ for the model to `read` back. read
    // rides the same mechanism with its own higher budget (MAX_READ_RESULT_TOKENS)
    // instead of the old blanket Infinity exemption — the truncation math lives in
    // result-ingestion.applyToolResultBudget.
    const budget = maxTokens ?? MAX_TOOL_RESULT_TOKENS
    const offloadDest = `~/.pulsemind/tmp/trunc/trunc_${toolUseId.slice(0, 8)}_${Date.now()}.txt`
    const { text, truncated } = applyToolResultBudget(content, isError, budget, offloadDest)
    if (truncated) {
      getHost().writeFile({ filePath: offloadDest, content }).catch(() => {})
    }

    // Guard against duplicate
    for (const msg of this.messages) {
      if (msg.role !== 'user') continue
      if (msg.contentBlocks.some(b => b.type === 'tool_result' && b.tool_use_id === toolUseId)) {
        console.warn(`[AgentEngine] Duplicate tool_result skipped for ${toolUseId}`)
        // A duplicate of an ALREADY-settled result must not re-drive the loop:
        // the first delivery already continued it, and a second continue issued
        // mid-stream races the running round on this engine's shared stream
        // state — the doubled garbled assistant message (ask_user chip answered
        // twice, user report 2026-09-20). Only a duplicate that was STILL
        // pending — the batch is genuinely waiting on it — may close the loop.
        if (this.pendingToolIds.delete(toolUseId) && this.pendingToolIds.size === 0 && !this.isAutoExecuting) this.continueLoop()
        return
      }
    }

    // Auto-mark tool_use as completed — ensures React.memo re-renders ExecutionSegment
    // with the correct status, since addToolResult creates a new messages reference
    // that includes the updated block status. 'queued' is covered as a safety net:
    // a result landing on a not-yet-started call still settles it (executors mark
    // 'running' at entry, so the normal path arrives here via 'running').
    for (const msg1 of this.messages) {
      for (const block1 of msg1.contentBlocks) {
        if (block1.type === 'tool_use' && block1.id === toolUseId && (block1.status === 'running' || block1.status === 'queued')) {
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
    // Async straggler drain (PLAN-plan-scheduler): the plan scheduler gets
    // first refusal — a delivered wave settles and the next dispatches here,
    // with no LLM round in between. false → the ordinary continuation.
    if (this.pendingToolIds.size === 0 && !this.isAutoExecuting && !this.planScheduler.kick()) this.continueLoop()
    else {
      // Mid-drain chaining (2026-09-30, 「不应该浪费槽」): a spawn result that
      // lands while its batch-mates still run settles immediately and its
      // ready dependents chain into the freed slots, instead of idling behind
      // the whole-wave barrier. Never drives a continuation — the live drain
      // owns the turn; consult/wait still wait for the batch tail's kick.
      this.planScheduler.settleAndChain()
      // settleAndChain may have registered chained calls above, so the
      // remaining set is re-read after it.
      if (this.pendingToolIds.size > 0) {
        const remaining = this.toolUseBlocks.filter(t => this.pendingToolIds.has(t.id))
        // Park only for a call the ladder is actually holding ('pending'). This
        // branch fires after EVERY result in a batch and the rest usually are just
        // still running — repainting the park then would flip the approval UI on
        // (and pause the turn clock as waiting-on-user) for a decision nobody owes.
        if (remaining.some(t => t.status === 'pending')) {
          this.agentStatus = { status: 'awaiting_approval', tools: remaining }
          this.notify()
        }
      }
    }
  }

  // ── Tool result persistence (for tool_result_search) ──────────────────

  // ── Compaction pipeline ──────────────────────────────────────────────
  //
  // Three-layer strategy (all operate on API copies; this.messages untouched),
  // triggered per request build in prepareLoopRequest:
  //
  //   Layer 1: nanoCompact — tiered tool_result content replacement (API copy)
  //   Layer 2: lightCompact — structured removal of complete tool cycles (API copy)
  //   Layer 3: hardTruncate — drop oldest messages (API copy, last resort)
  //
  // followed by injectHistorySummary, which summarizes the dropped region
  // into the copy. The remaining-window floors (30K light / 10K hard) live in
  // engine/context-compactor.ts next to the thresholds they guard. Above the
  // post-turn ratio, schedulePostTurnCompaction prewarms the summary at turn
  // end so the request path hits the cache instead of an LLM round; an
  // explicit /compact sets manualCompactActive and bypasses the thresholds.
  //
  // Background memory extraction replaces the old autoCompact mechanism —
  // saves memories from old tool pairs instead of modifying messages.

  /** @internal - also driven by ExecutionFlow */
  cleanupTerminalListeners(): void {
    for (const unsub of this.terminalCleanups) unsub()
    this.terminalCleanups = []
  }

  /** Run the HistorySummaryAgent non-streaming. Returns '' on LLM failure/empty. */
  private async runHistorySummary(regionText: string, instruction?: string): Promise<string> {
    const summaryAgent = new HistorySummaryAgent()
    try {
      return await summaryAgent.execute(
        { regionText, instruction, locale: this.opts.locale },
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
  /** Turn-end salvage runs used by this session (PLAN-memory-extraction-dedup:
   *  MEM_SALVAGE_MAX_PER_SESSION caps the whole process lifetime of a session). */
  /** @internal */
  _memSalvageCount = 0
}
