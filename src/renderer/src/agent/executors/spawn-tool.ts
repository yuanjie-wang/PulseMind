// ── spawn_agent implementation (moved out of ToolExecutor 0.4.1) ──
// Profile/expert resolution, prompt composition, delegation via
// ToolExecContext.spawnSubAgent, and result summarization for the parent.

import { getHost } from '../host'
import { ENGINEERING_WORKFLOW, TASK_COMPLETION_SENTINEL_SECTION, readProjectInstructionsBody } from '../system-prompt-builder'
import { detectVerifyCommands } from '../verify-loop'
import {
  composeExpertInstructions,
  GENERAL_SUBAGENT_PROMPT,
  toExpertRefCatalogs,
  type ExpertRefCatalogs,
} from '../../../../shared/expert-context'
import { formatUpstreamResults, MAX_PLAN_NODES, MAX_SPLIT_GEN, nodeNumberOf, resolveReadyNode } from '../../../../shared/plan/graph'
import { parseSplitProposal } from '../../../../shared/plan/split-proposal'
import { extractDeclaredStatus, formatReportContract, resolvePlanExchange } from '../../../../shared/plan/exchange'
import type { Plan, PlanNode, PlanNodeExecutionStatus } from '../../../../shared/types/plan'
import { getCachedMcpServers } from '../mcp-cache'
import {
  getSubAgentParallelLimit,
  acquireSubAgentSlot,
  activeSubAgentCount,
  queuedSubAgentCount,
  subAgentBudgetKey,
  tryAcquireSubAgentSlot,
  type ReleaseSubAgentSlot,
} from '../engine/subagent-limiter'
import type { ToolExecContext } from './context'
import type { ExpertProfile } from '../../../../shared/types/expert'
import type { ToolUseBlock, TextBlock } from '../../types/agent'
import { MAX_TOOL_RESULT_TOKENS, SPAWN_ROUND_ENVELOPE_BUDGET, MIN_SPAWN_ENVELOPE_BUDGET } from '../engine/engine-constants'
import { getLoopIterationLimit } from '../agent-utils'
import { SUB_AGENT_FOLLOWUP_KEEP } from '../engine/spawn-manager'

/** spawn_agent: assistant text fed back to the parent. */
const SUBAGENT_TEXT_MAX = 10_000

/** Head slice of the delivered report scanned for its 状态 verdict — the
 *  skeleton mandates the section as the report's first, so the head carries
 *  it; the cap only bounds a pathological file. */
const REPORT_STATUS_HEAD_CHARS = 65_536

// ── explore 预设（2026-10-27 验证闭环批次 #2）────────────────────────────
// 只读侦察子代理：把「先摸清仓库再动手」的窗口开销外包出去——父会话花几百字
// 买到整个代码库的结构认知，而不是自己把大文件读进主上下文。工具集白名单是
// 结构性只读：exec 不在列（写面全在 write/edit/office_edit），MCP 发现在
// allowedToolsSet 存在时本就跳过（tool-collection 的 doMcpDiscovery 条件），
// 所以白名单即完整攻击面。recall 是 gated 工具，白名单把它放回（tool-collection
// 的 allowed?.has 分支）——探索一个代码库时，过去会话与知识库里关于它的记忆
// 常是最短的路。
export const EXPLORE_TOOLSET = ['search', 'find', 'read', 'list_dir', 'office_read', 'office_inspect', 'recall']

/** explore 的报告契约。挂在 spawn system prompt 的最末：模型从最后字节决定
 *  下一步（信封 close-out 的同一判词），最后一个位置读得最认真。 */
export const EXPLORE_REPORT_CONTRACT = `## Explore Mode

You are a READ-ONLY codebase explorer. Your toolset is restricted to search / find / read / list_dir / office_read / office_inspect / recall — you cannot write, edit or execute, and you must not try. Do the narrow reconnaissance the task asks for and report back; the parent holds every write tool and acts on your map.

Report format (keep it under ~400 words):
- **Map** — the relevant files as \`path:line\` anchors, one line each: what it is, where the entry points are, what calls what.
- **Key facts** — signatures, data shapes, constants, config values the parent needs, quoted exactly with their anchors.
- **Gaps** — what you could not determine, and where the answer would live.

Never paste whole files or long listings — anchors plus short quotes only. Precision of \`path:line\` beats volume.`

/** The ledger key for the re-dispatch gate: whitespace-normalized, lowercased
 *  task text. Exact-normalized match only — 「near-identical」 stays a
 *  judgment call for the model — but that is precisely the shape the measured
 *  incident took (mimo, 2026-09-16: five BYTE-identical re-dispatches). */
export function spawnTaskSignature(task: string): string {
  return task.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** The refusal text for re-running a task this session already completed. */
export function spawnRedispatchRejection(): string {
  return '## Sub-Agent Result (rejected)\n\nThis exact task was already delegated and COMPLETED this session — its result is already in hand. A second run cannot improve a result you already hold. Report the existing result to the user in your own words; if it missed the mark, say so and ask the user instead of re-delegating. (Retrying after a FAILED attempt remains legitimate — this gate only blocks re-running a completed task.)'
}

async function readReportHead(path: string): Promise<string> {
  try {
    const text = await getHost().readFile(path)
    return (text ?? '').slice(0, REPORT_STATUS_HEAD_CHARS)
  } catch { return '' }
}

/** 报告契约违约的一次恢复轮（PLAN-tool-issues #7，2026-10-28）：经注册表向
 *  同一暖代理发一次补写 nudge，重验文件。注册表未命中（LRU 淘汰/重启）或
 *  续聊未完成都按「未补齐」回落——调用方的 FAILED 路径照旧。返回是否已补齐。 */
export async function nudgeReportContract(ex: ToolExecContext, subConvId: string, reportPath: string): Promise<boolean> {
  const handle = ex.followUpSubAgent?.(subConvId,
    `Your task finished, but the Report Contract is NOT satisfied: the report file at "${reportPath}" is missing or empty, and the plan is about to mark this node FAILED. Write the report file NOW with the write tool to that exact path (create parent directories as needed) — summarize what you did, the deliverables and findings, and end with a line "Status: success" / "Status: partial" / "Status: failed". Do NOT redo the work; write the report from your existing context.`)
  if (!handle) return false
  try {
    const result = await handle.waitForCompletion()
    if (result.status !== 'completed') return false
  } catch { return false }
  try {
    const stat = await getHost().getFileStat(reportPath)
    return (stat?.size ?? 0) > 0
  } catch { return false }
}

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
  // 'queued', not 'running': a top-level spawn WAITS inside acquireSubAgentSlot's
  // FIFO below while earlier experts hold their slots (10 dispatched / 5-slot
  // cap = 5 loading + 5 hourglass, user 2026-09-30), and it must not wear the
  // executing glyph there. The flip to 'running' happens after the slot lands.
  t.status = 'queued'; ex.notify()
  let planNode: PlanNode | null = null
  let dispatchPlan: Plan | null = null
  // Tool ids can be replayed on retry; each executor invocation gets a new id.
  const attemptId = `${t.id}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
  let attemptStarted = false
  // The parallel-cap slot once acquired; the inner finally releases it, and
  // the outer catch re-releases idempotently for throws in the expert-lookup
  // / prompt-composition stretch the inner try does not cover (makeRelease
  // no-ops on a second call).
  let heldSlot: ReleaseSubAgentSlot | null = null
  const execution = (status: PlanNodeExecutionStatus, subConvId?: string): void => {
    if (attemptStarted && planNode && ex.getPlan?.() === dispatchPlan) {
      ex.updatePlanNodeExecution?.(planNode.id, attemptId, status, subConvId)
    }
  }
  try {
    // Sub-agent boundary (PLAN-plan-split v2 R2): a spawned sub-agent cannot
    // delegate. The schema is denied at collection (SUB_AGENT_DENY_TOOLS);
    // this catches an out-of-schema hallucinated call — dispatch is by NAME,
    // so an undeclared tool_use would still reach this executor.
    if (ex.opts.spawnedToolset) {
      t.exitCode = -1
      t.status = 'completed'
      ex.addToolResult(t.id, '子代理不能再派生子代理：派生属于主 Agent。请完成你自己的工作并如实报告；若任务过重，使用 create_sub_plan（如可用）把剩余工作拆回父计划。', true)
      ex.notify()
      return
    }
    const subAgentId = String(t.input?.subAgentId || '').trim()
    const task = String(t.input?.task || '')
    if (!task.trim()) throw new Error('task is required')
    // explore 预设：preset 校验与 task 同级——同步拒绝，不进槽位队列（本
    // 函数所有校验的同一纪律）。未知 preset 名是模型错误，直接报错。
    const preset = String(t.input?.preset || '').trim()
    const isExplore = preset === 'explore'
    if (preset && !isExplore) throw new Error(`Unknown preset "${preset}" — the only supported value is "explore".`)

    // agentId 续聊（2026-10-28 续聊原语）：对已完成子代理的追问通道。与派发
    // 期注入的三样东西互斥（身份/工具集/计划节点契约都是派发时注入的，续聊
    // 引擎已带全量）——同步拒绝，不进槽位队列。
    const agentId = String(t.input?.agentId || '').trim()
    if (agentId) {
      if (subAgentId) throw new Error('agentId (follow-up) cannot be combined with subAgentId — the continued agent already carries its identity. Drop subAgentId.')
      if (preset) throw new Error('agentId (follow-up) cannot be combined with preset — the continued agent already carries its toolset. Drop preset.')
      const fuPlanNode = t.input?.planNode
      if (fuPlanNode !== undefined && fuPlanNode !== null && fuPlanNode !== '') {
        throw new Error('agentId (follow-up) cannot be combined with planNode — a follow-up is free-form continuation of a warm agent, not a plan-node dispatch. Drop planNode.')
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
      // Scheduler-ownership gate (conv_20261026154702 A1/B3): a never-started
      // READY node in a delegated plan belongs to the scheduler — it dispatches
      // the ready wave itself, and both the create_plan result and the plan
      // snapshot say so in prose. Prose did not hold (the model spawned the
      // whole ready wave manually one message after create_plan), so the
      // contract is enforced here. Everything that must stay manually
      // dispatchable is exempted exactly: the scheduler's own synthetic calls
      // (mintCalls stamps autoDispatch), a sub-agent's own plan (the scheduler
      // never runs there — 子代理内建图维持模型驱动), a direct-mode plan (no
      // scheduler), and a node with ANY prior attempt (failed/stopped → the
      // failure envelope itself instructs re-dispatch).
      if (!planNode.execution
        && (plan.mode ?? 'delegated') !== 'direct'
        && t.input?.autoDispatch !== true
        && !ex.isSpawnedSubAgent?.()) {
        throw new Error(
          `Plan node ${planNode.id} is READY — the scheduler dispatches READY nodes automatically. Do not spawn_agent them yourself: wait for delivery and handle failed/stopped nodes. If this node must not run, settle it first (advance_plan action="skip" or "fail").`,
        )
      }
      ex.beginPlanNodeExecution?.(planNode.id, attemptId)
      attemptStarted = true
    }

    // explore × planNode 冲突：计划节点派发欠一份报告文件（写面契约），explore
    // 是只读侦察——两个契约互斥，同步拒绝让模型改用自由派发。
    if (isExplore && planNode) {
      throw new Error('preset="explore" cannot be combined with planNode — an explore pass is read-only reconnaissance with no report file to deliver. Dispatch it as a free-form task instead.')
    }

    // 续聊路由（2026-10-28）：agentId 走自己的通道，位于再派发门之前——对
    // 同一代理的追问不是「重派已完成的活」（门要防的是重新付一遍发现成本，
    // 续聊恰恰是免掉它的机制），不取专家包、不组装 spawn 提示词。
    if (agentId) {
      await execAgentFollowUp(ex, t, agentId, task)
      return
    }

    // Re-dispatch gate (2026-10-27): a task this session already COMPLETED is
    // not re-runnable — the result is in hand and a second run is a whole
    // sub-session of spend for nothing. Free-form spawns only: plan-node
    // spawns have their own gates above (scheduler ownership, live attempt),
    // and a FAILED node's re-dispatch is the protocol itself. Fires BEFORE
    // the slot acquisition, so a refused call never queues behind five long
    // experts — the same fail-fast position every synchronous validation
    // here holds.
    if (!planNode) {
      const prior = ex.spawnTaskResults?.get(spawnTaskSignature(task))
      if (prior === 'completed') {
        const msg = spawnRedispatchRejection()
        t.exitCode = -1
        t.status = 'completed'
        ex.addToolResult(t.id, msg, true)
        ex.notify()
        return
      }
    }

    // 并行专家上限（PLAN-parallel-experts P2，用户裁定 2026-09-16：同一会话最多 5 个；
    // 计划文档在 _task/20260916/PLAN-parallel-experts.md）。
    // The slot is taken HERE — after every SYNCHRONOUS validation (a bad task
    // or planNode still fails fast without queueing behind five long experts)
    // but BEFORE THE FIRST AWAIT — and held for the whole dispatch, i.e.
    // across `waitForCompletion` below. The position is the fix for the
    // n5-queued-last scramble (2026-10-27): the limiter's FIFO can only order
    // ARRIVALS, and with the acquire parked behind the expert lookup and the
    // 项目法 read, six concurrent dispatches arrived in file-completion order —
    // a 6-node wave at cap 5 queued n5 instead of n6. Everything above is
    // synchronous, so a batch's calls arrive in mint order and the FIFO queue
    // IS the dispatch order. See the header of engine/subagent-limiter.ts for
    // why the slot is held across the wait.
    // 嵌套派生（本引擎自身就是子代理）走 tryAcquireSubAgentSlot——永不排队
    // （死锁修复 2026-09-29，用户报告：一个 plan 波次把全会话锁死）：持槽的
    // dispatch 若还能等槽位，「持槽者等子代理完成、子代理等嵌套槽位」就成环。
    // 顶层派生（主代理 / 调度器，自身零持槽）维持 FIFO 排队不变。
    // 这条路径日常由 spawnedToolset 门先行拦截（所有 spawn 都带 true），到达
    // 这里的是将来放宽 SUB_AGENT_DENY_TOOLS 后的嵌套派发——纪律由
    // tests/nested-spawn-fail-fast.test.ts 钉死：满员 fail-fast、不排队、
    // 不死锁；它不是死代码，是预留路径的现行契约。
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
    heldSlot = release
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
    // Slot in hand — the expert is now actually executing.
    t.status = 'running'; ex.notify()

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
    // Split gate (PLAN-plan-split v2 R5/R7): only a splittable node gets the
    // one-line pointer — gen < MAX_SPLIT_GEN AND ≥2 slots of node budget —
    // and only such a spawn also arms create_sub_plan (the planSplit config
    // below). A gen-1 child sees neither: structurally it cannot split. The
    // full protocol lives on the tool's own manual (both channels).
    let splitHint = ''
    if (planNode && dispatchPlan) {
      const headroom = MAX_PLAN_NODES - dispatchPlan.nodes.length
      if ((planNode.gen ?? 0) < MAX_SPLIT_GEN && headroom >= 2) {
        splitHint = '\n\n(If this task — or its remainder once you start — clearly exceeds one sub-agent, call create_sub_plan to split it back into the parent plan; see that tool\'s manual for the rules and the text alternative. Split before starting or mid-way, never after finishing.)'
      }
    }
    // Report contract (PLAN-plan-exchange E2): every plan-node spawn owes a
    // report at the system-minted path. The admission text is composed at
    // dispatch; the exit is verified mechanically at the choke point below.
    // plan.id was lazily minted by beginPlanNodeExecution above, so a legacy
    // plan gets its exchange area from its very first dispatch. No
    // workspaceDir (tool-studio-like sessions) → no contract, legacy behavior.
    // The contract rides the spawn SYSTEM PROMPT (user ruling 2026-10-05:
    // 对用户不可见——下钻读子会话时第一条消息只剩任务本身；效果不变，模型
    // 照样逐字读到契约), and the prompt is per-session with no shared cache
    // prefix, so the placement costs nothing. The task itself stays in the
    // first user message per the ruling below.
    const exchange = planNode && dispatchPlan ? resolvePlanExchange(ex.opts.workspaceDir, dispatchPlan) : null
    const reportContract = planNode && exchange ? `\n\n${formatReportContract(exchange, planNode)}` : ''
    const taskText = planNode
      ? `${task}\n\n(You are executing plan node ${planNode.id} of a larger plan — scope your work to this node only.)${splitHint}`
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
    // keys on it, and nothing volatile precedes the tool schemas. (The report
    // contract is deliberately NOT part of that visible half — 2026-10-05
    // ruling above — but the delegated TASK is exactly what the user should
    // see, so it stays here.)
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
    if (ex.opts.workspaceDir) {
      envLines.push(`- Workspace: ${ex.opts.workspaceDir} (relative file paths resolve here; the shell starts here)`)
      // Same hygiene rule the main agent's `## Workspace` state-block section
      // carries (system-prompt-builder.buildWorkspaceSection): throwaway files
      // go under the workspace's own .pulsemind/ so a project workspace (the
      // user's real directory) does not collect the model's scratch.
      envLines.push(`- Scratch: ${ex.opts.workspaceDir}/.pulsemind/tmp — put throwaway/intermediate files here, never loose in the workspace root`)
      // Verify 命令进子代理的 env block（2026-10-27 验证闭环）：子代理才是真正
      // 写代码的那一方，父会话 state block 的 Verify 行到不了这里
      // （spawnSystemPrompt 分支 → stateBlock null）。探测是 TTL 缓存的
      // （verify-loop.ts），每工作区每 10 分钟一次 host 读，所有 spawn 共享。
      try {
        const verifyCmds = await detectVerifyCommands(ex.opts.workspaceDir)
        if (verifyCmds.length > 0) {
          envLines.push(`- Verify: ${verifyCmds.map((c) => `\`${c}\``).join(' · ')} — this workspace's verification commands; run the relevant one after code changes`)
        }
      } catch { /* detection is best-effort */ }
    }
    // Project law rides the spawn prompt too (2026-10-07): a sub-agent doing
    // the work must answer to the same standing instructions as the parent,
    // and the parent cannot be trusted to transcribe them into every task.
    // Content ONLY — no empty-state pointer, no write invitation: sub-agents
    // are ephemeral workers; teaching the write path is the main agent's
    // state-block section's job. Per-session prompt, no shared cache prefix,
    // so the append is free; absent file → empty string, no section.
    const projectLaw = ex.opts.workspaceDir ? await readProjectInstructionsBody(ex.opts.workspaceDir) : ''
    const lawBlock = projectLaw
      ? `\n\n# Project Instructions\nStanding instructions for this project (.pulsemind/AGENTS.md) — follow them for work in this workspace.\n${projectLaw}`
      : ''
    if (Number.isFinite(ex.opts.maxTokens)) {
      envLines.push(`- Your maximum output limit: ${ex.opts.maxTokens} tokens per response. For large writes, split the content across multiple write calls.`)
    }
    const envBlock = envLines.length > 0 ? `\n\n# Running Environment\n${envLines.join('\n')}` : ''
    // Report contract lands between the environment and the engineering
    // workflow: 谁在干活 → 能用什么 → 在哪干活（+ 项目约定） → 要交付什么 → 怎么干活. The
    // `## 报告契约` heading keeps its text verbatim — only the carrier moved.
    // Guarded models teach the completion sentinel to their sub-agents too
    // (the flag rides the opts spread, so a spawn of a guarded parent inherits
    // both the section here and the engine-side guard itself).
    const sentinelBlock = ex.opts.earlyStopGuard ? `\n\n${TASK_COMPLETION_SENTINEL_SECTION}` : ''
    // explore 契约挂在最末（模型从最后字节决定下一步——信封 close-out 的同一
    // 判词；sentinel 之后追加不破坏其完成标记的行 solitude）。
    const exploreBlock = isExplore ? `\n\n${EXPLORE_REPORT_CONTRACT}` : ''
    const systemPrompt = `${expertBlock}${skillsCtx}${envBlock}${lawBlock}${reportContract}\n\n${ENGINEERING_WORKFLOW}${sentinelBlock}${exploreBlock}`

    console.log(`[spawn_agent] subAgentId="${subAgentId || '(general)'}" system prompt length=${systemPrompt.length}, task message length=${taskMessage.length} first 200 chars:`, taskMessage.slice(0, 200))
    t.output = `Spawning sub-agent for task: ${task.slice(0, 100)}...`
    ex.notify()

    try {
      // PLAN-plan-split v2 R6: arm create_sub_plan for splittable nodes —
      // the same gate as the tail hint above. The bridge (spawn-manager)
      // fills createdIds as merges land; read after waitForCompletion for
      // the envelope note, since the tool path leaves no trailing proposal
      // in the sub-agent's text.
      const planSplitConfig = planNode && dispatchPlan
        && (planNode.gen ?? 0) < MAX_SPLIT_GEN
        && MAX_PLAN_NODES - dispatchPlan.nodes.length >= 2
        ? { nodeRef: planNode.id, attemptId, createdIds: [] as string[] }
        : undefined
      // 可用能力白名单：有专家包就原样给出（空数组 = 一个都不许用）；
      // 没有专家包（通用子代理）才留 undefined，表示不限制。
      const handle = ex.spawnSubAgent!({
        ...(planSplitConfig ? { planSplit: planSplitConfig } : {}),
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
        // explore 预设的只读工具集白名单；undefined = 不限制（普通派发原样）。
        // 穿透链：config → spawn-manager 的 subOpts.allowedTools → 引擎的
        // allowedToolsSet → tool-collection 的白名单过滤（同时关闭 MCP 发现）。
        allowedTools: isExplore ? EXPLORE_TOOLSET : undefined,
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
      const subAssistantTexts = result.messages
        .filter(m => m.role === 'assistant')
        .flatMap(m => m.contentBlocks)
      const subText = subAssistantTexts.filter(b => b.type === 'text').map(b => (b as TextBlock).text).join('\n\n').slice(0, SUBAGENT_TEXT_MAX)
      const subTools = subAssistantTexts.filter(b => b.type === 'tool_use').map(b => `[tool_use: ${(b as ToolUseBlock).name}]`).join(', ')
      // Split handling (PLAN-plan-split v2 R3/R5): a merge NO LONGER replaces
      // settlement — X keeps its own work and settles naturally; the merge
      // only appends remainder-carrying children. Two channels, one merge:
      // a trailing `### Split Proposal` in the final text (parsed here,
      // before the settle marking, out of CAS discipline) and mid-run
      // create_sub_plan calls (visible via planSplitConfig.createdIds, filled
      // by the spawn-manager bridge). A rejected/malformed proposal no longer
      // fails the node — X's own delivered work stands.
      const deliverableNode = planNode !== null && result.status === 'completed' && attemptStarted && ex.getPlan?.() === dispatchPlan
      const delegatedPlan = (dispatchPlan?.mode ?? 'delegated') === 'delegated'
      let splitNote: string | null = null
      if (deliverableNode && planNode) {
        const parsed = parseSplitProposal(subText)
        if (parsed.kind === 'valid') {
          const merged = ex.mergeSplitProposal?.(planNode.id, attemptId, parsed.proposal.children, parsed.proposal.reason)
          if (merged?.ok) {
            const ids = merged.nodeIds
            const range = ids.length > 1 ? `${ids[0]}..${ids[ids.length - 1]}` : ids[0]
            splitNote = `its remainder was split into new plan nodes ${range}`
              + (parsed.proposal.reason ? ` (${parsed.proposal.reason})` : '')
              + (delegatedPlan
                ? ` — the scheduler dispatches them once this node settles; do NOT execute or re-dispatch them yourself.`
                : ` — execute them yourself in dependency order after this node settles (direct mode: no scheduler).`)
          } else {
            splitNote = `its trailing Split Proposal was REJECTED (${merged && !merged.ok ? merged.reason : 'no merge channel — the plan changed mid-run'}); its own work above still stands — decide on the remainder yourself.`
          }
        } else if (parsed.kind === 'invalid') {
          splitNote = `its trailing Split Proposal was malformed (${parsed.reason}); its own work above still stands — decide on the remainder yourself.`
        }
      }
      if (!splitNote && planSplitConfig?.createdIds.length && deliverableNode) {
        // The tool path: create_sub_plan merged mid-run, so the final text
        // carries no trailing section. The bridge recorded the created ids.
        const ids = planSplitConfig.createdIds
        const range = ids.length > 1 ? `${ids[0]}..${ids[ids.length - 1]}` : ids[0]
        splitNote = `mid-run it called create_sub_plan: its remainder was split into new plan nodes ${range}`
          + (delegatedPlan
            ? ` — the scheduler dispatches them once this node settles; do NOT execute or re-dispatch them yourself.`
            : ` — execute them yourself in dependency order after this node settles (direct mode: no scheduler).`)
      }
      if (!splitNote && result.status !== 'completed' && planNode && planSplitConfig?.createdIds.length) {
        // An error/stopped attempt that DID split mid-run still owes the parent
        // the split fact: the created nodes are live pending rows in the parent
        // plan, each depending on this node, and a consult round reading only
        // the envelope would never learn they exist (user report 2026-10-11).
        // The two sources above stay completed-gated — their wording assumes a
        // delivered node; this one is failure-shaped: settle THIS node first
        // (re-dispatch / fail / skip), then decide the children it left behind.
        const ids = planSplitConfig.createdIds
        const range = ids.length > 1 ? `${ids[0]}..${ids[ids.length - 1]}` : ids[0]
        splitNote = `mid-run it called create_sub_plan: its remainder was split into new plan nodes ${range}, which sit PENDING in the plan — each depends on this node, so none will dispatch until this node is settled (re-dispatch / advance_plan fail / skip); decide theirs after.`
      }
      // Exit check (PLAN-plan-exchange E3): a merged split skips it — the
      // proposal IS the splitter's deliverable and the children carry the
      // remainder. Everyone else owes a report at the minted path; missing or
      // empty fails the contract (the deliverable IS the report), and the
      // declared status is extracted as advisory data only — the report FILE
      // speaks first (2026-10-05 ruling: trust the contract artifact, not the
      // prose), the reply's status line is the fallback, and prose never
      // votes (see extractDeclaredStatus).
      let reportViolation: string | null = null
      let declaredStatus: 'success' | 'partial' | 'failed' | undefined
      if (planNode && deliverableNode && exchange && !splitNote) {
        const expectedPath = exchange.reportPath(planNode.id)
        let size = 0
        try {
          const stat = await getHost().getFileStat(expectedPath)
          size = stat?.size ?? 0
        } catch { size = 0 }
        if (size <= 0) reportViolation = expectedPath
        else declaredStatus = extractDeclaredStatus(await readReportHead(expectedPath)) ?? extractDeclaredStatus(subText)
      }
      // Recovery round (PLAN-tool-issues #7, 2026-10-28): a violated contract
      // used to FAIL the node outright — but the node's work was done and the
      // agent is still warm, so one omitted file write escalated into a full
      // re-run (3 real nodes died this way; the path is system-minted and
      // system-injected via the Report Contract section, so the miss is
      // sub-agent non-compliance, not a parent omission). Nudge the SAME warm
      // engine once via the registry — riding THIS dispatch's already-held
      // slot, since followUpSubAgent is the bare registry call — re-verify;
      // only a still-missing report fails the node.
      if (reportViolation && planNode && exchange) {
        const recovered = await nudgeReportContract(ex, handle.subConvId, reportViolation)
        if (recovered) {
          reportViolation = null
          declaredStatus = extractDeclaredStatus(await readReportHead(exchange.reportPath(planNode.id))) ?? extractDeclaredStatus(subText)
        }
      }
      if (reportViolation) execution('failed') // from 'running' — the CAS allows running→failed
      else execution(result.status === 'completed' ? 'delivered' : result.status === 'aborted' ? 'stopped' : 'failed')
      // Hand-off capture (PLAN-plan-scheduler S8): a successful node's output
      // becomes the plan's carrier for its dependents — recorded HERE, at the
      // one choke point every spawn's result flows through. Under the v2
      // midprocess shape this INCLUDES a split: X's handoff (partial work
      // included) is what its split children read as upstream input, and the
      // downstream union (X + children) sees everything.
      if (deliverableNode && planNode && !reportViolation) {
        ex.recordNodeHandoff?.(planNode.id, attemptId, subText)
        // The report stamp (E3): CAS on attemptId, same discipline as the
        // handoff — downstream reads it from the node row, never from prose.
        // A merged split skipped the check on purpose: no report was owed.
        if (exchange && !splitNote) {
          ex.recordNodeReport?.(planNode.id, attemptId, exchange.reportPath(planNode.id), declaredStatus)
        }
      }
      const expertName = profile?.name || subAgentId || '(general sub-agent)'
      // Shared round budget: this batch's envelopes split one allowance so a
      // wide parallel dispatch cannot append a window-busting collector message.
      const envelopeBudget = spawnEnvelopeBudget(ex.spawnBatchTotal?.() ?? 1)

      // Contract-violation envelope (PLAN-plan-exchange E3): the sub-agent's
      // engine completed, but the plan's deliverable — the report — is
      // missing, so this reads as a FAILURE for the consult round.
      if (reportViolation && planNode) {
        const summary = `## Sub-Agent Result (failed — report contract)\n\n`
          + `**Report contract violated:** no report file at ${reportViolation} (missing or empty). The plan treats the report as the deliverable, so the node is marked FAILED.`
          + ` A recovery nudge was already sent to the same warm agent (agentId "${handle.subConvId}") and it still did not write the report.\n\n`
          + (subText ? `**What the sub-agent said it did (unverified):**\n${subText}\n\n` : '')
          + `**Decide next:** re-dispatch it with spawn_agent planNode=${nodeNumberOf(planNode)} — the retry sees the same contract and must write its report to that path — or settle it with advance_plan action="fail" / "skip".`
        t.exitCode = 1
        t.status = 'completed'
        ex.addToolResult(t.id, summary, true, undefined, envelopeBudget)
        t.output = `报告契约未满足：${reportViolation} 缺失或为空`
        ex.notify()
        return
      }

      // 单专家 @召唤的结论原文进对话（用户裁定 2026-09-17：「能不能在主对话中直接
      // 输出专家的结论」——主 Agent 转述一遍会丢信息）。The engine accepts the
      // conclusion ONLY for the delegation it dispatched itself, so a
      // model-emitted spawn_agent can never close a turn verbatim; on
      // acceptance it travels as the turn's own assistant message, which is
      // why the tool result stays short here — the full text in both places
      // would be a duplicate 10k chars in every later request. A split's
      // proposal text is not a user-facing conclusion — never deliver it
      // verbatim.
      const verbatim = !splitNote && result.status === 'completed' && !!subText.trim()
        && ex.deliverExpertConclusion?.(t.id, subText) === true
      if (verbatim) {
        t.exitCode = 0
        t.status = 'completed'
        ex.addToolResult(
          t.id,
          `## Sub-Agent Result (completed)\n\nDelegated to **${expertName}**. The expert's conclusion is delivered to the user verbatim as the message that follows — do NOT restate or summarize it.`
            + `\n\n(Follow-ups: this agent stays warm for the session — spawn_agent { agentId: "${handle.subConvId}", task: "…" } continues it with full context; a spawn WITHOUT agentId starts a fresh agent.)`,
          false,
          undefined,
          envelopeBudget
        )
        t.output = `子代理已完成. ${subText}`
        if (result.stopReason === 'max_tokens') t.output += '\n\n（输出被长度上限截断，结果可能不完整）'
      } else {
        const errorDetail = result.status !== 'completed'
          ? `\n\n### Sub-agent Status: ${result.status}\n`
            + (result.error ? `**Reason:** ${result.error}\n` : '')
            + (subText ? `**Partial Output:**\n${subText}` : '') + (subTools ? `\n**Tool Calls Attempted:** ${subTools}` : '')
          : ''
        let summary = result.status === 'completed'
          ? `## Sub-Agent Result (${result.status})\n\nThe sub-agent completed the delegated task.\n\n### Summary\n${subText}`
          : `## Sub-Agent Result (${result.status})\n\nThe sub-agent did not complete successfully.${errorDetail}`
        // 截断不撒谎（2026-11-12）：status 仍是 completed（路由/exitCode/isError
        // 一律不变），但输出被长度上限切断时，父模型必须读到「这可能是半截话」——
        // 否则它会把缺失的结论当成「没什么可报」。
        if (result.status === 'completed' && result.stopReason === 'max_tokens') {
          summary += '\n\n⚠️ **Truncated:** this sub-agent hit the output length limit. The text above may stop mid-thought — treat missing conclusions as MISSING, not as "nothing to report".'
        }
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
        // The split note rides AFTER the settle line: the parent model must
        // read "this node delivered AND its remainder moved to new nodes" as
        // one fact — otherwise the new nodes look like someone else's mistake.
        if (splitNote) summary += `\n\n**Split:** ${splitNote}`
        // Close-out instruction, deliberately the LAST bytes of the envelope:
        // the envelope reads like an intermediate artifact, and a weak model
        // answers it by delegating again — measured loop (2026-09-16, mimo):
        // five identical re-dispatches of an already-completed translation. The
        // model decides its next move off the end of this result, so the end
        // says what to do: report, don't re-run.
        summary += result.status === 'completed'
          ? '\n\n**This result is the deliverable.** Report it to the user in your own words and move on — do NOT re-dispatch the same or a near-identical task.'
            + `\n\n**Follow-up channel:** this agent stays warm for the session — continue its context with spawn_agent { agentId: "${handle.subConvId}", task: "…" }; a spawn WITHOUT agentId starts a fresh agent.`
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
        if (result.status === 'completed' && result.stopReason === 'max_tokens') t.output += '\n\n（输出被长度上限截断，结果可能不完整）'
        if (splitNote) t.output += '\n\n（剩余工作已拆分回父计划）'
      }
      // Ledger the outcome (re-dispatch gate): free-form spawns only — a
      // plan node's lifecycle lives on the node row, not here. 'aborted' is
      // recorded but never blocks: a user-stopped spawn did not complete, and
      // re-running it is a legitimate decision.
      if (!planNode && ex.spawnTaskResults) {
        ex.spawnTaskResults.set(
          spawnTaskSignature(task),
          result.status === 'completed' ? 'completed' : result.status === 'aborted' ? 'aborted' : 'failed',
        )
      }
    } finally {
      release()
    }
  } catch (err) {
    // A throw before the inner try (expert lookup / prompt composition) is
    // still holding the slot — hand it back; the spawn stretch is covered by
    // the inner finally, and makeRelease no-ops the second call.
    heldSlot?.()
    execution('failed')
    t.exitCode = -1
    t.status = 'completed'
    ex.addToolResult(t.id, `Error: ${err instanceof Error ? err.message : 'spawn_agent failed'}`, true)
  }
  ex.notify()
}

/** agentId 续聊的执行通道（2026-10-28 续聊原语）：与自由派发共享槽位纪律
 *  （嵌套不排队、FIFO 到达序、停止拒启），但跳过专家包/提示词组装——引擎
 *  是从注册表唤醒的现成者。信封是自由派发完成形态的续聊变体：状态、摘要、
 *  close-out，末尾再教一次续聊通道（链条可以继续）。结果照常进
 *  spawnTaskResults 台账——对同一追问文本的自由重派仍会被门拦住。 */
async function execAgentFollowUp(ex: ToolExecContext, t: ToolUseBlock, agentId: string, task: string): Promise<void> {
  t.status = 'queued'; ex.notify()
  const budgetKey = subAgentBudgetKey(ex.opts)
  const nested = ex.isSpawnedSubAgent?.() ?? false
  const busy = activeSubAgentCount(budgetKey)
  const parallelLimit = getSubAgentParallelLimit()
  if (!nested && (busy >= parallelLimit || queuedSubAgentCount(budgetKey) > 0)) {
    t.output = `排队中：本会话已有 ${busy} 个专家在运行（上限 ${parallelLimit} 个），前面还有等待空位的续聊…`
    ex.notify()
  }
  const release = nested ? tryAcquireSubAgentSlot(budgetKey) : await acquireSubAgentSlot(budgetKey)
  if (!release) {
    t.exitCode = -1
    t.status = 'completed'
    ex.addToolResult(t.id, nested
      ? '并行槽位已满：嵌套续聊不排队等待。请稍后再追问，或直接用你自己的工具继续。'
      : '子代理续聊未启动：本次执行已被停止。', true)
    ex.notify()
    return
  }
  t.status = 'running'; ex.notify()
  try {
    const handle = ex.followUpSubAgent?.(agentId, task)
    if (!handle) {
      t.exitCode = -1
      t.status = 'completed'
      ex.addToolResult(
        t.id,
        `agentId "${agentId}" is no longer warm — the follow-up registry keeps the most recent ${SUB_AGENT_FOLLOWUP_KEEP} completed agents per session, and an app restart empties it. Re-delegate as a FRESH spawn, folding the context you still need into the task text (this rejection is not the re-dispatch gate — a fresh spawn with the original task text passes it).`,
        true,
      )
      ex.notify()
      return
    }
    t.subConvId = handle.subConvId
    ex.notify()
    const result = await handle.waitForCompletion()
    const subAssistantTexts = result.messages
      .filter(m => m.role === 'assistant')
      .flatMap(m => m.contentBlocks)
    const subText = subAssistantTexts.filter(b => b.type === 'text').map(b => (b as TextBlock).text).join('\n\n').slice(0, SUBAGENT_TEXT_MAX)
    const envelopeBudget = spawnEnvelopeBudget(ex.spawnBatchTotal?.() ?? 1)
    if (result.status === 'completed') {
      t.exitCode = 0
      t.status = 'completed'
      const summary = `## Sub-Agent Result (follow-up, completed)\n\nThe continued agent answered your follow-up with its full prior context in hand.\n\n### Summary\n${subText}`
        + `\n\n**Continue it again** — it stays warm: spawn_agent { agentId: "${handle.subConvId}", task: "…" }. A spawn WITHOUT agentId starts a fresh agent. Report this result to the user in your own words — do NOT re-send the follow-up.`
      t.output = `子代理续聊完成. ${subText}`
      ex.addToolResult(t.id, summary, false, undefined, envelopeBudget)
    } else {
      t.exitCode = 1
      t.status = 'completed'
      const detail = (result.error ? `**Reason:** ${result.error}\n` : '') + (subText ? `**Partial Output:**\n${subText}` : '')
      const summary = `## Sub-Agent Result (follow-up, ${result.status})\n\nThe continued agent did not complete successfully.\n\n${detail}`
        + `\n\n**Report this outcome to the user.** The agent (agentId "${handle.subConvId}") stays warm — one more follow-up is a legitimate retry if the failure looks transient; a fresh spawn re-pays the discovery cost.`
      t.output = `子代理续聊${result.status === 'aborted' ? '已被停止' : '失败'}${result.error ? `：${result.error}` : ''}`
      ex.addToolResult(t.id, summary, result.status === 'error', undefined, envelopeBudget)
    }
    // Ledger the follow-up's own text: a later free-form re-dispatch of the
    // SAME follow-up is exactly what the gate exists for.
    if (ex.spawnTaskResults) {
      ex.spawnTaskResults.set(
        spawnTaskSignature(task),
        result.status === 'completed' ? 'completed' : result.status === 'aborted' ? 'aborted' : 'failed',
      )
    }
  } catch (err) {
    t.exitCode = -1
    t.status = 'completed'
    ex.addToolResult(t.id, `Error: ${err instanceof Error ? err.message : 'spawn_agent follow-up failed'}`, true)
  } finally {
    release()
  }
  ex.notify()
}
