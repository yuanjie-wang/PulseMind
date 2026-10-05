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
import type { AgentEngineOptions } from '../AgentEngine'
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
  /** The token limit parsed off a provider context-overflow rejection (null
   *  until one happens). prepareLoopRequest answers it with
   *  compactor.emergencyTruncate on the API copy; a successful request clears
   *  it. See stream-runner's catch and engine/context-estimate.ts. */
  contextOverflowLimit: number | null
  /** One-shot guard for the automatic truncated retry after an overflow —
   *  reset by a successful request and by prepareTurn. */
  contextOverflowRetries: number
  /** Refill-breaker state (PLAN-context-zcode-benchmarks P1): the pace
   *  counter the refill evaluation reads and the suspended flag the
   *  compactor consumes through its deps. See context-compactor.ts
   *  `evaluateRefillBreaker`. */
  compactTracking: CompactTracking
  pendingToolIds: Set<string>
  executingProcessId: string | null
  terminalCleanups: (() => void)[]
  selectedMcpTools: string[]
  selectedBuiltinTools: string[]
  mcpToolOwner: Map<string, string>
  toolExecutor: ToolExecutor

  // ── Spawn/sub-agent state ──
  activeSubAgents: Map<string, EngineCore>
  spawnSystemPrompt?: string
  spawnTitle?: string
  /** True only for an engine SpawnManager constructed as a child (NOT for a
   *  pinned prompt override landing in spawnSystemPrompt) — the plan
   *  scheduler's applicability gate rides on it, as does ask_user's fail-fast. */
  isSpawnedSubAgent: boolean
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
