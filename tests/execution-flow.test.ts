import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ExecutionFlow } from '../src/renderer/src/agent/engine/execution-flow'
import { setHost } from '../src/renderer/src/agent/host'
import type { PulseHost } from '../src/renderer/src/agent/host/types'
import type { EngineCore } from '../src/renderer/src/agent/engine/engine-core'
import { refreshMcpServers } from '../src/renderer/src/agent/mcp-cache'
import type { AgentMessage, ToolUseBlock } from '../src/renderer/src/types/agent'

/**
 * ExecutionFlow 的分支补齐（AGENTS.md「单测纪律」2026-10-05）：ExecutionFlow 挂在
 * EngineCore 接口上，接口即契约 —— 这里用最小假 Core 直驱，覆盖既有真引擎测试
 * （auto-mode-phantom-approval 等）走不到的分支：approveTool 的分组路由表、
 * 终端事件收尾、allowlist 盖戳与放行、pause/resume/stop 的记账、dispatch 的
 * 全家族扇出、drain/kick 矩阵与回合收尾的钩子面。
 */

const EXEC_METHODS = [
  'execReadOnlyTools', 'execPageReadTools', 'execWorkspaceTool', 'execPageTool', 'execMCPTool',
  'execOtherTool', 'execPickSkill', 'execPickTool', 'execInstall', 'execSpawnAgent',
  'execWebFetch', 'execBrowser', 'execCreateSubPlan',
] as const

type ExecName = (typeof EXEC_METHODS)[number]

function toolUse(id: string, name: string, input: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): ToolUseBlock {
  return { type: 'tool_use', id, name, input, status: 'pending', ...extra } as unknown as ToolUseBlock
}

function makeHost() {
  const outCbs: Array<(d: { processId: string, data: string }) => void> = []
  const exitCbs: Array<(d: { processId: string, code: number }) => void> = []
  const errCbs: Array<(d: { processId: string, message: string }) => void> = []
  let allowlist: string[] = []
  const host = {
    onTerminalOutput: (cb: (d: { processId: string, data: string }) => void) => { outCbs.push(cb); return () => { const i = outCbs.indexOf(cb); if (i !== -1) outCbs.splice(i, 1) } },
    onTerminalExit: (cb: (d: { processId: string, code: number }) => void) => { exitCbs.push(cb); return () => { const i = exitCbs.indexOf(cb); if (i !== -1) exitCbs.splice(i, 1) } },
    onTerminalError: (cb: (d: { processId: string, message: string }) => void) => { errCbs.push(cb); return () => { const i = errCbs.indexOf(cb); if (i !== -1) errCbs.splice(i, 1) } },
    executeCommand: vi.fn(async () => 'pid-1'),
    killCommand: vi.fn(),
    execKill: vi.fn(async () => {}),
    apiAbortStream: vi.fn(),
    addExecAllowlist: vi.fn(async () => {}),
    getExecAllowlist: vi.fn(async () => allowlist),
    mcpListServers: vi.fn(async () => [
      { id: 'srv_gated', name: 'gated', config: { requireApproval: true } },
      { id: 'srv_free', name: 'free', config: {} },
    ]),
    expertList: vi.fn(async () => []),
    getSkillPreferences: vi.fn(async () => ({ enabledSkills: [], skillKeywords: {} })),
    onMcpServersChanged: () => () => {},
    onSkillsChanged: () => () => {},
    emitOutput(pid: string, data: string) { for (const cb of outCbs) cb({ processId: pid, data }) },
    emitExit(pid: string, code: number) { for (const cb of exitCbs) cb({ processId: pid, code }) },
    emitError(pid: string, message: string) { for (const cb of errCbs) cb({ processId: pid, message }) },
  }
  return {
    host,
    setAllowlist(a: string[]) { allowlist = a },
    asHost: host as unknown as PulseHost,
  }
}

function makeCore(over: {
  opts?: Record<string, unknown>
  spawnSystemPrompt?: string
  isSpawnedSubAgent?: boolean
  onSpawnProgress?: (s: string) => void
  autoSettle?: boolean
} = {}) {
  const autoSettle = over.autoSettle ?? true
  const h = makeHost()
  setHost(h.asHost)
  const calls = {
    results: [] as Array<{ id: string, content: string, isError: boolean }>,
    executor: [] as Array<[ExecName, string]>,
    notifies: 0,
    batches: 0,
  }
  const raw = {
    messages: [] as AgentMessage[],
    agentStatus: { status: 'idle' } as Record<string, unknown>,
    streamingBlocks: [] as unknown[],
    currentAssistantBlocks: [] as unknown[],
    toolUseBlocks: [] as ToolUseBlock[],
    jsonAccumulators: new Map(),
    planManager: { execCreatePlan: vi.fn(async () => {}), execAdvancePlan: vi.fn(async () => {}) },
    planScheduler: { kick: vi.fn(() => false) },
    pendingVerbatimReply: null,
    opts: {
      apiKey: 'k', baseURL: 'https://example.invalid', model: 'm', maxTokens: 100,
      adapter: {} as never, conversationId: 'conv_exec_flow', approvalMode: 'auto',
      platformInfo: { platform: 'darwin' },
      toolManager: { getEnabledTools: () => [] as Array<{ definition: { name: string } }> },
      ...over.opts,
    },
    abortController: null as AbortController | null,
    currentRequestId: null as string | null,
    cancelledRequestIds: new Set<string>(),
    loopCount: 0, maxLoopCount: 40, isCancelled: false, isAutoExecuting: false,
    requestStartTime: 0,
    turnClock: { pause: vi.fn(), resume: vi.fn(), stop: vi.fn(() => 1234), isActive: vi.fn(() => true) },
    streamIdleRetries: 0, thinkingOnlyRetries: 0, contextOverflowLimit: null, contextOverflowRetries: 0,
    compactTracking: { toolRoundsSinceDrop: 0 },
    pendingToolIds: new Set<string>(),
    executingProcessId: null as string | null,
    executingToolUseId: null as string | null,
    contextWindowReaim: null as number | null,
    persistedToolResultIds: new Set<string>(),
    gatedScan: { scannedMsgs: 0, hitCategories: new Set<string>() },
    terminalCleanups: [] as Array<() => void>,
    selectedMcpTools: [] as string[],
    selectedBuiltinTools: [] as string[],
    mcpToolOwner: new Map<string, string>([
      ['mcp_free', 'srv_free'], ['mcp_gated', 'srv_gated'], ['mcp_orphan', 'srv_missing'],
    ]),
    toolExecutor: null as unknown,
    activeSubAgents: new Map<string, EngineCore>(),
    spawnSystemPrompt: over.spawnSystemPrompt,
    isSpawnedSubAgent: over.isSpawnedSubAgent ?? false,
    onSpawnProgress: over.onSpawnProgress,
    notify: vi.fn(() => { calls.notifies++ }),
    notifyCoalesced: vi.fn(),
    notifyStreamingCoalesced: vi.fn(),
    addToolResult: (id: string, content: string, isError: boolean) => {
      calls.results.push({ id, content, isError })
      if (autoSettle) raw.pendingToolIds.delete(id)
    },
    recordToolBatchComplete: vi.fn(() => { calls.batches++ }),
    getHost: () => h.asHost,
    reportSpawnProgress: vi.fn(),
    resolveCompletionIfSpawned: vi.fn(),
    handleToolUseResponse: () => Promise.resolve(),
    handleMaxTokensResponse: () => Promise.resolve(),
    handleEndTurnResponse: vi.fn(),
    // 阶段完成协议：普通会话没有 finish_stage 记录，drain 走 kick/continueLoop。
    consumeStageFinishTurnEnd: vi.fn(() => false),
    _memExtractionInProgress: false, _memSalvageCount: 0,
    compactor: { contextTokens: () => 0 },
    continueLoop: vi.fn(async () => {}),
    cancelLoop: vi.fn(),
    resumeExecution: vi.fn(),
    pauseExecution: vi.fn(),
    steer: vi.fn(),
    schedulePostTurnCompaction: vi.fn(),
    nudgeSummonIfUnplanned: vi.fn(() => false),
  }
  const execStub: Record<string, (t: ToolUseBlock | ToolUseBlock[], classify?: (names: string[]) => void) => Promise<void>> = {}
  for (const m of EXEC_METHODS) {
    execStub[m] = async (t, classify) => {
      // execReadOnlyTools / execPageReadTools 收数组，其余收单块 —— 统一展开
      const blocks = Array.isArray(t) ? t : [t]
      for (const b of blocks) calls.executor.push([m, b.name])
      if (m === 'execPickTool' && classify) classify(['mcp_picked'])
      if (!Array.isArray(t) && t.id === 'spawn_fail') throw new Error('spawn exploded')
      if (autoSettle) {
        for (const b of blocks) { b.status = 'completed'; raw.addToolResult(b.id, 'ok', false) }
      }
    }
  }
  raw.toolExecutor = execStub
  const flow = new ExecutionFlow(raw as unknown as EngineCore)
  return { raw: raw as unknown as EngineCore & typeof raw, flow, calls, host: h.host, setAllowlist: h.setAllowlist }
}

function msg(blocks: ToolUseBlock[] | undefined, role: 'user' | 'assistant' = 'assistant'): AgentMessage {
  return {
    id: `m_${Math.random().toString(36).slice(2, 8)}`, role,
    ...(blocks ? { contentBlocks: blocks } : {}),
    createdAt: new Date().toISOString(),
  } as AgentMessage
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ExecutionFlow approveTool 路由表', () => {
  it('缺 apiKey 不再静默死键（B6）——审批照常放行，工具执行', async () => {
    // 2026-10-24 harness review B6: since M1.4 every engine is main-hosted and
    // the LLM stream rides the api-proxy's own profile resolution — opts.apiKey
    // is legitimately empty for local providers. The old silent return left the
    // tool pending and the engine parked on awaiting_approval with a dead
    // button; approval now proceeds (a local-model session can approve tools).
    const { raw, flow, calls } = makeCore({ opts: { apiKey: '' } })
    // seed a held write so approveTool routes to the workspace executor
    raw.messages = [{ id: 'm1', role: 'assistant', createdAt: new Date().toISOString(), contentBlocks: [{ type: 'tool_use', id: 't1', name: 'write', input: { file_path: 'a.txt', content: 'x' }, status: 'pending' }] }]
    await flow.approveTool('t1')
    expect(calls.executor).toContainEqual(['execWorkspaceTool', 'write'])
    expect(raw.agentStatus.status).not.toBe('awaiting_approval')
  })

  it('找不到块 → 显式 error 状态', async () => {
    const { raw, flow } = makeCore()
    await flow.approveTool('nope')
    expect(raw.agentStatus).toEqual({ status: 'error', error: 'Tool use block not found' })
  })

  it('memory / office / write / mcp / spawn / page / ask_user 各归各位', async () => {
    // memory（recall）→ execOtherTool
    let ctx = makeCore()
    ctx.raw.messages.push(msg([toolUse('t1', 'recall', { query: 'x' })]))
    await ctx.flow.approveTool('t1')
    expect(ctx.calls.executor).toEqual([['execOtherTool', 'recall']])

    // office_inspect 与 office_read → execWorkspaceTool（OR 两侧都过）
    for (const name of ['office_inspect', 'office_read']) {
      ctx = makeCore()
      ctx.raw.messages.push(msg([toolUse('t1', name, { file_path: '/a.docx' })]))
      await ctx.flow.approveTool('t1')
      expect(ctx.calls.executor).toEqual([['execWorkspaceTool', name]])
    }

    // write（WRITE_TIER）→ execWorkspaceTool
    ctx = makeCore()
    ctx.raw.messages.push(msg([toolUse('t1', 'write', { file_path: '/a', content: 'x' })]))
    await ctx.flow.approveTool('t1')
    expect(ctx.calls.executor).toEqual([['execWorkspaceTool', 'write']])

    // MCP → execMCPTool
    ctx = makeCore()
    ctx.raw.messages.push(msg([toolUse('t1', 'mcp_free')]))
    await ctx.flow.approveTool('t1')
    expect(ctx.calls.executor).toEqual([['execMCPTool', 'mcp_free']])

    // spawn_agent → execSpawnAgent
    ctx = makeCore()
    ctx.raw.messages.push(msg([toolUse('t1', 'spawn_agent')]))
    await ctx.flow.approveTool('t1')
    expect(ctx.calls.executor).toEqual([['execSpawnAgent', 'spawn_agent']])

    // page → execPageTool（不是 shell 默认 —— H10 陷阱）
    ctx = makeCore()
    ctx.raw.messages.push(msg([toolUse('t1', 'page_click')]))
    await ctx.flow.approveTool('t1')
    expect(ctx.calls.executor).toEqual([['execPageTool', 'page_click']])

    // ask_user → 只标 running，等 respondToTool
    ctx = makeCore()
    const ask = toolUse('t1', 'ask_user', { question: 'q' })
    ctx.raw.messages.push(msg([ask]))
    await ctx.flow.approveTool('t1')
    expect(ctx.calls.executor).toHaveLength(0)
    expect(ask.status).toBe('running')
  })

  it('shell 默认：exit 事件收尾，无输出给 (no output)，exitCode 0 非错误', async () => {
    const { raw, flow, calls, host } = makeCore()
    const block = toolUse('t1', 'exec', { command: 'echo hi' })
    raw.messages.push(msg([block]))
    await flow.approveTool('t1')
    // 4th arg = the engine's conversationId → its persistent shell key (review
    // P0-1): the approval release must land in the SAME shell as the auto path.
    expect(host.executeCommand).toHaveBeenCalledWith('echo hi', undefined, undefined, 'conv_exec_flow')
    expect(raw.executingProcessId).toBe('pid-1')
    host.emitExit('pid-1', 0)
    expect(calls.results).toEqual([{ id: 't1', content: '(no output)', isError: false }])
    expect(block.status).toBe('completed')
    expect(block.exitCode).toBe(0)
    expect(raw.executingProcessId).toBeNull()
  })

  it('有输出 + 非零退出码 → isError', async () => {
    const { raw, flow, calls, host } = makeCore()
    raw.messages.push(msg([toolUse('t2', 'exec', { command: 'boom' })]))
    await flow.approveTool('t2')
    host.emitOutput('pid-1', 'partial out')
    host.emitExit('pid-1', 1)
    expect(calls.results).toEqual([{ id: 't2', content: 'partial out', isError: true }])
  })

  it('beforeTool hook 改写命令；空命令被阻断', async () => {
    const hook = vi.fn(async (ctx: { command: string }) => ({ ...ctx, command: 'safe --cmd' }))
    let ctx = makeCore({ opts: { hooks: { beforeTool: hook } } })
    ctx.raw.messages.push(msg([toolUse('t1', 'exec', { command: 'danger' })]))
    await ctx.flow.approveTool('t1')
    expect(hook).toHaveBeenCalled()
    expect(ctx.host.executeCommand).toHaveBeenCalledWith('safe --cmd', undefined, undefined, 'conv_exec_flow')

    // hook 清空命令 → 阻断，不执行
    const emptyHook = async () => ({ command: '', cwd: '' })
    ctx = makeCore({ opts: { hooks: { beforeTool: emptyHook } } })
    ctx.raw.messages.push(msg([toolUse('t2', 'exec', { command: 'x' })]))
    await ctx.flow.approveTool('t2')
    expect(ctx.host.executeCommand).not.toHaveBeenCalled()
    expect(ctx.calls.results[0]?.content).toContain('blocked by beforeTool hook')
    expect(ctx.calls.results[0]?.isError).toBe(true)
  })

  it('alwaysAllow 把 allowlist key 存进会话白名单', async () => {
    const { raw, host, flow } = makeCore()
    raw.messages.push(msg([toolUse('t1', 'exec', { command: 'npm test' })]))
    await flow.approveTool('t1', true)
    expect(host.addExecAllowlist).toHaveBeenCalledWith('npm test')
  })

  it('executeCommand 拒绝 → 错误结果收尾', async () => {
    const { raw, flow, calls, host } = makeCore()
    host.executeCommand.mockRejectedValueOnce(new Error('spawn failed'))
    const block = toolUse('t1', 'exec', { command: 'x' })
    raw.messages.push(msg([block]))
    await flow.approveTool('t1')
    expect(calls.results[0]).toMatchObject({ id: 't1', isError: true })
    expect(block.exitCode).toBe(-1)
    expect(block.output).toBe('Error: spawn failed')
  })

  it('timeout 参数 ×1000 传入 executeCommand', async () => {
    const { raw, flow, host } = makeCore()
    raw.messages.push(msg([toolUse('t1', 'exec', { command: 'x', timeout: 5 })]))
    await flow.approveTool('t1')
    expect(host.executeCommand).toHaveBeenCalledWith('x', undefined, 5000, 'conv_exec_flow')
  })

  it('terminalError 只吃第一个，后续忽略', async () => {
    const { raw, flow, calls, host } = makeCore()
    raw.messages.push(msg([toolUse('t1', 'exec', { command: 'x' })]))
    await flow.approveTool('t1')
    host.emitError('pid-1', 'killed by oom')
    host.emitError('pid-1', 'second error ignored')
    expect(calls.results).toHaveLength(1)
    expect(calls.results[0]?.content).toBe('Error: killed by oom')
  })
})

describe('ExecutionFlow cleanup / killTool', () => {
  it('cleanup 清空终端清理表（吞异常）并杀前台进程', () => {
    const { raw, flow, host } = makeCore()
    raw.terminalCleanups.push(() => { throw new Error('cleanup boom') }, vi.fn())
    raw.executingProcessId = 'pid-9'
    flow.cleanup()
    expect(host.killCommand).toHaveBeenCalledWith('pid-9')
    expect(raw.terminalCleanups).toHaveLength(0)
    expect(raw.executingProcessId).toBeNull()
  })

  it('killTool 前台路径：杀进程 + 标记 completed', () => {
    const { raw, flow, calls, host } = makeCore()
    const block = toolUse('t1', 'exec', { command: 'x' })
    raw.messages.push(msg([block]))
    raw.executingProcessId = 'pid-3'
    flow.killTool('t1')
    expect(host.killCommand).toHaveBeenCalledWith('pid-3')
    expect(raw.executingProcessId).toBeNull()
    expect(block.status).toBe('completed')
    expect(block.output).toBe('(killed by user)')
    expect(calls.results[0]).toMatchObject({ id: 't1', isError: true })
  })

  it('killTool 后台路径：走 pid 通道而不是前台标量', () => {
    const { raw, flow, host } = makeCore()
    const block = toolUse('t1', 'exec', { command: 'x' }, { backgroundPid: 4242, output: 'running...' })
    raw.messages.push(msg([block]))
    flow.killTool('t1')
    expect(host.execKill).toHaveBeenCalledWith(4242)
    expect(block.output).toBe('running...\n[killed by user]')
  })
})

describe('ExecutionFlow pause / resume / stop', () => {
  it('pause 冻结请求记账、杀前台进程、递归子树、park 在 awaiting_continue', () => {
    const { raw, flow, host } = makeCore()
    const sub = { pauseExecution: vi.fn() } as unknown as EngineCore
    raw.activeSubAgents.set('sub1', sub)
    raw.abortController = new AbortController()
    const abortSpy = vi.spyOn(raw.abortController, 'abort')
    raw.currentRequestId = 'req-1'
    raw.executingProcessId = 'pid-5'
    raw.streamingBlocks.push({ type: 'text' } as never)
    raw.pendingToolIds.add('t1')
    flow.pauseExecution()
    expect(abortSpy).toHaveBeenCalled()
    expect(raw.cancelledRequestIds.has('req-1')).toBe(true)
    expect(host.apiAbortStream).toHaveBeenCalledWith('req-1')
    expect(raw.currentRequestId).toBeNull()
    expect(host.killCommand).toHaveBeenCalledWith('pid-5')
    expect(sub.pauseExecution).toHaveBeenCalled()
    expect(raw.streamingBlocks).toHaveLength(0)
    expect(raw.pendingToolIds.size).toBe(0)
    expect(raw.agentStatus).toEqual({ status: 'awaiting_continue', subAgentCount: 1 })
    expect(raw.turnClock.pause).toHaveBeenCalled()
  })

  it('pause 最小形态：无子代理时不带 subAgentCount', () => {
    const { raw, flow, host } = makeCore()
    flow.pauseExecution()
    expect(raw.agentStatus).toEqual({ status: 'awaiting_continue' })
    expect(host.killCommand).not.toHaveBeenCalled()
  })

  it('resume：子树递归、kick false 走 continueLoop；kick true 不抢回合', async () => {
    let ctx = makeCore()
    const sub = { resumeExecution: vi.fn() } as unknown as EngineCore
    ctx.raw.activeSubAgents.set('sub1', sub)
    ctx.raw.isCancelled = true
    ctx.flow.resumeExecution()
    await new Promise(r => setTimeout(r, 5))
    expect(sub.resumeExecution).toHaveBeenCalled()
    expect(ctx.raw.isCancelled).toBe(false)
    expect(ctx.raw.turnClock.resume).toHaveBeenCalled()
    expect(ctx.raw.continueLoop).toHaveBeenCalled()

    ctx = makeCore()
    ctx.raw.planScheduler.kick = vi.fn(() => true)
    ctx.flow.resumeExecution()
    await new Promise(r => setTimeout(r, 5))
    expect(ctx.raw.continueLoop).not.toHaveBeenCalled()
  })

  it('stop：结算整棵专家树（含孙辈）+ aborted + idle', () => {
    const { raw, flow, host } = makeCore()
    const grandchild = { cancelLoop: vi.fn(), activeSubAgents: new Map(), resolveCompletionIfSpawned: vi.fn() } as unknown as EngineCore
    const sub = {
      cancelLoop: vi.fn(), activeSubAgents: new Map([['g', grandchild]]), resolveCompletionIfSpawned: vi.fn(),
    } as unknown as EngineCore
    raw.activeSubAgents.set('sub1', sub)
    raw.currentRequestId = 'req-2'
    raw.abortController = new AbortController()
    raw.executingProcessId = 'pid-6'
    flow.stopExecution()
    expect(host.apiAbortStream).toHaveBeenCalledWith('req-2')
    expect(host.killCommand).toHaveBeenCalledWith('pid-6')
    expect(sub.cancelLoop).toHaveBeenCalled()
    expect(grandchild.cancelLoop).toHaveBeenCalled()
    expect(grandchild.resolveCompletionIfSpawned).toHaveBeenCalledWith('aborted')
    expect(sub.resolveCompletionIfSpawned).toHaveBeenCalledWith('aborted')
    expect(raw.resolveCompletionIfSpawned).toHaveBeenCalledWith('aborted')
    expect(raw.activeSubAgents.size).toBe(0)
    expect(raw.agentStatus).toEqual({ status: 'idle' })
  })
})

describe('ExecutionFlow dispatch 扇出（auto 模式）', () => {
  it('一个批次覆盖全家族路由', async () => {
    const { raw, flow, calls } = makeCore()
    const batch = [
      toolUse('t_read', 'read', { file_path: '/a' }),
      toolUse('t_preadd', 'page_get_content'),
      toolUse('t_write', 'write', { file_path: '/a', content: 'x' }),
      toolUse('t_pclick', 'page_click'),
      toolUse('t_mcpfree', 'mcp_free'),
      toolUse('t_mcpgated', 'mcp_gated'),
      toolUse('t_skill', 'pick_skill', { name: 'office' }),
      toolUse('t_pick', 'pick_tool', { names: ['mcp_picked'] }),
      toolUse('t_install', 'install', { package: 'x' }),
      toolUse('t_web', 'webfetch', { url: 'https://x' }),
      toolUse('t_browser', 'browser'),
      toolUse('t_subplan', 'create_sub_plan'),
      toolUse('t_mem', 'recall'),
      toolUse('t_compact', 'context_compact'),
      
      toolUse('t_exp', 'experience_read'),
      toolUse('t_logs', 'exec_logs'),
      toolUse('t_other', 'custom_thing'),
      toolUse('spawn_ok', 'spawn_agent'),
      toolUse('spawn_fail', 'spawn_agent'),
      toolUse('t_advance', 'advance_plan'),
    ]
    await flow.handleToolUseResponse(batch)
    const got = (m: ExecName): string[] => calls.executor.filter(([k]) => k === m).map(([, n]) => n)
    expect(got('execReadOnlyTools')).toEqual(['read'])
    expect(got('execPageReadTools')).toEqual(['page_get_content'])
    expect(got('execWorkspaceTool')).toEqual(['write'])
    expect(got('execPageTool')).toEqual(['page_click'])
    expect(got('execMCPTool').sort()).toEqual(['mcp_free', 'mcp_gated']) // auto 模式 gated 也放行
    expect(got('execPickSkill')).toEqual(['pick_skill'])
    expect(got('execPickTool')).toEqual(['pick_tool'])
    expect(raw.selectedMcpTools).toEqual(['mcp_picked'])
    expect(got('execInstall')).toEqual(['install'])
    expect(got('execWebFetch')).toEqual(['webfetch'])
    expect(got('execBrowser')).toEqual(['browser'])
    expect(got('execCreateSubPlan')).toEqual(['create_sub_plan'])
    expect(got('execOtherTool')).toEqual(['recall', 'context_compact', 'experience_read', 'exec_logs', 'custom_thing'])
    expect(got('execSpawnAgent').sort()).toEqual(['spawn_agent', 'spawn_agent'])
    expect(raw.planManager.execAdvancePlan).toHaveBeenCalled()
    // spawn 失败被兜住：块标 completed + 错误结果，其余专家不受牵连
    const failed = batch.find(t => t.id === 'spawn_fail')!
    expect(failed.status).toBe('completed')
    expect(failed.exitCode).toBe(-1)
    expect(calls.results.some(r => r.id === 'spawn_fail' && r.content.includes('spawn exploded'))).toBe(true)
    // 恰好一次批计点（混批由 dispatch 收尾覆盖）
    expect(calls.batches).toBe(1)
    expect(raw.isAutoExecuting).toBe(false)
    expect(calls.executor.length + raw.planManager.execAdvancePlan.mock.calls.length).toBeGreaterThanOrEqual(batch.length)
  })

  it('create_plan / advance_plan 在子代理内被拒（幻觉调用按名拦截）', async () => {
    const { raw, flow, calls } = makeCore({ opts: { spawnedToolset: true } })
    const batch = [toolUse('t1', 'create_plan'), toolUse('t2', 'advance_plan')]
    await flow.handleToolUseResponse(batch)
    expect(calls.executor).toHaveLength(0)
    expect(raw.planManager.execCreatePlan).not.toHaveBeenCalled()
    expect(raw.planManager.execAdvancePlan).not.toHaveBeenCalled()
    expect(calls.results.filter(r => r.content.includes('子代理无权使用该工具'))).toHaveLength(2)
  })
})

describe('ExecutionFlow 审批梯子与白名单', () => {
  it('outside-ask：exec 持有、白名单盖戳换块对象（含无块/非命中消息的遍历分支）', async () => {
    const { raw, flow, calls } = makeCore({ opts: { approvalMode: 'outside-ask' } })
    const target = toolUse('t1', 'exec', { command: 'npm test' })
    // 三种消息形态都进 swapToolUseBlock：无 contentBlocks / 有块不含目标 / 命中
    raw.messages.push(msg(undefined, 'user'))
    raw.messages.push(msg([toolUse('other', 'read', { file_path: '/x' })]))
    raw.messages.push(msg([target]))
    await flow.handleToolUseResponse([target])
    expect(calls.executor).toHaveLength(0)
    const stamped = raw.messages[2].contentBlocks![0] as ToolUseBlock & { _allowKey?: string }
    expect(stamped).not.toBe(target)
    expect(stamped._allowKey).toBe('npm test')
    expect(raw.pendingToolIds.has('t1')).toBe(true)
    expect(raw.agentStatus.status).toBe('awaiting_approval')
  })

  it('白名单命中的 exec 不持有，照常执行', async () => {
    const { flow, calls, setAllowlist } = makeCore({ opts: { approvalMode: 'outside-ask' } })
    setAllowlist(['npm test'])
    await flow.handleToolUseResponse([toolUse('t1', 'exec', { command: 'npm test' })])
    expect(calls.executor).toEqual([['execOtherTool', 'exec']])
    expect(calls.results[0]).toMatchObject({ id: 't1', isError: false })
  })

  it('白名单查询抛错 → 降级为空名单，exec 仍被持有', async () => {
    const { raw, flow, host } = makeCore({ opts: { approvalMode: 'outside-ask' } })
    ;(host.getExecAllowlist as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('no session'))
    await flow.handleToolUseResponse([toolUse('t1', 'exec', { command: 'x' })])
    expect(raw.agentStatus.status).toBe('awaiting_approval')
  })

  it('always-ask：write 也被持有', async () => {
    const { raw, flow, calls } = makeCore({ opts: { approvalMode: 'always-ask' } })
    const read = toolUse('t_read', 'read', { file_path: '/a' })
    const write = toolUse('t_write', 'write', { file_path: '/a', content: 'x' })
    await flow.handleToolUseResponse([read, write])
    expect(calls.executor).toEqual([['execReadOnlyTools', 'read']])
    expect(raw.pendingToolIds.has('t_write')).toBe(true)
    expect(raw.agentStatus.status).toBe('awaiting_approval')
  })

  it('outside-ask：finish_stage 是完成协议，永不上审批梯子', async () => {
    // 2026-11-11 阶段完成协议：finish_stage 只写引擎上的结算记录，没有文件/
    // 进程副作用。它曾落在 otherTools 里，exec 被持有的模式（outside-ask）下
    // 会停在 awaiting_approval——无人值守的阶段恰好在最需要完成信号时卡死。
    const { raw, flow, calls } = makeCore({ opts: { approvalMode: 'outside-ask', stageFinish: { verdicts: ['成功'] } } })
    const finish = toolUse('t_finish', 'finish_stage', { verdict: '成功', summary: '做完了' })
    await flow.handleToolUseResponse([finish])
    expect(calls.executor).toEqual([['execOtherTool', 'finish_stage']])
    expect(raw.pendingToolIds.has('t_finish')).toBe(false)
    expect(raw.agentStatus.status).not.toBe('awaiting_approval')
  })

  it('outside-ask：同批 exec 被持有，finish_stage 仍立即执行', async () => {
    const { raw, flow, calls } = makeCore({ opts: { approvalMode: 'outside-ask', stageFinish: { verdicts: ['成功'] } } })
    const shell = toolUse('t_sh', 'exec', { command: 'rm -rf /tmp/x' })
    const finish = toolUse('t_finish', 'finish_stage', { verdict: '成功', summary: '做完了' })
    raw.messages.push(msg([shell, finish]))
    await flow.handleToolUseResponse([shell, finish])
    expect(calls.executor).toEqual([['execOtherTool', 'finish_stage']])
    expect(raw.pendingToolIds.has('t_sh')).toBe(true)
    expect(raw.pendingToolIds.has('t_finish')).toBe(false)
    expect(raw.agentStatus.status).toBe('awaiting_approval')
  })
  it('outside-ask：gated MCP 持有、免审批 MCP 与孤儿 owner（缓存缺席）放行', async () => {
    const { raw, flow, calls } = makeCore({ opts: { approvalMode: 'outside-ask' } })
    await refreshMcpServers()
    const batch = [toolUse('t_gated', 'mcp_gated'), toolUse('t_free', 'mcp_free'), toolUse('t_orphan', 'mcp_orphan')]
    await flow.handleToolUseResponse(batch)
    const ran = calls.executor.filter(([k]) => k === 'execMCPTool').map(([, n]) => n)
    expect(ran.sort()).toEqual(['mcp_free', 'mcp_orphan'])
    expect(raw.pendingToolIds.has('t_gated')).toBe(true)
    expect(raw.agentStatus.status).toBe('awaiting_approval')
  })

  // audit 2026-10-10 #1：install(type=mcp) 注册完立即拉起 stdio 进程——信任组
  // 曾让它对审批梯子隐身。梯子按 exec 档扣留；skill 分支只写文件，留在信任组。
  it('install(type=mcp) 在 outside-ask 被持有；放行后路由到 execInstall 而非 shell 默认', async () => {
    const { raw, flow, calls } = makeCore({ opts: { approvalMode: 'outside-ask' } })
    const inst = toolUse('t1', 'install', { type: 'mcp', config: { name: 'x', command: 'bash', args: ['-c', 'echo hi'] } })
    raw.messages.push(msg([inst]))
    await flow.handleToolUseResponse([inst])
    expect(calls.executor).toHaveLength(0)
    expect(raw.pendingToolIds.has('t1')).toBe(true)
    expect(raw.agentStatus.status).toBe('awaiting_approval')
    await flow.approveTool('t1')
    expect(calls.executor).toEqual([['execInstall', 'install']])
  })

  it('install(type=skill) 留在信任组：outside-ask 也照常自动执行', async () => {
    const { flow, calls, raw } = makeCore({ opts: { approvalMode: 'outside-ask' } })
    await flow.handleToolUseResponse([toolUse('t1', 'install', { type: 'skill', content: '---\nname: x\n---\nbody' })])
    expect(calls.executor).toEqual([['execInstall', 'install']])
    expect(raw.agentStatus.status).not.toBe('awaiting_approval')
  })

  it('auto 模式 install(type=mcp) 照常自动执行（全访问档没有要绕的梯子）', async () => {
    const { flow, calls } = makeCore({ opts: { approvalMode: 'auto' } })
    await flow.handleToolUseResponse([toolUse('t1', 'install', { type: 'mcp', config: { name: 'x', command: 'bash' } })])
    expect(calls.executor).toEqual([['execInstall', 'install']])
  })
})

describe('ExecutionFlow 批前合成路径', () => {
  it('_jsonTruncated 批：合成错误结果 + 打点 + 续环，不派发', async () => {
    const { raw, flow, calls } = makeCore()
    const t = toolUse('t1', 'write', { file_path: '/a', content: 'x' }, { _jsonTruncated: true })
    await flow.handleToolUseResponse([t])
    expect(calls.executor).toHaveLength(0)
    expect(calls.batches).toBe(1)
    expect(raw.continueLoop).toHaveBeenCalled()
    expect(raw.messages).toHaveLength(1)
    expect(raw.messages[0].role).toBe('user')
    expect((raw.messages[0].contentBlocks as Array<{ type: string, is_error?: boolean }>)[0].is_error).toBe(true)
  })

  it('超大参数混批：合成拒绝 + 其余照常派发，打点恰一次', async () => {
    const { raw, flow, calls } = makeCore()
    const big = toolUse('t_big', 'write', { content: 'x'.repeat(1_050_000) })
    const read = toolUse('t_read', 'read', { file_path: '/a' })
    await flow.handleToolUseResponse([big, read])
    expect(calls.executor).toEqual([['execReadOnlyTools', 'read']])
    expect(calls.batches).toBe(1)
    expect(raw.messages).toHaveLength(1)
    const result = (raw.messages[0].contentBlocks as Array<{ tool_use_id: string, is_error: boolean }>)[0]
    expect(result.tool_use_id).toBe('t_big')
    expect(result.is_error).toBe(true)
    expect(raw.continueLoop).toHaveBeenCalled()
  })

  it('超大混批的簿记与正常路径对称：批内落地不提前续环（review_20261028 中2）', async () => {
    const { raw, flow, calls } = makeCore()
    const big = toolUse('t_big', 'write', { content: 'x'.repeat(1_050_000) })
    const read = toolUse('t_read', 'read', { file_path: '/a' })
    // 旧代码在这里的形状：pendingToolIds 空集 + isAutoExecuting false ⇒ read
    // 的结果一落地（批友还没跑完/刚跑完）就提前 continueLoop——与批尾那次
    // 合起来是并发流。钉法：结果落地当下 auto 标志必须在场且续环未发生。
    const atResultTime = { autoFlag: false, continuedAlready: true }
    ;(raw.toolExecutor as Record<string, unknown>).execReadOnlyTools = async (blocks: ToolUseBlock[]) => {
      atResultTime.autoFlag = raw.isAutoExecuting === true
      atResultTime.continuedAlready = raw.continueLoop.mock.calls.length > 0
      for (const b of blocks) { calls.executor.push(['execReadOnlyTools', b.name]); b.status = 'completed'; raw.addToolResult(b.id, 'ok', false) }
    }
    await flow.handleToolUseResponse([big, read])
    expect(atResultTime.autoFlag).toBe(true)
    expect(atResultTime.continuedAlready).toBe(false)
    expect(raw.isAutoExecuting).toBe(false) // finally 复位，与正常路径同型
    expect(raw.pendingToolIds.size).toBe(0) // 批排干
    expect(raw.toolUseBlocks.map(t => t.id)).toEqual(['t_read']) // 台账=活批
    expect(calls.executor).toEqual([['execReadOnlyTools', 'read']])
    expect(calls.batches).toBe(1)
    expect(raw.continueLoop).toHaveBeenCalledTimes(1) // 恰一次续环
  })

  it('纯超大批：全部被拒时也打点一次', async () => {
    const { raw, flow, calls } = makeCore()
    const big = toolUse('t_big', 'write', { content: 'x'.repeat(1_050_000) })
    await flow.handleToolUseResponse([big])
    expect(calls.executor).toHaveLength(0)
    expect(calls.batches).toBe(1)
    expect(raw.continueLoop).toHaveBeenCalled()
  })
})

describe('ExecutionFlow ask_user 与 drain/kick 矩阵', () => {
  it('ask_user 非子代理 → awaiting_user_input', async () => {
    const { raw, flow } = makeCore()
    await flow.handleToolUseResponse([toolUse('t1', 'ask_user', { question: 'q' })])
    expect(raw.agentStatus.status).toBe('awaiting_user_input')
  })

  it('ask_user 子代理 + 批已排干 → 合成结果 + continueLoop', async () => {
    const { raw, flow, calls } = makeCore({ isSpawnedSubAgent: true })
    await flow.handleToolUseResponse([toolUse('t1', 'ask_user', { question: 'q' })])
    expect(calls.results.some(r => r.id === 't1' && r.content.includes('ask_user is not available in sub-agent mode.'))).toBe(true)
    expect(raw.continueLoop).toHaveBeenCalled()
  })

  it('ask_user 子代理 + 未排干 → completed + 结算 completion', async () => {
    const { raw, flow } = makeCore({ isSpawnedSubAgent: true, autoSettle: false })
    await flow.handleToolUseResponse([toolUse('t1', 'ask_user', { question: 'q' })])
    expect(raw.agentStatus.status).toBe('completed')
    expect(raw.resolveCompletionIfSpawned).toHaveBeenCalledWith('completed')
    expect(raw.continueLoop).not.toHaveBeenCalled()
  })

  it('drain：批排干 + kick false → continueLoop', async () => {
    const { raw, flow } = makeCore()
    await flow.handleToolUseResponse([toolUse('t1', 'read', { file_path: '/a' })])
    expect(raw.continueLoop).toHaveBeenCalled()
    expect(raw.agentStatus.status).not.toBe('completed')
  })

  it('drain：kick true（调度器接管）→ 不 continueLoop', async () => {
    const { raw, flow } = makeCore()
    raw.planScheduler.kick = vi.fn(() => true)
    await flow.handleToolUseResponse([toolUse('t1', 'read', { file_path: '/a' })])
    expect(raw.continueLoop).not.toHaveBeenCalled()
  })

  it('drain：未排干 + midDrain kick true → 保持持有不关回合', async () => {
    const { raw, flow } = makeCore({ autoSettle: false })
    raw.planScheduler.kick = vi.fn((o?: { midDrain?: boolean }) => o?.midDrain === true)
    await flow.handleToolUseResponse([toolUse('t1', 'read', { file_path: '/a' })])
    expect(raw.continueLoop).not.toHaveBeenCalled()
    expect(raw.resolveCompletionIfSpawned).not.toHaveBeenCalled()
  })

  it('drain：未排干 + kick false → completed + 结算', async () => {
    const { raw, flow } = makeCore({ autoSettle: false })
    await flow.handleToolUseResponse([toolUse('t1', 'read', { file_path: '/a' })])
    expect(raw.agentStatus.status).toBe('completed')
    expect(raw.resolveCompletionIfSpawned).toHaveBeenCalledWith('completed')
  })

  it('spawn 进度在子代理引擎上回报', async () => {
    const onSpawnProgress = vi.fn()
    const { flow } = makeCore({ spawnSystemPrompt: '子代理', onSpawnProgress })
    await flow.handleToolUseResponse([toolUse('t1', 'read', { file_path: '/a' })])
    expect(onSpawnProgress).toHaveBeenCalledWith(expect.stringContaining('子代理进度: [1/1]'))
  })
})

describe('ExecutionFlow max_tokens 与回合收尾', () => {
  it('max_tokens 无工具调用 → 直接关回合', async () => {
    const { raw, flow } = makeCore()
    await flow.handleMaxTokensResponse([])
    expect(raw.handleEndTurnResponse).toHaveBeenCalledWith('max_tokens')
  })

  it('max_tokens 带截断工具 → 合成结果 + 打点 + 钩子 + 续环', async () => {
    const afterLlmCall = vi.fn()
    const { raw, flow, calls } = makeCore({ opts: { hooks: { afterLlmCall } } })
    const t = toolUse('t1', 'write', { content: 'x' })
    await flow.handleMaxTokensResponse([t])
    expect(calls.batches).toBe(1)
    expect(raw.continueLoop).toHaveBeenCalled()
    expect(afterLlmCall).toHaveBeenCalledWith(expect.objectContaining({ stopReason: 'max_tokens' }))
    expect(t.status).toBe('completed')
  })

  it('endTurn：nudge 拥有回合时提前返回', () => {
    const { raw, flow } = makeCore()
    raw.nudgeSummonIfUnplanned = vi.fn(() => true)
    flow.handleEndTurnResponse('end_turn')
    expect(raw.notify).not.toHaveBeenCalled()
    expect(raw.resolveCompletionIfSpawned).not.toHaveBeenCalled()
  })

  it('endTurn：调度器 kick true → 回合保持打开', () => {
    const { raw, flow } = makeCore()
    raw.planScheduler.kick = vi.fn(() => true)
    flow.handleEndTurnResponse('end_turn')
    expect(raw.agentStatus.status).not.toBe('completed')
    expect(raw.resolveCompletionIfSpawned).not.toHaveBeenCalled()
  })

  it('endTurn：正常收尾 —— 耗时落最后一条 assistant、双钩子齐发、prewarm 调度', () => {
    const afterLlmCall = vi.fn()
    const afterSession = vi.fn()
    const { raw, flow } = makeCore({ opts: { hooks: { afterLlmCall, afterSession } } })
    const last = msg([toolUse('x', 'read')])
    raw.messages.push(last)
    flow.handleEndTurnResponse('end_turn')
    expect(last.processingMs).toBe(1234)
    expect(raw.agentStatus.status).toBe('completed')
    expect(afterLlmCall).toHaveBeenCalled()
    expect(afterSession).toHaveBeenCalled()
    expect(raw.resolveCompletionIfSpawned).toHaveBeenCalledWith('completed')
    expect(raw.schedulePostTurnCompaction).toHaveBeenCalled()
  })

  it('endTurn：最后一条不是 assistant → 不写耗时；clock 未激活 → 同样跳过', () => {
    let ctx = makeCore()
    ctx.raw.messages.push(msg(undefined, 'user'))
    ctx.flow.handleEndTurnResponse('end_turn')
    expect((ctx.raw.messages[0] as { processingMs?: number }).processingMs).toBeUndefined()

    ctx = makeCore()
    ctx.raw.turnClock.isActive = vi.fn(() => false)
    const last = msg([toolUse('x', 'read')])
    ctx.raw.messages.push(last)
    ctx.flow.handleEndTurnResponse('end_turn')
    expect(last.processingMs).toBeUndefined()
  })

  it('endTurn：notify 链路抛异常被吞，结算与 prewarm 照常（finally 契约）', () => {
    const { raw, flow } = makeCore()
    raw.notify = vi.fn(() => { throw new Error('sink dead') })
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    flow.handleEndTurnResponse('end_turn')
    expect(raw.resolveCompletionIfSpawned).toHaveBeenCalledWith('completed')
    expect(raw.schedulePostTurnCompaction).toHaveBeenCalled()
    expect(consoleWarn).toHaveBeenCalled()
    consoleWarn.mockRestore()
  })
})
