// ── PlanScheduler: the delegated plan's code-driven orchestrator ──
// (PLAN-plan-scheduler S4/S5). Before it, EVERY intermediate step of a
// delegated plan cost an LLM round: the model transcribed the READY set,
// spawn_agent'd it, then had to call advance_plan before anything moved.
// This layer performs those steps itself as one synchronous, single-step
// `kick()` per event — a drain, a turn end, a resume — reading the decision
// from shared/plan/schedule.ts (`nextScheduleAction`) and executing it:
// settle through PlanManager (still the plan's only writer), dispatch as a
// synthetic spawn batch shaped exactly like AgentEngine.startDelegatedLoop's
// (byte-for-byte the blocks a model emits, so the spawn machinery — slot
// limiter, approvals, stop/pause — applies unchanged), and since 2026-09-30
// CHAIN a settled node's ready dependents alongside the still-draining wave
// (user ruling 「不应该浪费槽」) through dispatchConcurrent.
//
// The contract with its callers is one boolean:
//   true  → the scheduler owns the turn: it dispatched/chained (or an attempt
//           is in flight). The caller must NOT continueLoop / close the turn;
//           the next kick arrives from the batch's own drain (event-driven
//           loop, no running flag — JS is single-threaded and the dispatch's
//           sync prefix sets pendingToolIds before kick returns).
//   false → not the scheduler's turn: the caller runs the ordinary LLM round.
//           That is where every remaining consult naturally lands — a failed
//           node (decision round) and the closed plan (final synthesis).
//
// Applicability rides nextScheduleAction (plan open, delegated mode) plus the
// engine gates below, so a direct-mode plan, a sub-agent's own in-prompt plan
// and a cancelled engine all fall straight through to normal LLM behaviour.

import type { EngineCore } from './engine-core'
import { nextScheduleAction, type ScheduleAction } from '../../../../shared/plan/schedule'
import type { PlanNode } from '../../../../shared/types/plan'
import type { ToolUseBlock } from '../../types/agent'
import { generateMsgId } from '../agent-utils'
import { queuedSubAgentCount, subAgentBudgetKey } from './subagent-limiter'

export class PlanScheduler {
  constructor(private engine: EngineCore) {}

  /** One scheduler step. Returns true when the caller must not run its own
   *  continuation (LLM round / turn close) — see the header. `midDrain` marks
   *  the batch-tail call: chained calls are still registered in the engine's
   *  pending set, so a clean `dispatch` is FORBIDDEN — it would re-enter
   *  handleToolUseResponse and clobber the live accounting
   *  (`pendingToolIds = new Set(新批 ids)`), the exact hazard
   *  settleAndChain's comment warns about (review_20260930 中5; today the
   *  claim lands in the same microtask so 'dispatch' is unreachable here,
   *  but a future host whose expertList does real I/O opens the window).
   *  The drain's own tail re-kicks when the in-flight calls settle. */
  kick(opts?: { midDrain?: boolean }): boolean {
    const engine = this.engine
    // Applicability gates. A cancelled engine (stop/pause) must not be revived
    // by a synthetic dispatch; a spawned sub-agent's plan stays model-driven
    // (user ruling: 子代理内建图维持模型驱动); a pending verbatim reply is a
    // single-expert @-summon's conclusion and continueLoop owns that turn.
    // No apiKey gate (review_20261028 高1): `opts.apiKey` is legitimately empty
    // for local providers (ollama/LM Studio) — the same gate was removed from
    // approveTool for exactly that reason (execution-flow.ts, the M1.4 note) —
    // and spawned experts ride the same api-proxy profile resolution as their
    // parent, so an empty key here never meant "doomed to fail". What it DID
    // mean: kick() returned false while spawn-tool's scheduler-ownership gate
    // rejected the model's own manual dispatch of a never-started READY node —
    // two individually correct gates stacking into a deadlock with no legal
    // start path, and the stale-attempt demotion below skipped with it.
    if (engine.isCancelled || engine.isSpawnedSubAgent) return false
    if (engine.pendingVerbatimReply !== null) return false

    const action = this.settleAll(nextScheduleAction(engine.planManager.plan))

    switch (action.type) {
      case 'dispatch':
        if (opts?.midDrain) return true
        this.dispatch(action.nodes)
        return true
      case 'chain':
        this.dispatchConcurrent(action.nodes)
        return true
      case 'wait': {
        // In-flight attempt owns the turn only while something really is
        // running — its result re-kicks via the drain. A queued/running
        // execution with no live spawn behind it is STALE: plan_json recorded
        // it and the app restarted mid-run. Nothing will ever settle that, so
        // demote it to 'stopped' — the same consult an interrupted attempt
        // owes the model — instead of waiting forever.
        if (this.hasLiveWork()) return true
        for (const node of action.nodes) {
          if (node.execution) engine.planManager.updateNodeExecution(node.id, node.execution.attemptId, 'stopped')
        }
        console.log(`[PlanScheduler] stale attempt(s) ${action.nodes.map(n => n.id).join(', ')} demoted to stopped — consulting the model`)
        return false
      }
      case 'consult':
        console.log(`[PlanScheduler] consulting the model: ${action.nodes.map(n => n.id).join(', ')} failed`)
        return false
      default:
        // Closed plan / direct mode / everything blocked → the ordinary LLM
        // round (the final synthesis falls out of a completed plan this way).
        return false
    }
  }

  /** Mid-drain entry, fired from addToolResult after EVERY result that did not
   *  close the drain (2026-09-30): a delivered node settles immediately and
   *  its ready dependents chain into the freed slots instead of idling behind
   *  the whole-wave barrier. Deliberately NEVER drives a continuation — the
   *  live drain owns the turn, and consult/wait/dispatch need a clean drain,
   *  which is the batch tail's kick. Cheap when no plan is in play: the
   *  applicability gates no-op the whole call. */
  settleAndChain(): void {
    const engine = this.engine
    if (engine.isCancelled || engine.isSpawnedSubAgent) return
    if (engine.pendingVerbatimReply !== null) return
    const action = this.settleAll(nextScheduleAction(engine.planManager.plan))
    // chain only — a clean `dispatch` here would re-enter handleToolUseResponse
    // while an engine batch is still live and clobber its drain accounting.
    if (action.type === 'chain') this.dispatchConcurrent(action.nodes)
  }

  /** Settle re-evaluates in place: it is synchronous and its outcome (a wave
   *  unblocked, the plan closed) changes what comes next, and no external
   *  event fires between now and then. The loop cannot spin — autoSettle only
   *  accepts delivered+pending nodes, so each pass retires at least one; the
   *  settledAny guard makes even a hypothetical no-op pass fall through to a
   *  normal LLM round rather than loop. */
  private settleAll(action: ScheduleAction): ScheduleAction {
    const engine = this.engine
    while (action.type === 'settle') {
      let settledAny = false
      for (const node of action.nodes) {
        if (engine.planManager.autoSettle(node.id)) {
          settledAny = true
          console.log(`[PlanScheduler] settled ${node.id} (delivered, no LLM round)`)
        }
      }
      if (!settledAny) break
      action = nextScheduleAction(engine.planManager.plan)
    }
    return action
  }

  /** True while a node attempt has a spawn behind it: a running or queued
   *  sub-engine, a slot queue wait, or the parent's own batch still draining. */
  private hasLiveWork(): boolean {
    const engine = this.engine
    return engine.activeSubAgents.size > 0
      || engine.isAutoExecuting
      || engine.pendingToolIds.size > 0
      || queuedSubAgentCount(subAgentBudgetKey(engine.opts)) > 0
  }

  /** Mint this wave's spawn_agent blocks — the same shape the clean-drain
   *  dispatch and the mid-drain chain both send through the spawn machinery.
   *  autoDispatch stamps the scheduler's own calls so spawn-tool's
   *  scheduler-ownership gate (manual spawn of a never-started READY node is
   *  rejected) lets them through — the gate's whole point is that THIS path,
   *  not the model, owns those dispatches. */
  private mintCalls(nodes: PlanNode[]): ToolUseBlock[] {
    return nodes.map((node, i) => ({
      id: `toolu_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 9)}`,
      type: 'tool_use',
      name: 'spawn_agent',
      input: {
        task: node.description,
        ...(node.assignee ? { subAgentId: node.assignee } : {}),
        planNode: node.id,
        autoDispatch: true,
      },
      status: 'pending',
    }))
  }

  /** Mint this wave's spawn_agent blocks and run them through the same
   *  choke point model-emitted calls take — handleToolUseResponse — so the
   *  batch's drain re-enters kick and the loop closes without an LLM round
   *  between waves. The assistant message is part of the shape: the collector
   *  expects results to follow a tool_use message, and the transcript should
   *  show who dispatched what. */
  private dispatch(nodes: PlanNode[]): void {
    const engine = this.engine
    const calls = this.mintCalls(nodes)
    console.log(`[PlanScheduler] dispatching ${nodes.map(n => n.id).join(', ')} (auto, no LLM round)`)
    engine.messages = [...engine.messages, {
      id: generateMsgId(),
      role: 'assistant',
      contentBlocks: calls,
      createdAt: new Date().toISOString(),
    }]
    engine.agentStatus = { status: 'executing', toolUseId: calls[0].id }
    engine.notify()
    void engine.handleToolUseResponse(calls).catch((err: unknown) => {
      console.error('[PlanScheduler] synthetic dispatch failed:', err)
      engine.agentStatus = { status: 'error', error: err instanceof Error ? err.message : 'Plan dispatch failed' }
      engine.notify()
    })
  }

  /** Chain ready nodes alongside the LIVE drain (2026-09-30, 「不应该浪费槽」):
   *  same synthetic spawn_agent shape as dispatch(), but deliberately NOT
   *  through handleToolUseResponse — that call assigns the engine's whole
   *  batch state (pendingToolIds / toolUseBlocks / isAutoExecuting) and a
   *  second live batch would clobber the drain still in progress. The chained
   *  calls register INTO the live accounting and run detached through the
   *  same executor a batch uses (the approveTool path is the precedent), so
   *  the slot limiter, the plan-node CAS and the stop/pause settle all apply
   *  unchanged; at the width cap the dispatch queues FIFO exactly like a
   *  wide wave does. Their results drain through addToolResult's ordinary
   *  tail — which re-enters here and closes the turn when the last one
   *  lands. The transcript interleaves with the parent batch's results;
   *  prepareLoopRequest's regroup repairs the wire shape per request. */
  private dispatchConcurrent(nodes: PlanNode[]): void {
    const engine = this.engine
    const calls = this.mintCalls(nodes)
    console.log(`[PlanScheduler] chaining ${nodes.map(n => n.id).join(', ')} alongside the live drain (auto, no LLM round)`)
    engine.messages = [...engine.messages, {
      id: generateMsgId(),
      role: 'assistant',
      contentBlocks: calls,
      createdAt: new Date().toISOString(),
    }]
    for (const call of calls) {
      // The live batch owns agentStatus — do not clobber its toolUseId.
      call.status = 'running'
      engine.toolUseBlocks.push(call)
      engine.pendingToolIds.add(call.id)
    }
    engine.notify()
    for (const call of calls) {
      void engine.toolExecutor.execSpawnAgent(call).catch((err: unknown) => {
        console.error('[PlanScheduler] chained spawn failed:', err)
        call.status = 'completed'
        call.exitCode = -1
        engine.addToolResult(call.id, `Error: ${err instanceof Error ? err.message : 'spawn_agent failed'}`, true)
      })
    }
  }
}
