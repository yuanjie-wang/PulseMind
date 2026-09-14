/**
 * Tool execution lifecycle (PLAN-0.3.5 refactor, split 4/5): tool approval /
 * rejection, terminal process kill and pause/resume/stop flows, extracted from
 * AgentEngine with a back-reference to the owning engine.
 */
import { getHost } from '../host'
import { getCachedMcpServers } from '../mcp-cache'
import { addTruncatedResults, validateToolParams } from './result-ingestion'
import { generateMsgId } from '../agent-utils'
import type { ToolUseBlock, ContentBlock } from '../../types/agent'
import { buildCommandFromSkillInput } from '../command-builder'
import { safeInvoke, safeInvokeObserver } from '../agent-utils'
import { TOOL_PARAM_LIMITS } from './engine-constants'
import type { EngineCore } from './engine-core'

export class ExecutionFlow {
  constructor(private engine: EngineCore) {}

  cleanup(): void {
    this.engine.terminalCleanups.forEach((fn: () => void) => { try { fn() } catch { /* ignore */ } })
    this.engine.terminalCleanups = []
    if (this.engine.executingProcessId) {
      try { this.engine.getHost().killCommand(this.engine.executingProcessId) } catch { /* already dead */ }
      this.engine.executingProcessId = null
    }
  }


  approveTool = async (toolUseId: string): Promise<void> => {
    if (!this.engine.opts.apiKey) return

    let targetBlock: ToolUseBlock | undefined
    for (const msg of this.engine.messages) {
      for (const block of msg.contentBlocks) {
        if (block.type === 'tool_use' && block.id === toolUseId) { targetBlock = block; break }
      }
      if (targetBlock) break
    }
    if (!targetBlock) { this.engine.agentStatus = { status: 'error', error: 'Tool use block not found' }; this.engine.notify(); return }

    targetBlock.status = 'running'; this.engine.notify()
    this.engine.agentStatus = { status: 'executing', toolUseId }; this.engine.notify()

    const memoryTools: string[] = ['memory_search', 'memory_save', 'conversation_search', 'tool_result_search']
    if (memoryTools.includes(targetBlock.name)) {
      await this.engine.toolExecutor.execOtherTool(targetBlock)
      return
    }
    if (targetBlock.name === 'write' || targetBlock.name === 'edit') {
      await this.engine.toolExecutor.execWorkspaceTool(targetBlock)
      return
    }
    if (this.engine.mcpToolOwner.has(targetBlock.name)) {
      await this.engine.toolExecutor.execMCPTool(targetBlock)
      return
    }
    if (targetBlock.name === 'spawn_agent') {
      await this.engine.toolExecutor.execSpawnAgent(targetBlock)
      return
    }

    // ask_user — no tool_result yet, wait for respondToTool
    if (targetBlock.name === 'ask_user') {
      targetBlock.status = 'running'; this.engine.notify(); return
    }

    // Shell execution (default)
    const platform = this.engine.opts.platformInfo?.platform || ''
    const command = buildCommandFromSkillInput(targetBlock.name, targetBlock.input || {}, platform, this.engine.opts.platformInfo?.ripgrepPath)
    const cwd = String(targetBlock.input.cwd || '')

    const beforeToolCtx = await safeInvoke(this.engine.opts.hooks?.beforeTool, { toolUseId, toolName: targetBlock.name, toolInput: targetBlock.input, command, cwd }, 'beforeTool')
    const resolvedCommand = beforeToolCtx.command; const resolvedCwd = beforeToolCtx.cwd
    if (!resolvedCommand.trim()) { this.engine.addToolResult(toolUseId, 'Tool execution was blocked by beforeTool hook (empty command).', true); return }

    this.cleanup()
    let outputBuffer = ''

    const uo = getHost().onTerminalOutput(d => { outputBuffer += d.data; targetBlock!.output = outputBuffer; this.engine.notifyCoalesced() })
    const ue = getHost().onTerminalExit(d => {
      targetBlock!.exitCode = d.code; targetBlock!.status = 'completed'; this.engine.executingProcessId = null; this.cleanup(); this.engine.notify()
      this.engine.addToolResult(toolUseId, outputBuffer || '(no output)', d.code !== 0)
    })
    let terminalErrorReceived = false
    const uerr = getHost().onTerminalError(d => {
      if (terminalErrorReceived) return; terminalErrorReceived = true
      targetBlock!.exitCode = -1; targetBlock!.status = 'completed'; this.engine.executingProcessId = null; targetBlock!.output = d.message; this.cleanup(); this.engine.notify()
      this.engine.addToolResult(toolUseId, `Error: ${d.message}`, true)
    })
    this.engine.terminalCleanups = [uo, ue, uerr].filter(Boolean) as (() => void)[]

    try {
      const timeoutMs = targetBlock.input.timeout != null ? Number(targetBlock.input.timeout) * 1000 : undefined
      const processId = await getHost().executeCommand(resolvedCommand, resolvedCwd || undefined, timeoutMs)
      this.engine.executingProcessId = processId
    } catch (err) {
      targetBlock.status = 'completed'; targetBlock.exitCode = -1; targetBlock.output = `Error: ${err instanceof Error ? err.message : 'Failed'}`
      this.cleanup(); this.engine.notify()
      this.engine.addToolResult(toolUseId, targetBlock.output, true)
    }
  }


  rejectTool = (toolUseId: string): void => {
    for (const msg of this.engine.messages) {
      for (const block of msg.contentBlocks) {
        if (block.type === 'tool_use' && block.id === toolUseId) { block.status = 'rejected'; break }
      }
    }
    this.engine.notify()
    this.engine.addToolResult(toolUseId, 'Command execution was rejected by the user.', true)
  }


  killTool = (toolUseId: string): void => {
    if (this.engine.executingProcessId) { getHost().killCommand(this.engine.executingProcessId); this.engine.executingProcessId = null }
    this.cleanup()
    for (const msg of this.engine.messages) {
      for (const block of msg.contentBlocks) {
        if (block.type === 'tool_use' && block.id === toolUseId) { block.status = 'completed'; block.exitCode = -1; block.output = '(killed by user)'; break }
      }
    }
    this.engine.notify()
    this.engine.addToolResult(toolUseId, 'Command execution was killed by the user.', true)
  }

  /** Pause execution (cancel current work but DON'T resolve spawn completion) */
  pauseExecution = (): void => {
    this.engine.isCancelled = true
    this.engine.abortController?.abort()
    if (this.engine.currentRequestId) { getHost().apiAbortStream(this.engine.currentRequestId); this.engine.currentRequestId = null }
    this.cleanup()
    if (this.engine.executingProcessId) { getHost().killCommand(this.engine.executingProcessId); this.engine.executingProcessId = null }
    this.engine.streamingBlocks = []
    this.engine.pendingToolIds = new Set()
    this.engine.notify()
  }

  /** Resume execution (reset cancelled state and restart loop) */
  resumeExecution = (): void => {
    for (const subEngine of this.engine.activeSubAgents.values()) {
      subEngine.resumeExecution()
    }
    this.engine.isCancelled = false
    this.engine.loopCount = 0
    this.engine.pendingToolIds = new Set()
    this.engine.agentStatus = { status: 'idle' }
    this.engine.notify()
    setTimeout(() => this.engine.continueLoop(), 0)
  }

  /** Fully stop execution (main agent + abort all sub-agents) */
  stopExecution = (): void => {
    this.engine.isCancelled = true
    this.engine.abortController?.abort()
    if (this.engine.currentRequestId) { getHost().apiAbortStream(this.engine.currentRequestId); this.engine.currentRequestId = null }
    this.cleanup()
    if (this.engine.executingProcessId) { getHost().killCommand(this.engine.executingProcessId); this.engine.executingProcessId = null }
    for (const subEngine of this.engine.activeSubAgents.values()) {
      subEngine.cancelLoop()
    }
    this.engine.activeSubAgents.clear()
    this.engine.agentStatus = { status: 'idle' }
    this.engine.streamingBlocks = []
    this.engine.pendingToolIds = new Set()
    this.engine.resolveCompletionIfSpawned('aborted')
    this.engine.notify()
  }


  /** True when the MCP server owning a tool has requireApproval enabled. */
  private mcpRequiresApproval(toolName: string): boolean {
    const serverId = this.engine.mcpToolOwner.get(toolName)
    if (!serverId) return false
    return getCachedMcpServers().find(s => s.id === serverId)?.config?.requireApproval === true
  }

  /** Categorize and execute tool_use blocks. Shared by normal path and oversized-param skip path. */
  private async dispatchToolExecution(tools: ToolUseBlock[]): Promise<void> {
    const readOnlyTools = tools.filter(t => t.name === 'read' || t.name === 'list_dir' || t.name === 'find' || t.name === 'search' || t.name === 'git_status' || t.name === 'git_diff' || t.name === 'git_log')
    const writeEditTools = tools.filter(t => t.name === 'write' || t.name === 'edit' || t.name === 'git_commit' || t.name === 'git_restore')
    const isSystemTool = (name: string): boolean => name === 'install' || name === 'pick_skill' || name === 'pick_tool' || name === 'spawn_agent' || name === 'create_plan' || name === 'advance_plan' || name === 'webfetch' || name === 'browser'
    const systemTools = tools.filter(t => isSystemTool(t.name))
    const isMemoryTool = (name: string): boolean => name === 'memory_search' || name === 'memory_save' || name === 'conversation_search' || name === 'tool_result_search'
    const memoryTools = tools.filter(t => isMemoryTool(t.name))
    const isKnowledgeTool = (name: string): boolean => name === 'knowledge_search' || name === 'knowledge_read'
    const knowledgeTools = tools.filter(t => isKnowledgeTool(t.name))
    const isExperienceTool = (name: string): boolean => name === 'experience_read'
    const experienceTools = tools.filter(t => isExperienceTool(t.name))
    const isMCPTool = (name: string): boolean => this.engine.mcpToolOwner.has(name)
    // Gated (requireApproval) MCP tools behave like otherTools: auto-executed only in
    // YOLO mode, otherwise they wait for user approval in handleToolUseResponse.
    const gatedMcpTools = tools.filter(t => isMCPTool(t.name) && this.mcpRequiresApproval(t.name))
    const mcpTools = tools.filter(t => isMCPTool(t.name) && !this.mcpRequiresApproval(t.name))
    const otherTools = tools.filter(t => !readOnlyTools.includes(t) && !writeEditTools.includes(t) && !systemTools.includes(t) && !memoryTools.includes(t) && !knowledgeTools.includes(t) && !experienceTools.includes(t) && !isMCPTool(t.name) && t.name !== 'ask_user')
    const isYoloMode = !!this.engine.opts.yoloMode || !!this.engine.spawnSystemPrompt

    try {
      if (readOnlyTools.length > 0) await this.engine.toolExecutor.execReadOnlyTools(readOnlyTools)
      if (writeEditTools.length > 0) for (const t of writeEditTools) await this.engine.toolExecutor.execWorkspaceTool(t)
      if (mcpTools.length > 0) for (const t of mcpTools) await this.engine.toolExecutor.execMCPTool(t)
      if (isYoloMode && gatedMcpTools.length > 0) for (const t of gatedMcpTools) await this.engine.toolExecutor.execMCPTool(t)
      for (const t of systemTools) {
        if (t.name === 'pick_skill') await this.engine.toolExecutor.execPickSkill(t)
        else if (t.name === 'pick_tool') await this.engine.toolExecutor.execPickTool(t, (names) => {
          // Classify by built-in definition set (not mcpToolOwner): an MCP tool from a
          // server that connected after this loop's discovery is still a valid MCP pick.
          const builtinNames = new Set(this.engine.opts.toolManager.getEnabledTools().map(x => x.definition.name))
          this.engine.selectedMcpTools = names.filter(n => !builtinNames.has(n))
          this.engine.selectedBuiltinTools = names.filter(n => builtinNames.has(n))
        })
        else if (t.name === 'install') await this.engine.toolExecutor.execInstall(t)
        else if (t.name === 'spawn_agent') await this.engine.toolExecutor.execSpawnAgent(t)
        else if (t.name === 'webfetch') await this.engine.toolExecutor.execWebFetch(t)
        else if (t.name === 'browser') await this.engine.toolExecutor.execBrowser(t)
        else if (t.name === 'create_plan') await this.engine.planManager.execCreatePlan(t)
        else if (t.name === 'advance_plan') await this.engine.planManager.execAdvancePlan(t)
      }
      if (memoryTools.length > 0) for (const t of memoryTools) await this.engine.toolExecutor.execOtherTool(t)
      if (knowledgeTools.length > 0) for (const t of knowledgeTools) await this.engine.toolExecutor.execOtherTool(t)
      if (experienceTools.length > 0) for (const t of experienceTools) await this.engine.toolExecutor.execOtherTool(t)
      if (isYoloMode && otherTools.length > 0) { for (const t of otherTools) await this.engine.toolExecutor.execOtherTool(t) }
    } catch (err) {
      this.engine.isAutoExecuting = false
      const msg = err instanceof Error ? err.message : 'Tool execution failed'
      console.error('[AgentEngine] Tool execution error:', msg)
      this.engine.agentStatus = { status: 'error', error: msg }
      this.engine.notify()
      return
    }
  }

  /** @internal */
  async handleToolUseResponse(toolUses: ToolUseBlock[]): Promise<void> {
    const opts = this.engine.opts

    const hasTruncated = toolUses.some(t => (t as any)._jsonTruncated === true)
    if (hasTruncated) {
      addTruncatedResults(this.engine.messages, toolUses)
      this.engine.notify()
      this.engine.continueLoop()
      return
    }

    // Reject tools with oversized parameters before dispatching
    const oversized = validateToolParams(toolUses)
    if (oversized.length > 0) {
      const oversizedIds = new Set(oversized.map(t => t.id))
      const oversizedResults: ContentBlock[] = oversized.map(t => {
        t.status = 'completed'
        const limits = TOOL_PARAM_LIMITS[t.name] || {}
        const details = Object.entries(limits)
          .filter(([key]) => typeof t.input?.[key] === 'string')
          .map(([key, max]) => `${key}: ${String(t.input?.[key] ?? '').length} chars (max ${max})`)
          .join(', ')
        const msg = `Tool "${t.name}" was rejected: parameter(s) too large (${details}). Please split the work into smaller calls.`
        return { type: 'tool_result' as const, tool_use_id: t.id, content: msg, is_error: true, tool_result_id: crypto.randomUUID() }
      })
      this.engine.messages = [...this.engine.messages, { id: generateMsgId(), role: 'user' as const, contentBlocks: oversizedResults, createdAt: new Date().toISOString() }]
      // Execute non-oversized tools
      const validTools = toolUses.filter(t => !oversizedIds.has(t.id))
      if (validTools.length > 0) {
        await this.dispatchToolExecution(validTools)
      }
      this.engine.notify()
      this.engine.continueLoop()
      return
    }

    const readOnlyTools = toolUses.filter(t => t.name === 'read' || t.name === 'list_dir' || t.name === 'find' || t.name === 'search' || t.name === 'git_status' || t.name === 'git_diff' || t.name === 'git_log')
    const writeEditTools = toolUses.filter(t => t.name === 'write' || t.name === 'edit' || t.name === 'git_commit' || t.name === 'git_restore')
    const askUserTools = toolUses.filter(t => t.name === 'ask_user')
    const isSystemTool = (name: string): boolean => name === 'install' || name === 'pick_skill' || name === 'pick_tool' || name === 'spawn_agent' || name === 'create_plan' || name === 'advance_plan' || name === 'webfetch' || name === 'browser'
    const systemTools = toolUses.filter(t => isSystemTool(t.name))
    const isMemoryTool = (name: string): boolean => name === 'memory_search' || name === 'memory_save' || name === 'conversation_search' || name === 'tool_result_search'
    const memoryTools = toolUses.filter(t => isMemoryTool(t.name))
    const isKnowledgeTool = (name: string): boolean => name === 'knowledge_search' || name === 'knowledge_read'
    const knowledgeTools = toolUses.filter(t => isKnowledgeTool(t.name))
    const isExperienceTool = (name: string): boolean => name === 'experience_read'
    const experienceTools = toolUses.filter(t => isExperienceTool(t.name))
    const isMCPTool = (name: string): boolean => this.engine.mcpToolOwner.has(name)
    const mcpApprovalTools = toolUses.filter(t => isMCPTool(t.name) && this.mcpRequiresApproval(t.name))
    const mcpAutoTools = toolUses.filter(t => isMCPTool(t.name) && !this.mcpRequiresApproval(t.name))
    const mcpTools = toolUses.filter(t => isMCPTool(t.name))
    const otherTools = toolUses.filter(t => !readOnlyTools.includes(t) && !writeEditTools.includes(t) && !systemTools.includes(t) && !memoryTools.includes(t) && !knowledgeTools.includes(t) && !experienceTools.includes(t) && !mcpTools.includes(t) && t.name !== 'ask_user')

    const isYoloMode = !!opts.yoloMode || !!this.engine.spawnSystemPrompt

    this.engine.toolUseBlocks = toolUses
    this.engine.pendingToolIds = new Set(toolUses.map(t => t.id))
    this.engine.isAutoExecuting = true
    for (const t of [...readOnlyTools, ...writeEditTools, ...systemTools, ...memoryTools, ...knowledgeTools, ...experienceTools, ...mcpAutoTools]) t.status = 'running'
    for (const t of askUserTools) t.status = 'running'
    // Gated MCP tools auto-execute in YOLO mode (incl. sub-agents); in mixed mode
    // they stay pending until the user approves.
    if (isYoloMode) for (const t of [...otherTools, ...mcpApprovalTools]) t.status = 'running'
    else for (const t of mcpApprovalTools) t.status = 'pending'
    this.engine.notify()

    await this.dispatchToolExecution(toolUses)

    this.engine.isAutoExecuting = false
    // Report progress for spawned agents after each tool execution batch
    if (this.engine.onSpawnProgress && this.engine.spawnSystemPrompt) {
      const completed = toolUses.filter(t => t.status === 'completed').length
      this.engine.onSpawnProgress(`子代理进度: [${completed}/${toolUses.length}] ${toolUses.map(t => t.name).join(', ')}`)
    }

    // YOLO mode (incl. sub-agents) bypasses the approval gate — gated MCP tools were
    // already executed by dispatchToolExecution. Only mixed mode holds them for approval.
    const shouldAutoExecAll = isYoloMode || (otherTools.length === 0 && mcpApprovalTools.length === 0)
    if (shouldAutoExecAll) {
      if (askUserTools.length > 0) {
        if (this.engine.spawnSystemPrompt) {
          for (const t of askUserTools) {
            this.engine.addToolResult(t.id, 'ask_user is not available in sub-agent mode.', true)
            t.status = 'completed'
          }
          if (this.engine.pendingToolIds.size === 0) this.engine.continueLoop()
          else { this.engine.agentStatus = { status: 'completed' }; this.engine.notify(); this.engine.resolveCompletionIfSpawned('completed') }
        } else {
          this.engine.agentStatus = { status: 'awaiting_user_input', tools: askUserTools }
        }
      } else if (this.engine.pendingToolIds.size === 0) this.engine.continueLoop()
      else { this.engine.agentStatus = { status: 'completed' }; this.engine.resolveCompletionIfSpawned('completed') }
      this.engine.notify()
      safeInvokeObserver(opts.hooks?.afterLlmCall, { messages: this.engine.messages, stopReason: 'tool_use', status: this.engine.agentStatus }, 'afterLlmCall')
      return
    }

    // Mixed mode: show approval UI (gated MCP tools are held for approval — only YOLO mode auto-executes them)
    this.engine.toolUseBlocks = toolUses
    const approvalTools = toolUses.filter(t => !readOnlyTools.includes(t) && !writeEditTools.includes(t) && !mcpAutoTools.includes(t) && !systemTools.includes(t) && !memoryTools.includes(t))
    this.engine.pendingToolIds = new Set(approvalTools.map(t => t.id))
    this.engine.agentStatus = { status: 'awaiting_approval', tools: toolUses }
    safeInvokeObserver(opts.hooks?.afterLlmCall, { messages: this.engine.messages, stopReason: 'tool_use', status: { status: 'awaiting_approval', tools: toolUses } }, 'afterLlmCall')
    this.engine.notify()
  }

  /** @internal */
  async handleMaxTokensResponse(toolUses: ToolUseBlock[]): Promise<void> {
    if (toolUses.length > 0) { addTruncatedResults(this.engine.messages, toolUses); this.engine.notify() }
    safeInvokeObserver(this.engine.opts.hooks?.afterLlmCall, { messages: this.engine.messages, stopReason: 'max_tokens', status: { status: 'streaming' } }, 'afterLlmCall')
    this.engine.continueLoop()
  }

  /** @internal */
  handleEndTurnResponse(stopReason: string | null): void {
    // Update last assistant message with total session time (user input → loop end)
    if (this.engine.sessionStartTime > 0) {
      const totalMs = Math.round(performance.now() - this.engine.sessionStartTime)
      const lastMsg = this.engine.messages[this.engine.messages.length - 1]
      if (lastMsg?.role === 'assistant') lastMsg.processingMs = totalMs
      this.engine.sessionStartTime = 0
    }
    this.engine.agentStatus = { status: 'completed' }
    this.engine.notify()
    safeInvokeObserver(this.engine.opts.hooks?.afterLlmCall, { messages: this.engine.messages, stopReason, status: { status: 'completed' } }, 'afterLlmCall')
    safeInvokeObserver(this.engine.opts.hooks?.afterSession, { messages: this.engine.messages, status: { status: 'completed' } }, 'afterSession')
    this.engine.resolveCompletionIfSpawned('completed')
  }

}
