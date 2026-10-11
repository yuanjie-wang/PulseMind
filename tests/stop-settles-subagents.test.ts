import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Same HOME sandbox as thinking-only-retry.test.ts — the engine import chain
// touches real stores, and a test must never write into the user's live
// ~/.pulsemind.
process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-stop-settles-'))

const { AgentEngine } = await import('../src/renderer/src/agent/AgentEngine')
const { openaiAdapter } = await import('../src/renderer/src/llm/OpenAIAdapter')
const { ToolManager } = await import('../src/renderer/src/tools/ToolManager')
const { SkillManager } = await import('../src/renderer/src/skills/SkillManager')
const { setSubAgentParallelLimit } = await import('../src/renderer/src/agent/engine/subagent-limiter')

import type { PulseHost } from '../src/renderer/src/agent/host/types'
import { setHost } from '../src/renderer/src/agent/host'
import type { ToolUseBlock } from '../src/renderer/src/types/agent'
import { resetSubAgentLimiter } from '../src/renderer/src/agent/engine/subagent-limiter'

const tick = () => new Promise((r) => setTimeout(r, 10))

/**
 * 停止 / 继续执行 / 停止任务 / 新消息 对整棵专家树的语义（user ruling
 * 2026-09-29 最终形态，体验回滚后：单停止钮 + 确认条）。
 *
 * composer 的停止按钮 = `cancelLoop`（agentSessionCancel 落点）= **冻结**：
 * 中止在飞请求、整棵专家树一起冻结（递归 pauseExecution）、completion 一律不
 * 结算、并行槽位仍被持有、排队者不排空。回合停进 `awaiting_continue`，转写区
 * 下方的灰色确认条（任务已暂停…继续执行/停止任务）决定去留：
 *   继续执行 → `resumeExecution`：同一批子引擎原样续跑（引擎身份不变，不重派）；
 *   停止任务 → `stopExecution`：整棵树结算为 aborted、槽位归还、排队者判 null；
 *   输入新消息 → `prepareTurn`：同样结算旧树（引擎侧权威，所有客户端的新回合
 *   都经过它），然后开新回合——且结算续延必须在 isCancelled 仍关着时排空，
 *   否则信封落账的 addToolResult 会与新回合并发各开一条循环。
 *
 * These tests drive the REAL spawn path (real execSpawnAgent → real
 * spawnSubAgent → real sub-engines with live LLM streams over a controllable
 * host) — the existing parallel-spawn tests stub spawnSubAgent with fake
 * handles, so `activeSubAgents` (the map the stop walk consumes) is never
 * populated there and the freeze/settle of real sub-engines was untested.
 */

/** A host whose LLM streams are HELD OPEN until released, and which records
 *  every issued/aborted request id. `apiAbortStream` rejects the pending
 *  stream and emits the error, mimicking the proxy's abort behavior. Unknown
 *  methods record their name and resolve [] — the spawn path touches many
 *  optional host calls (skill appendix, preferences) that must degrade quietly. */
function makeHoldHost(): PulseHost & {
  issued: string[]
  aborted: string[]
  resolveStream(requestId: string, chunks: string[]): void
  abortStream(requestId: string, error?: string): void
} {
  const issued: string[] = []
  const aborted: string[] = []
  const pending = new Map<string, {
    resolve: () => void
    reject: (err: Error) => void
    chunkListeners: Set<(d: { requestId: string; data: string }) => void>
    errorListeners: Set<(d: { requestId: string; error: string }) => void>
    doneListeners: Set<(d: { requestId: string }) => void>
  }>()
  const globalChunk = new Set<(d: { requestId: string; data: string }) => void>()
  const globalError = new Set<(d: { requestId: string; error: string }) => void>()
  const globalDone = new Set<(d: { requestId: string }) => void>()

  const noop = () => Promise.resolve([] as unknown[])
  const base: Record<string, unknown> = {
    onApiStreamChunk: (fn: (d: { requestId: string; data: string }) => void) => { globalChunk.add(fn); return () => { globalChunk.delete(fn) } },
    onApiStreamError: (fn: (d: { requestId: string; error: string }) => void) => { globalError.add(fn); return () => { globalError.delete(fn) } },
    onApiStreamDone: (fn: (d: { requestId: string }) => void) => { globalDone.add(fn); return () => { globalDone.delete(fn) } },
    onApiStreamRetry: () => () => {},
    apiFetchStream: async (requestId: string) => {
      issued.push(requestId)
      await new Promise<void>((resolve, reject) => {
        pending.set(requestId, { resolve, reject, chunkListeners: globalChunk, errorListeners: globalError, doneListeners: globalDone })
      })
    },
    apiAbortStream: async (requestId: string) => {
      aborted.push(requestId)
      const p = pending.get(requestId)
      if (p) {
        pending.delete(requestId)
        for (const fn of [...p.errorListeners]) fn({ requestId, error: 'Request aborted' })
        p.reject(new Error('Request aborted'))
      }
    },
  }
  const host = new Proxy(base, {
    get(target, prop: string) {
      if (prop in target) return target[prop]
      if (!(prop in target)) (target as Record<string, unknown>)[prop] = noop
      return (target as Record<string, unknown>)[prop]
    },
  }) as unknown as PulseHost & {
    issued: string[]
    aborted: string[]
    resolveStream(requestId: string, chunks: string[]): void
    abortStream(requestId: string, error?: string): void
  }
  Object.defineProperties(host, {
    issued: { get: () => issued },
    aborted: { get: () => aborted },
  })
  // Resolvers live on the base object (never hit the Proxy's noop fallback):
  // resolveStream completes a held stream cleanly (chunks + DONE), abortStream
  // surfaces the proxy's abort error for one.
  ;(base as Record<string, unknown>).resolveStream = (requestId: string, chunks: string[]) => {
    const p = pending.get(requestId)
    if (!p) return
    for (const c of chunks) for (const fn of [...p.chunkListeners]) fn({ requestId, data: c })
    for (const fn of [...p.doneListeners]) fn({ requestId })
    pending.delete(requestId)
    p.resolve()
  }
  ;(base as Record<string, unknown>).abortStream = (requestId: string, error = 'Request aborted') => {
    const p = pending.get(requestId)
    if (!p) return
    for (const fn of [...p.errorListeners]) fn({ requestId, error })
    pending.delete(requestId)
    p.reject(new Error(error))
  }
  return host
}

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`

/** A tool round from a sub-agent: its loop would continue if the stop failed
 *  to stick — a new request after the stop is the observable failure. */
const subToolStream = (toolId: string): string[] => [
  sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: toolId, type: 'function', function: { name: 'webfetch', arguments: '{"url":"https://example.invalid"}' } }] } }] }),
  sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
  'data: [DONE]\n\n',
]

/** A clean text round: ends the sub-agent's turn and settles its completion
 *  ('completed') — what lets a finished expert hand its slot to the queued one. */
const subTextEndStream = (): string[] => [
  sse({ choices: [{ delta: { content: '任务完成。' } }] }),
  sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4 } }),
  'data: [DONE]\n\n',
]

function makeEngine(conversationId: string, _host: PulseHost) {
  return new AgentEngine({
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
    conversationId,
  } as never)
}

const spawnBlock = (id: string, task: string): ToolUseBlock =>
  ({ type: 'tool_use', id, name: 'spawn_agent', input: { subAgentId: '', task }, status: 'pending' }) as ToolUseBlock

const toolResultIds = (engine: AgentEngine): string[] =>
  engine.messages.flatMap(m => m.contentBlocks).filter(b => b.type === 'tool_result').map(b => (b as { tool_use_id: string }).tool_use_id)

const toolResultFor = (engine: AgentEngine, id: string): string =>
  engine.messages.flatMap(m => m.contentBlocks)
    .filter(b => b.type === 'tool_result' && (b as { tool_use_id: string }).tool_use_id === id)
    .map(b => (b as { content: string }).content).join('')

/** Plant `blocks` as this engine's tool batch, run the real dispatch, and wait
 *  until `count` sub-engines hold a live (host-held) LLM request. */
async function dispatchSpawns(engine: AgentEngine, blocks: ToolUseBlock[], count: number): Promise<void> {
  engine.messages = [...engine.messages, {
    id: `m_${blocks[0].id}`,
    role: 'assistant',
    contentBlocks: blocks,
    createdAt: new Date().toISOString(),
  }]
  engine.pendingToolIds = new Set(blocks.map(b => b.id))
  void engine.handleToolUseResponse(blocks)
  await waitFor(() =>
    [...engine.activeSubAgents.values()].filter(s => (s as unknown as { currentRequestId: string }).currentRequestId).length >= count,
  'sub-engines live')
}

/** Wait until the predicate holds, draining the event loop meanwhile. */
async function waitFor(pred: () => boolean, what: string, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (pred()) return
    await tick()
  }
  throw new Error(`timeout waiting for: ${what}`)
}

beforeEach(() => {
  resetSubAgentLimiter()
  setSubAgentParallelLimit(null)
})

afterEach(() => {
  setSubAgentParallelLimit(null)
})

describe('停止按钮（cancelLoop）冻结整棵树 — completion 不结算、槽位不归还、队列不排空', () => {
  it('freeze aborts the streams, parks awaiting_continue with subAgentCount, and settles nothing', async () => {
    const host = makeHoldHost()
    setHost(host)
    const engine = makeEngine('conv_freeze', host)

    await dispatchSpawns(engine, [spawnBlock('toolu_f1', '任务A'), spawnBlock('toolu_f2', '任务B')], 2)
    const subs = [...engine.activeSubAgents.values()]

    // ── The composer's stop button: agentSessionCancel → cancelLoop.
    engine.cancelLoop()

    // Both sub streams aborted, the turn parks behind the confirm strip…
    await waitFor(() => host.aborted.length >= 2, 'both sub streams aborted')
    expect(engine.agentStatus).toEqual({ status: 'awaiting_continue', subAgentCount: 2 })
    // …and NOTHING settles: engines stay registered, completions stay open,
    // slots stay held, no envelopes landed.
    expect(engine.activeSubAgents.size).toBe(2)
    expect([...engine.activeSubAgents.values()]).toEqual(subs)
    expect(toolResultIds(engine)).toHaveLength(0)
    const { activeSubAgentCount, subAgentBudgetKey } = await import('../src/renderer/src/agent/engine/subagent-limiter')
    expect(activeSubAgentCount(subAgentBudgetKey(engine.opts))).toBe(2)

    // The proxy-side abort surfaces as stream errors; no engine re-issues.
    await tick()
    await tick()
    expect(host.issued.length).toBe(2)
  })

  it('a late clean DONE stays dead in the frozen tree; 停止任务 (stopExecution) then settles it for real', async () => {
    const host = makeHoldHost()
    setHost(host)
    const engine = makeEngine('conv_freeze_late', host)

    await dispatchSpawns(engine, [spawnBlock('toolu_l1', '任务A')], 1)
    const [reqA] = host.issued
    const sub = [...engine.activeSubAgents.values()][0]

    engine.cancelLoop()
    await tick()

    // The provider had already finished: the DONE event lands after the freeze.
    // The frozen sub discards it — no tool dispatch, no next request, and the
    // completion stays open (the dispatcher is still parked on it).
    host.resolveStream(reqA, subToolStream('call_x'))
    await tick()
    await tick()
    expect(host.issued.length).toBe(1)
    expect(engine.activeSubAgents.size).toBe(1)
    expect((sub as unknown as { isCancelled: boolean }).isCancelled).toBe(true)

    // ── 确认条的 停止任务：settle the tree.
    engine.stopExecution()
    await waitFor(() => engine.activeSubAgents.size === 0, 'tree settled')
    await waitFor(() => toolResultIds(engine).length >= 1, 'envelope landed')
    expect(engine.agentStatus.status).toBe('idle')
    await tick()
    expect(host.issued.length).toBe(1)
  })

  it('停止任务 on a parked session declines the queued expert (子代理未启动) and frees the slots', async () => {
    const host = makeHoldHost()
    setHost(host)
    setSubAgentParallelLimit(1)
    const engine = makeEngine('conv_stop_queued2', host)

    const a = spawnBlock('toolu_q1', '任务A')
    const b = spawnBlock('toolu_q2', '任务B')
    engine.messages = [...engine.messages, {
      id: 'm1',
      role: 'assistant',
      contentBlocks: [a, b],
      createdAt: new Date().toISOString(),
    }]
    engine.pendingToolIds = new Set([a.id, b.id])
    void engine.handleToolUseResponse([a, b])
    await waitFor(() => host.issued.length >= 1, 'first expert started')
    await tick()
    const { queuedSubAgentCount, subAgentBudgetKey } = await import('../src/renderer/src/agent/engine/subagent-limiter')
    expect(queuedSubAgentCount(subAgentBudgetKey(engine.opts))).toBe(1)

    // 停止 first freezes (the queue stays eligible for the resume path)…
    engine.cancelLoop()
    await tick()
    expect(queuedSubAgentCount(subAgentBudgetKey(engine.opts))).toBe(1)

    // …then 停止任务 settles: the running expert resolves aborted AND the
    // queued one is declined on the same click.
    engine.stopExecution()
    await waitFor(() => engine.activeSubAgents.size === 0, 'tree settled')
    await waitFor(() => toolResultIds(engine).length >= 2, 'both spawn results')
    expect(host.issued.length).toBe(1)
    expect(toolResultFor(engine, b.id)).toContain('子代理未启动')
    expect(queuedSubAgentCount(subAgentBudgetKey(engine.opts))).toBe(0)
    expect(engine.agentStatus.status).toBe('idle')
  })
})

describe('继续执行（resumeExecution）= 同一批子引擎原样续跑', () => {
  it('resume re-issues the identical sub-engines and the parent loop', async () => {
    const host = makeHoldHost()
    setHost(host)
    const engine = makeEngine('conv_resume_same', host)

    await dispatchSpawns(engine, [spawnBlock('toolu_p1', '任务A'), spawnBlock('toolu_p2', '任务B')], 2)
    const before = [...engine.activeSubAgents.values()]
    const issuedBefore = host.issued.length

    engine.cancelLoop()
    await waitFor(() => host.aborted.length >= 2, 'both sub streams aborted')
    expect(engine.agentStatus).toEqual({ status: 'awaiting_continue', subAgentCount: 2 })

    // ── 确认条的 继续执行：the SAME engine objects keep running (原样续跑 —
    // resume never re-spawns), and each re-issues its request.
    engine.resumeExecution()
    await waitFor(() => host.issued.length >= issuedBefore + 2, 'both experts re-issued')
    expect([...engine.activeSubAgents.values()]).toEqual(before)
    // The parent's own loop resumes too.
    await waitFor(() => host.issued.length >= issuedBefore + 3, 'parent loop resumed')
  })

  it('the freeze keeps the queued expert eligible — resume lets it start when the slot frees', async () => {
    const host = makeHoldHost()
    setHost(host)
    setSubAgentParallelLimit(1)
    const engine = makeEngine('conv_resume_queued', host)

    const a = spawnBlock('toolu_q1', '任务A')
    const b = spawnBlock('toolu_q2', '任务B')
    engine.messages = [...engine.messages, {
      id: 'm1',
      role: 'assistant',
      contentBlocks: [a, b],
      createdAt: new Date().toISOString(),
    }]
    engine.pendingToolIds = new Set([a.id, b.id])
    void engine.handleToolUseResponse([a, b])
    await waitFor(() => host.issued.length >= 1, 'first expert started')
    await tick()
    const subA = [...engine.activeSubAgents.values()][0]
    const { queuedSubAgentCount, subAgentBudgetKey } = await import('../src/renderer/src/agent/engine/subagent-limiter')
    expect(queuedSubAgentCount(subAgentBudgetKey(engine.opts))).toBe(1)

    // 停止 — the queue must NOT drain (恢复时还要用): B stays eligible.
    engine.cancelLoop()
    await tick()
    expect(queuedSubAgentCount(subAgentBudgetKey(engine.opts))).toBe(1)
    expect(engine.agentStatus.status).toBe('awaiting_continue')

    // 继续执行 — A re-issues and finishes cleanly; its slot hands over to B,
    // who STARTS (the anti-stop invariant: only 停止任务/新消息 decline the queue).
    engine.resumeExecution()
    // A's fresh round rides the SAME engine: read its requestId off the engine
    // itself — the resumed parent also issues its own request, so issued-order
    // guessing would resolve the wrong stream.
    await waitFor(() => host.issued.length >= 3, 'expert A re-issued + parent resumed')
    const aRound = (subA as unknown as { currentRequestId: string }).currentRequestId
    expect(aRound).toBeTruthy()
    host.resolveStream(aRound, subTextEndStream())
    await waitFor(() => toolResultIds(engine).length >= 1, 'expert A envelope')
    // The freed slot hands over to B: a new engine, a new request. A's own
    // entry left the map with its completion (cleanup) — only B remains.
    await waitFor(() => host.issued.length >= 4, 'queued expert B started')
    expect(engine.activeSubAgents.size).toBe(1)
    const subB = [...engine.activeSubAgents.values()][0]
    const bRound = (subB as unknown as { currentRequestId: string }).currentRequestId
    expect(bRound).toBeTruthy()
    host.resolveStream(bRound, subTextEndStream())
    await waitFor(() => toolResultIds(engine).length >= 2, 'expert B envelope')
    expect(toolResultFor(engine, b.id)).not.toContain('子代理未启动')
    expect(queuedSubAgentCount(subAgentBudgetKey(engine.opts))).toBe(0)
  })
})

describe('输入了新消息 = 旧回合终止（prepareTurn 结算旧树，引擎侧权威）', () => {
  it('a new send settles the frozen tree (envelopes + slots) and opens the new turn with exactly one loop', async () => {
    const host = makeHoldHost()
    setHost(host)
    const engine = makeEngine('conv_newmsg', host)

    await dispatchSpawns(engine, [spawnBlock('toolu_n1', '任务A'), spawnBlock('toolu_n2', '任务B')], 2)

    // 停止 (freeze) — then the user ignores the strip and types a new message.
    engine.cancelLoop()
    await tick()
    expect(engine.activeSubAgents.size).toBe(2)

    void engine.startLoop('新任务，别管之前的专家了')
    // The old tree settles (envelopes land, engines leave the map, slots free)…
    await waitFor(() => toolResultIds(engine).length >= 2, 'old tree envelopes')
    await waitFor(() => engine.activeSubAgents.size === 0, 'tree gone')
    const { activeSubAgentCount, subAgentBudgetKey } = await import('../src/renderer/src/agent/engine/subagent-limiter')
    expect(activeSubAgentCount(subAgentBudgetKey(engine.opts))).toBe(0)
    // …and the new turn runs EXACTLY ONE new request: the settled dispatches'
    // addToolResult continuations drained while isCancelled still gated them —
    // they must not revive alongside the new turn's own loop.
    await waitFor(() => host.issued.length >= 3, 'new turn request issued')
    await tick()
    await tick()
    expect(host.issued.length).toBe(3)
  })

  it('a new send also declines a queued expert (子代理未启动) — same settle path', async () => {
    const host = makeHoldHost()
    setHost(host)
    setSubAgentParallelLimit(1)
    const engine = makeEngine('conv_newmsg_queued', host)

    const a = spawnBlock('toolu_m1', '任务A')
    const b = spawnBlock('toolu_m2', '任务B')
    engine.messages = [...engine.messages, {
      id: 'm1',
      role: 'assistant',
      contentBlocks: [a, b],
      createdAt: new Date().toISOString(),
    }]
    engine.pendingToolIds = new Set([a.id, b.id])
    void engine.handleToolUseResponse([a, b])
    await waitFor(() => host.issued.length >= 1, 'first expert started')
    await tick()

    engine.cancelLoop()
    await tick()

    void engine.startLoop('新任务')
    await waitFor(() => toolResultIds(engine).length >= 2, 'both spawn results')
    await waitFor(() => engine.activeSubAgents.size === 0, 'tree gone')
    // One for expert A, one for the new turn itself (held open) — B never ran.
    await waitFor(() => host.issued.length >= 2, 'new turn request issued')
    await tick()
    expect(host.issued.length).toBe(2)
    expect(toolResultFor(engine, b.id)).toContain('子代理未启动')
    const { queuedSubAgentCount, subAgentBudgetKey } = await import('../src/renderer/src/agent/engine/subagent-limiter')
    expect(queuedSubAgentCount(subAgentBudgetKey(engine.opts))).toBe(0)
  })
})

describe('a failing expert carries its reason to the parent (2026-09-29)', () => {
  it('stream failure → the completion resolves {status:"error", error}, the envelope names it, the card stops claiming 已完成', async () => {
    const host = makeHoldHost()
    setHost(host)
    const engine = makeEngine('conv_spawn_fail_reason', host)

    const a = spawnBlock('toolu_f1', '任务A')
    engine.messages = [...engine.messages, {
      id: 'm1',
      role: 'assistant',
      contentBlocks: [a],
      createdAt: new Date().toISOString(),
    }]
    engine.pendingToolIds = new Set([a.id])

    void engine.handleToolUseResponse([a])
    await waitFor(() => host.issued.length >= 1, 'sub-agent LLM request')
    const [reqA] = host.issued

    // A plain provider error: HTTP-status errors are NOT transport-retryable
    // (the engine's stream-failure retry covers resets/aborts — see
    // tests/network-stream-retry.test.ts — so 'Request aborted' would now
    // re-issue instead of settling), and the error path must still settle the
    // sub-agent's completion in one shot with the reason surviving the settle
    // — the parent's envelope and tool card used to see only the bare word
    // `error`.
    host.abortStream(reqA, 'HTTP 500: provider exploded')

    await waitFor(() => toolResultIds(engine).length >= 1, 'spawn envelope')
    const blocks = engine.messages.flatMap(m => m.contentBlocks)
    const resultBlock = blocks.find(b => b.type === 'tool_result' && (b as { tool_use_id: string }).tool_use_id === a.id) as { content: string } | undefined
    expect(resultBlock?.content).toContain('### Sub-agent Status: error')
    expect(resultBlock?.content).toContain('**Reason:** HTTP 500: provider exploded')
    const useBlock = blocks.find(b => b.type === 'tool_use' && b.id === a.id) as { output?: string; exitCode?: number } | undefined
    expect(useBlock?.output).toContain('子代理失败：HTTP 500: provider exploded')
    expect(useBlock?.output).not.toContain('子代理已完成')
    expect(useBlock?.exitCode).toBe(1)
    // The failed expert's engine left the map with its settle — no leak.
    await waitFor(() => engine.activeSubAgents.size === 0, 'sub engine cleaned up')
  })
})
