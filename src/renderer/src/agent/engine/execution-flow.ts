/**
 * Tool execution lifecycle (PLAN-0.3.5 refactor, split 4/5): tool approval /
 * rejection, terminal process kill and pause/resume/stop flows, extracted from
 * AgentEngine with a back-reference to the owning engine.
 */
import { getHost } from '../host'
import { runTurnEndMemoryExtraction } from './memory-extraction'
import { getCachedMcpServers } from '../mcp-cache'
import { addTruncatedResults, validateToolParams } from './result-ingestion'
import { generateMsgId } from '../agent-utils'
import type { ToolUseBlock, ContentBlock, AgentMessage } from '../../types/agent'
import { buildCommandFromSkillInput, detectShellFileWrite, shellFileWriteRejection } from '../command-builder'
import { installTypeOf } from '../executors/install-tool'
import { safeInvoke, safeInvokeObserver, editToolTargetPaths } from '../agent-utils'
import { TOOL_PARAM_LIMITS, MAX_LIVE_OUTPUT_CHARS } from './engine-constants'
import { READ_TIER_TOOLS, WRITE_TIER_TOOLS, tierOfTool } from './tool-tiers'
import { isPageTool } from '../../../../shared/agent-protocol/page-tools'
import { requiresApproval } from '../../../../shared/sandbox/policy'
import { isProjectInstructionsPath } from '../system-prompt-builder'
import type { SandboxToolTier } from '../../../../shared/sandbox/policy'
import { commandAllowlistKey, commandMatchesAllowlist } from '../../../../shared/sandbox/command-allowlist'
import { registerForegroundExec, unregisterForegroundExec } from '../executors/foreground-exec'
import type { EngineCore } from './engine-core'
import type { PulseHost } from '../host/types'
import { releaseQueuedSubAgents, subAgentBudgetKey } from './subagent-limiter'
import { beginTerminalSpan } from '../terminal-span'

/** Built-in tools that only look — the 'read' tier, never gated.
 *  `built-in-tools.ts` holds the definitions; the approval ladder needs the
 *  membership test at three sites (dispatch, gate, approve). The sets
 *  themselves live in tool-tiers.ts, next to `tierOfTool`. */

/** The trusted memory group's membership — ONE list shared by the dispatch
 *  partition (isMemoryTool below) and approveTool's release routing. A drifted
 *  third copy in approveTool once missed context_compact: exactly the
 *  copy-drift accident the dispatch-side comment warns about, so the list
 *  lives once, here. */
const MEMORY_GROUP_TOOL_NAMES = ['recall', 'memory_save', 'tool_result_search', 'context_compact']

/** Swap one tool_use block for a restamped replacement inside the message that
 *  owns it (the stream's just-appended assistant message). Engine-side the
 *  contentBlocks array is edited in place — every diff consumer keys on message
 *  id / block id, or on the content signature, and the BLOCK object swap is
 *  exactly what makes that signature change. */
function swapToolUseBlock(messages: AgentMessage[], oldBlock: ToolUseBlock, newBlock: ToolUseBlock): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const blocks = messages[i].contentBlocks
    if (!blocks) continue
    const idx = blocks.indexOf(oldBlock)
    if (idx === -1) continue
    blocks[idx] = newBlock
    return
  }
}

export class ExecutionFlow {
  constructor(private engine: EngineCore) {}

  /** The tiers this engine's approval mode holds back for the user to confirm.
   *  A sub-agent run is unattended, so it holds nothing at all. */
  private heldTiers(): Set<SandboxToolTier> {
    const held = new Set<SandboxToolTier>()
    if (this.engine.spawnSystemPrompt) return held
    // The fallback is deliberately 'auto', NOT DEFAULT_APPROVAL_MODE: it covers
    // engines with NO user to answer a hold (a sub-agent inheriting an unset
    // parent / a derived session that pins its own level — see
    // AgentEngineOptions.approvalMode). A hold nobody can release is worse
    // than an auto-run; every user-facing constructor passes an explicit level.
    const mode = this.engine.opts.approvalMode ?? 'auto'
    if (requiresApproval(mode, 'write')) held.add('write')
    if (requiresApproval(mode, 'exec')) held.add('exec')
    return held
  }

  cleanup(): void {
    // Order is kill → settle → unbind, and each step is load-bearing
    // (2026-10-24 harness review B7): the killed process's exit event arrives
    // asynchronously over IPC, so a cleanup that unbound the terminal listeners
    // FIRST left that exit unconsumed — the block spun 执行中 forever and its
    // id never left pendingToolIds (approving a second held call mid-run killed
    // the first command and wedged the whole batch in 'executing'; a
    // stop/pause mid-command left a permanently-spinning card). We kill, settle
    // the killed call's block HERE, and only then unbind — the later exit
    // event lands on a stopped span and is dropped deterministically, the
    // duplicate result on the already-settled id is swallowed by addToolResult's
    // duplicate guard.
    const pid = this.engine.executingProcessId
    const killedToolUseId = this.engine.executingToolUseId
    this.engine.executingProcessId = null
    this.engine.executingToolUseId = null
    if (pid) {
      try { this.engine.getHost().killCommand(pid) } catch { /* already dead */ }
    }
    this.engine.terminalCleanups.forEach((fn: () => void) => { try { fn() } catch { /* ignore */ } })
    this.engine.terminalCleanups = []
    if (pid && killedToolUseId) {
      const block = this.findToolBlock(killedToolUseId)
      // 'running' only: a block the onExit/onError handler already settled
      // cleared the pid fields, so this path can only see a genuinely
      // in-flight command.
      if (block && block.status === 'running') {
        block.status = 'completed'
        block.exitCode = -1
        block.output = `${block.output || ''}\n[killed by user]`.trimStart()
        this.engine.notify()
        this.engine.addToolResult(killedToolUseId, 'Command execution was terminated before exit (killed by session cleanup).', true)
      }
    }
  }


  approveTool = async (toolUseId: string, alwaysAllow?: boolean): Promise<void> => {
    // No apiKey gate: approving releases a TOOL execution, and since every
    // engine is main-hosted the LLM stream rides the api-proxy's own profile
    // resolution — `opts.apiKey` is legitimately empty for local providers
    // (ollama/LM Studio), and the old silent return here left such sessions
    // parked on awaiting_approval with a dead button (the renderer-engine-era
    // guard survived the M1.4 move). Missing-block and execution failures
    // still settle loudly below.

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

    const memoryTools: string[] = MEMORY_GROUP_TOOL_NAMES
    if (memoryTools.includes(targetBlock.name)) {
      await this.engine.toolExecutor.execOtherTool(targetBlock)
      return
    }
    // office_inspect / office_read / office_search are read-tier workspace
    // tools — they can no longer be held (reads never wait), but the branch
    // keeps an approval release from ever reaching the shell default below
    // (the H10 trap, same shape as page tools).
    if (targetBlock.name === 'office_inspect' || targetBlock.name === 'office_read' || targetBlock.name === 'office_search') {
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
    // install 的 MCP 分支被 exec 档扣留（audit 2026-10-10 #1）——放行后从这
    // 里进执行器；没有这行它会掉进下面的 shell 默认路径被当命令执行。
    if (targetBlock.name === 'install') {
      await this.engine.toolExecutor.execInstall(targetBlock)
      return
    }

    // ask_user — no tool_result yet, wait for respondToTool
    if (targetBlock.name === 'ask_user') {
      targetBlock.status = 'running'; this.engine.notify(); return
    }

    // Shell execution (default)
    // File-write gate (2026-10-27): the auto path gates inside
    // execSkillCommand; this is the released-call path, and the SAME raw
    // input gets the SAME scan — approval releases execution, it does not
    // launder a command the gate would have refused.
    if (typeof targetBlock.input?.command === 'string' && targetBlock.input.command.trim()) {
      const trip = detectShellFileWrite(targetBlock.input.command)
      if (trip) {
        const msg = shellFileWriteRejection(trip)
        targetBlock.exitCode = 1
        targetBlock.status = 'completed'
        targetBlock.output = msg
        this.engine.addToolResult(toolUseId, msg, true)
        this.engine.notify()
        return
      }
    }
    const platform = this.engine.opts.platformInfo?.platform || ''
    const command = buildCommandFromSkillInput(targetBlock.name, targetBlock.input || {}, platform, this.engine.opts.platformInfo?.ripgrepPath)
    const cwd = String(targetBlock.input.cwd || '')

    const beforeToolCtx = await safeInvoke(this.engine.opts.hooks?.beforeTool, { toolUseId, toolName: targetBlock.name, toolInput: targetBlock.input, command, cwd }, 'beforeTool')
    const resolvedCommand = beforeToolCtx.command; const resolvedCwd = beforeToolCtx.cwd
    if (!resolvedCommand.trim()) { this.engine.addToolResult(toolUseId, 'Tool execution was blocked by beforeTool hook (empty command).', true); return }

    this.cleanup()
    let outputBuffer = ''
    let terminalErrorReceived = false

    // 「本会话总是允许」(P0-2 #7): the click that approves this call may also
    // narrow the rest of the session — store the command's stable prefix in the
    // session context so the ladder (handleToolUseResponse / dispatchToolExecution)
    // stops holding matching commands. The allowlist lives main-side; failures
    // degrade to a plain one-shot approval.
    if (alwaysAllow) {
      const key = commandAllowlistKey(resolvedCommand)
      if (key) {
        try { await getHost().addExecAllowlist(key) } catch { /* no session context or old host — plain approval */ }
      }
    }

    // Terminal events broadcast by channel, so another engine's concurrent
    // process delivers here too (PLAN-parallel-experts T7): the span filters
    // by processId and parks the pre-pid window instead of consuming it.
    const span = beginTerminalSpan(getHost(), {
      onOutput: d => {
        outputBuffer += d.data
        // Live-output cap (MAX_LIVE_OUTPUT_CHARS): a runaway process must not
        // grow the block (and main-process memory) without bound. Head-kept —
        // the same slice the session-manager wire cap already shows the
        // renderer, so past the cap the frozen head also freezes the
        // tool_status diff signature and the per-tick updates stop.
        if (outputBuffer.length > MAX_LIVE_OUTPUT_CHARS) outputBuffer = outputBuffer.slice(0, MAX_LIVE_OUTPUT_CHARS)
        targetBlock!.output = outputBuffer; this.engine.notifyCoalesced()
      },
      onExit: d => {
        unregisterForegroundExec(toolUseId)
        targetBlock!.exitCode = d.code; targetBlock!.status = 'completed'; this.engine.executingProcessId = null; this.engine.executingToolUseId = null; this.cleanup(); this.engine.notify()
        this.engine.addToolResult(toolUseId, outputBuffer || '(no output)', d.code !== 0)
        // Verify-streak reset for the RELEASED path (2026-10-27 验证闭环): an
        // approved verification run clears the source-edit streak exactly like
        // the auto path's execSkillCommand does — the model verified, it just
        // needed the user's blessing. resolvedCommand is what actually ran
        // (the beforeTool hook may have rewritten it). Optional call: the
        // concrete ToolExecutor always has it, but test fakes may not.
        this.engine.toolExecutor.noteVerifyExec?.(resolvedCommand)
      },
      onError: d => {
        if (terminalErrorReceived) return; terminalErrorReceived = true
        unregisterForegroundExec(toolUseId)
        targetBlock!.exitCode = -1; targetBlock!.status = 'completed'; this.engine.executingProcessId = null; this.engine.executingToolUseId = null; targetBlock!.output = d.message; this.cleanup(); this.engine.notify()
        this.engine.addToolResult(toolUseId, `Error: ${d.message}`, true)
      },
    })
    span.start()
    this.engine.terminalCleanups = [() => span.stop()]

    try {
      const timeoutMs = targetBlock.input.timeout != null ? Number(targetBlock.input.timeout) * 1000 : undefined
      // Same shell key as the auto path (review P0-1): an approved command's
      // cd/export must land in the SAME persistent shell the auto-run commands
      // use, or the session's state forks between the two dispatch sites.
      const processId = await getHost().executeCommand(resolvedCommand, resolvedCwd || undefined, timeoutMs, this.engine.opts.conversationId)
      this.engine.executingProcessId = processId
      this.engine.executingToolUseId = toolUseId
      span.claim(processId)
      // Promotion handle (PLAN-background-tasks A): the approve-released exec
      // parks no promise — its loop continuation is the onExit tail — so a
      // 转入后台 click settles INLINE via promoteReleasedTool below.
      registerForegroundExec(toolUseId, {
        processId,
        promote: () => { this.promoteReleasedTool(toolUseId) },
      })
    } catch (err) {
      span.stop()
      targetBlock.status = 'completed'; targetBlock.exitCode = -1; targetBlock.output = `Error: ${err instanceof Error ? err.message : 'Failed'}`
      this.cleanup(); this.engine.notify()
      this.engine.addToolResult(toolUseId, targetBlock.output, true)
    }
  }


  /** 运行中「转入后台」on the approve-released path (PLAN-background-tasks A).
   *  This path has no parked promise — the loop continues from the span's
   *  onExit tail — so promotion settles the block INLINE: stop the span, move
   *  the process to the pid-keyed background channels, settle with the SAME
   *  background envelope a `background: true` spawn uses, and let
   *  addToolResult's tail continue the loop exactly as an exit would. Returns
   *  false when this tool is not the engine's in-flight released command (the
   *  auto path owns the registry hit in that case). */
  promoteReleasedTool = (toolUseId: string): boolean => {
    const processId = this.engine.executingProcessId
    const ownedToolUseId = this.engine.executingToolUseId
    if (!processId || ownedToolUseId !== toolUseId) return false
    const block = this.findToolBlock(toolUseId)
    if (!block || block.status !== 'running') return false
    unregisterForegroundExec(toolUseId)
    // The span and the scalar die together — no further terminal event for
    // this processId may settle the already-settled block.
    this.engine.terminalCleanups.forEach((fn: () => void) => { try { fn() } catch { /* already gone */ } })
    this.engine.terminalCleanups = []
    this.engine.executingProcessId = null
    this.engine.executingToolUseId = null
    block.status = 'completed'
    void getHost().promoteToBackground(processId)
      .catch(() => null)
      .then((promoted) => {
        if (promoted && promoted.pid > 0) {
          block.exitCode = 0
          block.backgroundPid = promoted.pid
          const note = `Moved to background by the user: pid=${promoted.pid}\n\nThis result is immediate — the process keeps running beyond the turn. When it exits you will be NOTIFIED in a later turn's context (a Background Tasks section appears automatically — no polling needed); you can also read its output anytime with exec_logs(pid=${promoted.pid}) (the log tail also reports "[exited code=N]" once it ends). Stop it with exec_kill(pid=${promoted.pid}).`
          block.output = note
          this.engine.addToolResult(toolUseId, note, false)
        } else {
          // The process ended (or could not be adopted) between the click and
          // the move — settle honestly instead of promising a background run.
          const msg = 'The command exited before it could be moved to the background.'
          block.exitCode = -1
          block.output = msg
          this.engine.addToolResult(toolUseId, msg, true)
        }
        this.engine.notify()
      })
    return true
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
    // A background block's kill goes through the pid channel (P0-3), NOT the
    // scalar below — the block settled long ago, so killing must reach the
    // session-registered pid instead of whatever foreground process (if any)
    // happens to be running now.
    const block = this.findToolBlock(toolUseId)
    const backgroundPid = (block as { backgroundPid?: number } | undefined)?.backgroundPid
    if (block && backgroundPid) {
      getHost().execKill(backgroundPid).catch(() => { /* already gone */ })
      const updated = `${block.output || ''}\n[killed by user]`
      block.output = updated
      this.engine.notify()
      this.engine.addToolResult(toolUseId, updated, false)
      return
    }
    if (this.engine.executingProcessId) { getHost().killCommand(this.engine.executingProcessId); this.engine.executingProcessId = null; this.engine.executingToolUseId = null }
    this.cleanup()
    for (const msg of this.engine.messages) {
      for (const blk of msg.contentBlocks) {
        if (blk.type === 'tool_use' && blk.id === toolUseId) { blk.status = 'completed'; blk.exitCode = -1; blk.output = '(killed by user)'; break }
      }
    }
    this.engine.notify()
    this.engine.addToolResult(toolUseId, 'Command execution was killed by the user.', true)
  }

  private findToolBlock(toolUseId: string): ToolUseBlock | undefined {
    for (const msg of this.engine.messages) {
      for (const block of msg.contentBlocks) {
        if (block.type === 'tool_use' && block.id === toolUseId) return block
      }
    }
    return undefined
  }

  /**
   * 冻结回合（cancelLoop——停止按钮的引擎落点——委托到这里；user ruling
   * 2026-09-29 体验回滚：单停止钮，不再有独立的 ⏸）。主循环与整棵专家树一起
   * 冻结——各自中止在飞的请求/进程、`isCancelled` 关闸、递归进入自己的子树——
   * 但 **completion 一律不结算**：派发方的 `await waitForCompletion()` 还挂着，
   * 并行槽位因此仍被持有，5s 存档定时器还在跑，排队等槽位的专家也不排空——
   * 恢复（resumeExecution）时它们照旧续跑/起跑。回合停进 `awaiting_continue`，
   * 确认条（SubAgentStopPrompt）的 继续执行 / 停止任务 从这里接手；真正结算
   * 整棵树的是 stopExecution 和 prepareTurn（输入了新消息）。
   */
  pauseExecution = (): void => {
    // The clock gets BOTH holds — the explicit pause() (user hold, survives a
    // status that would release it) and the awaiting_continue park via notify's
    // sync — because the pause now HAS a status of its own and both must agree.
    this.engine.turnClock.pause()
    this.engine.isCancelled = true
    this.engine.abortController?.abort()
    if (this.engine.currentRequestId) {
      // 记账到请求 id（不是只靠 isCancelled）：恢复若在本 rejection 的微任务
      // 之前清了旗，stream-runner 的 catch 仍能认出这是被冻结杀掉的旧请求
      // （见 EngineCore 的 cancelledRequestIds 注释与 stop-settles 测试钉住的竞态）。
      this.engine.cancelledRequestIds.add(this.engine.currentRequestId)
      getHost().apiAbortStream(this.engine.currentRequestId)
      this.engine.currentRequestId = null
    }
    this.cleanup()
    if (this.engine.executingProcessId) { getHost().killCommand(this.engine.executingProcessId); this.engine.executingProcessId = null }
    for (const subEngine of this.engine.activeSubAgents.values()) {
      subEngine.pauseExecution()
    }
    this.engine.streamingBlocks = []
    this.engine.pendingToolIds = new Set()
    this.engine.agentStatus = {
      status: 'awaiting_continue',
      ...(this.engine.activeSubAgents.size > 0 ? { subAgentCount: this.engine.activeSubAgents.size } : {}),
    }
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
    // Resume takes the scheduler first (PLAN-plan-scheduler): a live attempt
    // owns the turn (true → nothing re-issued here, that attempt's drain
    // re-kicks), otherwise the ordinary continuation runs.
    setTimeout(() => { if (!this.engine.planScheduler.kick()) this.engine.continueLoop() }, 0)
  }

  /** Fully stop execution — 确认条的「停止任务」（dispose 走同一结算）。与
   *  cancelLoop（冻结）相反：结算整棵专家树（completion 落 aborted、槽位归还、
   *  排队者判 null）并以 idle 关闭回合。用户裁定 2026-09-29：停止先冻结出确认
   *  条，这里是不可逆出口之一（另一个是 prepareTurn 里输入了新消息）。 */
  stopExecution = (): void => {
    this.engine.isCancelled = true
    this.engine.abortController?.abort()
    if (this.engine.currentRequestId) {
      this.engine.cancelledRequestIds.add(this.engine.currentRequestId)
      getHost().apiAbortStream(this.engine.currentRequestId)
      this.engine.currentRequestId = null
    }
    this.cleanup()
    if (this.engine.executingProcessId) { getHost().killCommand(this.engine.executingProcessId); this.engine.executingProcessId = null }
    this.settleSubAgentTree(this.engine)
    // 排队等槽位的专家不能在用户按停止之后再起一个。
    releaseQueuedSubAgents(subAgentBudgetKey(this.engine.opts))
    this.engine.agentStatus = { status: 'idle' }
    this.engine.streamingBlocks = []
    this.engine.pendingToolIds = new Set()
    this.engine.resolveCompletionIfSpawned('aborted')
    this.engine.notify()
  }

  /**
   * 把整棵专家树的 completion 结算掉。cancelLoop（停止主对话，user ruling
   * 2026-09-29）与 stopExecution、dispose 都走这里。
   *
   * 每个被中止的专家若不结算 completion，会留下三样东西：永远不清理的 5s 存档
   * 定时器、永远不放回的并行槽位（本会话的五个槽位就此永久占死，之后所有专家
   * 只能排队）、以及最后一次 tick 之后没有落库的尾部消息。结算把 'aborted' 交
   * 回派发方的 `waitForCompletion`，三样一起清掉。
   *
   * 递归是必需的而不是保险：专家的 spawn 不受工具白名单限制，专家可以再派专家，
   * 而孙辈的派发挂在**子引擎**的 execSpawnAgent 上——只结算直接子代，孙辈的槽位
   * 照样泄漏。子引擎的 cancelLoop 是冻结（委托 pauseExecution，递归冻它自己的
   * 子树）且幂等，被遍历第二次时是安全的 no-op。
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

  /**
   * The session's exec allowlist (P0-2 #5), read fresh per batch — the user can
   * add a prefix at any approval click, and this is the only channel the
   * partition and the dispatch share. Test hosts without the method (or a
   * call outside any session context) degrade to an empty allowlist.
   */
  private async execAllowlist(): Promise<string[]> {
    try {
      const host = this.engine.getHost() as PulseHost & { getExecAllowlist?: () => Promise<string[]> }
      return (await host.getExecAllowlist?.()) ?? []
    } catch {
      return []
    }
  }

  /** Whether a tool's resolved command carries a prefix from that allowlist. */
  /** Sub-agent boundary (PLAN-plan-split v2 R2): a spawned sub-agent must not
   *  plan, settle or delegate. Collection hides the schemas; this catches an
   *  out-of-schema hallucinated call, since dispatch is by NAME. */
  private subAgentDeniedTool(t: ToolUseBlock): void {
    t.exitCode = -1
    t.status = 'completed'
    this.engine.addToolResult(t.id, '子代理无权使用该工具：创建/推进计划与派生子代理都属于主 Agent。请完成你自己的节点工作并如实报告；若任务超出能力，使用 create_sub_plan（如可用）。', true)
    this.engine.notify()
  }

  private commandAllowlisted(t: ToolUseBlock, allowlist: string[]): boolean {
    if (allowlist.length === 0) return false
    const command = buildCommandFromSkillInput(t.name, t.input || {}, this.engine.opts.platformInfo?.platform || '', this.engine.opts.platformInfo?.ripgrepPath)
    return commandMatchesAllowlist(command, allowlist)
  }

  /**
   * The write-tier partition, shared by the marking stage (handleToolUseResponse)
   * and the dispatch stage — the ladder and the executor must never disagree
   * about which writes run without asking. Three buckets:
   *  - `auto`    — runs now (tier not held AND not protected);
   *  - `held`    — waits on the approval ladder (tier held, OR the protected
   *    path below);
   *  - `denied`  — a spawned sub-agent's protected-path write: nobody can
   *    approve it (heldTiers holds nothing unattended and a hold nobody can
   *    release is worse than an auto-run), so the call settles as a flat
   *    rejection instead.
   * Protected = the project instructions file (.pulsemind/AGENTS.md): the
   * state block teaches 「propose the change first」 — that proposal IS an
   * approval hold, now at every level including 'auto' (2026-10-27).
   */
  private partitionWrites(tools: ToolUseBlock[]): { auto: ToolUseBlock[]; held: ToolUseBlock[]; denied: ToolUseBlock[] } {
    const out: { auto: ToolUseBlock[]; held: ToolUseBlock[]; denied: ToolUseBlock[] } = { auto: [], held: [], denied: [] }
    const wd = this.engine.opts.workspaceDir
    const tierHeld = this.heldTiers().has('write')
    for (const t of tools) {
      // editToolTargetPaths names EVERY path one call writes — including each
      // `diff --git` section of an atomic multi-file edit — so a protected
      // file cannot ride to disk inside a multi-file diff's later section.
      const targets = editToolTargetPaths(t.input)
      if (wd && targets.some((p) => isProjectInstructionsPath(p, wd))) {
        if (this.engine.isSpawnedSubAgent) out.denied.push(t)
        else out.held.push(t)
        continue
      }
      if (tierHeld) out.held.push(t)
      else out.auto.push(t)
    }
    return out
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
    const isSystemTool = (name: string): boolean => name === 'install' || name === 'pick_skill' || name === 'pick_tool' || name === 'spawn_agent' || name === 'create_plan' || name === 'advance_plan' || name === 'todo_write' || name === 'create_sub_plan' || name === 'webfetch' || name === 'browser'
    // install(type=mcp) 是 exec 档决定（audit 2026-10-10 #1）：注册完立即
    // mcpStartServer 拉起 stdio command——信任组曾让它对审批梯子隐身，一条
    // 注入指令就能在 outside-ask 下绕过 exec 审批拿到进程启动。skill 分支
    // 只写文件不执行，留在信任组。梯子按 exec 档扣留（与 shell 同档）。
    const isInstallMcp = (t: ToolUseBlock): boolean => t.name === 'install' && installTypeOf(t) === 'mcp'
    const systemTools = tools.filter(t => isSystemTool(t.name) && !isInstallMcp(t))
    const installMcpTools = tools.filter(isInstallMcp)
    // context_compact rides the memory group on purpose (PLAN-context-compact-tool
    // D7): the trusted-group exemption is name-based HERE, not category-based —
    // leaving it out drops the tool into otherTools and puts a compaction behind
    // the approval ladder. Single source: MEMORY_GROUP_TOOL_NAMES (approveTool's
    // release routing reads the same list).
    const isMemoryTool = (name: string): boolean => MEMORY_GROUP_TOOL_NAMES.includes(name)
    const memoryTools = tools.filter(t => isMemoryTool(t.name))
    const isKnowledgeTool = (_name: string): boolean => false  // knowledge_read 已退役（E8）：知识读取走 read 绝对路径（read 组）
    const knowledgeTools = tools.filter(t => isKnowledgeTool(t.name))
    const isExperienceTool = (name: string): boolean => name === 'experience_read' || name === 'experience_save'
    const experienceTools = tools.filter(t => isExperienceTool(t.name))
    const isMCPTool = (name: string): boolean => this.engine.mcpToolOwner.has(name)
    // Gated (requireApproval) MCP tools behave like otherTools: held for approval
    // at any level above 'auto', auto-executed otherwise.
    const gatedMcpTools = tools.filter(t => isMCPTool(t.name) && this.mcpRequiresApproval(t.name))
    const mcpTools = tools.filter(t => isMCPTool(t.name) && !this.mcpRequiresApproval(t.name))
    const grouped = new Set([...readOnlyTools, ...writeEditTools, ...pageReadTools, ...pageWriteTools])
    const procReadTools = tools.filter(t => t.name === 'exec_logs')
    const otherTools = tools.filter(t => !grouped.has(t) && !systemTools.includes(t) && !memoryTools.includes(t) && !knowledgeTools.includes(t) && !experienceTools.includes(t) && !isMCPTool(t.name) && !installMcpTools.includes(t) && t.name !== 'ask_user' && t.name !== 'exec_logs')
    const spawnTools = systemTools.filter(t => t.name === 'spawn_agent')
    const held = this.heldTiers()
    // exec_logs is a read (P0-3 #14) dispatched through execOtherTool — never a
    // ladder call. Other allowlisted exec commands (P0-2 #5) run despite the
    // held tier: the user explicitly narrowed the ladder for their prefixes.
    const allowlist = await this.execAllowlist()
    const autoOther = otherTools.filter(t => !held.has('exec') || this.commandAllowlisted(t, allowlist))
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
      // Same partition the marking stage used: protected-path writes never
      // auto-run (they wait on the ladder), and a spawned sub-agent's are
      // settled as flat rejections — its ladder can never release them.
      // (Dedicated wording: subAgentDeniedTool's text is about the plan
      // boundary, not the instructions file.)
      const writes = this.partitionWrites(writeEditTools)
      if (writes.denied.length > 0) {
        for (const t of writes.denied) {
          t.exitCode = -1
          t.status = 'completed'
          this.engine.addToolResult(t.id, '子代理无权修改项目指令文件（AGENTS.md / .pulsemind/AGENTS.md）——它是用户所有的工作区约定，修订须由用户提出。请完成你自己的节点工作；如认为约定需要修订，在你的报告里向父代理建议。', true)
        }
        this.engine.notify()
      }
      if (writes.auto.length > 0) for (const t of writes.auto) await this.engine.toolExecutor.execWorkspaceTool(t)
      // A page write clears the ladder only when its own tier allows it
      // (page_execute_js is 'exec' and stays held at 'outside-ask').
      for (const t of pageWriteTools) {
        if (!requiresApproval(this.engine.opts.approvalMode ?? 'auto', tierOfTool(t.name))) {
          await this.engine.toolExecutor.execPageTool(t)
        }
      }
      if (mcpTools.length > 0) for (const t of mcpTools) await this.engine.toolExecutor.execMCPTool(t)
      if (!held.has('exec') && gatedMcpTools.length > 0) for (const t of gatedMcpTools) await this.engine.toolExecutor.execMCPTool(t)
      if (!held.has('exec')) for (const t of installMcpTools) await this.engine.toolExecutor.execInstall(t)
      for (const t of systemTools) {
        if (t.name === 'spawn_agent') continue // started above, awaited after the serial groups
        if (t.name === 'pick_skill') await this.engine.toolExecutor.execPickSkill(t)
        else if (t.name === 'pick_tool') await this.engine.toolExecutor.execPickTool(t, (names) => {
          // Classify by built-in definition set (not mcpToolOwner): an MCP tool from a
          // server that connected after this loop's discovery is still a valid MCP pick.
          const builtinNames = new Set(this.engine.opts.toolManager.getEnabledTools().map(x => x.definition.name))
          this.engine.selectedMcpTools = names.filter(n => !builtinNames.has(n))
          this.engine.selectedBuiltinTools = names.filter(n => builtinNames.has(n))
        }, () => [...this.engine.selectedBuiltinTools, ...this.engine.selectedMcpTools])
        else if (t.name === 'install') await this.engine.toolExecutor.execInstall(t)
        else if (t.name === 'spawn_agent') await this.engine.toolExecutor.execSpawnAgent(t)
        else if (t.name === 'webfetch') await this.engine.toolExecutor.execWebFetch(t)
        else if (t.name === 'browser') await this.engine.toolExecutor.execBrowser(t)
        else if (t.name === 'create_plan') {
          // Sub-agent boundary (v2 R2): the schema is denied at collection;
          // this catches an out-of-schema hallucinated call (dispatch is by NAME).
          if (this.engine.opts.spawnedToolset) this.subAgentDeniedTool(t)
          else await this.engine.planManager.execCreatePlan(t)
        }
        else if (t.name === 'advance_plan') {
          if (this.engine.opts.spawnedToolset) this.subAgentDeniedTool(t)
          else await this.engine.planManager.execAdvancePlan(t)
        }
        else if (t.name === 'todo_write') {
          // 2026-10-26 (user: 允许子代理用todo_write): no spawnedToolset guard —
          // a sub-agent keeps its OWN direct list in its own PlanManager (the
          // parent's plan is never visible to it). create_plan / advance_plan
          // keep their guards below: the graph boundary still holds.
          await this.engine.planManager.execTodoWrite(t)
        }
        else if (t.name === 'create_sub_plan') await this.engine.toolExecutor.execCreateSubPlan(t)
      }
      if (memoryTools.length > 0) for (const t of memoryTools) await this.engine.toolExecutor.execOtherTool(t)
      if (knowledgeTools.length > 0) for (const t of knowledgeTools) await this.engine.toolExecutor.execOtherTool(t)
      if (experienceTools.length > 0) for (const t of experienceTools) await this.engine.toolExecutor.execOtherTool(t)
      if (procReadTools.length > 0) for (const t of procReadTools) await this.engine.toolExecutor.execOtherTool(t)
      if (autoOther.length > 0) { for (const t of autoOther) await this.engine.toolExecutor.execOtherTool(t) }
      if (spawnBatch) await spawnBatch
      // One completed tool batch (results landed, loop about to re-request) —
      // the refill breaker's rounds-since-drop paces off this (P1).
      this.engine.recordToolBatchComplete()
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
      this.engine.messages = addTruncatedResults(this.engine.messages, toolUses)
      this.engine.notify()
      // Synthetic error results landed — one batch by the same pacing contract.
      this.engine.recordToolBatchComplete()
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
        // Bookkeeping must match the normal path below (review_20261028 中2):
        // without the pending set + auto flag, every mid-dispatch result saw
        // an empty set and a clear flag and re-fired continueLoop from
        // addToolResult's straggler drain while its batch-mates were still
        // executing — concurrent streams on the shared request state, the
        // exact hazard the ask-family comment below names. The oversized
        // blocks themselves are already settled (synthetic results above) and
        // stay out of both registers.
        this.engine.toolUseBlocks = validTools
        this.engine.pendingToolIds = new Set(validTools.map(t => t.id))
        this.engine.isAutoExecuting = true
        try {
          await this.dispatchToolExecution(validTools)
        } finally {
          this.engine.isAutoExecuting = false
        }
      } else {
        // 纯合成批：全部被拒，结果已着陆、循环即将重请求 —— 与下方截断批同一
        // 计数口径；混批由 dispatchToolExecution 收尾的那一次打点覆盖，不重复。
        this.engine.recordToolBatchComplete()
      }
      this.engine.notify()
      // Same drain gate as the normal tail below: a held call (the ladder
      // re-applied inside dispatchToolExecution kept it out of the executors)
      // or a background-exec straggler still owns the pending set — starting
      // the next LLM round over it would run concurrent with its result.
      // Held calls park the turn exactly the way addToolResult's tail paints
      // awaiting_approval (AgentEngine's stillHeld filter reads the same
      // toolUseBlocks register set above).
      if (this.engine.pendingToolIds.size > 0) {
        const stillHeld = this.engine.toolUseBlocks.filter(t => this.engine.pendingToolIds.has(t.id) && t.status === 'pending')
        if (stillHeld.length > 0) {
          this.engine.agentStatus = { status: 'awaiting_approval', tools: stillHeld }
          this.engine.notify()
        }
      } else if (!this.engine.planScheduler.kick()) {
        this.engine.continueLoop()
      }
      return
    }

    const readOnlyTools = toolUses.filter(t => READ_TIER_TOOLS.has(t.name))
    const writeEditTools = toolUses.filter(t => WRITE_TIER_TOOLS.has(t.name))
    const askUserTools = toolUses.filter(t => t.name === 'ask_user')
    // Page tools: reads never wait, writes wait per their own tier
    // (`page_execute_js` = 'exec', the rest = 'write').
    const pageTools = toolUses.filter(t => isPageTool(t.name))
    const pageWriteTools = pageTools.filter(t => tierOfTool(t.name) !== 'read')
    const isSystemTool = (name: string): boolean => name === 'install' || name === 'pick_skill' || name === 'pick_tool' || name === 'spawn_agent' || name === 'create_plan' || name === 'advance_plan' || name === 'todo_write' || name === 'create_sub_plan' || name === 'webfetch' || name === 'browser'
    // install(type=mcp) 挂 exec 档（audit 2026-10-10 #1，同 dispatch 侧注释）：
    // 注册完立即拉起 stdio 进程，信任组曾让它在 outside-ask 下绕过 exec 审批。
    const isInstallMcp = (t: ToolUseBlock): boolean => t.name === 'install' && installTypeOf(t) === 'mcp'
    const installMcpTools = toolUses.filter(isInstallMcp)
    const systemTools = toolUses.filter(t => isSystemTool(t.name) && !isInstallMcp(t))
    const isMemoryTool = (name: string): boolean => MEMORY_GROUP_TOOL_NAMES.includes(name)
    const memoryTools = toolUses.filter(t => isMemoryTool(t.name))
    const isKnowledgeTool = (_name: string): boolean => false  // knowledge_read 已退役（E8）：知识读取走 read 绝对路径（read 组）
    const knowledgeTools = toolUses.filter(t => isKnowledgeTool(t.name))
    const isExperienceTool = (name: string): boolean => name === 'experience_read' || name === 'experience_save'
    const experienceTools = toolUses.filter(t => isExperienceTool(t.name))
    const isMCPTool = (name: string): boolean => this.engine.mcpToolOwner.has(name)
    const mcpApprovalTools = toolUses.filter(t => isMCPTool(t.name) && this.mcpRequiresApproval(t.name))
    const mcpTools = toolUses.filter(t => isMCPTool(t.name))
    const pageHeldTools = pageWriteTools.filter(t => requiresApproval(this.engine.opts.approvalMode ?? 'auto', tierOfTool(t.name)))
    const otherTools = toolUses.filter(t => !readOnlyTools.includes(t) && !writeEditTools.includes(t) && !pageTools.includes(t) && !systemTools.includes(t) && !memoryTools.includes(t) && !knowledgeTools.includes(t) && !experienceTools.includes(t) && !mcpTools.includes(t) && !installMcpTools.includes(t) && t.name !== 'ask_user' && t.name !== 'exec_logs')

    // The approval ladder decides what waits: shell / ungrouped / gated MCP
    // calls at 'outside-ask' and above, file writes as well at 'always-ask',
    // and page writes by their own tier (reads are dispatched, never held).
    // A session-allowlisted exec command (P0-2 #5) is NOT held at any level —
    // the user already named its prefix with 本会话总是允许.
    const held = this.heldTiers()
    const allowlist = await this.execAllowlist()
    const otherHeld = otherTools.filter(t => !this.commandAllowlisted(t, allowlist))
    if (held.has('exec')) {
      // Stamp the stable prefix the third approval button (本会话总是允许) will
      // store — computed here, off the same input the partition just matched,
      // so the button and the ladder can never disagree about the key.
      //
      // The stamp REPLACES the block object (the mirror identity contract — the
      // same lesson as patchToolUse): the stream runner already appended these
      // blocks to a message and notified, and the content signature caches by
      // object identity, so an in-place write would never re-sign the message —
      // no messages_update, and the third button would only ever appear through
      // a snapshot re-hydration (切走会话再切回来). A fresh object re-signs,
      // and this turn's next notify ships it to every mirror client.
      for (let i = 0; i < otherHeld.length; i++) {
        const t = otherHeld[i]
        const key = commandAllowlistKey(buildCommandFromSkillInput(t.name, t.input || {}, this.engine.opts.platformInfo?.platform || '', this.engine.opts.platformInfo?.ripgrepPath))
        if (!key) continue
        const stamped = { ...t, _allowKey: key } as ToolUseBlock
        otherHeld[i] = stamped
        const ti = toolUses.indexOf(t)
        if (ti !== -1) toolUses[ti] = stamped
        swapToolUseBlock(this.engine.messages, t, stamped)
      }
    }
    const writes = this.partitionWrites(writeEditTools)
    const heldTools = [
      ...writes.held,
      ...(held.has('exec') ? [...otherHeld, ...mcpApprovalTools, ...installMcpTools] : []),
      ...pageHeldTools,
    ]

    this.engine.toolUseBlocks = toolUses
    this.engine.pendingToolIds = new Set(toolUses.map(t => t.id))
    this.engine.isAutoExecuting = true
    // The partition is held vs. not-held, never an enumeration of the auto-run
    // groups: enumerating them skipped `otherTools` (shell exec) and gated MCP,
    // so at 'auto' those executed while still wearing the stream's 'pending' —
    // and the next tool's addToolResult parked the engine on awaiting_approval,
    // painting the approval ladder for a call the ladder never held until the
    // executor's own status write wiped it a beat later (「即使权限设为完全访问，
    // 权限审批框也会先出现，再自动消失」). ask_user is not held either and runs
    // through the same marking.
    const heldIds = new Set(heldTools.map(t => t.id))
    // A non-held call is ACCEPTED here, but the serial groups below start
    // tools one at a time — so it rides 'queued' (hourglass in the tool
    // header) until its own executor's entry mark flips it to 'running'
    // (loading). The blanket-'running' marking this replaced made every
    // batch-mate wear the executing glyph while actually waiting its turn.
    for (const t of toolUses) if (!heldIds.has(t.id)) t.status = 'queued'
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

    // ── Sub-agent ask_user fail-fast ──────────────────────────────────
    // (isSpawnedSubAgent, NOT spawnSystemPrompt — the assistants' pinned
    // override lands in the same field and their transcript has a live user to
    // answer): a spawned agent has no user channel, so ask_user must fail fast
    // instead of parking forever. isAutoExecuting suppresses addToolResult's
    // per-result continuation while the whole ask family settles — each result
    // would otherwise re-fire continueLoop over the same emptied pending set
    // and run concurrent streams on the shared request state — so the ONE
    // explicit continuation below is the only one.
    if (askUserTools.length > 0 && this.engine.isSpawnedSubAgent) {
      this.engine.isAutoExecuting = true
      for (const t of askUserTools) {
        this.engine.addToolResult(t.id, 'ask_user is not available in sub-agent mode.', true)
        t.status = 'completed'
      }
      this.engine.isAutoExecuting = false
      if (this.engine.pendingToolIds.size === 0) this.engine.continueLoop()
      else { this.engine.agentStatus = { status: 'completed' }; this.engine.notify(); this.engine.resolveCompletionIfSpawned('completed') }
      this.engine.notify()
      safeInvokeObserver(opts.hooks?.afterLlmCall, { messages: this.engine.messages, stopReason: 'tool_use', status: this.engine.agentStatus }, 'afterLlmCall')
      return
    }

    // ── Nothing held: the batch either ran to completion or is still
    // draining asynchronously (a running command's exit closes the loop). ──
    if (heldTools.length === 0) {
      if (askUserTools.length > 0) {
        this.engine.agentStatus = { status: 'awaiting_user_input', tools: askUserTools }
      } else if (this.engine.pendingToolIds.size === 0) {
        // kick() true = the scheduler just dispatched a wave (or an attempt
        // owns the turn): status is `executing` and the batch's own drain
        // re-enters here — painting `completed` over it would report the turn
        // finished while experts are still running.
        if (!this.engine.planScheduler.kick()) this.engine.continueLoop()
      } else if (this.engine.planScheduler.kick({ midDrain: true })) {
        // Chained attempts (2026-09-30) are still registered in the pending
        // set: the scheduler owns the turn — its kick settles, chains more or
        // waits, and the chained spawns' own addToolResult tail closes the
        // loop. Falling through to `completed` here used to end the turn
        // under live experts. midDrain additionally forbids the clean
        // 'dispatch' — re-entering handleToolUseResponse from here would
        // clobber the in-flight chained ids out of pendingToolIds
        // (review_20260930 中5).
      } else { this.engine.agentStatus = { status: 'completed' }; this.engine.resolveCompletionIfSpawned('completed') }
      this.engine.notify()
      safeInvokeObserver(opts.hooks?.afterLlmCall, { messages: this.engine.messages, stopReason: 'tool_use', status: this.engine.agentStatus }, 'afterLlmCall')
      return
    }

    // ── Held calls on the ladder: the approval UI owns the loop from here.
    // Only an explicit approval (or rejection) settles each held tool, so the
    // pending set is exactly them — plus the ask cards of a MIXED batch. ──
    if (askUserTools.length > 0) {
      // Mixed batch (ask_user + ladder-held calls — a weak model's shape): the
      // question leads. Both parks share the pending set: answering the
      // question drops the engine onto awaiting_approval via addToolResult's
      // repaint (remaining-held branch there), and the hosted flow registers
      // the ask entries here, the approval prompts after the repaint. The
      // pre-fix shape dropped the ask ids from the pending set entirely — the
      // question was never asked, reconcile faked a "cancelled" result, and
      // the hosted panel's answer bounced with unknown callId.
      this.engine.pendingToolIds = new Set([...heldTools, ...askUserTools].map(t => t.id))
      this.engine.agentStatus = { status: 'awaiting_user_input', tools: askUserTools }
      safeInvokeObserver(opts.hooks?.afterLlmCall, { messages: this.engine.messages, stopReason: 'tool_use', status: { status: 'awaiting_user_input', tools: askUserTools } }, 'afterLlmCall')
    } else {
      // tools carries ONLY the held calls: session-manager ships status.tools
      // to hosted clients verbatim, and the whole batch here would mint
      // approval cards (with 120s auto-reject timers) for tools that already
      // ran — a completed card flipped to 已拒绝 when the timer fired.
      this.engine.pendingToolIds = new Set(heldTools.map(t => t.id))
      this.engine.agentStatus = { status: 'awaiting_approval', tools: heldTools }
      safeInvokeObserver(opts.hooks?.afterLlmCall, { messages: this.engine.messages, stopReason: 'tool_use', status: { status: 'awaiting_approval', tools: heldTools } }, 'afterLlmCall')
    }
    this.engine.notify()
  }

  /** @internal */
  async handleMaxTokensResponse(toolUses: ToolUseBlock[]): Promise<void> {
    // A max_tokens cut with NO tool calls is a finished-in-spite-of-truncation
    // text answer: the turn must close here. Continuing would re-issue a
    // request with nothing new on the wire — and a reasoning model that burns
    // its hidden thinking budget (finish_reason=length on a short visible
    // reply) then re-issues itself content-less rounds forever, improvising
    // 「你发了空消息」 at each wake-up (user report 2026-09-20, ws_1789878852687).
    // Only truncated tool_use params need the loop: their synthetic error
    // results must reach the model so it can retry the calls.
    if (toolUses.length === 0) {
      this.engine.handleEndTurnResponse('max_tokens')
      return
    }
    this.engine.messages = addTruncatedResults(this.engine.messages, toolUses); this.engine.notify()
    // 合成错误批着陆、循环即将重请求 —— 与 handleToolUseResponse 截断分支的
    // 打点同款批同款计数（review_20260930 中2：此前同形状一个计一个不计）。
    this.engine.recordToolBatchComplete()
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
    // Plan scheduler (PLAN-plan-scheduler): a turn that stops with the plan
    // still open is not a stopping point — a delivered wave settles and the
    // READY set dispatches here, keeping the turn OPEN (true = do NOT close,
    // no `completed` status, the clock keeps running, exactly like the nudge
    // above). consult/none fall through: a failure the model has not answered,
    // or the completed plan's final synthesis, is an ordinary turn end.
    if (this.engine.planScheduler.kick()) return
    // The turn's duration — user send → this last output character, with every
    // thinking round and tool call in between counted and any stretch parked on
    // the user (held approval / ask_user / loop-limit prompt / manual pause)
    // excluded. The clock is the accumulator that knows the difference; the
    // per-round times stay on the intermediate messages.
    if (this.engine.turnClock.isActive()) {
      const totalMs = Math.round(this.engine.turnClock.stop())
      // The turn's answer is the LAST ASSISTANT message — not necessarily the
      // last message. A plan wave's delivery, a tool result and a resume notice
      // all append a `role: 'user'` entry right after the round that produced
      // them, so reading `messages[len - 1]` and requiring
      // `role === 'assistant'` skipped the stamp silently on every
      // plan-dispatched turn (user report 2026-11-06: a 13-sub-agent review read
      // back as its final round's 11s). Search backwards instead of trusting the
      // tail.
      for (let i = this.engine.messages.length - 1; i >= 0; i--) {
        const msg = this.engine.messages[i]
        if (msg.role !== 'assistant') continue
        msg.processingMs = totalMs
        break
      }
    }
    this.engine.agentStatus = { status: 'completed' }
    try {
      this.engine.notify()
      safeInvokeObserver(this.engine.opts.hooks?.afterLlmCall, { messages: this.engine.messages, stopReason, status: { status: 'completed' } }, 'afterLlmCall')
      safeInvokeObserver(this.engine.opts.hooks?.afterSession, { messages: this.engine.messages, status: { status: 'completed' } }, 'afterSession')
      // Turn-end memory salvage (PLAN-memory-extraction-dedup): the loop itself
      // no longer spends LLM calls on memory; old tool pairs at compaction risk
      // are mined HERE, once, capped. Fire-and-forget.
      runTurnEndMemoryExtraction(this.engine)
    } catch (err) {
      // 回合收尾面上的异常就地吞掉：onStreamComplete 对本函数是同步调用且无
      // await 方，一个逃逸的 rejection 就是静默死亡——终局消息已入库、状态已
      // 写 completed，唯独结算没跑，用户看到的就是「专家做完了、光标还在」。
      console.warn('[AgentEngine] turn-end notify/hook failed (settle continues):', err)
    } finally {
      // 结算是引擎对派发方的契约，不依赖 notify 的健康（conv_20260929224057：
      // 5 专家并行评审，4 个的终局消息带完整 stats 入库，但结算从未到达父代理
      // ——派发方的 `await waitForCompletion()` 永远挂起，回合停在 busy，光标
      // 常亮数小时）。notify 链路上任何一个 session 事件 sink 抛异常（webContents
      // 正在销毁、ws send 失败）都不能吞掉它；sink 侧另有逐个隔离（session-manager
      // 的 emit），这里是最后一道。
      this.engine.resolveCompletionIfSpawned('completed')
    }
    // Post-turn compaction prewarm (fire-and-forget): the turn is closed, the
    // engine idle — if usage is high, the expensive history-summary LLM call
    // runs NOW instead of blocking the next turn's first request. Compacting
    // at this clean boundary is the whole point: mid-request the drop lands
    // under a running task, at turn end the next round starts fresh.
    this.engine.schedulePostTurnCompaction()
  }

}
