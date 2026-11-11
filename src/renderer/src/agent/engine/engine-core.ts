// ── EngineCore: the strategy modules' view of the engine ──
// engine/* classes (execution-flow, stream-runner, spawn-manager, …) used to
// hold back-references to the CONCRETE AgentEngine class, making the split
// cosmetic — every module could reach any engine private via a type rename.
// This interface states exactly the surface those modules rely on; AgentEngine
// `implements` it, so the compiler keeps the two in sync while the strategy
// modules now depend on the abstraction, not the class.
//
// Adding a member here means a strategy module genuinely needs it — prefer
// passing data through method parameters over widening this surface.

import type { AgentMessage, AgentStatus, ContentBlock, SteerOutcome, ToolUseBlock } from '../../types/agent'
import type { SubAgentResult } from '../agent-utils'
import type { AgentEngine, AgentEngineOptions } from '../AgentEngine'
import type { ToolExecutor } from '../tool-executors'
import type { PlanManager } from '../plan-manager'
import type { PlanScheduler } from './plan-scheduler'
import type { ContextCompactor, CompactTracking } from './context-compactor'
import type { IncrementalJsonTracker } from '../json-stream'
import type { TurnClock } from './turn-clock'
import type { PulseHost } from '../host/types'

export interface EngineCore {
  // ── Conversation state ──
  messages: AgentMessage[]
  agentStatus: AgentStatus
  streamingBlocks: ContentBlock[]
  currentAssistantBlocks: (ContentBlock | undefined)[]
  toolUseBlocks: ToolUseBlock[]
  jsonAccumulators: Map<number, IncrementalJsonTracker>
  planManager: PlanManager
  /** The delegated plan's auto-scheduler (PLAN-plan-scheduler). `kick()` gets
   *  first refusal at every drain / turn end / resume: true = the scheduler
   *  took the turn (dispatched, or an attempt is live), so the caller must
   *  neither continueLoop nor close the turn; false = the ordinary LLM round. */
  planScheduler: PlanScheduler
  /** A single-expert @-summon's conclusion awaiting delivery as the turn's own
   *  assistant message (set by deliverExpertConclusion, consumed by
   *  continueLoop). While set the scheduler yields — that verbatim close owns
   *  the turn and must not be delayed behind a synthetic dispatch. */
  pendingVerbatimReply: string | null

  // ── Request/loop state ──
  opts: AgentEngineOptions
  abortController: AbortController | null
  currentRequestId: string | null
  /** True only while continueLoop is inside prepareLoopRequest — the build
   *  phase where compaction may await its history-summary LLM call. That call
   *  rides the same retrying transport as a live request (20 attempts, each
   *  with the 120s connect timeout) but arms NO currentRequestId, so the
   *  sub-agent watchdog reads the phase as "no in-flight request" and would
   *  settle a healthy engine past 10 quiet minutes (slow-gateway/Windows
   *  reports). The watchdog counts this flag as in-flight work. */
  prepareLoopInProgress: boolean
  /** Request ids this engine aborted while freezing/stopping (pauseExecution /
   *  stopExecution / prepareTurn). The stream-runner's catch must consult this
   *  SET, not the mutable `isCancelled`: a resume that lands between the abort
   *  and the rejection's microtask clears the flag, and the OLD request's death
   *  would be misread as a fresh engine error — settling a sub-agent the user
   *  just resumed (tests/stop-settles-subagents.test.ts pins the race). */
  cancelledRequestIds: Set<string>
  loopCount: number
  maxLoopCount: number
  isCancelled: boolean
  isAutoExecuting: boolean
  requestStartTime: number
  /** The turn's duration accumulator (send → last output character, excluding
   *  time parked on the user) — see engine/turn-clock.ts. */
  turnClock: TurnClock
  streamIdleRetries: number
  /** Consecutive thinking-only rounds this turn (no text, no tool_use — a
   *  reasoning model that burned its output on CoT and closed with nothing).
   *  stream-runner re-issues once, then ends the turn as an explicit error.
   *  Reset by prepareTurn and by any round that produced visible output. */
  thinkingOnlyRetries: number
  /** Early-stop continuation guard (opts.earlyStopGuard models only). */
  // Tool rounds that have SETTLED this turn (recordToolBatchComplete ticks).
  // The guard's "task in flight" evidence: a text-only end_turn with zero of
  // these is just a chat answer. Reset by prepareTurn.
  toolRoundsThisTurn: number
  /** Nudges since the last progress (a continuation that produced tool calls
   *  re-arms it to 0). One unproductive continuation then hands the turn back
   *  — the model had its chance and its words are on the canvas. */
  earlyStopContinues: number
  /** Total nudges this turn (the hard cap MAX_EARLYSTOP_CONTINUATIONS reads
   *  it; never reset mid-turn). Reset by prepareTurn. */
  earlyStopNudgesTotal: number
  /** Armed by stream-runner's guard, consumed by prepareLoopRequest: the next
   *  built state block carries the continuation directive (final message,
   *  never persisted, never rendered). One-shot per request build. */
  pendingEarlyStopNudge: boolean
  /** The token limit parsed off a provider context-overflow rejection (null
   *  until one happens). prepareLoopRequest answers it with
   *  compactor.emergencyTruncate on the API copy; a successful request clears
   *  it. See stream-runner's catch and engine/context-estimate.ts. */
  contextOverflowLimit: number | null
  /** One-shot guard for the automatic truncated retry after an overflow —
   *  reset by a successful request and by prepareTurn. */
  contextOverflowRetries: number
  /** The provider-named window an overflow rejection re-aimed this session at
   *  (null until one happens). updateOptions clamps opts.contextLength back
   *  under it — refreshOptions rebuilds the bag wholesale, so the re-aim must
   *  live on the engine to survive a refresh. Dropped on profile switch. */
  contextWindowReaim: number | null
  /** Refill-breaker state (PLAN-context-zcode-benchmarks P1): the pace
   *  counter the refill evaluation reads and the suspended flag the
   *  compactor consumes through its deps. See context-compactor.ts
   *  `evaluateRefillBreaker`. */
  compactTracking: CompactTracking
  pendingToolIds: Set<string>
  executingProcessId: string | null
  /** The tool_use id of the command `executingProcessId` runs — written next
   *  to the pid, so a cleanup that kills the process can settle THAT call's
   *  block (the exit event never arrives once the terminal listeners unbind;
   *  see execution-flow.cleanup). */
  executingToolUseId: string | null
  /** tool_result ref ids already handed to the DB — persistUnsavedToolResults
   *  skips them instead of re-binding the whole history every request. */
  persistedToolResultIds: Set<string>
  /** Gated-tool keyword scan watermark (tool-collection): messages scanned so
   *  far + categories whose triggers already hit. The live history's user text
   *  is append-only, so incremental scanning is exact. */
  gatedScan: { scannedMsgs: number; hitCategories: Set<string> }
  terminalCleanups: (() => void)[]
  selectedMcpTools: string[]
  selectedBuiltinTools: string[]
  mcpToolOwner: Map<string, string>
  toolExecutor: ToolExecutor
  /** 后台命令名台账（PLAN-background-tasks D）：pid → 命令串，exit/转后台的
   *  同一拍写入（execution-flow 的 promote 臂与 executors/domain-tools 的两处
   *  dispatch 点）。AgentEngine 上是构造期赋值的箭头属性，恒存在。 */
  registerBackgroundCommand(pid: number, command: string): void

  // ── Spawn/sub-agent state ──
  activeSubAgents: Map<string, EngineCore>
  /** Settled sub-engines kept for spawn_agent `agentId` follow-up (2026-10-28
   *  续聊原语). spawn-manager's retainCompleted/followUpCompleted are the only
   *  writers — LRU capped at SUB_AGENT_FOLLOWUP_KEEP, cleared on restart. */
  completedSubAgents: Map<string, { engine: AgentEngine; title: string }>
  spawnSystemPrompt?: string
  spawnTitle?: string
  /** True only for an engine SpawnManager constructed as a child (NOT for a
   *  pinned prompt override landing in spawnSystemPrompt) — the plan
   *  scheduler's applicability gate rides on it, as does ask_user's fail-fast. */
  isSpawnedSubAgent: boolean
  /** Epoch-ms deadline of the /init write window for .pulsemind/AGENTS.md
   *  (0 / past = no window). Scoped exactly to that one file: root AGENTS.md
   *  stays held, the write tier's own approval still wins (always-ask), and
   *  a spawned sub-agent's flat rejection is untouched. */
  projectInstructionsGrantUntil: number
  onSpawnProgress?: (summary: string) => void
  resolveCompletion?: (result: SubAgentResult) => void
  completionPromise?: Promise<SubAgentResult>

  // ── Behavior ──
  notify: () => void
  notifyCoalesced: () => void
  notifyStreamingCoalesced: () => void
  addToolResult: (toolUseId: string, content: string, isError: boolean, imageData?: string, maxTokens?: number) => void
  /** One completed tool batch (a model round whose tool results landed).
   *  Drives the refill breaker's rounds-since-drop counter. */
  recordToolBatchComplete: () => void
  getHost(): PulseHost
  reportSpawnProgress: (msg: string, force?: boolean) => void
  resolveCompletionIfSpawned: (status: SubAgentResult['status']) => void
  handleToolUseResponse: (toolUses: ToolUseBlock[]) => Promise<void>
  handleMaxTokensResponse: (toolUses: ToolUseBlock[]) => Promise<void>
  handleEndTurnResponse: (stopReason: string | null) => void
  /** 阶段完成协议（2026-11-11）：本回合已收到合法的 finish_stage，且当前已是
   *  最后一个落地结果——返回 true 并消费一次性信号；调用方直接收尾，
   *  不再起 LLM 轮（结算是 pipeline-engine 的事）。 */
  consumeStageFinishTurnEnd: () => boolean

  // ── Background extraction bookkeeping ──
  _memExtractionInProgress: boolean
  _memSalvageCount: number

  // ── Loop control & collaborators ──
  compactor: ContextCompactor
  continueLoop: () => Promise<void>
  cancelLoop: () => void
  resumeExecution: () => void
  /** Freeze the turn (recursive: sub-engines freeze their own subtrees) without
   *  settling completions — the stop button's engine landing point since the
   *  2026-09-29 single-stop-button ruling. execution-flow's pauseExecution
   *  recurses into activeSubAgents, so the freeze needs to cross the Core
   *  boundary (f8c4f7d). */
  pauseExecution: () => void
  /** Mid-stream steering (PLAN-mid-stream-steer M1): redirect the LIVE LLM
   *  stream with a new user instruction. Accepts only in the streaming phase;
   *  structured rejection otherwise so the UI can fall back to staging. */
  steer: (text: string) => Promise<SteerOutcome>
  /** Post-turn compaction prewarm (fire-and-forget): called from
   *  handleEndTurnResponse once the turn is closed. Skips spawned sub-agents,
   *  in-flight prewarms, and usage below the post-turn ratio. */
  schedulePostTurnCompaction: () => void
  /** 多专家 @召唤：the turn ended without a plan — one corrective re-issue is
   *  owed. True means the caller must NOT close the turn (the engine is about
   *  to re-run it). See AgentEngine.nudgeSummonIfUnplanned. */
  nudgeSummonIfUnplanned: () => boolean
}
