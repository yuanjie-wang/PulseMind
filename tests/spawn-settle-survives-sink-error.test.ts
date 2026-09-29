import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Same HOME sandbox as stop-settles-subagents.test.ts — the engine import
// chain touches real stores, and a test must never write into the user's live
// ~/.pulsemind.
process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-spawn-settle-sink-'))

const { AgentEngine } = await import('../src/renderer/src/agent/AgentEngine')
const { openaiAdapter } = await import('../src/renderer/src/llm/OpenAIAdapter')
const { ToolManager } = await import('../src/renderer/src/tools/ToolManager')
const { SkillManager } = await import('../src/renderer/src/skills/SkillManager')
const { setSubAgentParallelLimit, resetSubAgentLimiter } = await import('../src/renderer/src/agent/engine/subagent-limiter')

import type { PulseHost } from '../src/renderer/src/agent/host/types'
import { setHost } from '../src/renderer/src/agent/host'
import type { ToolUseBlock } from '../src/renderer/src/types/agent'

const tick = () => new Promise((r) => setTimeout(r, 10))

// The makeHoldHost harness is copied from stop-settles-subagents.test.ts —
// identical semantics (held streams, resolver hooks, Proxy noop fallback).
function makeHoldHost(): PulseHost & {
  issued: string[]
  resolveStream(requestId: string, chunks: string[]): void
} {
  const issued: string[] = []
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
  }
  const host = new Proxy(base, {
    get(target, prop: string) {
      if (prop in target) return target[prop]
      if (!(prop in target)) (target as Record<string, unknown>)[prop] = noop
      return (target as Record<string, unknown>)[prop]
    },
  }) as unknown as PulseHost & { issued: string[]; resolveStream(requestId: string, chunks: string[]): void }
  Object.defineProperties(host, { issued: { get: () => issued } })
  ;(base as Record<string, unknown>).resolveStream = (requestId: string, chunks: string[]) => {
    const p = pending.get(requestId)
    if (!p) return
    for (const c of chunks) for (const fn of [...p.chunkListeners]) fn({ requestId, data: c })
    for (const fn of [...p.doneListeners]) fn({ requestId })
    pending.delete(requestId)
    p.resolve()
  }
  return host
}

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`

/** A clean text round: ends the sub-agent's turn and settles its completion. */
const subTextEndStream = (): string[] => [
  sse({ choices: [{ delta: { content: '审查完成，报告已落盘。' } }] }),
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

const toolResultFor = (engine: AgentEngine, id: string): string =>
  engine.messages.flatMap(m => m.contentBlocks)
    .filter(b => b.type === 'tool_result' && (b as { tool_use_id: string }).tool_use_id === id)
    .map(b => (b as { content: string }).content).join('')

async function waitFor(pred: () => boolean, what: string, tries = 150): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (pred()) return
    await tick()
  }
  throw new Error(`timeout waiting for: ${what}`)
}

/** Plant `blocks` as this engine's tool batch, run the real dispatch, and
 *  return the sub-engines together with their held request ids. */
async function dispatchSpawns(engine: AgentEngine, blocks: ToolUseBlock[], count: number) {
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
  return [...engine.activeSubAgents.values()].map(s => ({
    engine: s,
    requestId: (s as unknown as { currentRequestId: string }).currentRequestId,
  }))
}

beforeEach(() => {
  resetSubAgentLimiter()
  setSubAgentParallelLimit(null)
})

afterEach(() => {
  setSubAgentParallelLimit(null)
})

describe('专家完成后的结算不得被 UI 事件面的异常打断 — 光标常亮楔死的根因', () => {
  // conv_20260929224057 的实测形状（分模块代码评审，5 专家并行）：4/5 个专家
  // 的终局消息带完整 stats（onStreamComplete 走完、消息入库），但父代理只收到
  // 第一个完成的信封——其余专家的 resolveCompletionIfSpawned 没有到达，父代理
  // 的 `await waitForCompletion()` 永远挂起，主对话状态停在 busy，光标常亮。
  // 本测试钉住不变量：**结算（resolveCompletionIfSpawned）是引擎对派发方的
  // 契约，不允许被 notify 链路上的异常（session 事件 sink、webContents、ws）
  // 吞掉。**
  it('一个 sink 在结算 notify 上死去，信封仍必须落账、派发方仍必须被放行', async () => {
    const host = makeHoldHost()
    setHost(host)
    const engine = makeEngine('conv_sink_die', host)

    const subs = await dispatchSpawns(engine, [spawnBlock('toolu_s0', '任务A'), spawnBlock('toolu_s1', '任务B')], 2)

    // Production shape: a main-side session-event sink (makeCallbacks → emit →
    // webContents.send / ws send) throws on the sub-engine's completed status.
    // notify() calls onStatusChanged synchronously inside handleEndTurnResponse,
    // BETWEEN the status write and resolveCompletionIfSpawned.
    for (const s of subs) {
      ;(s.engine as unknown as { callbacks: unknown }).callbacks = {
        onStatusChanged: (status: { status: string }) => {
          if (status.status === 'completed') throw new Error('sink died')
        },
      }
    }

    // Expert 0 settles while the world is healthy…
    host.resolveStream(subs[0].requestId, subTextEndStream())
    await waitFor(() => toolResultFor(engine, 'toolu_s0').includes('Sub-Agent Result'), 'first envelope')
    expect(toolResultFor(engine, 'toolu_s0')).toContain('(completed)')

    // …expert 1 finishes the same way, and its settle-time notify throws.
    host.resolveStream(subs[1].requestId, subTextEndStream())

    // THE INVARIANT: the envelope must land and the dispatcher must be released.
    // Before the fix this timed out: handleEndTurnResponse died at notify(),
    // resolveCompletionIfSpawned never ran, the spawn batch's Promise.all never
    // resolved, the parent sat in 'executing' forever — the blinking cursor.
    await waitFor(() => toolResultFor(engine, 'toolu_s1').includes('Sub-Agent Result'), 'second envelope lands despite the dead sink')
    expect(toolResultFor(engine, 'toolu_s1')).toContain('(completed)')
  })
})

// 深防（同一缺陷的第二、第三层）：session-manager 的 emit 逐 sink 隔离——一个
// 坏 sink 不得中断兄弟 sink，更不得把异常掷回引擎的 notify；ws-server 的事件
// 面守卫 socket.send（readyState 检查与 send 之间 socket 可以关闭，ws 会同步
// 抛）。行为级等价物很难在 vitest 里搭（要真 webContents/真 ws），源码形状
// 扫描按本仓库惯例钉住。
describe('事件面隔离的接线钉子', () => {
  it('session-manager emit isolates each sink; ws-server guards its send', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const read = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
    const sm = read('../src/main/agent/session-manager.ts')
    expect(sm).toMatch(/for \(const sink of this\.eventSinks\) \{\s*try \{ sink\(sessionId, data\) \} catch/)
    const ws = read('../src/main/agent/ws-server.ts')
    expect(ws).toMatch(/try \{ conn\.socket\.send\(payload\) \} catch/)
  })
})
