// ── spawn_agent implementation (moved out of ToolExecutor 0.4.1) ──
// Profile/expert resolution, prompt composition, delegation via
// ToolExecContext.spawnSubAgent, and result summarization for the parent.

import { getHost } from '../host'
import { ENGINEERING_WORKFLOW } from '../system-prompt-builder'
import {
  composeExpertInstructions,
  GENERAL_SUBAGENT_PROMPT,
  toExpertRefCatalogs,
  type ExpertRefCatalogs,
} from '../../../../shared/expert-context'
import { formatUpstreamResults, nodeNumberOf, resolveReadyNode } from '../../../../shared/plan/graph'
import type { Plan, PlanNode, PlanNodeExecutionStatus } from '../../../../shared/types/plan'
import { getCachedMcpServers } from '../mcp-cache'
import {
  getSubAgentParallelLimit,
  acquireSubAgentSlot,
  activeSubAgentCount,
  queuedSubAgentCount,
  subAgentBudgetKey,
  tryAcquireSubAgentSlot,
} from '../engine/subagent-limiter'
import type { ToolExecContext } from './context'
import type { ExpertProfile } from '../../../../shared/types/expert'
import type { ToolUseBlock, TextBlock } from '../../types/agent'
import { MAX_TOOL_RESULT_TOKENS, SPAWN_ROUND_ENVELOPE_BUDGET, MIN_SPAWN_ENVELOPE_BUDGET } from '../engine/engine-constants'
import { getLoopIterationLimit } from '../agent-utils'

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
      // resolveReadyNode is the order gate: pending AND dependencies-completed.
      // A plain pending check here once let the model dispatch a node whose
      // upstream was still running — depends_on was advisory, not enforced.
      planNode = resolveReadyNode(plan, planNodeRaw as string | number)
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
    // Upstream hand-off (PLAN-plan-scheduler S8): the direct dependencies'
    // recorded output rides the prompt as data — the sub-agent has no state
    // block (spawnSystemPrompt branch → stateBlock null) and no tool to read
    // its ancestors, so without this the only channel is the parent model
    // transcribing upstream results into `task`, which is exactly the lossy
    // link this replaces. Read against the LIVE plan at dispatch time, like
    // the planNode gate above.
    const upstream = planNode ? formatUpstreamResults(ex.getPlan?.() ?? null, planNode) : null
    // The task rides the sub-agent's FIRST USER MESSAGE, not the system prompt
    // (user ruling 2026-09-25): the user can read what was delegated in the
    // sub-agent transcript, where the old shape showed only a fixed placeholder
    // and buried the task in an invisible prompt. The system prompt keeps the
    // invariant half — expert identity/methodology + the skills appendix —
    // so `spawnSystemPrompt` stays non-empty for every discriminator that
    // keys on it, and nothing volatile precedes the tool schemas.
    const taskMessage = `## 你的任务\n${taskText}${upstream ? `\n\n${upstream}` : ''}`
    // The engineering contract rides here too (PLAN-coding-contract, ruling
    // D1): sub-agents do the actual coding and must answer to the same
    // read-before-write / verify-before-claim rules as the main agent. A spawn
    // prompt is per-session with no shared cache prefix, so the append is free.
    // The environment block rides here for the same reason: the spawnSystemPrompt
    // branch returns stateBlock null (system-prompt-builder), so the `## Workspace`
    // and `## System Info` sections never reach a sub-agent — runtime inheritance
    // is fine (opts.workspaceDir rides the opts spread, relative paths resolve,
    // the ALS sandbox lands on the parent's dir), but the MODEL never sees the
    // path: it cannot name the directory in absolute paths, cannot say where its
    // files landed, and guesses `~/…` (which hits the deny root). skillsCtx
    // already fixed the identical problem for skill locations; this fixes it for
    // the workspace. Without a workspaceDir the line just stays out.
    const envLines: string[] = []
    if (ex.opts.workspaceDir) envLines.push(`- Workspace: ${ex.opts.workspaceDir} (relative file paths resolve here; the shell starts here)`)
    if (Number.isFinite(ex.opts.maxTokens)) {
      envLines.push(`- Your maximum output limit: ${ex.opts.maxTokens} tokens per response. For large writes, split the content across multiple write calls.`)
    }
    const envBlock = envLines.length > 0 ? `\n\n# Running Environment\n${envLines.join('\n')}` : ''
    const systemPrompt = `${expertBlock}${skillsCtx}${envBlock}\n\n${ENGINEERING_WORKFLOW}`

    console.log(`[spawn_agent] subAgentId="${subAgentId || '(general)'}" system prompt length=${systemPrompt.length}, task message length=${taskMessage.length} first 200 chars:`, taskMessage.slice(0, 200))
    t.output = `Spawning sub-agent for task: ${task.slice(0, 100)}...`
    ex.notify()

    // 并行专家上限（PLAN-parallel-experts P2，用户裁定 2026-09-16：同一会话最多 5 个；
    // 计划文档在 _task/20260916/PLAN-parallel-experts.md）。
    // The slot is taken AFTER validation (a bad planNode must fail fast, not
    // after queueing behind five long experts) and held for the whole
    // dispatch — i.e. across `waitForCompletion` below. See the header of
    // engine/subagent-limiter.ts for why that is the shape that survives
    // pause/resume and stop.
    // 嵌套派生（本引擎自身就是子代理）走 tryAcquireSubAgentSlot——永不排队
    // （死锁修复 2026-09-29，用户报告：一个 plan 波次把全会话锁死）：持槽的
    // dispatch 若还能等槽位，「持槽者等子代理完成、子代理等嵌套槽位」就成环。
    // 顶层派生（主代理 / 调度器，自身零持槽）维持 FIFO 排队不变。
    const budgetKey = subAgentBudgetKey(ex.opts)
    const busy = activeSubAgentCount(budgetKey)
    const queued = queuedSubAgentCount(budgetKey)
    const parallelLimit = getSubAgentParallelLimit()
    const nested = ex.isSpawnedSubAgent?.() ?? false
    if (!nested && (busy >= parallelLimit || queued > 0)) {
      t.output = `排队中：本会话已有 ${busy} 个专家在运行（上限 ${parallelLimit} 个），前面还有 ${queued} 个等待空位…`
      ex.notify()
    }
    const release = nested ? tryAcquireSubAgentSlot(budgetKey) : await acquireSubAgentSlot(budgetKey)
    if (!release) {
      t.exitCode = -1
      t.status = 'completed'
      if (nested) {
        // At cap and not allowed to wait: hand the work back — the caller
        // holds every tool needed to do it itself. execution('failed') is a
        // no-op unless a planNode attempt started (plan-node spawns are
        // top-level only; kept for defense in depth).
        execution('failed')
        ex.addToolResult(
          t.id,
          `并行槽位已满：本会话已有 ${busy} 个子代理在运行（上限 ${parallelLimit} 个），嵌套派生不排队等待。` +
            '不要继续派生子代理——请直接用你自己的工具完成这项工作，或把无法完成的部分如实报告。',
          true,
        )
      } else {
        // The session was stopped while this expert waited in line. Starting it
        // now would run work the user just cancelled.
        execution('stopped')
        ex.addToolResult(t.id, '子代理未启动：本次执行已被停止。', true)
      }
      ex.notify()
      return
    }

    try {
      // 可用能力白名单：有专家包就原样给出（空数组 = 一个都不许用）；
      // 没有专家包（通用子代理）才留 undefined，表示不限制。
      const handle = ex.spawnSubAgent!({
        systemPrompt,
        initialMessages: [{
          id: `spawn_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
          role: 'user',
          contentBlocks: [{ type: 'text', text: taskMessage }],
          createdAt: new Date().toISOString(),
        }],
        title: `${profile?.name || '子代理'}: ${task.slice(0, 60)}`,
        allowedSkills: profile ? profile.skillNames ?? [] : undefined,
        allowedMcpServers: profile ? profile.mcpServerIds ?? [] : undefined,
        maxTokens: ex.opts.maxTokens,
        // The session's configurable loop base — the same getLoopIterationLimit()
        // the host engine caps itself with (设置 → 助手设置 maxLoopIterations;
        // main-hosted sessions get the saved value, a renderer-hosted session
        // reads the same default its own engine does) — replacing the fixed 40
        // (PLAN-parallel-experts T8/L12). The expert still ERRORS at this limit
        // instead of silently renewing — a never-ending expert burns tokens
        // forever, the parent's batch never returns, and the FIFO slot queue
        // wedges behind it.
        maxLoopIterations: getLoopIterationLimit(),
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
      // Hand-off capture (PLAN-plan-scheduler S8): a successful node's output
      // becomes the plan's carrier for its dependents — recorded HERE, at the
      // one choke point every spawn's result flows through, before any
      // summarization for the parent. CAS on attemptId (via PlanManager) means
      // a straggler from a superseded retry can't overwrite a newer attempt.
      // Failures record nothing: their dependents are blocked anyway.
      if (planNode && result.status === 'completed' && attemptStarted && ex.getPlan?.() === dispatchPlan) {
        ex.recordNodeHandoff?.(planNode.id, attemptId, subText)
      }
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
          ? `\n\n### Sub-agent Status: ${result.status}\n`
            + (result.error ? `**Reason:** ${result.error}\n` : '')
            + (subText ? `**Partial Output:**\n${subText}` : '') + (subTools ? `\n**Tool Calls Attempted:** ${subTools}` : '')
          : ''
        let summary = result.status === 'completed'
          ? `## Sub-Agent Result (${result.status})\n\nThe sub-agent completed the delegated task.\n\n### Summary\n${subText}`
          : `## Sub-Agent Result (${result.status})\n\nThe sub-agent did not complete successfully.${errorDetail}`
        // Close the plan loop in the model's face: the result names the node
        // and what happens to it next. Mode-gated (PLAN-plan-scheduler): a
        // delegated plan settles on delivery — telling the model to call
        // advance_plan here would invite a ritual round the scheduler exists
        // to remove — while a failed spawn still gets the settle instruction,
        // because THAT is the consult the model must answer (direct mode
        // keeps the original wording throughout: it never auto-settles).
        if (planNode) {
          const delegated = (dispatchPlan?.mode ?? 'delegated') === 'delegated'
          summary += delegated && result.status === 'completed'
            ? `\n\n**Plan node ${planNode.id}** ("${planNode.description}") — its output has been recorded as the node's handoff for downstream nodes; the scheduler settles it automatically.`
            : `\n\n**Plan node ${planNode.id}** ("${planNode.description}") — settle it now with advance_plan action="complete" node=${nodeNumberOf(planNode)} (or "fail" / "skip" if it did not succeed).`
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
        // The tool card renders t.output: a failure must say so and name the
        // reason, not paint 已完成 over it. addToolResult mirrored the envelope
        // into output above — this overwrite used to clobber it with a success
        // string on every path, which is why a dead expert's card lied.
        t.output = result.status === 'completed'
          ? `子代理已完成. ${subText}`
          : `子代理${result.status === 'aborted' ? '已被停止' : '失败'}`
            + (result.error ? `：${result.error}` : '')
            + (subText ? `\n\n${subText}` : '')
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
