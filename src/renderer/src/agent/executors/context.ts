// ── ToolExecContext: what the extracted executor modules may touch ──
// tool-executors.ts used to be one 1100-line class; the per-domain
// implementations now live in executors/*.ts as free functions that receive
// this context instead of reaching into the class. ToolExecutor implements
// it — the compiler keeps the surface honest (same pattern as EngineCore).

import type { ToolUseBlock } from '../../types/agent'
import type { AgentEngineOptions } from '../AgentEngine'
import type { SpawnSubAgentFn } from '../tool-executors'
import type { SkillKeywordAgent } from '../one-shot-agent'
import type { Plan, PlanNodeExecutionStatus } from '../../../../shared/types/plan'
import type { SplitChildSpec } from '../../../../shared/plan/split-proposal'

/** Tool-block output preview cap shared by executors and the engine. */
export const UI_PREVIEW_MAX = 3000

// ── context_compact (PLAN-context-compact-tool) ──────────────────────
/** The tool's parsed call: the main action (instruction / notes / bare) and
 *  the orthogonal light action (freeResults = tool_use ids to compress to
 *  placeholders), both optional and combinable. */
export interface CompactToolRequest {
  instruction?: string
  notes?: string
  freeResults?: string[]
}

/** Structured outcome — the executor turns it into the model-facing envelope;
 *  guards never throw. */
export interface CompactToolOutcome {
  ok: boolean
  /** Why the main action was refused (absent on success). */
  reason?: 'request_in_flight' | 'already_this_turn' | 'not_worthwhile' | 'nothing_to_drop'
  /** free_results ids accepted for mandated compression. */
  freedResults?: string[]
  /** free_results ids skipped, with the guard that skipped them. */
  skippedIds?: Array<{ id: string; reason: string }>
  droppedMessages?: number
  tokensBefore?: number
  tokensAfter?: number
  /** A history summary rides the upcoming requests. */
  summaryLanded?: boolean
  /** The model's own note verbatim-made it into the landed summary text. */
  notesKept?: boolean
  /** Live readings for the not_worthwhile refusal message. */
  tokens?: number
  window?: number
}

export interface ToolExecContext {
  opts: AgentEngineOptions
  addToolResult: (toolUseId: string, content: string, isError: boolean, imageData?: string, maxTokens?: number) => void
  notify: () => void
  spawnSubAgent?: SpawnSubAgentFn
  /** Live plan accessor — spawn_agent validates its planNode against it so the
   *  create_plan → spawn_agent → advance_plan chain shares one numbering. */
  getPlan?: () => Plan | null
  /** Record the sub-conversation a dispatched node runs in (PLAN-workbench W12).
   *  Routed through PlanManager so the plan keeps its single writer. */
  linkPlanNode?: (ref: string | number, subConvId: string) => void
  /** Parent-owned, attempt-scoped lifecycle; never settles acceptance. */
  beginPlanNodeExecution?: (ref: string | number, attemptId: string) => void
  updatePlanNodeExecution?: (ref: string | number, attemptId: string, status: PlanNodeExecutionStatus, subConvId?: string) => void
  /** CAS the delivered node's output onto the plan as its handoff — the
   *  downstream hand-off medium (PLAN-plan-scheduler S8). Routed through
   *  PlanManager like every other plan write. */
  recordNodeHandoff?: (ref: string | number, attemptId: string, text: string) => boolean
  /** Stamp a node's delivered report file + self-declared outcome onto the
   *  plan (PLAN-plan-exchange E3) — CAS on attemptId, same discipline. */
  recordNodeReport?: (
    ref: string | number, attemptId: string, reportPath: string, declaredStatus?: 'success' | 'partial' | 'failed',
  ) => boolean
  /** Merge a validated split proposal into the live plan (PLAN-plan-split
   *  P3/P8) — the plan's third write policy. The graph layer gates CAS on
   *  attemptId / gen cap / node budget and rejects whole-unit; `ok: false`
   *  carries the model-facing rejection reason for the failure envelope. */
  mergeSplitProposal?: (
    ref: string | number, attemptId: string, children: SplitChildSpec[], reason?: string,
  ) => { ok: true; nodeIds: string[] } | { ok: false; reason: string }
  /** create_sub_plan's channel (PLAN-plan-split v2 R6): merge the sub-agent's
   *  proposed subtasks into the PARENT plan via spawn-manager's bridge.
   *  Implemented on ToolExecutor (opts.spawnPlanSplit gate + parentPlanMerge);
   *  absent on engines without the opt — the tool isn't in their toolset
   *  anyway. */
  createSubPlan?: (
    children: SplitChildSpec[], reason?: string,
  ) => { ok: true; nodeIds: string[] } | { ok: false; reason: string }
  /** 单专家 @召唤的结论原文交付：the executor hands the finished expert's text to
   *  the engine, which delivers it as the turn's own assistant message instead
   *  of letting another LLM round re-summarize it (which loses information).
   *  Returns true when the engine ACCEPTED it — which happens only for the
   *  delegation the engine dispatched itself (`startDelegatedLoop`), so a
   *  model-emitted spawn_agent never closes a turn this way. A true return also
   *  means the conclusion travels as the assistant message, so the executor
   *  must keep its tool result short rather than repeat the text. */
  deliverExpertConclusion?: (toolUseId: string, text: string) => boolean
  /** spawn_agent calls in the current round — the shared envelope budget's
   *  denominator (see executors/spawn-tool.ts spawnEnvelopeBudget). Absent
   *  reads as a single-dispatch round. */
  spawnBatchTotal?: () => number
  /** Whether THIS engine is itself a spawned sub-agent — i.e. a spawn_agent
   *  call here is a NESTED dispatch. A getter, not a snapshot: the flag is set
   *  on the engine AFTER its ToolExecutor exists (spawn-manager), so a
   *  constructor-time boolean would read false on every sub-agent. A nested
   *  dispatch takes the no-queue slot path (tryAcquireSubAgentSlot) — a
   *  slot-holder waiting for a slot is the circular wait that deadlocked a
   *  whole session (2026-09-29); absent reads as top-level. */
  isSpawnedSubAgent?: () => boolean
  /** Long-running exec tools report the spawned pid (terminal card wiring). */
  onProcessStart?: (pid: string) => void
  /** context_compact's channel into the engine (PLAN-context-compact-tool):
   *  guards, the prewarm with the model's instruction/notes, and the
   *  free_results mandate all live engine-side — the executor only formats
   *  the outcome into the envelope. Absent (test stubs) = the tool refuses. */
  compactContext?: (call: CompactToolRequest) => Promise<CompactToolOutcome>
  /** The one-shot agent behind install's fire-and-forget keyword backfill.
   *  Optional: absent (tests) skips the extraction entirely. */
  skillKeywordAgent?: SkillKeywordAgent
  /** Free-form spawn ledger (2026-10-27): normalized task signature → the
   *  LAST dispatch's outcome, per session (one executor per engine, so the
   *  ledger is naturally per-session the way readFilePaths is). The
   *  re-dispatch gate reads it to refuse re-running a task this session
   *  already COMPLETED — the mimo incident (five identical re-dispatches of
   *  a finished translation) is what all three layers of prose could not
   *  prevent. Optional so old test fakes construct; the gate skips when
   *  absent. Plan-node spawns never enter the ledger: their retries ARE the
   *  protocol (the failure envelope instructs re-dispatch), and the
   *  scheduler's own gates own that path. */
  spawnTaskResults?: Map<string, 'completed' | 'failed' | 'aborted'>
  /** Verify-streak exec-side reset (2026-10-27 验证闭环): a completed exec
   *  whose command looks like verification (test/lint/build — isVerifyExecCommand)
   *  clears the source-edit streak, at BOTH dispatch points — execSkillCommand's
   *  auto path and approveTool's released-shell path. A failed test run resets
   *  too: the failure itself is the lesson. Optional so old test fakes construct. */
  noteVerifyExec?(command: string): void
  /** Format exec tool result with exit code and stdout/stderr separation. */
  formatExecResult(exitCode: number | null, stdout: string, stderr: string): string
}

export type { ToolUseBlock }
