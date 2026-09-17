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

import type { AgentMessage, AgentStatus, ContentBlock, ToolUseBlock } from '../../types/agent'
import type { SubAgentResult } from '../agent-utils'
import type { AgentEngineOptions } from '../AgentEngine'
import type { ToolExecutor } from '../tool-executors'
import type { PlanManager } from '../plan-manager'
import type { ContextCompactor } from './context-compactor'
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

  // ── Request/loop state ──
  opts: AgentEngineOptions
  abortController: AbortController | null
  currentRequestId: string | null
  loopCount: number
  maxLoopCount: number
  isCancelled: boolean
  isAutoExecuting: boolean
  requestStartTime: number
  /** The turn's duration accumulator (send → last output character, excluding
   *  time parked on the user) — see engine/turn-clock.ts. */
  turnClock: TurnClock
  streamIdleRetries: number
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
  onSpawnProgress?: (summary: string) => void
  resolveCompletion?: (result: SubAgentResult) => void
  completionPromise?: Promise<SubAgentResult>

  // ── Behavior ──
  notify: () => void
  notifyCoalesced: () => void
  notifyStreamingCoalesced: () => void
  addToolResult: (toolUseId: string, content: string, isError: boolean, imageData?: string, maxTokens?: number) => void
  getHost(): PulseHost
  reportSpawnProgress: (msg: string, force?: boolean) => void
  resolveCompletionIfSpawned: (status: SubAgentResult['status']) => void
  handleToolUseResponse: (toolUses: ToolUseBlock[]) => Promise<void>
  handleMaxTokensResponse: (toolUses: ToolUseBlock[]) => Promise<void>
  handleEndTurnResponse: (stopReason: string | null) => void

  // ── Background extraction bookkeeping ──
  _memExtractionInProgress: boolean
  _lastMemExtractionTime: number

  // ── Loop control & collaborators ──
  compactor: ContextCompactor
  continueLoop: () => Promise<void>
  cancelLoop: () => void
  resumeExecution: () => void
  /** 多专家 @召唤：the turn ended without a plan — one corrective re-issue is
   *  owed. True means the caller must NOT close the turn (the engine is about
   *  to re-run it). See AgentEngine.nudgeSummonIfUnplanned. */
  nudgeSummonIfUnplanned: () => boolean
}
