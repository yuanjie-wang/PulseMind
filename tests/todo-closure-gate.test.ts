import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Same HOME sandbox as early-stop-guard.test.ts — the engine import chain
// touches real stores, and a test must never write into the user's live
// ~/.pulsemind.
process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-todo-gate-'))

const { AgentEngine } = await import('../src/renderer/src/agent/AgentEngine')
const { openaiAdapter } = await import('../src/renderer/src/llm/OpenAIAdapter')
const { ToolManager } = await import('../src/renderer/src/tools/ToolManager')
const { SkillManager } = await import('../src/renderer/src/skills/SkillManager')
const { buildSystemPrompt } = await import('../src/renderer/src/agent/system-prompt-builder')
import type { PulseHost } from '../src/renderer/src/agent/host/types'
import { setHost } from '../src/renderer/src/agent/host'
import type { AgentEngineOptions } from '../src/renderer/src/agent/AgentEngine'
import type { Plan } from '../src/shared/types/plan'

/**
 * Todo closure gate (2026-11-12, user: 任务已完成但 todo list 未更新).
 *
 * The shape it fixes: the turn does real tool work against a direct-mode
 * checklist and the model closes with prose while entries are still open —
 * todo_write's settle discipline was prompt-only, so the list just stayed
 * behind. The gate bounces the turn back ONCE (quota in the engine, the
 * "不断补充任务" bound) with the Todo Closure directive riding the state
 * block. Blocked entries don't fire the gate (user ruling: blocked = a
 * legitimate close); a pure-chat turn leaves a stale list alone; max_tokens
 * keeps its own continuation path; delegated plans are the scheduler's.
 *
 * Same harness as tests/early-stop-guard.test.ts (the REAL StreamRunner
 * dispatch over a fake host pumping queued SSE chunks per request), with the
 * earlyStopGuard flag OFF so the ONLY continuation mechanism under test is
 * the gate.
 */

type Runner = {
  run(opts: AgentEngineOptions, req: { apiUrl: string; headers: Record<string, string>; resolvedBody: unknown }): Promise<void>
}
const REQ = { apiUrl: 'https://example.invalid/v1/chat/completions', headers: {}, resolvedBody: {} }
const runnerOf = (engine: InstanceType<typeof AgentEngine>): Runner =>
  (engine as unknown as { streamRunner: Runner }).streamRunner

function makeStreamHost(): PulseHost & { pump(chunks: string[]): void } {
  const chunkListeners = new Set<(d: { requestId: string; data: string }) => void>()
  const doneListeners = new Set<(d: { requestId: string }) => void>()
  const queue: string[][] = []
  const noop = () => Promise.resolve([] as unknown[])
  const host = {
    onApiStreamChunk: (fn: (d: { requestId: string; data: string }) => void) => { chunkListeners.add(fn); return () => { chunkListeners.delete(fn) } },
    onApiStreamError: () => () => {},
    onApiStreamDone: (fn: (d: { requestId: string }) => void) => { doneListeners.add(fn); return () => { doneListeners.delete(fn) } },
    onApiStreamRetry: () => () => {},
    apiFetchStream: async (requestId: string) => {
      const chunks = queue.shift() ?? []
      for (const c of chunks) for (const fn of [...chunkListeners]) fn({ requestId, data: c })
      for (const fn of [...doneListeners]) fn({ requestId })
    },
    onTerminalOutput: () => () => {},
    onTerminalExit: () => () => {},
    onTerminalError: () => () => {},
    onMcpServersChanged: () => () => {},
    onSkillsChanged: () => () => {},
    mcpListServers: noop,
    expertList: noop,
    getSkillPreferences: () => Promise.resolve({}),
    getSettings: () => Promise.resolve({ locale: 'zh' }),
  } as unknown as PulseHost & { pump(chunks: string[]): void }
  ;(host as unknown as { pump(chunks: string[]): void }).pump = (chunks: string[]) => { queue.push(chunks) }
  return host
}

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`

const toolStream = (): string[] => [
  sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'webfetch', arguments: '{"url":"https://example.invalid"}' } }] } }] }),
  sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 881, completion_tokens: 9 } }),
  'data: [DONE]\n\n',
]

/** A real todo_write round: mint a list with one settled and one open step. */
const todoWriteStream = (): string[] => [
  sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_todo', type: 'function', function: { name: 'todo_write', arguments: JSON.stringify({ objective: 'ship the fix', items: [{ description: 'read the log', status: 'completed' }, { description: 'write the patch' }] }) } }] } }] }),
  sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 881, completion_tokens: 30 } }),
  'data: [DONE]\n\n',
]

/** The failure shape: the turn closes in prose with the list still open. */
const endTurnStream = (): string[] => [
  sse({ choices: [{ delta: { content: '第一步已经做完了，第二步我接着处理。' } }] }),
  sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 881, completion_tokens: 24 } }),
  'data: [DONE]\n\n',
]

const maxTokenStream = (): string[] => [
  sse({ choices: [{ delta: { content: '我先读取一下' } }] }),
  sse({ choices: [{ delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 100, completion_tokens: 8 } }),
  'data: [DONE]\n\n',
]

/** A direct-mode plan live in the engine's PlanManager. */
function makeDirectPlan(nodes: Array<{ id: string; description: string; status?: string; dependsOn?: string[] }>, over?: Partial<Plan>): Plan {
  return {
    id: 'plan_todo_gate',
    objective: 'ship the fix',
    nodes: nodes.map((n) => ({ id: n.id, description: n.description, status: (n.status ?? 'pending') as Plan['nodes'][number]['status'], dependsOn: n.dependsOn ?? [] })),
    completed: false,
    version: 2,
    mode: 'direct',
    ...over,
  } as Plan
}

function makeEngine(host: ReturnType<typeof makeStreamHost>, opts: { conversationId?: string } = {}) {
  const engine = new AgentEngine({
    apiKey: 'test-key',
    baseURL: 'https://example.invalid',
    model: 'test-model',
    maxTokens: 1024,
    myName: 'tester',
    soul: '',
    yourName: 'user',
    adapter: openaiAdapter,
    toolManager: new ToolManager() as never,
    skillManager: new SkillManager(),
    conversationId: opts.conversationId ?? 'conv_todo_gate',
    // earlyStopGuard deliberately ABSENT — the gate must be the only
    // continuation mechanism firing in these tests.
  } as unknown as AgentEngineOptions)

  const statuses: string[] = []
  const baseNotify = engine.notify.bind(engine)
  engine.notify = () => { statuses.push(engine.agentStatus.status); baseNotify() }
  // Tool rounds must settle without touching a network: same stub shape as
  // auto-mode-phantom-approval.test.ts. The settle tick is what increments
  // toolRoundsThisTurn (recordToolBatchComplete) — the gate's evidence.
  engine.toolExecutor.execReadOnlyTools = async (tools: Array<{ id: string; status?: string; exitCode?: number | null }>) => {
    for (const t of tools) { t.status = 'completed'; t.exitCode = 0 }
    engine.addToolResult(tools[0].id, 'page body', false)
  }
  return { engine, statuses }
}

/** Wait for the turn cascade (tool batch → gate → setTimeout continuation →
 *  next round) to land on a terminal status. A fixed tick() races under full-
 *  suite load — the gate's continuation is fire-and-forget, so only the
 *  status is a reliable settle signal. */
async function waitForClose(engine: InstanceType<typeof AgentEngine>) {
  for (let i = 0; i < 600; i++) {
    const s = engine.agentStatus.status
    if (s === 'completed' || s === 'error' || s === 'awaiting_extension') return
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** Drive the runner through a queue of rounds via a faked continueLoop. */
async function drive(host: ReturnType<typeof makeStreamHost>, engine: InstanceType<typeof AgentEngine>, rounds: string[][]) {
  let continueCalls = 0
  engine.continueLoop = async (): Promise<void> => {
    continueCalls += 1
    const chunks = rounds.shift()
    if (!chunks) return
    host.pump(chunks)
    await runnerOf(engine).run(engine.opts, REQ)
    await waitForClose(engine)
  }
  const first = rounds.shift()!
  host.pump(first)
  await runnerOf(engine).run(engine.opts, REQ)
  await waitForClose(engine)
  return { get continueCalls() { return continueCalls } }
}

describe('todo closure gate: fires once on an open list after tool work', () => {
  it('bounces the first open-ended close; the second closes normally even with the list still open', async () => {
    const host = makeStreamHost()
    setHost(host)
    const { engine, statuses } = makeEngine(host)
    engine.planManager.plan = makeDirectPlan([
      { id: 'n1', description: 'step one', status: 'completed' },
      { id: 'n2', description: 'step two' },
    ])

    // tool round → text close (gate fires) → text close again (quota spent).
    // continueCalls = 2: the tool round's own continuation + the gate.
    const rounds = [toolStream(), endTurnStream(), endTurnStream()]
    const { continueCalls } = await drive(host, engine, rounds)

    expect(continueCalls).toBe(2)
    expect(statuses).toContain('retrying')
    expect(engine.agentStatus).toEqual({ status: 'completed', stopReason: 'end_turn' })
    expect(engine.todoCloseNudged).toBe(true)
    // The directive armed for the bounced round (prepareLoopRequest never ran
    // under the faked continueLoop — the prompt tests below prove delivery).
    expect(engine.pendingTodoCloseNudge).toBe(true)
    expect(engine.toolRoundsThisTurn).toBe(1)
    // All three rounds live in the transcript; the gate never deletes.
    expect(engine.messages.filter((m) => m.role === 'assistant')).toHaveLength(3)
  })

  it('a real todo_write round drives the gate end-to-end (reconcile → plan → gate)', async () => {
    const host = makeStreamHost()
    setHost(host)
    // No conversation row → savePlan no-ops (the fake host has no DB methods).
    const { engine } = makeEngine(host, { conversationId: undefined })

    const rounds = [todoWriteStream(), endTurnStream(), endTurnStream()]
    const { continueCalls } = await drive(host, engine, rounds)

    expect(continueCalls).toBe(2)
    const plan = engine.planManager.plan
    expect(plan?.mode).toBe('direct')
    expect(plan?.nodes.find((n) => n.id === 'n2')?.status).toBe('pending')
    expect(engine.todoCloseNudged).toBe(true)
    expect(engine.agentStatus).toEqual({ status: 'completed', stopReason: 'end_turn' })
  })
})

describe('todo closure gate: exempt shapes close without a nudge', () => {
  it('blocked entries are a legitimate close (user ruling) — gate stays silent', async () => {
    const host = makeStreamHost()
    setHost(host)
    const { engine } = makeEngine(host)
    engine.planManager.plan = makeDirectPlan([
      { id: 'n1', description: 'step one', status: 'completed' },
      { id: 'n2', description: 'waiting on the vendor reply', status: 'blocked' },
    ])

    const rounds = [toolStream(), endTurnStream()]
    const { continueCalls } = await drive(host, engine, rounds)

    expect(continueCalls).toBe(1) // the tool round's own continuation only
    expect(engine.todoCloseNudged).toBe(false)
    expect(engine.agentStatus).toEqual({ status: 'completed', stopReason: 'end_turn' })
  })

  it('no plan at all → sessions that never built a checklist are untouched', async () => {
    const host = makeStreamHost()
    setHost(host)
    const { engine } = makeEngine(host)

    const rounds = [toolStream(), endTurnStream()]
    const { continueCalls } = await drive(host, engine, rounds)

    expect(continueCalls).toBe(1)
    expect(engine.todoCloseNudged).toBe(false)
    expect(engine.agentStatus).toEqual({ status: 'completed', stopReason: 'end_turn' })
  })

  it('a fully settled direct plan → no gate', async () => {
    const host = makeStreamHost()
    setHost(host)
    const { engine } = makeEngine(host)
    engine.planManager.plan = makeDirectPlan(
      [{ id: 'n1', description: 'only step', status: 'completed' }],
      { completed: true },
    )

    const rounds = [toolStream(), endTurnStream()]
    const { continueCalls } = await drive(host, engine, rounds)

    expect(continueCalls).toBe(1)
    expect(engine.todoCloseNudged).toBe(false)
    expect(engine.agentStatus).toEqual({ status: 'completed', stopReason: 'end_turn' })
  })

  it('a delegated plan is the scheduler\'s, not the gate\'s', async () => {
    const host = makeStreamHost()
    setHost(host)
    const { engine } = makeEngine(host)
    // Pending chain with nothing READY (the only dep is failed) — the
    // scheduler has no wave to dispatch (kick() falls through to consult)
    // and the gate must not fire either.
    engine.planManager.plan = makeDirectPlan(
      [
        { id: 'n1', description: 'downstream', dependsOn: ['n2'] },
        { id: 'n2', description: 'upstream', status: 'failed' },
      ],
      { mode: 'delegated' },
    )

    const rounds = [toolStream(), endTurnStream()]
    const { continueCalls } = await drive(host, engine, rounds)

    expect(continueCalls).toBe(1)
    expect(engine.todoCloseNudged).toBe(false)
    expect(engine.agentStatus).toEqual({ status: 'completed', stopReason: 'end_turn' })
  })

  it('a pure-chat turn never fires — no tool rounds, no bounce', async () => {
    const host = makeStreamHost()
    setHost(host)
    const { engine } = makeEngine(host)
    engine.planManager.plan = makeDirectPlan([{ id: 'n1', description: 'stale step' }])

    const rounds = [endTurnStream()]
    const { continueCalls } = await drive(host, engine, rounds)

    expect(continueCalls).toBe(0)
    expect(engine.toolRoundsThisTurn).toBe(0)
    expect(engine.todoCloseNudged).toBe(false)
    expect(engine.agentStatus).toEqual({ status: 'completed', stopReason: 'end_turn' })
  })

  it('max_tokens closes stay with their own path — the gate skips them', async () => {
    const host = makeStreamHost()
    setHost(host)
    const { engine } = makeEngine(host)
    engine.planManager.plan = makeDirectPlan([{ id: 'n1', description: 'open step' }])

    const rounds = [toolStream(), maxTokenStream()]
    const { continueCalls } = await drive(host, engine, rounds)

    expect(continueCalls).toBe(1)
    expect(engine.todoCloseNudged).toBe(false)
    expect(engine.agentStatus).toEqual({ status: 'completed', stopReason: 'max_tokens' })
  })
})

describe('the Todo Closure directive rides exactly one state block', () => {
  it("'todoClose' renders the closure section — and never the sentinel protocol", async () => {
    const opts = {
      apiKey: 'k', baseURL: 'https://example.invalid', model: 'm', maxTokens: 1024,
      myName: '', soul: '', yourName: '', locale: 'zh' as const,
    }
    const on = await buildSystemPrompt({ opts: opts as unknown as AgentEngineOptions, messages: [], plan: null, continuationNudge: 'todoClose' })
    expect(on.stateBlock).toContain('## Todo Closure')
    expect(on.stateBlock).toContain('todo_write')
    expect(on.stateBlock).not.toContain('<<TASK_DONE>>')
    expect(on.stateBlock).not.toContain('## Turn Continuation')

    const guard = await buildSystemPrompt({ opts: opts as unknown as AgentEngineOptions, messages: [], plan: null, continuationNudge: true })
    expect(guard.stateBlock).toContain('## Turn Continuation')
    expect(guard.stateBlock).not.toContain('## Todo Closure')

    const off = await buildSystemPrompt({ opts: opts as unknown as AgentEngineOptions, messages: [], plan: null })
    // The main path's state block always exists (clock section); what must be
    // absent is either nudge section.
    expect(off.stateBlock).not.toContain('## Todo Closure')
    expect(off.stateBlock).not.toContain('## Turn Continuation')
  })

  it('a spawned engine\'s minimal state block carries the closure section too', async () => {
    const spawnOpts = {
      apiKey: 'k', baseURL: 'https://example.invalid', model: 'm', maxTokens: 1024,
      myName: '', soul: '', yourName: '', locale: 'zh' as const,
    }
    const on = await buildSystemPrompt({ opts: spawnOpts as unknown as AgentEngineOptions, spawnSystemPrompt: 'You are a spawned expert.', messages: [], plan: null, continuationNudge: 'todoClose' })
    expect(on.stateBlock).toContain('## Todo Closure')
    expect(on.stateBlock).not.toContain('<<TASK_DONE>>')
    expect(on.stateBlock).not.toContain('## Workspace') // minimal: no session state
    const off = await buildSystemPrompt({ opts: spawnOpts as unknown as AgentEngineOptions, spawnSystemPrompt: 'You are a spawned expert.', messages: [], plan: null })
    expect(off.stateBlock).toBeNull()
  })
})

describe('wiring scans (a half-landed edit must fail here)', () => {
  const read = (p: string): string => readFileSync(join(__dirname, '..', p), 'utf-8')

  it('EngineCore declares the gate; the engine fields and quota exist', () => {
    const core = read('src/renderer/src/agent/engine/engine-core.ts')
    expect(core).toContain('nudgeTodoIfUnsettled: (stopReason: string | null) => boolean')
    const engineSrc = read('src/renderer/src/agent/AgentEngine.ts')
    expect(engineSrc).toContain('todoCloseNudged = false')
    expect(engineSrc).toContain('pendingTodoCloseNudge = false')
    expect(engineSrc).toContain('nudgeTodoIfUnsettled')
  })

  it('prepareTurn resets the quota — a new turn never inherits the old bound', () => {
    const src = read('src/renderer/src/agent/AgentEngine.ts')
    expect(src).toContain('this.todoCloseNudged = false')
    expect(src).toContain('this.pendingTodoCloseNudge = false')
  })

  it('prepareLoopRequest unions both nudge flags into the widened channel', () => {
    const src = read('src/renderer/src/agent/AgentEngine.ts')
    expect(src).toContain("const continuationNudge: boolean | 'todoClose' = this.pendingEarlyStopNudge")
    expect(src.match(/this\.pendingTodoCloseNudge = false/g)?.length).toBe(2)
  })

  it('execution-flow fires the gate after the scheduler kick and before the close bookkeeping', () => {
    const src = read('src/renderer/src/agent/engine/execution-flow.ts')
    const gate = src.indexOf('this.engine.nudgeTodoIfUnsettled(stopReason)')
    const kick = src.indexOf('this.engine.planScheduler.kick()')
    const classify = src.indexOf('const stop = classifyStopReason(stopReason)')
    expect(gate).toBeGreaterThan(-1)
    expect(kick).toBeGreaterThan(-1)
    expect(classify).toBeGreaterThan(-1)
    expect(gate).toBeGreaterThan(kick)
    expect(gate).toBeLessThan(classify)
  })

  it('both render sites branch through continuationNudgeSection', () => {
    const src = read('src/renderer/src/agent/system-prompt-builder.ts')
    expect(src).toContain("continuationNudge?: boolean | 'todoClose'")
    expect(src.match(/continuationNudgeSection\(continuationNudge\)/g)?.length).toBe(2)
    expect(src).toContain('const TODO_CLOSURE_NUDGE')
  })

  it('the todo_write manual teaches the enforced closure', () => {
    const src = read('src/renderer/src/tools/tool-instructions.ts')
    expect(src).toContain('The engine enforces the closure')
    expect(src).toContain('bounced back ONCE')
  })
})
