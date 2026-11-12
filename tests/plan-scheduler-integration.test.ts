import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { PulseHost } from '../src/renderer/src/agent/host/types'
import { setHost } from '../src/renderer/src/agent/host'
import { AgentEngine } from '../src/renderer/src/agent/AgentEngine'
import { ToolManager } from '../src/renderer/src/tools/ToolManager'
import { SkillManager } from '../src/renderer/src/skills/SkillManager'
import type { SpawnSubAgentConfig, SubAgentHandle, SubAgentResult } from '../src/renderer/src/agent/agent-utils'
import type { AgentStatus } from '../src/renderer/src/types/agent'
import { createPlanDag } from '../src/shared/plan/graph'
import { resetSubAgentLimiter } from '../src/renderer/src/agent/engine/subagent-limiter'

/**
 * The auto-scheduler, end to end on the real engine (PLAN-plan-scheduler).
 * `continueLoop` is the LLM-round counter: every round the pre-scheduler plan
 * needed (transcribe READY → spawn → settle → next) went through it, so
 *
 *  ① a diamond runs wave by wave to completion with ZERO intermediate rounds
 *     and exactly ONE final synthesis;
 *  ② a failed node pulls the model in for exactly ONE consult and the
 *     downstream wave is never dispatched (失败立即拉回 LLM, no auto-retry);
 *  ③ each downstream spawn's FIRST USER MESSAGE carries the task plus its
 *     direct dependencies' output verbatim as a `## 前序节点处理结果`
 *     section — the channel that replaces the parent model transcribing
 *     upstream results into `task`, and the visible record of what was
 *     delegated (user ruling 2026-09-25: the task used to live in the
 *     invisible system prompt behind a fixed placeholder).
 *
 * Non-vacuity is inherent in ①: the counter is a MOCKED continueLoop, so a
 * missing drain hook breaks the event chain — the plan never completes and
 * vi.waitFor times out — while an extra ritual round over-counts.
 */

function makeMockHost(): PulseHost {
  const record = (name: string) => () => {
    console.log(`[mockHost] ${name}`)
    return Promise.resolve([] as unknown[])
  }
  return {
    getSettings: () => Promise.resolve({ locale: 'zh' }),
    ...Object.fromEntries(
      [
        'onApiStreamChunk', 'onApiStreamError', 'onApiStreamDone', 'onApiStreamRetry',
        'onTerminalOutput', 'onTerminalExit', 'onTerminalError', 'onMcpServersChanged',
        'onSkillsChanged', 'mcpListServers', 'expertList', 'getSkillPreferences',
        'apiAbortStream', 'apiFetch', 'apiFetchStream', 'execCommandSync', 'executeCommand',
        'killCommand', 'readFile', 'writeFile', 'editFile', 'patchFile', 'getFileStat',
        'convertFileToMarkdown', 'copyFileToTmp', 'saveBase64Image', 'gitInvoke',
        'mcpStartServer', 'mcpRegisterServer', 'mcpUpdateServerSummary', 'mcpCallTool',
        'setSkillPreferences', 'readSkillRaw', 'installSkill',
        'saveMemory', 'searchConversationsByKeyword', 'getToolResult',
        'getConversation', 'saveConversation', 'appendConversationMessages',
        'persistToolResults', 'saveConversationPlan', 'getConversationPlan',
      ].map(k => [k, record(k)]),
    ),
  } as unknown as PulseHost
}

/** apiKey kept non-empty as a realistic profile; kick() no longer gates on it
 *  (review_20261028 高1 removed the gate — an empty key is the legitimate
 *  local-provider shape, and gating on it deadlocked delegated plans). */
function makeEngine(conversationId: string): AgentEngine {
  return new AgentEngine({
    apiKey: 'test-key', baseURL: 'https://example.invalid', model: 'test-model', maxTokens: 512,
    myName: '', soul: '', yourName: '',
    adapter: {} as never,
    toolManager: new ToolManager(),
    skillManager: new SkillManager(),
    conversationId,
  })
}

interface SpawnPlan {
  delayMs: number
  /** Assistant text the sub-agent "produces" — becomes the node handoff. */
  text?: string
  fail?: boolean
}

/** Fake sub-agent hosting keyed by the delegated task (the scheduler sends
 *  `task = node.description`, and spawn-tool titles the config with it).
 *  Records dispatch ORDER, per-node start/finish for the wave-overlap check,
 *  every systemPrompt (the invariant half) and every first user message (the
 *  task + upstream — what the sub-agent transcript shows). */
function stubSpawns(engine: AgentEngine, plan: Record<string, SpawnPlan>) {
  const order: string[] = []
  const counts: Record<string, number> = {}
  const startedAt = new Map<string, number>()
  const finishedAt = new Map<string, number>()
  const prompts: Record<string, string> = {}
  const taskMessages: Record<string, string> = {}
  engine.toolExecutor.spawnSubAgent = (config: SpawnSubAgentConfig): SubAgentHandle => {
    const label = Object.keys(plan).find(d => (config.title || '').includes(d)) ?? '?'
    order.push(label)
    counts[label] = (counts[label] ?? 0) + 1
    startedAt.set(label, Date.now())
    prompts[label] = config.systemPrompt
    taskMessages[label] = config.initialMessages[0]?.contentBlocks?.find(b => b.type === 'text')?.text ?? ''
    const { delayMs, text, fail } = plan[label]
    const completion = new Promise<SubAgentResult>((resolve, reject) => {
      setTimeout(() => {
        finishedAt.set(label, Date.now())
        if (fail) {
          reject(new Error(`node ${label} exploded`))
          return
        }
        resolve({
          status: 'completed',
          messages: [{
            id: `m_${label}`,
            role: 'assistant',
            contentBlocks: [{ type: 'text', text: text ?? `${label} done` }],
            createdAt: new Date().toISOString(),
          }],
        })
      }, delayMs)
    })
    return {
      id: `sub_${label}`,
      subConvId: `sub_conv_${label}`,
      messages: [],
      agentStatus: { status: 'idle' } as AgentStatus,
      abort: () => {},
      waitForCompletion: () => completion,
    }
  }
  return { order, counts, startedAt, finishedAt, prompts, taskMessages }
}

/** diamond: n1 → (n2, n3) → n4. */
function diamond() {
  return createPlanDag('ship it', [
    { description: '调研' },
    { description: '前端', dependsOn: [1] },
    { description: '后端', dependsOn: [1] },
    { description: '发布', dependsOn: [2, 3] },
  ])
}

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms))

/** The turn ends with the plan open — the end-turn hook is where the scheduler
 *  takes over (in production the model has just emitted create_plan). */
function startTurn(engine: AgentEngine): void {
  engine.handleEndTurnResponse(null)
}

beforeEach(() => {
  resetSubAgentLimiter()
  setHost(makeMockHost())
})

describe('plan scheduler integration — zero intermediate LLM rounds', () => {
  it('runs the diamond wave by wave to completion: 0 rounds during, exactly 1 final synthesis', async () => {
    const engine = makeEngine('conv_sched_auto')
    const llm = vi.spyOn(engine, 'continueLoop').mockResolvedValue(undefined)
    const { order, counts, startedAt, finishedAt } = stubSpawns(engine, {
      '调研': { delayMs: 20 },
      '前端': { delayMs: 80 },
      '后端': { delayMs: 80 },
      '发布': { delayMs: 20 },
    })
    engine.planManager.plan = diamond()

    startTurn(engine)
    await vi.waitFor(() => expect(engine.planManager.plan?.completed).toBe(true), { timeout: 5000 })

    // The entire DAG advanced on drains alone; the only LLM round is the
    // final synthesis the completed plan falls through to.
    expect(llm).toHaveBeenCalledTimes(1)
    expect(counts).toEqual({ '调研': 1, '前端': 1, '后端': 1, '发布': 1 })
    // Wave structure: n1 alone, then n2+n3 together, then the join.
    expect(order.slice(0, 1)).toEqual(['调研'])
    expect(new Set(order.slice(1, 3))).toEqual(new Set(['前端', '后端']))
    expect(order.slice(3)).toEqual(['发布'])
    // The middle wave really ran CONCURRENTLY (both in flight at once).
    expect(Math.max(startedAt.get('前端')!, startedAt.get('后端')!))
      .toBeLessThan(Math.min(finishedAt.get('前端')!, finishedAt.get('后端')!))
    // Every node auto-settled — no advance_plan round was needed.
    expect(engine.planManager.plan?.nodes.map(n => n.status)).toEqual(['completed', 'completed', 'completed', 'completed'])
  })

  it('keeps a consult round for a failure and never dispatches the downstream wave', async () => {
    const engine = makeEngine('conv_sched_fail')
    const llm = vi.spyOn(engine, 'continueLoop').mockResolvedValue(undefined)
    const { counts } = stubSpawns(engine, {
      '调研': { delayMs: 10, fail: true },
      '前端': { delayMs: 10 },
      '后端': { delayMs: 10 },
      '发布': { delayMs: 10 },
    })
    engine.planManager.plan = diamond()

    startTurn(engine)
    // First round through the counter IS the consult — the failure pulls the
    // model in immediately, ahead of anything else.
    await vi.waitFor(() => expect(llm).toHaveBeenCalledTimes(1), { timeout: 5000 })
    await tick(60)

    expect(llm).toHaveBeenCalledTimes(1) // exactly one decision round, no auto-retry
    expect(counts).toEqual({ '调研': 1 }) // n2/n3/n4 were never dispatched
    const plan = engine.planManager.plan!
    expect(plan.completed).toBeFalsy()
    expect(plan.nodes[0].execution?.status).toBe('failed')
    expect(plan.nodes[1].execution).toBeUndefined()
    expect(plan.nodes[1].status).toBe('pending')
  })
})

describe('plan scheduler integration — upstream results reach the sub-agent', () => {
  it('carries the task + each direct dependency\'s handoff in the first user message', async () => {
    const engine = makeEngine('conv_sched_upstream')
    vi.spyOn(engine, 'continueLoop').mockResolvedValue(undefined)
    const { prompts, taskMessages } = stubSpawns(engine, {
      '调研': { delayMs: 10, text: '调研产出：竞品 X 定价 99 元' },
      '前端': { delayMs: 10, text: '前端产出：组件已就绪' },
      '后端': { delayMs: 10, text: '后端产出：接口已上线' },
      '发布': { delayMs: 10 },
    })
    engine.planManager.plan = diamond()

    startTurn(engine)
    await vi.waitFor(() => expect(engine.planManager.plan?.completed).toBe(true), { timeout: 5000 })

    // The task lives ONLY in the first user message — the system prompt keeps
    // the invariant expert/capability half, nothing volatile in front of the
    // tool schemas (user ruling 2026-09-25).
    expect(taskMessages['调研']).toContain('## 你的任务')
    expect(prompts['调研']).not.toContain('## 你的任务')
    expect(prompts['前端']).not.toContain('调研产出')

    // The root has no dependencies → no section.
    expect(taskMessages['调研']).not.toContain('## 前序节点处理结果')

    // n2 gets n1's output VERBATIM (handoff, not a paraphrase), after the task.
    const n2 = taskMessages['前端']
    expect(n2).toContain('## 前序节点处理结果')
    expect(n2).toContain('### n1: 调研')
    expect(n2).toContain('调研产出：竞品 X 定价 99 元')
    expect(n2.indexOf('## 你的任务')).toBeLessThan(n2.indexOf('## 前序节点处理结果'))

    // n4 gets BOTH of its direct dependencies, one section each.
    const n4 = taskMessages['发布']
    expect(n4).toContain('### n2: 前端\n前端产出：组件已就绪')
    expect(n4).toContain('### n3: 后端\n后端产出：接口已上线')

    // The handoff is what settled n1 — autoSettle took its summary from it.
    expect(engine.planManager.plan?.nodes[0].handoff).toBe('调研产出：竞品 X 定价 99 元')
    expect(engine.planManager.plan?.nodes[0].summary).toBe('调研产出：竞品 X 定价 99 元')
  })
})

describe('plan scheduler integration — a split proposal merges and the wave continues (PLAN-plan-split v2)', () => {
  const PROPOSAL = [
    '调研范围确实过大，建议拆分。',
    '### Split Proposal',
    'Reason: 调研范围过大',
    '1. 拆子任务A',
    '2. 拆子任务B [deps: 1]',
  ].join('\n')

  it('merges the proposal, settles the node NORMALLY, dispatches the remainder — still zero intermediate rounds', async () => {
    const engine = makeEngine('conv_sched_split')
    const llm = vi.spyOn(engine, 'continueLoop').mockResolvedValue(undefined)
    const { order, counts, taskMessages } = stubSpawns(engine, {
      '调研': { delayMs: 10, text: PROPOSAL },
      '拆子任务A': { delayMs: 10, text: 'A 的产出' },
      '拆子任务B': { delayMs: 10, text: 'B 的产出' },
      '前端': { delayMs: 10 },
      '后端': { delayMs: 10 },
      '发布': { delayMs: 10 },
    })
    engine.planManager.plan = diamond()

    startTurn(engine)
    await vi.waitFor(() => expect(engine.planManager.plan?.completed).toBe(true), { timeout: 5000 })

    // The plan grew append-only; X settled NORMALLY (v2 midprocess shape) and
    // its children carried the remainder.
    const plan = engine.planManager.plan!
    expect(plan.nodes.map(n => n.id)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5', 'n6'])
    expect(plan.nodes.map(n => n.status)).toEqual(['completed', 'completed', 'completed', 'completed', 'completed', 'completed'])
    expect(plan.nodes[1].dependsOn).toEqual(['n1', 'n5', 'n6']) // downstream union KEEPS X
    expect(plan.nodes[4].dependsOn).toEqual(['n1']) // children wait on X
    expect(plan.nodes[5].dependsOn).toEqual(['n1', 'n5']) // proposal's internal dep

    // Wave structure: n1 → n5 (n6 waits on n5) → n6 → {n2, n3} → n4.
    expect(order.slice(0, 1)).toEqual(['调研'])
    expect(order.slice(1, 3)).toEqual(['拆子任务A', '拆子任务B'])
    expect(new Set(order.slice(3, 5))).toEqual(new Set(['前端', '后端']))
    expect(order.slice(5)).toEqual(['发布'])
    expect(counts).toEqual({ '调研': 1, '拆子任务A': 1, '拆子任务B': 1, '前端': 1, '后端': 1, '发布': 1 })

    // Zero intermediate LLM rounds — the merge rode the drains; the only
    // round is the final synthesis.
    expect(llm).toHaveBeenCalledTimes(1)

    // The gen gate: a split child (gen 1) never sees the split gate, an
    // original node still does — the structural half of termination.
    expect(taskMessages['拆子任务A']).not.toContain('create_sub_plan')
    expect(taskMessages['前端']).toContain('create_sub_plan')

    // The children read X's handoff as upstream input (the midprocess payoff:
    // X's delivered output — here the proposal text — reaches the remainder).
    expect(taskMessages['拆子任务A']).toContain('### n1: 调研')
    expect(taskMessages['拆子任务A']).toContain('调研范围确实过大')
  })
})
