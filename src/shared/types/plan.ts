/**
 * Plan DAG model (PLAN-plan-dag). A plan is a dependency graph of nodes; the
 * ready set — pending nodes whose dependencies are all completed — is what the
 * main agent fans out to expert sub-agents in parallel.
 *
 * Stored statuses are the only truth: 'ready' and 'blocked' are DERIVED
 * (shared/plan/graph.ts) and never persisted, so storage and derivation cannot
 * disagree. Acceptance (status) is separate from execution: the parent spawn
 * executor records an attempt's lifecycle, but only advance_plan settles it.
 */

export type PlanNodeStatus = 'pending' | 'completed' | 'failed' | 'skipped'

export type PlanNodeExecutionStatus = 'queued' | 'running' | 'delivered' | 'failed' | 'stopped'

export interface PlanNodeExecution {
  /** Parent-issued dispatch identity; never reuse it for a retry. */
  attemptId: string
  status: PlanNodeExecutionStatus
}

export interface PlanNode {
  /** Stable protocol id `n1`..`n20`, assigned by input order in create_plan. */
  id: string
  description: string
  status: PlanNodeStatus
  /** Optional for persisted legacy plans; delivery is NOT acceptance. */
  execution?: PlanNodeExecution
  /** Prerequisite node ids — internal form; the tool protocol carries 1-based indexes. */
  dependsOn: string[]
  /** Expert id this node is delegated to (spawn_agent's subAgentId); undefined = a general sub-agent. */
  assignee?: string
  /** Assistant message that settled this node — PlanPanel jumps here. */
  msgId?: string
  /** One-line outcome note from advance_plan; shown in snapshots and the panel. */
  summary?: string
  /** Sub-conversation hosting the spawn that implements this node
   *  (PLAN-workbench W12). Written when spawn_agent claims the node, so the
   *  graph's node click can open that session. The plan is deliberately the
   *  carrier: it is the one part of the link that is persisted and survives a
   *  restart, whereas the tool block's own copy rides the live status diff and
   *  can disappear with the assistant message when history is compacted. */
  subConvId?: string
}

export interface Plan {
  objective: string
  nodes: PlanNode[]
  completed: boolean
  /** Migration discriminator: a persisted plan without this field is linear v1. */
  version: 2
  /** delegated (default): ready nodes spawn to experts; direct: the main agent executes them itself. */
  mode?: 'direct' | 'delegated'
}
