// ── spawn_agent implementation (moved out of ToolExecutor 0.4.1) ──
// Profile/expert resolution, prompt composition, delegation via
// ToolExecContext.spawnSubAgent, and result summarization for the parent.

import { getHost } from '../host'
import {
  composeExpertInstructions,
  GENERAL_SUBAGENT_PROMPT,
  toExpertRefCatalogs,
  type ExpertRefCatalogs,
} from '../../../../shared/expert-context'
import { nodeNumberOf, resolveNodeRef } from '../../../../shared/plan/graph'
import type { Plan, PlanNode, PlanNodeExecutionStatus } from '../../../../shared/types/plan'
import { getCachedMcpServers } from '../mcp-cache'
import {
  getSubAgentParallelLimit,
  acquireSubAgentSlot,
  activeSubAgentCount,
  queuedSubAgentCount,
  subAgentBudgetKey,
} from '../engine/subagent-limiter'
import type { ToolExecContext } from './context'
import type { ExpertProfile } from '../../../../shared/types/expert'
import type { ToolUseBlock, TextBlock } from '../../types/agent'
import { MAX_TOOL_RESULT_TOKENS, SPAWN_ROUND_ENVELOPE_BUDGET, MIN_SPAWN_ENVELOPE_BUDGET } from '../engine/engine-constants'

/** spawn_agent: assistant text fed back to the parent. */
const SUBAGENT_TEXT_MAX = 10_000

/** Per-envelope token budget for a round that dispatched `batchTotal`
 *  spawn_agent calls. A round's envelopes all land in ONE collector user
 *  message (addToolResult's collector shape), and that message sits inside
 *  every compaction layer's protection window — nanoCompact needs 20+ spawn
 *  calls before it compresses one, light/hard truncate guard the newest
 *  rounds — so the batch's total is what the next request must carry. The
 *  round shares SPAWN_ROUND_ENVELOPE_BUDGET; each envelope gets its floor,
 *  clamped to the single-result cap. Truncation keeps the envelope's tail
 *  (the close-out) and offloads the full text for `read`/tool_result_search. */
export function spawnEnvelopeBudget(batchTotal: number): number {
  const n = Math.max(1, Math.floor(batchTotal) || 1)
  return Math.max(MIN_SPAWN_ENVELOPE_BUDGET, Math.min(MAX_TOOL_RESULT_TOKENS, Math.floor(SPAWN_ROUND_ENVELOPE_BUDGET / n)))
}

/** 可用能力目录：技能取本会话的 SkillManager，连接器取同步的 MCP 缓存。
 *  都读不到时把字段留空 → 指令里按 profile 记的名字原样列出。 */
function resolveRefCatalogs(ex: ToolExecContext): ExpertRefCatalogs {
  const skills = ex.opts.skillManager?.getAll().map((s) => s.definition)
  return toExpertRefCatalogs({
    skills,
    connectors: getCachedMcpServers().map((s) => ({ id: s.id, name: s.name, summary: s.summary })),
  })
}

// ── Spawn agent tool ───────────────────────────────────────────────────

export async function execSpawnAgent(ex: ToolExecContext, t: ToolUseBlock): Promise<void> {
  t.status = 'running'; ex.notify()
  let planNode: PlanNode | null = null
  let dispatchPlan: Plan | null = null
  // Tool ids can be replayed on retry; each executor invocation gets a new id.
  const attemptId = `${t.id}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
  let attemptStarted = false
  const execution = (status: PlanNodeExecutionStatus, subConvId?: string): void => {
    if (attemptStarted && planNode && ex.getPlan?.() === dispatchPlan) {
      ex.updatePlanNodeExecution?.(planNode.id, attemptId, status, subConvId)
    }
  }
  try {
    const subAgentId = String(t.input?.subAgentId || '').trim()
    const task = String(t.input?.task || '')
    if (!task.trim()) throw new Error('task is required')

    // Capability comes from the delegated pack: 可用技能 / 可用连接器 narrow the
    // sub-agent's toolset, everything else (tools, run parameters) is inherited
    // from the host session. Run parameters (model / token budget / loop cap)
    // come from the host too, so the delegated engine budgets like it.
    let profile: ExpertProfile | null = null
    if (subAgentId) {
      try {
        const profiles = await getHost().expertList()
        profile = profiles.find((p) => p.id === subAgentId) || null
        if (profile && profile.enabled === false) {
          throw new Error(`专家 "${profile.name || subAgentId}" 已关闭，请在能力中心 → 专家 中启用后再使用`)
        }
        if (!profile) {
          console.warn(`[execSpawnAgent] Expert "${subAgentId}" not found, falling back to a general sub-agent`)
        }
      } catch (err) {
        // A disabled expert is a user-visible rejection, not a lookup miss —
        // rethrow it; any other failure (IPC hiccup) degrades to the default.
        if (err instanceof Error && err.message.includes('已关闭')) throw err
      }
    }

    // Plan linkage (PLAN-plan-dag): the delegated task names the plan node it
    // implements, so create_plan numbering, spawn dispatch and advance_plan
    // settlement all speak the same ids. Validated against the LIVE plan — a
    // stale/unknown number is a model error, not a silent no-op.
    const planNodeRaw = t.input?.planNode
    if (planNodeRaw !== undefined && planNodeRaw !== null && planNodeRaw !== '') {
      const plan = ex.getPlan?.()
      if (!plan) throw new Error('planNode was given but no plan is active — call create_plan first, or drop planNode.')
      planNode = resolveNodeRef(plan, planNodeRaw as string | number)
      if (!planNode) throw new Error(`Unknown planNode "${String(planNodeRaw)}" — valid: n1..n${plan.nodes.length}.`)
      if (planNode.status !== 'pending') throw new Error(`Plan node ${planNode.id} is already ${planNode.status} — pick a node from the READY set.`)
      dispatchPlan = plan
      ex.beginPlanNodeExecution?.(planNode.id, attemptId)
      attemptStarted = true
    }

    // Expert config pack: compose the structured sections instead of a bare
    // basePrompt. Its capability whitelists travel to the spawned engine as
    // allowedSkills / allowedMcpServers so both runtimes restrict identically.
    const basePrompt = profile?.basePrompt || ''
    const expertBlock = profile
      ? composeExpertInstructions(
          {
            name: profile.name || subAgentId,
            basePrompt,
            methodology: profile.methodology,
            outputSpec: profile.outputSpec,
            constraints: profile.constraints,
            skillNames: profile.skillNames,
            mcpServerIds: profile.mcpServerIds,
          },
          resolveRefCatalogs(ex)
        )
      : GENERAL_SUBAGENT_PROMPT

    // Append available skills context (narrowed to the expert's whitelist).
    // skillsDir makes the <location> entries absolute — a relative
    // `office/SKILL.md` gives a sub-agent no root to derive companion-file
    // paths from (the sub-agent prompt carries no env block to supply one).
    let skillsCtx = ''
    try {
      const skillsAppendix = ex.opts.skillManager?.getSystemPromptAppendix(ex.opts.skillsDir, profile?.skillNames)
      if (skillsAppendix) skillsCtx = '\n\n' + skillsAppendix
    } catch { /* non-critical */ }

    // The sub-agent gets its node's scope spelled out so it does not drift
    // into the rest of the plan.
    const taskText = planNode
      ? `${task}\n\n(You are executing plan node ${planNode.id} of a larger plan — scope your work to this node only.)`
      : task
    const systemPrompt = `${expertBlock}\n\n## Your Task\n${taskText}${skillsCtx}`

    console.log(`[spawn_agent] subAgentId="${subAgentId || '(general)'}" prompt length=${systemPrompt.length} first 200 chars:`, systemPrompt.slice(0, 200))
    t.output = `Spawning sub-agent for task: ${task.slice(0, 100)}...`
    ex.notify()

    // 并行专家上限（PLAN-parallel-experts P2，用户裁定 2026-09-16：同一会话最多 5 个；
    // 计划文档在 _task/20260916/PLAN-parallel-experts.md）。
    // The slot is taken AFTER validation (a bad planNode must fail fast, not
    // after queueing behind five long experts) and held for the whole
    // dispatch — i.e. across `waitForCompletion` below. See the header of
    // engine/subagent-limiter.ts for why that is the shape that survives
    // pause/resume and stop.
    const budgetKey = subAgentBudgetKey(ex.opts)
    const busy = activeSubAgentCount(budgetKey)
    const queued = queuedSubAgentCount(budgetKey)
    const parallelLimit = getSubAgentParallelLimit()
    if (busy >= parallelLimit || queued > 0) {
      t.output = `排队中：本会话已有 ${busy} 个专家在运行（上限 ${parallelLimit} 个），前面还有 ${queued} 个等待空位…`
      ex.notify()
    }
    const release = await acquireSubAgentSlot(budgetKey)
    if (!release) {
      // The session was stopped while this expert waited in line. Starting it
      // now would run work the user just cancelled.
      execution('stopped')
      t.exitCode = -1
      t.status = 'completed'
      ex.addToolResult(t.id, '子代理未启动：本次执行已被停止。', true)
      ex.notify()
      return
    }

    try {
      // 可用能力白名单：有专家包就原样给出（空数组 = 一个都不许用）；
      // 没有专家包（通用子代理）才留 undefined，表示不限制。
      const handle = ex.spawnSubAgent!({
        systemPrompt,
        initialMessages: [],
        title: `${profile?.name || '子代理'}: ${task.slice(0, 60)}`,
        allowedSkills: profile ? profile.skillNames ?? [] : undefined,
        allowedMcpServers: profile ? profile.mcpServerIds ?? [] : undefined,
        maxTokens: ex.opts.maxTokens,
        // An independent task's actual length (PLAN-parallel-experts T8/L12).
        // The expert ERRORS at this limit instead of silently renewing — a
        // never-ending expert burns tokens forever, the parent's batch never
        // returns, and the FIFO slot queue wedges behind it.
        maxLoopIterations: 40,
        onProgress: (summary) => {
          // Rolling activity log (cap 8 lines) so the user sees the sub-agent moving live.
          const lines = (t.output || '').split('\n')
          lines.push(summary)
          while (lines.length > 8) lines.shift()
          t.output = lines.join('\n')
          ex.notify()
        },
      })

      // Set the sub-conversation link immediately so it survives an app restart
      // mid-run. It is written on the TOOL BLOCK (for the card's preview button,
      // which reads it off the block) and on the PLAN NODE (for the DAG's node
      // click, which needs a link that outlives message history). The block copy
      // reaches a client only through the tool_status diff — spawn-tool runs in
      // the main process, and the message snapshot was shipped before this point.
      t.subConvId = handle.subConvId
      if (planNode) {
        // Plan linkage marker (UI/telemetry hook): which plan node this spawn implements.
        t.planNodeId = planNode.id
        if (ex.updatePlanNodeExecution) execution('running', handle.subConvId)
        else if (ex.getPlan?.() === dispatchPlan) ex.linkPlanNode?.(planNode.id, handle.subConvId)
      }
      // Keep handle reference for live preview while the sub-agent is running.
      // Non-enumerable so JSON.stringify skips it — avoids serializing the entire engine state.
      Object.defineProperty(t, '_subAgentHandle', { value: handle, writable: true, enumerable: false, configurable: true })
      ex.notify()

      const result = await handle.waitForCompletion()
      execution(result.status === 'completed' ? 'delivered' : result.status === 'aborted' ? 'stopped' : 'failed')
      const subAssistantTexts = result.messages
        .filter(m => m.role === 'assistant')
        .flatMap(m => m.contentBlocks)
      const subText = subAssistantTexts.filter(b => b.type === 'text').map(b => (b as TextBlock).text).join('\n\n').slice(0, SUBAGENT_TEXT_MAX)
      const subTools = subAssistantTexts.filter(b => b.type === 'tool_use').map(b => `[tool_use: ${(b as ToolUseBlock).name}]`).join(', ')
      const expertName = profile?.name || subAgentId || '(general sub-agent)'
      // Shared round budget: this batch's envelopes split one allowance so a
      // wide parallel dispatch cannot append a window-busting collector message.
      const envelopeBudget = spawnEnvelopeBudget(ex.spawnBatchTotal?.() ?? 1)

      // 单专家 @召唤的结论原文进对话（用户裁定 2026-09-17：「能不能在主对话中直接
      // 输出专家的结论」——主 Agent 转述一遍会丢信息）。The engine accepts the
      // conclusion ONLY for the delegation it dispatched itself, so a
      // model-emitted spawn_agent can never close a turn verbatim; on
      // acceptance it travels as the turn's own assistant message, which is
      // why the tool result stays short here — the full text in both places
      // would be a duplicate 10k chars in every later request.
      const verbatim = result.status === 'completed' && !!subText.trim()
        && ex.deliverExpertConclusion?.(t.id, subText) === true
      if (verbatim) {
        t.exitCode = 0
        t.status = 'completed'
        ex.addToolResult(
          t.id,
          `## Sub-Agent Result (completed)\n\nDelegated to **${expertName}**. The expert's conclusion is delivered to the user verbatim as the message that follows — do NOT restate or summarize it.`,
          false,
          undefined,
          envelopeBudget
        )
        t.output = `子代理已完成. ${subText}`
      } else {
        const errorDetail = result.status !== 'completed'
          ? `\n\n### Sub-agent Status: ${result.status}\n` + (subText ? `**Partial Output:**\n${subText}` : '') + (subTools ? `\n**Tool Calls Attempted:** ${subTools}` : '')
          : ''
        let summary = result.status === 'completed'
          ? `## Sub-Agent Result (${result.status})\n\nThe sub-agent completed the delegated task.\n\n### Summary\n${subText}`
          : `## Sub-Agent Result (${result.status})\n\nThe sub-agent did not complete successfully.${errorDetail}`
        // Close the create_plan → spawn_agent → advance_plan loop in the model's
        // face: the result names the node and the exact settle call to make.
        if (planNode) {
          summary += `\n\n**Plan node ${planNode.id}** ("${planNode.description}") — settle it now with advance_plan action="complete" node=${nodeNumberOf(planNode)} (or "fail" / "skip" if it did not succeed).`
        }
        // Close-out instruction, deliberately the LAST bytes of the envelope:
        // the envelope reads like an intermediate artifact, and a weak model
        // answers it by delegating again — measured loop (2026-09-16, mimo):
        // five identical re-dispatches of an already-completed translation. The
        // model decides its next move off the end of this result, so the end
        // says what to do: report, don't re-run.
        summary += result.status === 'completed'
          ? '\n\n**This result is the deliverable.** Report it to the user in your own words and move on — do NOT re-dispatch the same or a near-identical task.'
          : '\n\n**Report this outcome to the user.** Do NOT silently re-dispatch the same task; retry only with a meaningfully different task description, or ask the user.'

        t.exitCode = result.status === 'completed' ? 0 : 1
        t.status = 'completed'
        ex.addToolResult(t.id, summary, result.status === 'error', undefined, envelopeBudget)
        t.output = `子代理已完成. ${subText}`
      }
    } finally {
      release()
    }
  } catch (err) {
    execution('failed')
    t.exitCode = -1
    t.status = 'completed'
    ex.addToolResult(t.id, `Error: ${err instanceof Error ? err.message : 'spawn_agent failed'}`, true)
  }
  ex.notify()
}
