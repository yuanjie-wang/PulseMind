/**
 * Tool execution lifecycle (PLAN-0.3.5 refactor, split 4/5): tool approval /
 * rejection, terminal process kill and pause/resume/stop flows, extracted from
 * AgentEngine with a back-reference to the owning engine.
 */
import { AgentEngine } from '../AgentEngine'
import { getHost } from '../host'
import type { ToolUseBlock } from '../../types/agent'
import { buildCommandFromSkillInput } from '../command-builder'
import { safeInvoke } from '../agent-utils'

export class ExecutionFlow {
  constructor(private engine: AgentEngine) {}

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

}
