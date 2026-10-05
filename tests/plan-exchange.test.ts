import { describe, expect, it, beforeEach } from 'vitest'

const { execSpawnAgent } = await import('../src/renderer/src/agent/executors/spawn-tool')
import type { PulseHost } from '../src/renderer/src/agent/host/types'
import { setHost } from '../src/renderer/src/agent/host'
import type { ToolExecContext } from '../src/renderer/src/agent/executors/context'
import type { ToolUseBlock } from '../src/renderer/src/types/agent'
import { PlanManager } from '../src/renderer/src/agent/plan-manager'
import {
  createPlanDag,
  formatUpstreamResults,
  migrateLinearPlan,
  mergeSplitProposal,
  resolveReadyNode,
} from '../src/shared/plan/graph'
import {
  extractDeclaredStatus,
  formatReportContract,
  REPORT_SKELETON,
  resolvePlanExchange,
} from '../src/shared/plan/exchange'
import type { Plan } from '../src/shared/types/plan'

/**
 * 计划节点数据交换规范（PLAN-plan-exchange）：每个 plan 一个工作区交换区
 * `<workspace>/.pulsemind/plans/<planId>/`；准入 = 派发时注入系统铸造的报告路径 + 标准
 * 骨架 + 节点 reportSpec；准出 = 收口点机械校验（存在/非空）后落
 * reportPath/declaredStatus，缺报告按失败结算；declaredStatus 只取判定行——
 * 报告文件先说、回复状态行兜底、散文永不投票（2026-10-05，n8 误报改源）；
 * 下游经 formatUpstreamResults 拿到报告路径自行 read。这里钉四层：exchange 纯函数、
 * graph 透传/注入、PlanManager CAS、spawn 收口点两端。
 */

// ── 1. exchange 纯函数 ───────────────────────────────────────────────────

describe('resolvePlanExchange: system-minted paths', () => {
  it('mints the exchange dir and per-node report paths', () => {
    const plan = createPlanDag('x', [{ description: 'a' }])
    const ex = resolvePlanExchange('/tmp/ws', plan)!
    expect(ex.dir).toBe(`/tmp/ws/.pulsemind/plans/${plan.id}`)
    expect(ex.reportPath('n3')).toBe(`/tmp/ws/.pulsemind/plans/${plan.id}/3-report.md`)
    expect(ex.reportPath('n12')).toBe(`/tmp/ws/.pulsemind/plans/${plan.id}/12-report.md`)
  })

  it('null without a workspace or a plan id (legacy, never dispatched)', () => {
    const plan = createPlanDag('x', [{ description: 'a' }])
    expect(resolvePlanExchange(undefined, plan)).toBeNull()
    const bare: Plan = { objective: 'x', nodes: plan.nodes, completed: false, version: 2 }
    expect(resolvePlanExchange('/tmp/ws', bare)).toBeNull()
  })

  it('extractDeclaredStatus: verdict lines only — prose never votes (2026-10-05 contract)', () => {
    // prose WITHOUT a verdict line declares nothing — the old full-text scan
    // read subject matter as verdicts (n8: a code-review reply's 「写入无失败
    // 兜底」 declared a node whose report said 成功)
    expect(extractDeclaredStatus('任务完成，一切成功')).toBeUndefined()
    expect(extractDeclaredStatus('部分成功：A 平台限流')).toBeUndefined()
    expect(extractDeclaredStatus('抓取失败，原因见下')).toBeUndefined()
    expect(extractDeclaredStatus('整体失败，A 部分成功')).toBeUndefined()
    expect(extractDeclaredStatus('no verdict here')).toBeUndefined()
    // the skeleton's own shapes are read verbatim — prose digressions cannot vote
    expect(extractDeclaredStatus('## 状态\n\n成功 —— 全部落库\n\n## 结论\n期间 error 重试两次后成功')).toBe('success')
    expect(extractDeclaredStatus('## 状态：部分成功')).toBe('partial')
    expect(extractDeclaredStatus('状态：部分成功（A 平台限流）')).toBe('partial')
    expect(extractDeclaredStatus('- 状态: 失败（网络不可达）')).toBe('failed')
    expect(extractDeclaredStatus('**Status**: error — upstream 500')).toBe('failed')
    // the reply duty's own vocabulary: 「执行结果」 as a heading or a label
    expect(extractDeclaredStatus('## 执行结果\n\n**成功** —— 已完成全量审查')).toBe('success')
    expect(extractDeclaredStatus('执行结果：失败（网络不可达）')).toBe('failed')
    // worst declaration wins within ONE verdict line
    expect(extractDeclaredStatus('状态：整体失败，A 部分成功')).toBe('failed')
    // the n8 incident, file-side: the body reviews failure modes, the 状态
    // line is the declaration — body 失败 words must not vote
    expect(extractDeclaredStatus('# n8 报告\n\n## 状态\n成功 —— 32 条问题清单已产出\n\n## 结论\nOffice 写入无失败兜底；withPathLock 失败不毒化')).toBe('success')
    // prose `error` stays a topic word — without a verdict line, nothing
    expect(extractDeclaredStatus('全部成功。error handling 已加固，0 errors。')).toBeUndefined()
    expect(extractDeclaredStatus('全部抓取成功，error 日志为空')).toBeUndefined()
    expect(extractDeclaredStatus('error handling 已加固')).toBeUndefined()
  })

  it('the admission contract names the minted path, the skeleton, and the node spec', () => {
    const plan = createPlanDag('x', [{ description: 'a', reportSpec: '关键数据必须含 CSV 表' }])
    const ex = resolvePlanExchange('/tmp/ws', plan)!
    const contract = formatReportContract(ex, plan.nodes[0])
    expect(contract).toContain(`## 报告契约`)
    expect(contract).toContain(ex.reportPath('n1'))
    expect(contract).toContain('## 状态')
    expect(contract).toContain('## 关键数据')
    expect(contract).toContain('关键数据必须含 CSV 表')
    expect(contract).toContain('成功 / 部分成功 / 失败')
    expect(REPORT_SKELETON).toContain('## 产物清单')
  })
})

// ── 2. graph 透传与注入 ──────────────────────────────────────────────────

describe('plan identity and reportSpec through the graph', () => {
  it('createPlanDag mints an id and carries reportSpec; migrateLinearPlan mints too', () => {
    const plan = createPlanDag('x', [{ description: 'a', reportSpec: 'JSON 数组' }, { description: 'b' }])
    expect(plan.id).toMatch(/^plan_/)
    expect(plan.nodes[0].reportSpec).toBe('JSON 数组')
    expect(plan.nodes[1].reportSpec).toBeUndefined()

    const legacy = migrateLinearPlan({ objective: 'old', steps: [{ description: 's1' }] })
    expect(legacy?.id).toMatch(/^plan_/)
  })

  it('split children inherit authored report specs', () => {
    const plan = createPlanDag('x', [{ description: 'a' }, { description: 'b', dependsOn: [1] }])
    plan.nodes[0].execution = { attemptId: 'a1', status: 'running' }
    const result = mergeSplitProposal(plan, 1, 'a1', [
      { description: 'A', reportSpec: '含错误码清单' },
      { description: 'B' },
    ])
    expect(result.ok).toBe(true)
    expect(plan.nodes[2].reportSpec).toBe('含错误码清单')
    expect(plan.nodes[3].reportSpec).toBeUndefined()
  })

  it('formatUpstreamResults lists each dependency report path and declared status', () => {
    const plan = createPlanDag('x', [{ description: '调研' }, { description: '撰写', dependsOn: [1] }])
    plan.nodes[0].status = 'completed'
    plan.nodes[0].handoff = '调研完成'
    plan.nodes[0].reportPath = '/tmp/ws/.pulsemind/plans/p1/1-report.md'
    plan.nodes[0].declaredStatus = 'partial'
    const section = formatUpstreamResults(plan, resolveReadyNode(plan, 2))
    expect(section).toContain('Report: /tmp/ws/.pulsemind/plans/p1/1-report.md')
    expect(section).toContain('（声明状态: 部分成功）')
    expect(section).toContain('read 直接读取')
    expect(section).toContain('调研完成')
  })
})

// ── 3. PlanManager：CAS 与懒铸 id ────────────────────────────────────────

describe('PlanManager.recordNodeReport', () => {
  function makeManager(plan: Plan | null): { pm: PlanManager; changes: number } {
    let changes = 0
    const pm = new PlanManager(
      () => {}, () => {}, () => [], () => { changes += 1 },
    )
    pm.plan = plan
    return { pm, changes }
  }

  it('CAS on attemptId; stamps reportPath + declaredStatus; notifies only on change', () => {
    const plan = createPlanDag('x', [{ description: 'a' }])
    plan.nodes[0].execution = { attemptId: 'a1', status: 'running' }
    const { pm, changes } = makeManager(plan)

    expect(pm.recordNodeReport('n1', 'WRONG', '/r.md', 'success')).toBe(false)
    expect(pm.recordNodeReport('n1', 'a1', '/r.md', 'partial')).toBe(true)
    expect(plan.nodes[0].reportPath).toBe('/r.md')
    expect(plan.nodes[0].declaredStatus).toBe('partial')
    const afterFirst = changes
    expect(pm.recordNodeReport('n1', 'a1', '/r.md', 'partial')).toBe(false) // no-op, no notify
    expect(changes).toBe(afterFirst)
  })

  it('beginNodeExecution lazily mints plan.id for legacy plans (single writer kept)', () => {
    const plan = createPlanDag('x', [{ description: 'a' }])
    const id = plan.id
    const { pm } = makeManager(plan)
    ;(plan as { id?: string }).id = undefined
    pm.beginNodeExecution('n1', 'a1')
    expect(plan.id).toMatch(/^plan_/)
    expect(plan.id).not.toBe(id)
  })
})

// ── 4. spawn 收口点：准入注入 + 准出校验 ─────────────────────────────────

const subMessages = (text: string) => [
  { id: 'a1', role: 'assistant', contentBlocks: [{ type: 'text', text }], createdAt: '2026-09-30T12:00:00.000Z' },
]

interface Captured { content: string; isError: boolean }

function makeExchangeContext(opts: { workspaceDir?: string; reportSize?: number | null; reportBody?: string }) {
  const calls = {
    results: [] as Captured[],
    executions: [] as string[],
    handoffs: [] as unknown[],
    reports: [] as Array<{ ref: string | number; path: string; status?: string }>,
    tasks: [] as string[],
    prompts: [] as string[],
    statPaths: [] as string[],
    readPaths: [] as string[],
  }
  const state: { resultText?: string } = {}
  const host = {
    getFileStat: (filePath: string) => {
      calls.statPaths.push(filePath)
      return Promise.resolve(opts.reportSize === null || opts.reportSize === undefined ? null : { size: opts.reportSize, birthtime: '', mtime: '', isDirectory: false })
    },
    readFile: (filePath: string) => {
      calls.readPaths.push(filePath)
      return Promise.resolve(opts.reportBody ?? '')
    },
  }
  setHost(host as unknown as PulseHost)
  const ex = {
    opts: { conversationId: 'conv_ex', maxTokens: 1024, ...(opts.workspaceDir ? { workspaceDir: opts.workspaceDir } : {}) },
    notify: () => {},
    addToolResult: (_id: string, content: string, isError: boolean) => { calls.results.push({ content, isError }) },
    spawnSubAgent: (config: { systemPrompt?: string; initialMessages: Array<{ contentBlocks: Array<{ type: string; text?: string }> }> }) => {
      calls.tasks.push(config.initialMessages[0]?.contentBlocks?.find(b => b.type === 'text')?.text ?? '')
      calls.prompts.push(config.systemPrompt ?? '')
      return {
        id: 'h1', subConvId: 'sub_ex', messages: [], agentStatus: { status: 'completed' }, abort: () => {},
        waitForCompletion: async () => ({ status: 'completed', messages: subMessages(state.resultText ?? '完成') }),
      }
    },
    getPlan: () => plan,
    beginPlanNodeExecution: () => { calls.executions.push('begin') },
    updatePlanNodeExecution: (_ref: string | number, _attemptId: string, status: string) => { calls.executions.push(status) },
    recordNodeHandoff: () => { calls.handoffs.push(1); return true },
    recordNodeReport: (ref: string | number, _attemptId: string, path: string, status?: string) => {
      calls.reports.push({ ref, path, status })
      return true
    },
    formatExecResult: () => '',
  } as unknown as ToolExecContext
  const plan = createPlanDag('exchange', [{ description: '调研节点' }, { description: '下游', dependsOn: [1] }])
  ;(ex as { calls: typeof calls }).calls = calls
  const tool = (input: Record<string, unknown>) =>
    ({ id: 't1', type: 'tool_use', name: 'spawn_agent', input, status: 'pending' }) as ToolUseBlock
  return { ex: ex as ToolExecContext, calls, tool, state, plan }
}

describe('spawn choke point: admission in, exit verified', () => {
  beforeEach(() => { setHost({} as unknown as PulseHost) })

  it('the admission contract rides the spawn system prompt, invisible in the first message', async () => {
    const { ex, calls, tool, state, plan } = makeExchangeContext({
      workspaceDir: '/tmp/ws_ex', reportSize: 120,
      reportBody: '# 调研节点 报告\n\n## 状态\n成功 —— 全部落库\n',
    })
    state.resultText = '任务成功，报告已写入指定路径'

    const block = tool({ task: '调研节点', planNode: 1 })
    await execSpawnAgent(ex, block)

    expect(plan.id).toMatch(/^plan_/)
    // 2026-10-05 user ruling: the contract is the model's business, not the
    // user's — the drill-in transcript shows the task, the prompt carries the
    // admission terms. Same bytes, different carrier.
    expect(calls.prompts[0]).toContain('## 报告契约')
    expect(calls.prompts[0]).toContain(`/tmp/ws_ex/.pulsemind/plans/${plan.id}/1-report.md`)
    expect(calls.prompts[0]).toContain('## 关键数据')
    expect(calls.tasks[0]).not.toContain('报告契约')
    expect(calls.tasks[0]).not.toContain('关键数据')
    expect(calls.statPaths).toEqual([`/tmp/ws_ex/.pulsemind/plans/${plan.id}/1-report.md`])
    expect(calls.readPaths).toEqual([`/tmp/ws_ex/.pulsemind/plans/${plan.id}/1-report.md`])
    expect(calls.executions).toEqual(['begin', 'running', 'delivered'])
    expect(calls.reports).toHaveLength(1)
    expect(calls.reports[0]).toEqual({ ref: 'n1', path: `/tmp/ws_ex/.pulsemind/plans/${plan.id}/1-report.md`, status: 'success' })
    expect(calls.handoffs).toHaveLength(1)
    expect(block.exitCode).toBe(0)
  })

  it('declared status: the report file speaks first — reply prose 失败 cannot override a 成功 状态 line (n8 regression)', async () => {
    const { ex, calls, tool, state, plan } = makeExchangeContext({
      workspaceDir: '/tmp/ws_ex', reportSize: 120,
      reportBody: '# 调研节点 报告\n\n## 状态\n成功 —— 32 条问题清单\n\n## 结论\nOffice 写入无失败兜底；withPathLock 失败不毒化。',
    })
    // the reply narrates the review's failure-mode subject matter AND its
    // verdict sits under a 执行结果 heading — under the old reply-only prose
    // scan this node recorded 'failed' off the body words
    state.resultText = '## 执行结果\n\n**成功** —— 全量审查完成。\n\n本次复查覆盖：写入失败路径、失败重试、失败不毒化等题材。'

    await execSpawnAgent(ex, tool({ task: '调研节点', planNode: 1 }))

    expect(calls.reports[0]).toEqual({ ref: 'n1', path: `/tmp/ws_ex/.pulsemind/plans/${plan.id}/1-report.md`, status: 'success' })
    expect(calls.executions).toEqual(['begin', 'running', 'delivered'])
  })

  it('declared status: the reply status line is the fallback when the report states no verdict', async () => {
    const { ex, calls, tool, state } = makeExchangeContext({
      workspaceDir: '/tmp/ws_ex', reportSize: 120,
      reportBody: '# 调研节点 报告\n\n## 结论\n做了事，但忘了写状态节。',
    })
    state.resultText = '## 执行结果\n\n部分成功 —— 依赖模块只查了一半。'

    await execSpawnAgent(ex, tool({ task: '调研节点', planNode: 1 }))

    expect(calls.reports).toHaveLength(1)
    expect(calls.reports[0]?.status).toBe('partial')
  })

  it('declared status: no verdict line anywhere → recorded as undefined (honest no-declaration), delivery unaffected', async () => {
    const { ex, calls, tool, state } = makeExchangeContext({
      workspaceDir: '/tmp/ws_ex', reportSize: 120,
      reportBody: '# 调研节点 报告\n\n## 结论\n任务完成，一切顺利，产出已落盘。',
    })
    state.resultText = '任务完成，一切成功，报告已写入。'

    await execSpawnAgent(ex, tool({ task: '调研节点', planNode: 1 }))

    expect(calls.reports).toHaveLength(1)
    expect(calls.reports[0]?.status).toBeUndefined()
    expect(calls.executions).toEqual(['begin', 'running', 'delivered'])
  })

  it('a missing report fails the contract: failed settle, violation envelope, no handoff stamp', async () => {
    const { ex, calls, tool, state, plan } = makeExchangeContext({ workspaceDir: '/tmp/ws_ex', reportSize: null })
    state.resultText = '任务完成（但忘了写报告）'

    const block = tool({ task: '调研节点', planNode: 1 })
    await execSpawnAgent(ex, block)

    expect(calls.executions).toEqual(['begin', 'running', 'failed'])
    expect(calls.handoffs).toHaveLength(0)
    expect(calls.reports).toHaveLength(0)
    const result = calls.results[0]
    expect(result.isError).toBe(true)
    expect(result.content).toContain('Report contract violated')
    expect(result.content).toContain(`/tmp/ws_ex/.pulsemind/plans/${plan.id}/1-report.md`)
    expect(result.content).toContain('spawn_agent planNode=1')
    expect(block.exitCode).toBe(1)
  })

  it('a merged split skips the report check (the proposal is the splitter\u2019s deliverable)', async () => {
    const { ex, calls, tool, state } = makeExchangeContext({ workspaceDir: '/tmp/ws_ex', reportSize: null })
    state.resultText = '### Split Proposal\nReason: 太重\n1. A\n2. B'

    await execSpawnAgent(ex, tool({ task: '调研节点', planNode: 1 }))

    expect(calls.statPaths).toEqual([]) // never even looked
    expect(calls.executions).toEqual(['begin', 'running', 'delivered'])
    expect(calls.reports).toHaveLength(0)
    expect(calls.results[0].content).toContain('**Split:**')
  })

  it('no workspaceDir → no contract, legacy behavior', async () => {
    const { ex, calls, tool, state } = makeExchangeContext({})
    state.resultText = '完成'

    await execSpawnAgent(ex, tool({ task: '调研节点', planNode: 1 }))

    expect(calls.tasks[0]).not.toContain('报告契约')
    expect(calls.prompts[0]).not.toContain('报告契约')
    expect(calls.statPaths).toEqual([])
    expect(calls.executions).toEqual(['begin', 'running', 'delivered'])
    expect(calls.reports).toHaveLength(0)
  })
})
