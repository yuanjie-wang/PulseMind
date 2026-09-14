// ── spawn_agent implementation (moved out of ToolExecutor 0.4.1) ──
// Profile/expert resolution, prompt composition, delegation via
// ToolExecContext.spawnSubAgent, and result summarization for the parent.

import { getHost } from '../host'
import { composeExpertInstructions } from '../../../../shared/expert-context'
import type { ToolUseBlock, TextBlock } from '../../types/agent'
import type { ToolExecContext } from './context'

/** spawn_agent: assistant text fed back to the parent. */
const SUBAGENT_TEXT_MAX = 10_000

// ── Spawn agent tool ───────────────────────────────────────────────────

export async function execSpawnAgent(ex: ToolExecContext, t: ToolUseBlock): Promise<void> {
  t.status = 'running'; ex.notify()
  try {
    const subAgentId = String(t.input?.subAgentId || '').trim()
    const task = String(t.input?.task || '')
    if (!subAgentId) throw new Error('subAgentId is required — select the most suitable sub-agent from the available list')
    if (!task.trim()) throw new Error('task is required')

    let allowedTools: string[] = ['read', 'write', 'edit', 'list_dir', 'search', 'find', 'exec']
    let allowedMcpServers: string[] = ['chrome-devtools']
    let allowedSkills: string[] | undefined
    let maxTokens: number | undefined
    let maxLoopIterations: number | undefined
    let profile: any = null
    let disabledError: Error | null = null
    try {
      const profiles = await getHost().subagentList()
      profile = profiles.find((p: any) => p.id === subAgentId) || null
      if (profile) {
        if (profile.enabled === false) {
          disabledError = new Error(`子代理 "${profile.name || subAgentId}" 已关闭，请在能力中心 → 专家 中启用后再使用`)
        }
        if (profile.allowedTools?.length) allowedTools = profile.allowedTools
        if (profile.allowedMcpServers?.length) allowedMcpServers = profile.allowedMcpServers
        if (profile.allowedSkills?.length) allowedSkills = profile.allowedSkills
        if (profile.maxTokens) maxTokens = profile.maxTokens
        if (profile.maxLoopIterations) maxLoopIterations = profile.maxLoopIterations
      } else {
        console.warn(`[execSpawnAgent] Sub-agent "${subAgentId}" not found, falling back to defaults`)
      }
    } catch { /* fallback */ }
    if (disabledError) throw disabledError

    // Expert config pack: compose the four structured sections instead of a
    // bare basePrompt; bound knowledge files ride along as a Bound Knowledge
    // index (the sub-session's knowledge tools stay global here — the pack's
    // file list already tells the model where to look).
    const basePrompt = profile?.basePrompt || ''
    const knowledgeFiles: Array<{ id: string; title: string; filePath: string }> = []
    if (profile?.knowledgeFileIds?.length) {
      const km = ex.opts.knowledgeManager
      if (km) {
        const rows = await Promise.all((profile.knowledgeFileIds as string[]).map(id => km.getFile(id).catch(() => null)))
        for (const f of rows) {
          if (f) knowledgeFiles.push({ id: f.id, title: f.title || f.filePath, filePath: f.filePath })
        }
      }
    }
    const expertBlock = profile
      ? composeExpertInstructions(
          { name: profile.name || subAgentId, basePrompt, methodology: profile.methodology, outputSpec: profile.outputSpec, constraints: profile.constraints },
          knowledgeFiles
        )
      : `You are a sub-agent executing a delegated task.

Guidelines:
- Focus exclusively on the task above. Ignore anything not relevant to it.
- You CANNOT install skills or modify tool preferences.
- When you complete the task, provide a concise summary of your findings.
- Do NOT ask the user for input — work autonomously.`

    const toolList = allowedTools.map(t => `- \`${t}\``).join('\n')
    const mcpList = allowedMcpServers.map(id => `- ${id}`).join('\n')

    // Append available skills context
    let skillsCtx = ''
    try {
      const skillsAppendix = ex.opts.skillManager?.getSystemPromptAppendix()
      if (skillsAppendix) skillsCtx = '\n\n' + skillsAppendix
    } catch { /* non-critical */ }

    const systemPrompt = `${expertBlock}\n\n## Your Task\n${task}\n\n## Available Tools\n${toolList}\n\n## Available MCP Servers\n${mcpList || '(none)'}${skillsCtx}`

    console.log(`[spawn_agent] subAgentId="${subAgentId}" prompt length=${systemPrompt.length} first 200 chars:`, systemPrompt.slice(0, 200))
    t.output = `Spawning sub-agent for task: ${task.slice(0, 100)}...`
    ex.notify()

    const handle = ex.spawnSubAgent!({
      systemPrompt,
      initialMessages: [],
      allowedTools,
      allowedMcpServers,
      allowedSkills,
      maxTokens: maxTokens || ex.opts.maxTokens,
      maxLoopIterations: maxLoopIterations || 20,
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