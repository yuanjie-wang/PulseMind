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
import { getCachedMcpServers } from '../mcp-cache'
import type { ToolExecContext } from './context'
import type { ExpertProfile } from '../../../../shared/types/expert'
import type { ToolUseBlock, TextBlock } from '../../types/agent'

/** spawn_agent: assistant text fed back to the parent. */
const SUBAGENT_TEXT_MAX = 10_000

/** 引用关系目录：技能取本会话的 SkillManager，连接器取同步的 MCP 缓存。
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

    // Capability is inherited from the host session — an expert config pack
    // only supplies identity, never a tool/connector/skill whitelist. Run
    // parameters (model / token budget / loop cap) come from the session too,
    // so the delegated engine budgets like the host one.
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

    // Expert config pack: compose the four structured sections instead of a
    // bare basePrompt; bound knowledge files ride along BOTH as a Bound
    // Knowledge index in the prompt AND as an enforced knowledgeScope on the
    // spawned engine — matching the @-summon runtime's convergence strength.
    const basePrompt = profile?.basePrompt || ''
    const knowledgeFiles: Array<{ id: string; title: string; filePath: string; wikiPages: string[] }> = []
    if (profile?.knowledgeFileIds?.length) {
      const km = ex.opts.knowledgeManager
      if (km) {
        const rows = await Promise.all((profile.knowledgeFileIds as string[]).map(id => km.getFile(id).catch(() => null)))
        for (const f of rows) {
          if (f) knowledgeFiles.push({ id: f.id, title: f.title || f.filePath, filePath: f.filePath, wikiPages: f.wikiOutputs ?? [] })
        }
      }
    }
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
          knowledgeFiles,
          resolveRefCatalogs(ex)
        )
      : GENERAL_SUBAGENT_PROMPT

    // Append available skills context
    let skillsCtx = ''
    try {
      const skillsAppendix = ex.opts.skillManager?.getSystemPromptAppendix()
      if (skillsAppendix) skillsCtx = '\n\n' + skillsAppendix
    } catch { /* non-critical */ }

    const systemPrompt = `${expertBlock}\n\n## Your Task\n${task}${skillsCtx}`

    console.log(`[spawn_agent] subAgentId="${subAgentId || '(general)'}" prompt length=${systemPrompt.length} first 200 chars:`, systemPrompt.slice(0, 200))
    t.output = `Spawning sub-agent for task: ${task.slice(0, 100)}...`
    ex.notify()

    const handle = ex.spawnSubAgent!({
      systemPrompt,
      initialMessages: [],
      title: `${profile?.name || '子代理'}: ${task.slice(0, 60)}`,
      knowledgeScope: knowledgeFiles.length > 0 ? knowledgeFiles : undefined,
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
    ;(t as any)._subConvId = handle.subConvId
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
    const summary = result.status === 'completed'
      ? `## Sub-Agent Result (${result.status})\n\nThe sub-agent completed the delegated task.\n\n### Summary\n${subText}`
      : `## Sub-Agent Result (${result.status})\n\nThe sub-agent did not complete successfully.${errorDetail}`

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