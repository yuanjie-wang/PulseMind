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
import type { PlanNode } from '../../../../shared/types/plan'
import { getCachedMcpServers } from '../mcp-cache'
import type { ToolExecContext } from './context'
import type { ExpertProfile } from '../../../../shared/types/expert'
import type { ToolUseBlock, TextBlock } from '../../types/agent'

/** spawn_agent: assistant text fed back to the parent. */
const SUBAGENT_TEXT_MAX = 10_000

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
    let planNode: PlanNode | null = null
    if (planNodeRaw !== undefined && planNodeRaw !== null && planNodeRaw !== '') {
      const plan = ex.getPlan?.()
      if (!plan) throw new Error('planNode was given but no plan is active — call create_plan first, or drop planNode.')
      planNode = resolveNodeRef(plan, planNodeRaw as string | number)
      if (!planNode) throw new Error(`Unknown planNode "${String(planNodeRaw)}" — valid: n1..n${plan.nodes.length}.`)
      if (planNode.status !== 'pending') throw new Error(`Plan node ${planNode.id} is already ${planNode.status} — pick a node from the READY set.`)
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
    let skillsCtx = ''
    try {
      const skillsAppendix = ex.opts.skillManager?.getSystemPromptAppendix(undefined, profile?.skillNames)
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

    // 可用能力白名单：有专家包就原样给出（空数组 = 一个都不许用）；
    // 没有专家包（通用子代理）才留 undefined，表示不限制。
    const handle = ex.spawnSubAgent!({
      systemPrompt,
      initialMessages: [],
      title: `${profile?.name || '子代理'}: ${task.slice(0, 60)}`,
      allowedSkills: profile ? profile.skillNames ?? [] : undefined,
      allowedMcpServers: profile ? profile.mcpServerIds ?? [] : undefined,
      maxTokens: ex.opts.maxTokens,
      maxLoopIterations: 20,
      onProgress: (summary) => {
        // Rolling activity log (cap 8 lines) so the user sees the sub-agent moving live.
        const lines = (t.output || '').split('\n')
        lines.push(summary)
        while (lines.length > 8) lines.shift()
        t.output = lines.join('\n')
        ex.notify()
      },
    })

    // Set _subConvId immediately so parent conversation saves link to sub-agent conversation
    // even if the app restarts before the sub-agent completes.
    ;(t as { _subConvId?: string })._subConvId = handle.subConvId
    // Plan linkage marker (UI/telemetry hook): which plan node this spawn implements.
    if (planNode) (t as { _planNodeId?: string })._planNodeId = planNode.id
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

    t.exitCode = result.status === 'completed' ? 0 : 1
    t.status = 'completed'
    ex.addToolResult(t.id, summary, result.status === 'error')
    t.output = `子代理已完成. ${subText}`
  } catch (err) {
    t.exitCode = -1
    t.status = 'completed'
    ex.addToolResult(t.id, `Error: ${err instanceof Error ? err.message : 'spawn_agent failed'}`, true)
  }
  ex.notify()
}