/**
 * Plan DAG model (PLAN-plan-dag). A plan is a dependency graph of nodes; the
 * ready set — pending nodes whose dependencies are all completed — is what the
 * main agent fans out to expert sub-agents in parallel.
 *
 * Stored statuses are the only truth: 'ready' and 'blocked' are DERIVED
 * (shared/plan/graph.ts) and never persisted, so storage and derivation cannot
 * disagree. Acceptance (status) is separate from execution: the parent spawn
 * executor records an attempt's lifecycle, but settlement is PlanManager's
 * alone — via advance_plan or (since PLAN-plan-scheduler) the auto-scheduler.
 */

export type PlanNodeStatus = 'pending' | 'blocked' | 'completed' | 'failed' | 'skipped' | 'split'
// 'blocked' is direct-mode (todo_write) vocabulary: live work waiting on
// something outside the agent's control. It is NOT terminal (the plan stays
// open, isTerminal excludes it) and it never reaches a delegated plan — the
// DAG has no minting path for it; delegated blocked-ness is DERIVED
// (graph.ts blockedNodes: dead dependencies), never stored.

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
  /** Split generation (PLAN-plan-split P5): 0/absent = an original node —
   *  splittable; 1 = itself the product of a split — NOT splittable
   *  (MAX_SPLIT_GEN). The termination bound for dynamic splitting: the spawn
   *  prompt only carries the proposal protocol for gen-0 nodes, so a gen-1
   *  child structurally cannot propose, and mergeSplitProposal re-checks at
   *  runtime. */
  gen?: number
  /** The completed node's output text (capped at NODE_HANDOFF_MAX), captured
   *  at the spawn choke point (PLAN-plan-scheduler S8) — the downstream
   *  hand-off medium. Written only on successful delivery (CAS on attemptId,
   *  same discipline as execution), persisted with plan_json, and injected
   *  into each dependent spawn's prompt as `## 前序节点处理结果`.
   *  Absent = nothing to hand over (legacy/manual completion), where
   *  consumers fall back to `summary`. */
  handoff?: string
  /** Authored at plan creation (PLAN-plan-exchange E2): the node's extra
   *  report-format requirements, injected into its spawn's admission
   *  contract on top of the standard skeleton. */
  reportSpec?: string
  /** The system-minted report file this node delivered (PLAN-plan-exchange
   *  E3), recorded by the spawn choke point after the mechanical existence
   *  check; downstream spawns receive it verbatim and `read` it themselves. */
  reportPath?: string
  /** The sub-agent's self-declared outcome (E4) — advisory DATA for the
   *  downstream reader, never plan state: delivery still settles completed. */
  declaredStatus?: 'success' | 'partial' | 'failed'
}

export interface Plan {
  objective: string
  nodes: PlanNode[]
  completed: boolean
  /** Migration discriminator: a persisted plan without this field is linear v1. */
  version: 2
  /** delegated (default): ready nodes spawn to experts; direct: the main agent executes them itself. */
  mode?: 'direct' | 'delegated'
  /** The node the main agent is working on NOW (todo_write's in_progress mark,
   *  direct mode only). One at a time; cleared when the node settles or drops
   *  off the list. Deliberately NOT `execution.status` — that field carries
   *  the attempt CAS contract (attemptId, scheduler settle), which a
   *  never-dispatched todo node must not grow. */
  currentNodeId?: string
  /** Exchange-area identity (PLAN-plan-exchange E1): `<workspace>/.pulsemind/plans/<id>/`.
   *  Minted at create/migrate, lazily on legacy plans by PlanManager at
   *  dispatch (which always saves the plan). Absent on plans never dispatched. */
  id?: string
}
