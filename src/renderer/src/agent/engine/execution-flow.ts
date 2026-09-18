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
import { READ_TIER_TOOLS, WRITE_TIER_TOOLS, tierOfTool } from './tool-tiers'
import { isPageTool } from '../../../../shared/agent-protocol/page-tools'
import { requiresApproval } from '../../../../shared/sandbox/policy'
import type { SandboxToolTier } from '../../../../shared/sandbox/policy'
import type { EngineCore } from './engine-core'
import { releaseQueuedSubAgents, subAgentBudgetKey } from './subagent-limiter'
import { beginTerminalSpan } from '../terminal-span'

/** Built-in tools that only look — the 'read' tier, never gated.
 *  `built-in-tools.ts` holds the definitions; the approval ladder needs the
 *  membership test at three sites (dispatch, gate, approve). The sets
 *  themselves live in tool-tiers.ts, next to `tierOfTool`. */

export class ExecutionFlow {
  constructor(private engine: EngineCore) {}

  /** The tiers this engine's approval mode holds back for the user to confirm.
   *  A sub-agent run is unattended, so it holds nothing at all. */
  private heldTiers(): Set<SandboxToolTier> {
    const held = new Set<SandboxToolTier>()
    if (this.engine.spawnSystemPrompt) return held
    const mode = this.engine.opts.approvalMode ?? 'auto'
    if (requiresApproval(mode, 'write')) held.add('write')
    if (requiresApproval(mode, 'exec')) held.add('exec')
    return held
  }

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
    // office_inspect is a read-tier workspace tool — it can no longer be held
    // (reads never wait), but the branch keeps an approval release from ever
    // reaching the shell default below (the H10 trap, same shape as page tools).
    if (targetBlock.name === 'office_inspect') {
      await this.engine.toolExecutor.execWorkspaceTool(targetBlock)
      return
    }
    // A held write reaches the executor from here (the gate skipped it in
    // dispatchToolExecution); the git tools run through execFile there, so they
    // must not fall through to the shell path below.
    if (WRITE_TIER_TOOLS.has(targetBlock.name)) {
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
    // A page tool reaches the executor from here too (the ladder held it in
    // dispatchToolExecution). Without this branch it would fall through to the
    // shell default below and be run as a command.
    if (isPageTool(targetBlock.name)) {
      await this.engine.toolExecutor.execPageTool(targetBlock)
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
    let terminalErrorReceived = false

    // Terminal events broadcast by channel, so another engine's concurrent
    // process delivers here too (PLAN-parallel-experts T7): the span filters
    // by processId and parks the pre-pid window instead of consuming it.
    const span = beginTerminalSpan(getHost(), {
      onOutput: d => { outputBuffer += d.data; targetBlock!.output = outputBuffer; this.engine.notifyCoalesced() },
      onExit: d => {
        targetBlock!.exitCode = d.code; targetBlock!.status = 'completed'; this.engine.executingProcessId = null; this.cleanup(); this.engine.notify()
        this.engine.addToolResult(toolUseId, outputBuffer || '(no output)', d.code !== 0)
      },
      onError: d => {
        if (terminalErrorReceived) return; terminalErrorReceived = true
        targetBlock!.exitCode = -1; targetBlock!.status = 'completed'; this.engine.executingProcessId = null; targetBlock!.output = d.message; this.cleanup(); this.engine.notify()
        this.engine.addToolResult(toolUseId, `Error: ${d.message}`, true)
      },
    })
    span.start()
    this.engine.terminalCleanups = [() => span.stop()]

    try {
      const timeoutMs = targetBlock.input.timeout != null ? Number(targetBlock.input.timeout) * 1000 : undefined
      const processId = await getHost().executeCommand(resolvedCommand, resolvedCwd || undefined, timeoutMs)
      this.engine.executingProcessId = processId
      span.claim(processId)
    } catch (err) {
      span.stop()
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
    // A manual pause is the same category as a held approval: the turn is still
    // in flight, the user is the one not answering. It has no status of its own
    // (the engine keeps reporting `executing`), so it pauses the clock here.
    this.engine.turnClock.pause()
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
    this.engine.turnClock.resume()
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
    this.settleSubAgentTree(this.engine)
    // 排队等槽位的专家不能在用户按停止之后再起一个（暂停不排空——恢复时还要用）。
    releaseQueuedSubAgents(subAgentBudgetKey(this.engine.opts))
    this.engine.agentStatus = { status: 'idle' }
    this.engine.streamingBlocks = []
    this.engine.pendingToolIds = new Set()
    this.engine.resolveCompletionIfSpawned('aborted')
    this.engine.notify()
  }

  /**
   * 停止（不是暂停）时把整棵专家树的 completion 结算掉。
   *
   * `cancelLoop` 故意不结算 completion——那是「暂停」，用户还可以恢复，而恢复要靠
   * 同一个 promise 把结果交回给派发方的 `waitForCompletion`。所以终止路径必须自己
   * 结算，否则每个被中止的专家都会留下三样东西：永远不清理的 5s 存档定时器、永远
   * 不放回的并行槽位（本会话的五个槽位就此永久占死，之后所有专家只能排队）、以及
   * 最后一次 tick 之后没有落库的尾部消息。
   *
   * 递归是必需的而不是保险：专家的 spawn 不受工具白名单限制，专家可以再派专家，
   * 而孙辈的派发挂在**子引擎**的 execSpawnAgent 上——只结算直接子代，孙辈的槽位
   * 照样泄漏。
   *
   * `@internal` — dispose() 走同一条路：dispose 没有「恢复」，只 cancelLoop 的话
   * 被删除会话的专家树同样槽位不归还、定时器不停（见上）。
   */
  settleSubAgentTree(engine: EngineCore): void {
    for (const subEngine of [...engine.activeSubAgents.values()]) {
      subEngine.cancelLoop()
      this.settleSubAgentTree(subEngine)
      subEngine.resolveCompletionIfSpawned('aborted')
    }
    engine.activeSubAgents.clear()
  }


  /** True when the MCP server owning a tool has requireApproval enabled. */
  private mcpRequiresApproval(toolName: string): boolean {
    const serverId = this.engine.mcpToolOwner.get(toolName)
    if (!serverId) return false
    return getCachedMcpServers().find(s => s.id === serverId)?.config?.requireApproval === true
  }

  /** Categorize and execute tool_use blocks. Shared by normal path and oversized-param skip path. */
  private async dispatchToolExecution(tools: ToolUseBlock[]): Promise<void> {
    const readOnlyTools = tools.filter(t => READ_TIER_TOOLS.has(t.name))
    const writeEditTools = tools.filter(t => WRITE_TIER_TOOLS.has(t.name))
    // Page tools are their own family (PLAN-browser-extension §3.4.2.1): they
    // must NOT join READ_TIER_TOOLS (that would send them to execReadOnlyTools'
    // file reader) or WRITE_TIER_TOOLS (that would treat a page click as a file
    // write). Reads may run in parallel; writes go one at a time so the page is
    // never acted on twice from a single batch.
    const pageReadTools = tools.filter(t => isPageTool(t.name) && tierOfTool(t.name) === 'read')
    const pageWriteTools = tools.filter(t => isPageTool(t.name) && tierOfTool(t.name) !== 'read')
    const isSystemTool = (name: string): boolean => name === 'install' || name === 'pick_skill' || name === 'pick_tool' || name === 'spawn_agent' || name === 'create_plan' || name === 'advance_plan' || name === 'webfetch' || name === 'browser'
    const systemTools = tools.filter(t => isSystemTool(t.name))
    const isMemoryTool = (name: string): boolean => name === 'memory_search' || name === 'memory_save' || name === 'conversation_search' || name === 'tool_result_search'
    const memoryTools = tools.filter(t => isMemoryTool(t.name))
    const isKnowledgeTool = (name: string): boolean => name === 'knowledge_search' || name === 'knowledge_read'
    const knowledgeTools = tools.filter(t => isKnowledgeTool(t.name))
    const isExperienceTool = (name: string): boolean => name === 'experience_read'
    const experienceTools = tools.filter(t => isExperienceTool(t.name))
    const isMCPTool = (name: string): boolean => this.engine.mcpToolOwner.has(name)
    // Gated (requireApproval) MCP tools behave like otherTools: held for approval
    // at any level above 'auto', auto-executed otherwise.
    const gatedMcpTools = tools.filter(t => isMCPTool(t.name) && this.mcpRequiresApproval(t.name))
    const mcpTools = tools.filter(t => isMCPTool(t.name) && !this.mcpRequiresApproval(t.name))
    const grouped = new Set([...readOnlyTools, ...writeEditTools, ...pageReadTools, ...pageWriteTools])
    const otherTools = tools.filter(t => !grouped.has(t) && !systemTools.includes(t) && !memoryTools.includes(t) && !knowledgeTools.includes(t) && !experienceTools.includes(t) && !isMCPTool(t.name) && t.name !== 'ask_user')
    const spawnTools = systemTools.filter(t => t.name === 'spawn_agent')
    const held = this.heldTiers()
    try {
      // spawn_agent hosts an independent engine per call, so a batch of them
      // runs CONCURRENTLY — that is multi-expert parallel delegation. They are
      // the long pole of any batch, so they start here and the serial groups
      // below run while the experts work; the batch still ends when the
      // slowest expert does. Interleaved completion is safe: addToolResult is
      // synchronous and already exercised concurrently by execReadOnlyTools.
      // Each executor swallows its own errors — this catch only keeps one
      // totally unexpected rejection from tearing down the other experts.
      const spawnBatch = spawnTools.length > 0
        ? Promise.all(spawnTools.map(t =>
            this.engine.toolExecutor.execSpawnAgent(t).catch((err: unknown) => {
              console.error('[AgentEngine] spawn_agent dispatch error:', err)
              t.status = 'completed'; t.exitCode = -1
              this.engine.addToolResult(t.id, `Error: ${err instanceof Error ? err.message : 'spawn_agent failed'}`, true)
            })
          ))
        : null
      if (readOnlyTools.length > 0) await this.engine.toolExecutor.execReadOnlyTools(readOnlyTools)
      if (pageReadTools.length > 0) await this.engine.toolExecutor.execPageReadTools(pageReadTools)
      if (!held.has('write') && writeEditTools.length > 0) for (const t of writeEditTools) await this.engine.toolExecutor.execWorkspaceTool(t)
      // A page write clears the ladder only when its own tier allows it
      // (page_execute_js is 'exec' and stays held at 'outside-ask').
      for (const t of pageWriteTools) {
        if (!requiresApproval(this.engine.opts.approvalMode ?? 'auto', tierOfTool(t.name))) {
          await this.engine.toolExecutor.execPageTool(t)
        }
      }
      if (mcpTools.length > 0) for (const t of mcpTools) await this.engine.toolExecutor.execMCPTool(t)
      if (!held.has('exec') && gatedMcpTools.length > 0) for (const t of gatedMcpTools) await this.engine.toolExecutor.execMCPTool(t)
      for (const t of systemTools) {
        if (t.name === 'spawn_agent') continue // started above, awaited after the serial groups
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
      if (!held.has('exec') && otherTools.length > 0) { for (const t of otherTools) await this.engine.toolExecutor.execOtherTool(t) }
      if (spawnBatch) await spawnBatch
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

    const hasTruncated = toolUses.some(t => (t as { _jsonTruncated?: boolean })._jsonTruncated === true)
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

    const readOnlyTools = toolUses.filter(t => READ_TIER_TOOLS.has(t.name))
    const writeEditTools = toolUses.filter(t => WRITE_TIER_TOOLS.has(t.name))
    const askUserTools = toolUses.filter(t => t.name === 'ask_user')
    // Page tools: reads never wait, writes wait per their own tier
    // (`page_execute_js` = 'exec', the rest = 'write').
    const pageTools = toolUses.filter(t => isPageTool(t.name))
    const pageReadTools = pageTools.filter(t => tierOfTool(t.name) === 'read')
    const pageWriteTools = pageTools.filter(t => tierOfTool(t.name) !== 'read')
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
    const pageHeldTools = pageWriteTools.filter(t => requiresApproval(this.engine.opts.approvalMode ?? 'auto', tierOfTool(t.name)))
    const otherTools = toolUses.filter(t => !readOnlyTools.includes(t) && !writeEditTools.includes(t) && !pageTools.includes(t) && !systemTools.includes(t) && !memoryTools.includes(t) && !knowledgeTools.includes(t) && !experienceTools.includes(t) && !mcpTools.includes(t) && t.name !== 'ask_user')

    // The approval ladder decides what waits: shell / ungrouped / gated MCP
    // calls at 'outside-ask' and above, file writes as well at 'always-ask',
    // and page writes by their own tier (reads are dispatched, never held).
    const held = this.heldTiers()
    const heldTools = [
      ...(held.has('write') ? writeEditTools : []),
      ...(held.has('exec') ? [...otherTools, ...mcpApprovalTools] : []),
      ...pageHeldTools,
    ]

    this.engine.toolUseBlocks = toolUses
    this.engine.pendingToolIds = new Set(toolUses.map(t => t.id))
    this.engine.isAutoExecuting = true
    for (const t of [...readOnlyTools, ...writeEditTools, ...systemTools, ...memoryTools, ...knowledgeTools, ...experienceTools, ...mcpAutoTools, ...pageReadTools, ...pageWriteTools]) t.status = 'running'
    for (const t of askUserTools) t.status = 'running'
    // What the ladder holds stays pending until the user approves it.
    for (const t of heldTools) t.status = 'pending'
    this.engine.notify()

    await this.dispatchToolExecution(toolUses)

    this.engine.isAutoExecuting = false
    // Report progress for spawned agents after each tool execution batch
    if (this.engine.onSpawnProgress && this.engine.spawnSystemPrompt) {
      const completed = toolUses.filter(t => t.status === 'completed').length
      this.engine.onSpawnProgress(`子代理进度: [${completed}/${toolUses.length}] ${toolUses.map(t => t.name).join(', ')}`)
    }

    // Nothing to confirm: the batch either ran to completion above or is still
    // draining asynchronously (a running command's exit closes the loop).
    if (heldTools.length === 0) {
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

    // Held: the approval UI owns the loop from here. Only an explicit approval
    // (or rejection) settles each held tool, so the pending set is exactly them.
    this.engine.pendingToolIds = new Set(heldTools.map(t => t.id))
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
    // 多专家 @召唤（计划模式）：a turn that ends with no plan is re-issued ONCE —
    // the summoned experts have not been asked to work yet, so the user's request
    // is still unanswered. Returning here keeps the turn OPEN: no `completed`
    // status, the clock keeps running, and afterSession is not fired for a turn
    // that will continue. The bound lives in the engine (`nudged`), so a model
    // that ignores both the brief and this correction closes normally next time.
    if (this.engine.nudgeSummonIfUnplanned()) return
    // The turn's duration — user send → this last output character, with every
    // thinking round and tool call in between counted and any stretch parked on
    // the user (held approval / ask_user / loop-limit prompt / manual pause)
    // excluded. The clock is the accumulator that knows the difference; the
    // per-round times stay on the intermediate messages.
    if (this.engine.turnClock.isActive()) {
      const totalMs = Math.round(this.engine.turnClock.stop())
      const lastMsg = this.engine.messages[this.engine.messages.length - 1]
      if (lastMsg?.role === 'assistant') lastMsg.processingMs = totalMs
    }
    this.engine.agentStatus = { status: 'completed' }
    this.engine.notify()
    safeInvokeObserver(this.engine.opts.hooks?.afterLlmCall, { messages: this.engine.messages, stopReason, status: { status: 'completed' } }, 'afterLlmCall')
    safeInvokeObserver(this.engine.opts.hooks?.afterSession, { messages: this.engine.messages, status: { status: 'completed' } }, 'afterSession')
    this.engine.resolveCompletionIfSpawned('completed')
  }

}
