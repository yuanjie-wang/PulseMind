// ── ToolExecContext: what the extracted executor modules may touch ──
// tool-executors.ts used to be one 1100-line class; the per-domain
// implementations now live in executors/*.ts as free functions that receive
// this context instead of reaching into the class. ToolExecutor implements
// it — the compiler keeps the surface honest (same pattern as EngineCore).

import type { ToolUseBlock } from '../../types/agent'
import type { AgentEngineOptions } from '../AgentEngine'
import type { SpawnSubAgentFn } from '../tool-executors'
import type { Plan, PlanNodeExecutionStatus } from '../../../../shared/types/plan'

/** Tool-block output preview cap shared by executors and the engine. */
export const UI_PREVIEW_MAX = 3000

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
  /** Long-running exec tools report the spawned pid (terminal card wiring). */
  onProcessStart?: (pid: string) => void
  /** Format exec tool result with exit code and stdout/stderr separation. */
  formatExecResult(exitCode: number | null, stdout: string, stderr: string): string
}

export type { ToolUseBlock }
