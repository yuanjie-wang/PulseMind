import { describe, expect, it } from 'vitest'

const { execSpawnAgent } = await import('../src/renderer/src/agent/executors/spawn-tool')
const { execCreateSubPlanTool } = await import('../src/renderer/src/agent/executors/create-sub-plan-tool')
import type { ToolExecContext } from '../src/renderer/src/agent/executors/context'
import type { ToolUseBlock } from '../src/renderer/src/types/agent'
import {
  blockedNodes,
  createPlanDag,
  formatPlanForPrompt,
  isTerminal,
  MAX_PLAN_NODES,
  mergeSplitProposal,
  planNodeExecutionLabel,
  readyNodes,
} from '../src/shared/plan/graph'
import { parseSplitProposal } from '../src/shared/plan/split-proposal'
import type { Plan } from '../src/shared/types/plan'

/**
 * 计划节点动态拆分 v2（PLAN-plan-split v2，工具定名 create_sub_plan）：
 * 子代理在循环内**任何时刻**（接受时或过程中）把剩余工作拆回父计划；合并是
 * **midprocess 形状**——X 完全不动（继续干活、照常结算），子节点依赖 [X] ∪
 * 内部依赖，下游并集**保留 X**。这里钉四层：
 *  1. 解析器（三态：none / invalid / valid）——结尾文本协议通道；
 *  2. 合并形状——X 不动、子节点等 X、下游 union 保留 X、CAS/gen/预算/整单拒绝；
 *  3. 派生触面——split 是保留终态、label、死依赖防御；
 *  4. 两个执行器——spawn 收口点（提案 → delivered+handoff+信封注记）与
 *     create_sub_plan（工具通道，桥 → 父 planManager）。
 */

const PROPOSAL = [
  '已完成需求梳理，剩余的抓取工作太重：',
  '### Split Proposal',
  'Reason: 数据源太多，单会话装不下',
  '1. 抓取 A 平台数据',
  '2. 抓取 B 平台数据',
  '3. 汇总对比 [deps: 1, 2]',
].join('\n')

// ── 1. parser（文本协议通道）─────────────────────────────────────────────

describe('parseSplitProposal: three states, no silent salvage', () => {
  it('no section → none (the sub-agent did all the work)', () => {
    expect(parseSplitProposal('任务完成，结论如下……')).toEqual({ kind: 'none' })
    expect(parseSplitProposal('')).toEqual({ kind: 'none' })
  })

  it('a valid proposal: reason, children, deps stripped from descriptions', () => {
    const parsed = parseSplitProposal(PROPOSAL)
    expect(parsed.kind).toBe('valid')
    if (parsed.kind !== 'valid') return
    expect(parsed.proposal.reason).toBe('数据源太多，单会话装不下')
    expect(parsed.proposal.children.map(c => c.description)).toEqual(['抓取 A 平台数据', '抓取 B 平台数据', '汇总对比'])
    expect(parsed.proposal.children[2].dependsOn).toEqual([1, 2])
    expect(parsed.proposal.children[0].dependsOn).toBeUndefined()
  })

  it('the LAST occurrence wins (draft then final)', () => {
    const text = `${PROPOSAL}\n\n${'### Split Proposal'}\nReason: 改主意了\n1. 只要一件事\n2. 另一件事`
    const parsed = parseSplitProposal(text)
    expect(parsed.kind).toBe('valid')
    if (parsed.kind !== 'valid') return
    expect(parsed.proposal.children).toHaveLength(2)
    expect(parsed.proposal.reason).toBe('改主意了')
  })

  it('a following markdown header ends the section', () => {
    const parsed = parseSplitProposal(`${PROPOSAL}\n\n## Summary\n1. 不是子任务`)
    expect(parsed.kind).toBe('valid')
    if (parsed.kind !== 'valid') return
    expect(parsed.proposal.children).toHaveLength(3)
  })

  it('header but no items (truncated) → invalid, NOT none', () => {
    const parsed = parseSplitProposal('正文\n### Split Proposal\nReason: 写到一半断了')
    expect(parsed.kind).toBe('invalid')
  })

  it('one child is not a split; six is a flood', () => {
    expect(parseSplitProposal('### Split Proposal\n1. 只写一件').kind).toBe('invalid')
    expect(parseSplitProposal('### Split Proposal\n' + [1, 2, 3, 4, 5, 6].map(n => `${n}. 第${n}件`).join('\n')).kind).toBe('invalid')
  })

  it('self / out-of-range / backward dependencies are all rejected', () => {
    expect(parseSplitProposal('### Split Proposal\n1. A [deps: 1]\n2. B').kind).toBe('invalid')
    expect(parseSplitProposal('### Split Proposal\n1. A\n2. B [deps: 3]').kind).toBe('invalid')
    expect(parseSplitProposal('### Split Proposal\n1. A [deps: 2]\n2. B').kind).toBe('invalid')
  })

  it('an over-long description is rejected, not truncated', () => {
    expect(parseSplitProposal(`### Split Proposal\n1. ${'长'.repeat(501)}\n2. B`).kind).toBe('invalid')
  })
})

// ── 2. merge：midprocess 形状 ────────────────────────────────────────────

function diamondWithAttempt(): { plan: Plan; attemptId: string } {
  const plan = createPlanDag('ship it', [
    { description: '调研' },
    { description: '前端', dependsOn: [1] },
    { description: '后端', dependsOn: [1] },
    { description: '发布', dependsOn: [2, 3] },
  ])
  plan.nodes[0].execution = { attemptId: 'attempt_1', status: 'running' }
  plan.nodes[0].subConvId = 'sub_proposer'
  return { plan, attemptId: 'attempt_1' }
}

describe('mergeSplitProposal: the node keeps working, children carry the remainder', () => {
  it('X is untouched; children depend on [X] ∪ internal; downstream unions X + children', () => {
    const { plan, attemptId } = diamondWithAttempt()
    const result = mergeSplitProposal(plan, 1, attemptId, [
      { description: '子任务A' },
      { description: '子任务B', dependsOn: [1] },
    ], '太重')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Append-only: children continue after n4; nothing else moved.
    expect(result.children.map(c => c.id)).toEqual(['n5', 'n6'])
    expect(plan.nodes.map(n => n.id)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5', 'n6'])
    // X untouched: still pending, still running OUR attempt, link kept.
    const n1 = plan.nodes[0]
    expect(n1.status).toBe('pending')
    expect(n1.execution).toEqual({ attemptId: 'attempt_1', status: 'running' })
    expect(n1.subConvId).toBe('sub_proposer')
    // children wait on X (the remainder starts when X's full output exists);
    // the internal dep made n6 wait on n5.
    expect(plan.nodes[4].dependsOn).toEqual(['n1'])
    expect(plan.nodes[4].gen).toBe(1)
    expect(plan.nodes[5].dependsOn).toEqual(['n1', 'n5'])
    expect(plan.nodes[5].gen).toBe(1)
    // downstream UNION: X kept (its partial output) + all children (the rest).
    expect(plan.nodes[1].dependsOn).toEqual(['n1', 'n5', 'n6'])
    expect(plan.nodes[2].dependsOn).toEqual(['n1', 'n5', 'n6'])
    expect(plan.nodes[3].dependsOn).toEqual(['n2', 'n3'])
    // Children are NOT ready — they wait for X to settle. The only ready node
    // is X itself (its live attempt is the scheduler's wait-branch concern,
    // not the derivation's); n2/n3 wait on the children now.
    expect(readyNodes(plan).map(n => n.id)).toEqual(['n1'])
    // X completing readies the first child (autoSettle shape).
    plan.nodes[0].status = 'completed'
    expect(readyNodes(plan).map(n => n.id)).toEqual(['n5'])
  })

  it('allows a second split of the same node (each covers work X will not do)', () => {
    const { plan, attemptId } = diamondWithAttempt()
    expect(mergeSplitProposal(plan, 1, attemptId, [{ description: 'A' }, { description: 'B' }]).ok).toBe(true)
    expect(mergeSplitProposal(plan, 1, attemptId, [{ description: 'C' }, { description: 'D', dependsOn: [1] }]).ok).toBe(true)
    expect(plan.nodes.map(n => n.id)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8'])
    // Both downstream additions accumulated; X still untouched.
    expect(plan.nodes[1].dependsOn).toEqual(['n1', 'n5', 'n6', 'n7', 'n8'])
    expect(plan.nodes[0].execution).toEqual({ attemptId: 'attempt_1', status: 'running' })
  })

  it('rejects a stale attempt (CAS) and leaves the plan untouched', () => {
    const { plan } = diamondWithAttempt()
    const before = JSON.stringify(plan)
    const result = mergeSplitProposal(plan, 1, 'attempt_STALE', [{ description: 'A' }, { description: 'B' }])
    expect(result.ok).toBe(false)
    expect(JSON.stringify(plan)).toBe(before)
  })

  it('rejects a split of a split product (gen gate)', () => {
    const { plan } = diamondWithAttempt()
    plan.nodes[0].gen = 1
    const before = JSON.stringify(plan)
    const result = mergeSplitProposal(plan, 1, 'attempt_1', [{ description: 'C' }, { description: 'D' }])
    expect(result.ok).toBe(false)
    expect(JSON.stringify(plan)).toBe(before)
  })

  it('enforces the node budget wall, whole-unit', () => {
    const plan = createPlanDag('big', Array.from({ length: MAX_PLAN_NODES }, (_, i) => ({ description: `n${i + 1}` })))
    plan.nodes[0].execution = { attemptId: 'a1', status: 'running' }
    const before = JSON.stringify(plan)
    const result = mergeSplitProposal(plan, 1, 'a1', [{ description: 'A' }, { description: 'B' }])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('20-node budget')
    expect(JSON.stringify(plan)).toBe(before)
  })

  it('rejects unknown refs, settled nodes, degenerate lists, empty descriptions', () => {
    const { plan, attemptId } = diamondWithAttempt()
    expect(mergeSplitProposal(plan, 99, attemptId, [{ description: 'A' }, { description: 'B' }]).ok).toBe(false)
    const settled = createPlanDag('done', [{ description: 'x' }, { description: 'y' }])
    settled.nodes[0].status = 'completed'
    expect(mergeSplitProposal(settled, 1, 'a', [{ description: 'A' }, { description: 'B' }]).ok).toBe(false)
    expect(mergeSplitProposal(plan, 1, attemptId, [{ description: '只有一件' }]).ok).toBe(false)
    expect(mergeSplitProposal(plan, 1, attemptId, [{ description: '  ' }, { description: 'B' }]).ok).toBe(false)
    expect(mergeSplitProposal(plan, 1, attemptId, [{ description: 'A' }, { description: 'B'.repeat(501) }]).ok).toBe(false)
  })
})

// ── 3. 派生触面（split 是保留终态）────────────────────────────────────────

describe('split as a status: terminal, labelled, defensively dead', () => {
  it('is terminal, labels 已拆分, and renders [split] (reserved vocabulary)', () => {
    const plan = createPlanDag('hand-made', [{ description: 'x' }, { description: 'y', dependsOn: [1] }])
    plan.nodes[0].status = 'split'
    plan.nodes[0].summary = 'split into n5..n6: 太重'

    expect(isTerminal('split')).toBe(true)
    expect(planNodeExecutionLabel(plan.nodes[0])).toBe('已拆分')
    expect(formatPlanForPrompt(plan)).toContain('[split] n1: x — split into n5..n6: 太重')
  })

  it('a pending node on a split dep shows blocked (defensive for broken invariants)', () => {
    const plan = createPlanDag('hand-broken', [{ description: 'x' }, { description: 'y', dependsOn: [1] }])
    plan.nodes[0].status = 'split' // invariant violation: nothing rewired this dep
    expect(blockedNodes(plan).map(n => n.id)).toEqual(['n2'])
  })
})

// ── 4a. spawn 收口点（文本协议通道）──────────────────────────────────────

const subMessages = (text: string) => [
  { id: 'a1', role: 'assistant', contentBlocks: [{ type: 'text', text }], createdAt: '2026-09-29T12:00:00.000Z' },
]

interface Captured { content: string; isError: boolean }

function makeSplitContext(plan: Plan | null) {
  const calls = {
    results: [] as Captured[],
    executions: [] as string[],
    handoffs: [] as Array<{ ref: string | number; text: string }>,
    merges: [] as Array<{ ref: string | number; children: unknown[]; reason?: string }>,
    tasks: [] as string[],
    planSplits: [] as unknown[],
  }
  const state: { resultText?: string; resultStatus?: 'completed' | 'error' | 'aborted'; resultError?: string; splitMidRun?: boolean; mergeOverride?: { ok: false; reason: string } } = {}
  const ex = {
    opts: { conversationId: 'conv_split_exec', maxTokens: 1024 },
    notify: () => {},
    addToolResult: (_id: string, content: string, isError: boolean) => { calls.results.push({ content, isError }) },
    spawnSubAgent: (config: { initialMessages: Array<{ contentBlocks: Array<{ type: string; text?: string }> }>; planSplit?: { createdIds?: string[] } | undefined }) => {
      calls.tasks.push(config.initialMessages[0]?.contentBlocks?.find(b => b.type === 'text')?.text ?? '')
      calls.planSplits.push(config.planSplit)
      // Simulate the spawn-manager bridge: a mid-run create_sub_plan merge
      // pushes the created node ids into the SAME config object the choke
      // point reads after waitForCompletion.
      if (state.splitMidRun && config.planSplit) config.planSplit.createdIds!.push('n5', 'n6')
      return {
        id: 'h1',
        subConvId: 'sub_split_test',
        messages: [],
        agentStatus: { status: 'completed' },
        abort: () => {},
        waitForCompletion: async () => ({
          status: state.resultStatus ?? 'completed',
          ...(state.resultError ? { error: state.resultError } : {}),
          messages: subMessages(state.resultText ?? '普通完成'),
        }),
      }
    },
    getPlan: () => plan,
    beginPlanNodeExecution: () => { calls.executions.push('begin') },
    updatePlanNodeExecution: (_ref: string | number, _attemptId: string, status: string) => { calls.executions.push(status) },
    recordNodeHandoff: (ref: string | number, _attemptId: string, text: string) => {
      calls.handoffs.push({ ref, text })
      return true
    },
    mergeSplitProposal: (ref: string | number, _attemptId: string, children: unknown[], reason?: string) => {
      calls.merges.push({ ref, children, reason })
      return state.mergeOverride ?? { ok: true, nodeIds: ['n5', 'n6'] }
    },
    formatExecResult: () => '',
  } as unknown as ToolExecContext
  const tool = (input: Record<string, unknown>) =>
    ({ id: 't1', type: 'tool_use', name: 'spawn_agent', input, status: 'pending' }) as ToolUseBlock
  return { ex, calls, tool, state }
}

function splittablePlan(): Plan {
  return createPlanDag('split me', [{ description: '拆我' }, { description: '下游', dependsOn: [1] }])
}

describe('spawn choke point: the text channel merges, then delivers normally (v2)', () => {
  it('a merged trailing proposal: delivered + handoff + the Split note in the envelope', async () => {
    const plan = splittablePlan()
    const { ex, calls, tool, state } = makeSplitContext(plan)
    state.resultText = PROPOSAL

    const block = tool({ task: '拆我', planNode: 1 })
    await execSpawnAgent(ex, block)

    expect(calls.merges).toHaveLength(1)
    expect(calls.merges[0].ref).toBe('n1')
    expect(calls.merges[0].reason).toBe('数据源太多，单会话装不下')
    expect(calls.merges[0].children).toHaveLength(3)
    // v2: X settles NORMALLY — delivered + handoff (its partial output is the
    // split children's upstream input).
    expect(calls.executions).toEqual(['begin', 'running', 'delivered'])
    expect(calls.handoffs).toHaveLength(1)
    expect(calls.handoffs[0].ref).toBe('n1')
    expect(calls.handoffs[0].text).toContain('### Split Proposal')
    const result = calls.results[0]
    expect(result.isError).toBe(false)
    expect(result.content).toContain('## Sub-Agent Result (completed)')
    expect(result.content).toContain('**Split:** its remainder was split into new plan nodes n5..n6')
    expect(result.content).toContain('do NOT execute or re-dispatch them yourself')
    expect(block.exitCode).toBe(0)
  })

  it('a rejected proposal: still delivered (partial work stands), envelope notes the rejection', async () => {
    const plan = splittablePlan()
    const { ex, calls, tool, state } = makeSplitContext(plan)
    state.resultText = PROPOSAL
    state.mergeOverride = { ok: false, reason: 'would exceed the 20-node budget' }

    const block = tool({ task: '拆我', planNode: 1 })
    await execSpawnAgent(ex, block)

    expect(calls.executions).toEqual(['begin', 'running', 'delivered'])
    expect(calls.handoffs).toHaveLength(1)
    const result = calls.results[0]
    expect(result.isError).toBe(false)
    expect(result.content).toContain('REJECTED (would exceed the 20-node budget)')
    expect(result.content).toContain('its own work above still stands')
    expect(block.exitCode).toBe(0)
  })

  it('a malformed proposal never reaches the merge and does not fail the node', async () => {
    const plan = splittablePlan()
    const { ex, calls, tool, state } = makeSplitContext(plan)
    state.resultText = '### Split Proposal\nReason: 只写了一件\n1. 唯一子任务'

    const block = tool({ task: '拆我', planNode: 1 })
    await execSpawnAgent(ex, block)

    expect(calls.merges).toHaveLength(0)
    expect(calls.executions).toEqual(['begin', 'running', 'delivered'])
    expect(calls.handoffs).toHaveLength(1)
    expect(calls.results[0].isError).toBe(false)
    expect(calls.results[0].content).toContain('malformed')
    expect(block.exitCode).toBe(0)
  })

  it('no proposal: the delivered chain is untouched (regression guard)', async () => {
    const plan = splittablePlan()
    const { ex, calls, tool, state } = makeSplitContext(plan)
    state.resultText = '任务完成，产出如下……'

    await execSpawnAgent(ex, tool({ task: '拆我', planNode: 1 }))

    expect(calls.merges).toHaveLength(0)
    expect(calls.executions).toEqual(['begin', 'running', 'delivered'])
    expect(calls.handoffs).toHaveLength(1)
    expect(calls.results[0].content).toContain('## Sub-Agent Result (completed)')
    expect(calls.results[0].content).not.toContain('**Split:**')
  })

  it('an error settlement that split mid-run still names the created nodes (the consult round sees them)', async () => {
    // The completed-gated split notes never fire on an error envelope, so a
    // watchdog-killed / crashed splitter left the consult round blind: the
    // children were live pending rows in the parent plan and the envelope
    // never said so. The failure-shaped note fixes exactly that.
    const plan = splittablePlan()
    const { ex, calls, tool, state } = makeSplitContext(plan)
    state.resultStatus = 'error'
    state.resultError = '子代理超过 10 分钟无任何产出且无在途请求/工具，疑似内部卡死，已自动结算。'
    state.splitMidRun = true

    const block = tool({ task: '拆我', planNode: 1 })
    await execSpawnAgent(ex, block)

    const result = calls.results[0]
    expect(result.isError).toBe(true)
    expect(result.content).toContain('### Sub-agent Status: error')
    expect(result.content).toContain('疑似内部卡死')
    expect(result.content).toContain(
      '**Split:** mid-run it called create_sub_plan: its remainder was split into new plan nodes n5..n6, which sit PENDING in the plan',
    )
    expect(result.content).toContain('advance_plan fail / skip')
    expect(calls.executions).toEqual(['begin', 'running', 'failed'])
    expect(block.exitCode).toBe(1)
    expect(block.output).toContain('剩余工作已拆分回父计划')
  })

  it('an error settlement with no mid-run split carries no Split note (negative control)', async () => {
    const plan = splittablePlan()
    const { ex, calls, tool, state } = makeSplitContext(plan)
    state.resultStatus = 'error'
    state.resultError = 'Sub-agent reached its loop limit (40 rounds) without completing the task.'

    const block = tool({ task: '拆我', planNode: 1 })
    await execSpawnAgent(ex, block)

    const result = calls.results[0]
    expect(result.isError).toBe(true)
    expect(result.content).toContain('### Sub-agent Status: error')
    expect(result.content).not.toContain('**Split:**')
    expect(block.output).not.toContain('剩余工作已拆分回父计划')
  })
})

describe('the split gate rides only for splittable nodes (v2 R5/R7)', () => {
  it('a gen-0 node with budget gets the hint AND the planSplit config; a gen-1 child gets neither', async () => {
    const plan = splittablePlan()
    const { ex, calls, tool, state } = makeSplitContext(plan)
    state.resultText = 'done'
    await execSpawnAgent(ex, tool({ task: '拆我', planNode: 1 }))
    expect(calls.tasks[0]).toContain('create_sub_plan')
    expect(calls.planSplits[0]).toMatchObject({ nodeRef: 'n1' })

    // A gen-1 child: splittable=false → no hint, no tool config → structurally
    // it cannot split.
    const after = splittablePlan()
    after.nodes[0].gen = 1
    const ctx2 = makeSplitContext(after)
    ctx2.state.resultText = 'done'
    await execSpawnAgent(ctx2.ex, ctx2.tool({ task: '拆我', planNode: 1 }))
    expect(ctx2.calls.tasks[0]).not.toContain('create_sub_plan')
    expect(ctx2.calls.planSplits[0]).toBeUndefined()
  })

  it('headroom < 2 suppresses the gate — a proposal can never bounce for room', async () => {
    const plan = createPlanDag('full', Array.from({ length: MAX_PLAN_NODES - 1 }, (_, i) => ({ description: `节点${i + 1}` })))
    const { ex, calls, tool, state } = makeSplitContext(plan)
    state.resultText = 'done'
    await execSpawnAgent(ex, tool({ task: '节点1', planNode: 1 }))
    expect(calls.tasks[0]).not.toContain('create_sub_plan')
    expect(calls.planSplits[0]).toBeUndefined()
  })
})

// ── 4b. create_sub_plan（工具通道）───────────────────────────────────────

describe('execCreateSubPlanTool: the tool channel through the bridge', () => {
  function makeToolContext(opts: { spawnPlanSplit?: { nodeRef: string; attemptId: string }; createSubPlan?: NonNullable<ToolExecContext['createSubPlan']> }) {
    const captured: Captured[] = []
    const ex = {
      opts: { conversationId: 'conv_tool', maxTokens: 1024, ...(opts.spawnPlanSplit ? { spawnPlanSplit: opts.spawnPlanSplit } : {}) },
      notify: () => {},
      addToolResult: (_id: string, content: string, isError: boolean) => { captured.push({ content, isError }) },
      ...(opts.createSubPlan ? { createSubPlan: opts.createSubPlan } : {}),
    } as unknown as ToolExecContext
    const tool = (input: Record<string, unknown>) =>
      ({ id: 'cs1', type: 'tool_use', name: 'create_sub_plan', input, status: 'pending' }) as ToolUseBlock
    return { ex, captured, tool }
  }

  it('a real bridge call: merges into the parent plan and reports the range', async () => {
    const { plan, attemptId } = diamondWithAttempt()
    const { ex, captured, tool } = makeToolContext({
      spawnPlanSplit: { nodeRef: 'n1', attemptId },
      createSubPlan: (children, reason) => {
        const r = mergeSplitProposal(plan, 'n1', attemptId, children, reason)
        return r.ok ? { ok: true, nodeIds: r.children.map(c => c.id) } : r
      },
    })

    const block = tool({ reason: '太重', subtasks: [{ description: 'A' }, { description: 'B', depends_on: [1] }] })
    await execCreateSubPlanTool(ex, block)

    expect(block.exitCode).toBe(0)
    expect(captured[0].isError).toBe(false)
    expect(captured[0].content).toContain('Merged into the parent plan as n5..n6 (太重)')
    expect(captured[0].content).toContain('The new nodes are NOT yours')
    // The parent plan grew with the midprocess shape; X untouched.
    expect(plan.nodes[4].dependsOn).toEqual(['n1'])
    expect(plan.nodes[0].status).toBe('pending')
  })

  it('a rejection is an ordinary tool error the sub-agent can retry', async () => {
    const { ex, captured, tool } = makeToolContext({
      spawnPlanSplit: { nodeRef: 'n1', attemptId: 'a1' },
      createSubPlan: () => ({ ok: false, reason: 'would exceed the 20-node budget' }),
    })
    const block = tool({ subtasks: [{ description: 'A' }, { description: 'B' }] })
    await execCreateSubPlanTool(ex, block)
    expect(block.exitCode).toBe(-1)
    expect(captured[0].isError).toBe(true)
    expect(captured[0].content).toContain('would exceed the 20-node budget')
    expect(captured[0].content).toContain('correct the call and retry')
  })

  it('without the gate or the bridge it refuses with an actionable error', async () => {
    const noGate = makeToolContext({ createSubPlan: () => ({ ok: true, nodeIds: ['n5', 'n6'] }) })
    const block1 = noGate.tool({ subtasks: [{ description: 'A' }, { description: 'B' }] })
    await execCreateSubPlanTool(noGate.ex, block1)
    expect(block1.exitCode).toBe(-1)
    expect(noGate.captured[0].content).toContain('only available to a sub-agent executing a splittable plan node')

    const noBridge = makeToolContext({ spawnPlanSplit: { nodeRef: 'n1', attemptId: 'a1' } })
    const block2 = noBridge.tool({ subtasks: [{ description: 'A' }, { description: 'B' }] })
    await execCreateSubPlanTool(noBridge.ex, block2)
    expect(block2.exitCode).toBe(-1)
    expect(noBridge.captured[0].content).toContain('no parent plan channel')
  })
})
