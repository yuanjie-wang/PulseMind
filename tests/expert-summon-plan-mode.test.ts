import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The engine import chain touches real stores (MEMORY.md creation on first
// touch), so point HOME at a temp dir BEFORE importing — a test must never
// write into the user's live ~/.pulsemind.
process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-summon-plan-'))

const { AgentEngine } = await import('../src/renderer/src/agent/AgentEngine')
const { setHost } = await import('../src/renderer/src/agent/host')
const { ToolManager } = await import('../src/renderer/src/tools/ToolManager')
const { SkillManager } = await import('../src/renderer/src/skills/SkillManager')
const { PlanManager } = await import('../src/renderer/src/agent/plan-manager')
const { buildSystemPrompt } = await import('../src/renderer/src/agent/system-prompt-builder')

import type { AgentEngineOptions } from '../src/renderer/src/agent/AgentEngine'
import type { ToolUseBlock } from '../src/renderer/src/types/agent'
import type { SummonedExpert } from '../src/shared/expert-context'

/** Construction-time cache warming pokes the host; nothing here needs it to
 *  answer, so every method is a generic async no-op. */
setHost(new Proxy({}, { get: () => () => Promise.resolve([] as unknown[]) }) as never)

const WRITER: SummonedExpert = { id: 'expert-writer', name: '写作专家' }
const REVIEWER: SummonedExpert = { id: 'expert-reviewer', name: '代码审查专家' }

function makeEngine(adapterPatch: Record<string, unknown> = {}) {
  return new AgentEngine({
    apiKey: 'test-key', baseURL: 'https://example.invalid', model: 'test-model', maxTokens: 1024,
    myName: 'tester', soul: '', yourName: 'user',
    // No request is ever issued on these paths — a spy on the request hook is
    // what proves it (a plain `{}` adapter would prove nothing about ordering).
    adapter: { reconcileMessages: vi.fn(), ...adapterPatch } as never,
    toolManager: new ToolManager() as never, skillManager: new SkillManager() as never,
    conversationId: 'conv_summon_plan',
  } as unknown as AgentEngineOptions)
}

const spawnBlock = (engine: ReturnType<typeof makeEngine>, index: number): ToolUseBlock =>
  engine.messages[index].contentBlocks[0] as ToolUseBlock

// ── Part 1: the expert's conclusion IS the answer ──────────────────────────

/**
 * 单专家 @召唤的结论原文交付（用户裁定 2026-09-17：「当专家输出结果后，还会被主
 * Agent 总结一遍，导致部分信息丢失，能不能在主对话中直接输出专家的结论」）。The
 * engine owns the invariant: `deliverExpertConclusion` accepts ONLY the tool-use
 * id minted by the delegation the engine itself dispatched, so a model-emitted
 * spawn_agent can never close a turn verbatim, and nothing forged can be written
 * onto a tool block. Acceptance sets `pendingVerbatimReply`, and continueLoop's
 * interception appends the text as the turn's own assistant message with NO
 * further LLM round — that round is the information loss being removed.
 */
describe('single-expert @-summon: the conclusion is delivered verbatim', () => {
  const deliver = (engine: ReturnType<typeof makeEngine>) =>
    (engine as unknown as { deliverExpertConclusion: (id: string, text: string) => boolean }).deliverExpertConclusion
  /** `reconcileMessages` is the last thing the request path does before sending
   *  (prepareTurn calls it once per turn too), so its COUNT is the observable
   *  "did this reach an LLM request" — a verbatim close adds none. */
  const reconciles = (engine: ReturnType<typeof makeEngine>) =>
    (engine.opts.adapter as unknown as { reconcileMessages: ReturnType<typeof vi.fn> }).reconcileMessages.mock.calls.length

  it('accepts only the delegation this engine dispatched, and needs real text', async () => {
    const engine = makeEngine()
    const dispatch = vi.spyOn(engine, 'handleToolUseResponse').mockResolvedValue(undefined)
    try {
      await engine.startDelegatedLoop('帮我写一篇周报', WRITER.id)
      const id = spawnBlock(engine, 1).id

      expect(deliver(engine)(id, '结论正文')).toBe(true)
      // A different id (a model-emitted spawn_agent, another turn's call) is
      // refused: those keep the ordinary envelope → parent-summarize path.
      expect(deliver(engine)(`toolu_${Date.now()}_forged`, '结论正文')).toBe(false)
      // Empty output is not a conclusion.
      expect(deliver(engine)(id, '   ')).toBe(false)
      expect(deliver(engine)('unknown-id', '结论正文')).toBe(false)
    } finally {
      dispatch.mockRestore()
    }
  })

  it('appends the accepted text as the turn\'s own assistant message and issues no LLM request', async () => {
    const engine = makeEngine()
    const dispatch = vi.spyOn(engine, 'handleToolUseResponse').mockResolvedValue(undefined)
    try {
      await engine.startDelegatedLoop('帮我写一篇周报', WRITER.id)
      const id = spawnBlock(engine, 1).id
      expect(deliver(engine)(id, '# 周报\n\n本周完成了 A、B、C。')).toBe(true)

      const before = reconciles(engine)
      await engine.continueLoop()

      // user → the spawn call → the expert's conclusion, and nothing else.
      expect(engine.messages).toHaveLength(3)
      const answer = engine.messages[2]
      expect(answer.role).toBe('assistant')
      expect(answer.contentBlocks).toEqual([{ type: 'text', text: '# 周报\n\n本周完成了 A、B、C。' }])
      // The turn is over (not "streaming") and the request path was never
      // entered — that is the whole point: no second round re-summarizes it.
      expect(engine.agentStatus).toEqual({ status: 'completed', stopReason: 'unknown' })
      expect(reconciles(engine)).toBe(before)
      // The delivery is consumed: a second loop must not re-append it.
      await engine.continueLoop()
      expect(engine.messages).toHaveLength(3)
    } finally {
      dispatch.mockRestore()
    }
  })

  it('a refusal leaves the ordinary loop in place (envelope → parent summarize)', async () => {
    const engine = makeEngine()
    const dispatch = vi.spyOn(engine, 'handleToolUseResponse').mockResolvedValue(undefined)
    try {
      await engine.startDelegatedLoop('帮我写一篇周报', WRITER.id)
      const id = spawnBlock(engine, 1).id
      expect(deliver(engine)(id, '')).toBe(false)
      // No pending reply → continueLoop walks the normal path and reaches the
      // request build-up (the reconcile hook is where that starts).
      const before = reconciles(engine)
      await engine.continueLoop()
      expect(engine.messages).toHaveLength(2)
      expect(reconciles(engine)).toBe(before + 1)
    } finally {
      dispatch.mockRestore()
    }
  })

  it('a plain turn never delivers verbatim: the id is minted per delegation', async () => {
    const engine = makeEngine()
    const dispatch = vi.spyOn(engine, 'handleToolUseResponse').mockResolvedValue(undefined)
    try {
      await engine.startLoop('普通消息')
      expect(deliver(engine)('any-id', '结论正文')).toBe(false)
      // The NEXT turn invalidates the previous delegation's id, so a late
      // conclusion can never land on a turn it does not belong to.
      const stale = 'toolu_stale'
      await engine.startDelegatedLoop('再写一篇', WRITER.id)
      expect(deliver(engine)(stale, '结论正文')).toBe(false)
      // messages: [0] 普通消息, [1] 再写一篇, [2] the spawn call
      expect(deliver(engine)(spawnBlock(engine, 2).id, '结论正文')).toBe(true)
    } finally {
      dispatch.mockRestore()
    }
  })
})

// ── Part 2: create_plan must cover every summoned expert ───────────────────

/**
 * 覆盖检查是把 `summons` 变成约束的地方（用户裁定 2026-09-17：「当@多个专家，能不能
 * 进入plan模式，为多个专家分配任务」）。The failure it prevents is silent: the model
 * returns a plan, the user believes their experts were assigned, and one of them
 * simply never appears. The error is model-facing — it names who is missing AND
 * who is already covered, so the next round can fix it inside the same loop.
 */
describe('plan mode: every summoned expert must own a node', () => {
  function makeManager(summoned: SummonedExpert[]) {
    const results: Array<{ id: string; content: string; isError: boolean }> = []
    const mgr = new PlanManager(
      (id, content, isError) => results.push({ id, content, isError }),
      () => {},
      () => [],
      () => {},
      () => summoned,
    )
    const mutations: string[] = []
    mgr.onMutated = () => mutations.push('mutated')
    return { mgr, results, mutations }
  }

  let seq = 0
  const tool = (input: Record<string, unknown>): ToolUseBlock =>
    ({ type: 'tool_use', id: `tu_${++seq}`, name: 'create_plan', input, status: 'pending' }) as ToolUseBlock

  it('rejects a plan that leaves a summoned expert unassigned, naming who and who is covered', async () => {
    const { mgr, results, mutations } = makeManager([WRITER, REVIEWER])
    const t = tool({
      objective: '把方案做出来',
      steps: [
        { description: '写初稿', assignee: WRITER.id },
        { description: '整理材料' },
      ],
    })
    await mgr.execCreatePlan(t)

    expect(t.exitCode).toBe(-1)
    expect(results[0].isError).toBe(true)
    expect(results[0].content).toContain('代码审查专家 (id: expert-reviewer)')
    expect(results[0].content).toContain('Already assigned: 写作专家')
    expect(results[0].content).toContain('create_plan again')
    // A rejected plan leaves the live one untouched and does not count as
    // "the plan tooling has been used".
    expect(mgr.plan).toBeNull()
    expect(mutations).toHaveLength(0)
  })

  it('accepts a plan where every summoned expert owns at least one node', async () => {
    const { mgr, results, mutations } = makeManager([WRITER, REVIEWER])
    const t = tool({
      objective: '把方案做出来',
      steps: [
        { description: '写初稿', assignee: WRITER.id },
        { description: '审查初稿', depends_on: [1], assignee: REVIEWER.id },
      ],
    })
    await mgr.execCreatePlan(t)

    expect(t.exitCode).toBe(0)
    expect(results[0].isError).toBe(false)
    expect(mgr.plan?.nodes.map((n) => n.assignee)).toEqual([WRITER.id, REVIEWER.id])
    expect(mutations).toEqual(['mutated'])
  })

  it('a second node for one expert does not discharge the other', async () => {
    const { mgr } = makeManager([WRITER, REVIEWER])
    const t = tool({
      objective: 'o',
      steps: [
        { description: 'a', assignee: WRITER.id },
        { description: 'b', assignee: WRITER.id },
        { description: 'c', assignee: WRITER.id },
      ],
    })
    await mgr.execCreatePlan(t)
    expect(t.exitCode).toBe(-1)
  })

  it('does not constrain a plain turn (no summons → normal plans pass unchanged)', async () => {
    const { mgr } = makeManager([])
    const t = tool({ objective: 'o', steps: [{ description: 'a' }, { description: 'b', assignee: REVIEWER.id }] })
    await mgr.execCreatePlan(t)
    expect(t.exitCode).toBe(0)
  })
})

// ── Part 2: the turn-end nudge ─────────────────────────────────────────────

/**
 * 简报是提示，不是保证：模型完全可能回一句「好的，我来安排」而不调 create_plan。
 * 所以回合结束时还有一道有界兜底——`handleEndTurnResponse` 先问引擎，引擎在
 * 「召唤了多位专家、没建计划、还没催过」时把这一轮**保持打开**再跑一次，`nudged`
 * 让第二次收尾正常关闭（弱模型两次都不理也不会死循环）。这里断言的是那句注释的
 * 可观察后果：状态没落到 completed、时钟还在走、continueLoop 被再次发起。
 */
describe('plan mode: a summons that ends with no plan is re-issued exactly once', () => {
  /** `nudgeSummonIfUnplanned` re-issues on a macrotask (setTimeout 0), so the
   *  spy's count is only meaningful after the queue drains — and only after
   *  `continueLoop.mockClear()`: opening the loop calls it once by itself, and a
   *  tool result landing with no pending work calls it again. Clearing right
   *  before the turn end makes the count mean "the nudge did this". */
  const tick = () => new Promise((r) => setTimeout(r, 0))

  async function summonedTurn() {
    const engine = makeEngine()
    const dispatch = vi.spyOn(engine, 'handleToolUseResponse').mockResolvedValue(undefined)
    const continueLoop = vi.spyOn(engine, 'continueLoop').mockResolvedValue(undefined)
    await engine.startPlanningLoop('把方案做出来', [WRITER, REVIEWER])
    expect(engine.summon).toMatchObject({ nudged: false, engaged: false })
    expect(engine.turnClock.isActive()).toBe(true)
    return { engine, dispatch, continueLoop }
  }

  it('keeps the turn open, nudged once, and does not fire the session end', async () => {
    const { engine, dispatch, continueLoop } = await summonedTurn()
    const afterSession = vi.fn()
    ;(engine.opts as { hooks?: Record<string, unknown> }).hooks = { afterSession }
    try {
      // One output character arrived and the model stopped without a plan.
      engine.agentStatus = { status: 'streaming' }
      continueLoop.mockClear()
      engine.handleEndTurnResponse(null)
      await tick()

      expect(continueLoop).toHaveBeenCalledTimes(1)
      // The turn is still running: no `completed`, clock still counting, and the
      // session-end observer — which fires once per finished turn — is silent.
      expect(engine.agentStatus).toEqual({ status: 'streaming' })
      expect(engine.turnClock.isActive()).toBe(true)
      expect(afterSession).not.toHaveBeenCalled()
      expect(engine.summon?.nudged).toBe(true)
    } finally {
      continueLoop.mockRestore()
      dispatch.mockRestore()
    }
  })

  it('bounds itself: the second turn end closes normally, clock and all', async () => {
    const { engine, dispatch, continueLoop } = await summonedTurn()
    try {
      continueLoop.mockClear()
      engine.handleEndTurnResponse(null)
      await tick()
      expect(continueLoop).toHaveBeenCalledTimes(1)

      // The model ignored the brief AND the correction: the second end is a
      // normal end — a re-issue that never stops is worse than no plan.
      engine.handleEndTurnResponse(null)
      await tick()
      expect(continueLoop).toHaveBeenCalledTimes(1)
      expect(engine.agentStatus).toEqual({ status: 'completed', stopReason: 'unknown' })
      expect(engine.turnClock.isActive()).toBe(false)
    } finally {
      continueLoop.mockRestore()
      dispatch.mockRestore()
    }
  })

  it('retires the nudge once a plan exists — and only then', async () => {
    const { engine, dispatch, continueLoop } = await summonedTurn()
    try {
      // An advance_plan that ERRORS ("No active plan") still reaches
      // notifyPlanChange — the very shape that would retire the nudge on a turn
      // with no plan at all, i.e. exactly the turn the nudge exists for.
      await engine.planManager.execAdvancePlan({
        type: 'tool_use', id: 'tu_early', name: 'advance_plan', input: { action: 'complete', node: 1 }, status: 'pending',
      } as ToolUseBlock)
      expect(engine.planManager.plan).toBeNull()
      expect(engine.summon?.engaged).toBe(false)

      continueLoop.mockClear()
      engine.handleEndTurnResponse(null)
      await tick()
      expect(continueLoop).toHaveBeenCalledTimes(1)

      // A covering plan is the real signal: from here the turn ends normally —
      // the experts have been asked to work, so nothing is left unanswered.
      await engine.planManager.execCreatePlan({
        type: 'tool_use', id: 'tu_plan', name: 'create_plan', status: 'pending',
        input: {
          objective: '把方案做出来',
          steps: [
            { description: '写初稿', assignee: WRITER.id },
            { description: '审查初稿', depends_on: [1], assignee: REVIEWER.id },
          ],
        },
      } as ToolUseBlock)
      expect(engine.summon?.engaged).toBe(true)
      continueLoop.mockClear()
      dispatch.mockClear()
      engine.handleEndTurnResponse(null)
      await tick()
      // The nudge retires, AND the plan scheduler now owns this turn end
      // (PLAN-plan-scheduler): n1 is READY with no attempt, so the turn stays
      // OPEN on a synthetic dispatch instead of closing — no LLM round, no
      // continueLoop. The close happens only after every node settles.
      expect(continueLoop).not.toHaveBeenCalled()
      expect(dispatch).toHaveBeenCalledTimes(1)
      expect(engine.agentStatus).toMatchObject({ status: 'executing' })
    } finally {
      continueLoop.mockRestore()
      dispatch.mockRestore()
    }
  })

  it('never revives a cancelled engine', async () => {
    const { engine, dispatch, continueLoop } = await summonedTurn()
    try {
      engine.stopExecution()
      continueLoop.mockClear()
      engine.handleEndTurnResponse(null)
      await tick()
      expect(continueLoop).not.toHaveBeenCalled()
    } finally {
      continueLoop.mockRestore()
      dispatch.mockRestore()
    }
  })

  // M3 (review 2026-09-18): planManager.plan survives across turns. With a
  // PREVIOUS turn's plan still installed, an advance_plan erroring against it
  // (notifyPlanChange fires even from the catch) or any mutation that leaves
  // the plan as the one the turn started with must NOT retire the nudge —
  // only a plan CREATED this turn may.
  it('a leftover plan from the previous turn does not retire the nudge', async () => {
    const engine = makeEngine()
    try {
      // A plan left over from the PREVIOUS turn (summon is null here, so the
      // coverage check has nobody to ask for).
      await engine.planManager.execCreatePlan({
        type: 'tool_use', id: 'tu_plan_old', name: 'create_plan', status: 'pending',
        input: {
          objective: '上一个回合的方案',
          steps: [{ description: '旧节点' }],
        },
      } as ToolUseBlock)
      const leftover = engine.planManager.plan
      expect(leftover).not.toBeNull()

      const dispatch = vi.spyOn(engine, 'handleToolUseResponse').mockResolvedValue(undefined)
      const continueLoop = vi.spyOn(engine, 'continueLoop').mockResolvedValue(undefined)
      await engine.startPlanningLoop('把方案做出来', [WRITER, REVIEWER])
      // The turn opened WITH that plan installed.
      expect(engine.summon?.planAtStart).toBe(leftover)

      // A mutation that leaves the plan as the one the turn started with —
      // exactly what a failed advance_plan against the old plan produces.
      ;(engine.planManager as unknown as { notifyPlanChange(): void }).notifyPlanChange()
      expect(engine.summon?.engaged).toBe(false)

      continueLoop.mockClear()
      engine.handleEndTurnResponse(null)
      await tick()
      // The nudge is still alive: the experts never got a node this turn.
      expect(continueLoop).toHaveBeenCalledTimes(1)

      // ...and a plan created over it (a NEW object) is the real signal.
      await engine.planManager.execCreatePlan({
        type: 'tool_use', id: 'tu_plan_new', name: 'create_plan', status: 'pending',
        input: {
          objective: '把方案做出来',
          steps: [
            { description: '写初稿', assignee: WRITER.id },
            { description: '审查初稿', depends_on: [1], assignee: REVIEWER.id },
          ],
        },
      } as ToolUseBlock)
      expect(engine.summon?.engaged).toBe(true)
      dispatch.mockRestore()
      continueLoop.mockRestore()
    } catch {
      // restorable spies are torn down above on the happy path only; vitest
      // reports the assertion failure either way.
    }
  })
})

// ── Part 2: the state-block brief ──────────────────────────────────────────

/**
 * 简报落在 state block（每回合的尾巴）而不是不变量核心里——那是缓存的契约：核心
 * 必须逐字节不变，任何随回合变化的值都必须走最后一个 message。
 */
describe('plan mode: the summons rides the state block, never the cached core', () => {
  const summon = { experts: [WRITER, REVIEWER], nudged: false, engaged: false }

  async function build(withSummon: boolean) {
    return buildSystemPrompt({
      opts: {
        apiKey: 'k', baseURL: 'b', model: 'm', maxTokens: 1,
        toolManager: new ToolManager() as never,
      } as unknown as AgentEngineOptions,
      messages: [],
      plan: null,
      ...(withSummon ? { summon } : {}),
    })
  }

  it('puts the roster and the protocol in the per-turn block', async () => {
    const { stateBlock } = await build(true)
    expect(stateBlock).toContain('## Summoned Experts (plan mode)')
    expect(stateBlock).toContain('**写作专家** (id: `expert-writer`)')
    expect(stateBlock).toContain('`create_plan` first')
    expect(stateBlock).toContain('advance_plan')
  })

  it('leaves the invariant core byte-identical with and without a summons', async () => {
    const withSummon = await build(true)
    const without = await build(false)
    expect(withSummon.systemPrompt).toBe(without.systemPrompt)
    expect(withSummon.systemPrompt).not.toContain('Summoned Experts')
    expect(without.stateBlock).not.toContain('Summoned Experts')
  })
})
